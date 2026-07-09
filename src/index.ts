// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * SPE MCP Server — main entry point.
 *
 * Architecture:
 *   1. Connect transport first (so MCP `initialize` handshake succeeds immediately)
 *   2. Initialize auth in background (non-blocking)
 *   3. Tools array with { name, description, inputSchema, handler }
 *   4. ListTools returns metadata only (no handler functions)
 *   5. CallTool dispatches to handler by name
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { initializeAuth, setAuthConfig } from "./auth.js";
import { assertAzCli, getSignedInIdentity } from "./bootstrap.js";
import { readState } from "./state.js";
import { USER_AGENT } from "./user-agent.js";
import { PACKAGE_VERSION } from "./version.js";
import type { McpTool, ServerConfig } from "./types.js";
import { redact } from "./logging.js";
import { fail } from "./responses.js";
import { toSafeError } from "./errors.js";
import {
  buildToolPolicy,
  isToolListed,
  checkToolCallAllowed,
  type ResolvedToolPolicy,
} from "./policy.js";
import { withConfirmation } from "./tools/confirmation.js";
// Status / diagnostics
import { statusTool } from "./tools/status.js";
// Container Type tools
import { createContainerTypeTool } from "./tools/create-container-type.js";
import { listContainerTypesTool } from "./tools/list-container-types.js";
import { createAppTool } from "./tools/create-app.js";
import { registerContainerTypeTool } from "./tools/register-container-type.js";
import { getContainerTypeTool, updateContainerTypeTool, deleteContainerTypeTool } from "./tools/container-type-crud.js";
import { grantContainerTypeOwnerTool, listContainerTypeOwnersTool, revokeContainerTypeOwnerTool } from "./tools/container-type-permissions.js";
import { addContainerTypeAppGrantTool, listContainerTypeAppGrantsTool, removeContainerTypeAppGrantTool } from "./tools/container-type-app-grants.js";
import {
  getContainerTypeRegistrationTool,
  listContainerTypeRegistrationsTool,
  deleteContainerTypeRegistrationTool,
} from "./tools/container-type-registration.js";
import { createContainerTool } from "./tools/create-container.js";
// Container Management tools
import { listContainersTool } from "./tools/list-containers.js";
import { getContainerTool } from "./tools/get-container.js";
import { updateContainerTool } from "./tools/update-container.js";
import { managePermissionsTool } from "./tools/manage-permissions.js";
import { archiveRestoreTool } from "./tools/archive-restore.js";
import { deleteContainerTool } from "./tools/delete-container.js";
import { listDeletedContainersTool } from "./tools/list-deleted-containers.js";
// Content Operations tools
import { uploadFileTool } from "./tools/upload-file.js";
import { createFolderTool } from "./tools/create-folder.js";
import { searchContentTool } from "./tools/search-content.js";
import { previewFileTool } from "./tools/preview-file.js";
import { manageSharingTool } from "./tools/manage-sharing.js";
// Billing tools
import { checkBillingTool } from "./tools/check-billing.js";
import { setupBillingTool } from "./tools/setup-billing.js";
import { listSubscriptionsTool, listResourceGroupsTool } from "./tools/list-azure.js";
// Documentation tools (proxy to Microsoft Learn MCP)
import { searchDocsTool, fetchDocTool } from "./tools/search-docs.js";
// Orchestration + config + Azure list + scaffold/run/deploy + content + cleanup
import { provisionTool } from "./tools/provision.js";
import { hydrateConfigTool } from "./tools/hydrate-config.js";
import { scaffoldTool } from "./tools/scaffold.js";
import { seedSampleDataTool } from "./tools/seed-sample-data.js";
import { runLocalTool } from "./tools/run-local.js";
import { deployAzureTool } from "./tools/deploy-azure.js";
import { grantContentAccessTool, revokeContentAccessTool, withContentAccess } from "./tools/content-access.js";
import { cleanupTool } from "./tools/cleanup.js";
import { SPE_PROMPTS, getPromptMessages } from "./prompts.js";
import { SPE_RESOURCES, readResource } from "./resources.js";
import { SPE_SERVER_INSTRUCTIONS } from "./server-instructions.js";

// Derived from package.json (single source of truth) — see src/version.ts.
const SERVER_VERSION = PACKAGE_VERSION;

// All server diagnostics go to **stderr**, never stdout. For a stdio MCP
// server, stdout is the JSON-RPC protocol channel — writing logs there would
// corrupt the message stream and break the client. `console.error` (stderr) is
// therefore the correct, intentional sink for every log and status line below.
function log(message: string, data?: unknown): void {
  const timestamp = new Date().toISOString();
  if (data !== undefined) {
    console.error(`[${timestamp}] [MCP] ${message}`, JSON.stringify(data));
  } else {
    console.error(`[${timestamp}] [MCP] ${message}`);
  }
}

// ─── Tool Registry ──────────────────────────────────────────────────────────

const TOOLS: McpTool[] = [
  // Status / diagnostics
  statusTool,
  // Provisioning (owning app → container type → register → container)
  createAppTool,
  provisionTool,
  // Container Types
  listContainerTypesTool,
  createContainerTypeTool,
  registerContainerTypeTool,
  getContainerTypeTool,
  updateContainerTypeTool,
  deleteContainerTypeTool,
  // Container Type permissions (owner role — beta; enables PCA container creation)
  grantContainerTypeOwnerTool,
  listContainerTypeOwnersTool,
  revokeContainerTypeOwnerTool,
  // Container Type registration — application permission grants (v1.0; authorize consuming apps)
  addContainerTypeAppGrantTool,
  listContainerTypeAppGrantsTool,
  removeContainerTypeAppGrantTool,
  // Container Type registration RECORD — CRUDL on the registration itself (v1.0).
  // Deleting the registration is REQUIRED before a container type can be deleted.
  // The delete tool self-gates on `confirm` and shows a blocker-aware preview, so
  // it is intentionally NOT wrapped with withConfirmation (which would suppress
  // that richer preview).
  getContainerTypeRegistrationTool,
  listContainerTypeRegistrationsTool,
  deleteContainerTypeRegistrationTool,
  // Container Management
  listContainersTool,
  getContainerTool,
  createContainerTool,
  updateContainerTool,
  managePermissionsTool,
  archiveRestoreTool,
  // container_delete self-guards permanent-delete; the middleware enforces the
  // same gate uniformly at registration (SAFE-002). Both produce an identical
  // CONFIRMATION_REQUIRED, so there is no double-prompt.
  withConfirmation(deleteContainerTool, { actions: ["permanent-delete"] }),
  // Recycle bin — list soft-deleted containers (blockers for registration delete)
  listDeletedContainersTool,
  // Content Operations (content-plane: gated behind content-access opt-in)
  withContentAccess(uploadFileTool),
  withContentAccess(createFolderTool),
  withContentAccess(searchContentTool),
  withContentAccess(previewFileTool),
  withContentAccess(manageSharingTool),
  // Billing
  checkBillingTool,
  setupBillingTool,
  listSubscriptionsTool,
  listResourceGroupsTool,
  // Config + scaffold + run + deploy
  hydrateConfigTool,
  scaffoldTool,
  withContentAccess(seedSampleDataTool),
  runLocalTool,
  deployAzureTool,
  // Content plane (opt-in, step-up consent)
  grantContentAccessTool,
  revokeContentAccessTool,
  // Hardening
  cleanupTool,
  // Documentation (grounded via Microsoft Learn MCP)
  searchDocsTool,
  fetchDocTool,
];

/**
 * Map an internal tool's `annotations` onto the subset of MCP annotation *hints*
 * the SDK serializes into the ListTools response (`readOnlyHint`,
 * `destructiveHint`, `idempotentHint`). Only annotations that are explicitly set
 * on the tool are forwarded; when the tool has none, `undefined` is returned so
 * the `annotations` field is omitted from the wire response entirely.
 */
function toMcpAnnotations(tool: McpTool): Record<string, boolean> | undefined {
  const annotations: Record<string, boolean> = {};
  if (tool.annotations?.readOnly !== undefined) annotations.readOnlyHint = tool.annotations.readOnly;
  if (tool.annotations?.destructive !== undefined) annotations.destructiveHint = tool.annotations.destructive;
  if (tool.annotations?.idempotent !== undefined) annotations.idempotentHint = tool.annotations.idempotent;
  return Object.keys(annotations).length > 0 ? annotations : undefined;
}

function withDuration(structuredContent: unknown, durationMs: number): unknown {
  if (structuredContent === undefined) return undefined;
  if (structuredContent && typeof structuredContent === "object" && !Array.isArray(structuredContent)) {
    return { ...structuredContent as Record<string, unknown>, durationMs };
  }
  return { data: structuredContent, durationMs };
}

function validateArgs(args: Record<string, unknown>, tool: McpTool): { ok: true; args: Record<string, unknown> } | { ok: false; result: ReturnType<typeof fail> } {
  if (tool.validateArgs) {
    return { ok: true, args: tool.validateArgs(args) };
  }

  const missing = (tool.inputSchema.required ?? []).filter((key) => args[key] === undefined || args[key] === null);
  if (missing.length > 0) {
    return {
      ok: false,
      result: fail(
        "INVALID_ARGS",
        `Missing required argument${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}`,
        "Provide all required fields from the tool input schema.",
      ),
    };
  }

  return { ok: true, args };
}

function toListToolEntry(tool: McpTool) {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    ...(toMcpAnnotations(tool) ? { annotations: toMcpAnnotations(tool) } : {}),
  };
}

/**
 * Active tool policy (SAFE-003 read-only mode / SAFE-004 tool allowlist). `null`
 * means no restriction (every tool advertised and callable). Set once in
 * startServer(). See docs/SECURITY-CONTROLS.md for the control-code legend.
 */
let activePolicy: ResolvedToolPolicy | null = null;

/** Tools advertised to the client, filtered by the active policy. */
function listVisibleTools() {
  return TOOLS.filter((tool) => isToolListed(tool, activePolicy)).map(toListToolEntry);
}

// ─── Server Setup ───────────────────────────────────────────────────────────

const server = new Server(
  { name: "spe-mcp-server", version: SERVER_VERSION },
  {
    capabilities: { tools: {}, prompts: {}, resources: {} },
    // Domain primer returned in the MCP `initialize` result so clients can prime
    // the model with SPE's mental model + first-request routing before any tool
    // is called. See src/server-instructions.ts.
    instructions: SPE_SERVER_INSTRUCTIONS,
  },
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const tools = listVisibleTools();
  log(`ListTools request received`, { count: tools.length });
  return { tools };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const safeArgs = args && typeof args === "object" ? args as Record<string, unknown> : {};
  log(`Tool call received: ${name}`, { tool: name, argKeys: Object.keys(safeArgs), args: redact(safeArgs) });
  const startTime = Date.now();

  try {
    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) {
      // Reachable guard, not dead code: this single handler receives EVERY
      // tools/call the MCP SDK dispatches, so a client can request a name that
      // was never registered (or one hidden by policy). Fail closed with a
      // structured UNKNOWN_TOOL error rather than throwing. Exercised by the
      // "returns isError + UNKNOWN_TOOL for an unknown tool" protocol e2e test.
      log(`Unknown tool: ${name}`);
      const result = fail("UNKNOWN_TOOL", `Unknown tool: ${name}`);
      return {
        content: result.content.map((c) => ({ type: "text" as const, text: c.text })),
        isError: result.isError,
        structuredContent: withDuration(result.structuredContent, Date.now() - startTime),
      } as const;
    }

    log(`Executing ${name}`, { tool: name, argKeys: Object.keys(safeArgs), args: redact(safeArgs) });

    // SAFE-003 (read-only mode) / SAFE-004 (tool allowlist): enforce these BEFORE
    // validating arguments or invoking the handler, so a denied call never
    // touches Graph/Azure.
    const denied = checkToolCallAllowed(tool, activePolicy);
    if (denied) {
      const durationMs = Date.now() - startTime;
      log(`${name} blocked by tool policy in ${durationMs}ms`);
      return {
        content: denied.content.map((c) => ({ type: "text" as const, text: c.text })),
        isError: true,
        structuredContent: withDuration(denied.structuredContent, durationMs),
      } as const;
    }

    const validated = validateArgs(safeArgs, tool);
    if (!validated.ok) {
      const durationMs = Date.now() - startTime;
      log(`${name} rejected invalid arguments in ${durationMs}ms`);
      return {
        content: validated.result.content.map((c) => ({ type: "text" as const, text: c.text })),
        isError: true,
        structuredContent: withDuration(validated.result.structuredContent, durationMs),
      } as const;
    }

    const result = await tool.handler(validated.args);
    const durationMs = Date.now() - startTime;
    log(`${name} completed in ${durationMs}ms`);
    return {
      content: result.content.map((c) => ({ type: "text" as const, text: c.text })),
      isError: result.isError,
      structuredContent: withDuration(result.structuredContent, durationMs),
    } as const;
  } catch (error) {
    const safeError = toSafeError(error);
    log(`Tool error (${safeError.correlationId})`, {
      tool: name,
      argKeys: Object.keys(safeArgs),
      args: redact(safeArgs),
      error: error instanceof Error
        ? { name: error.name, message: error.message, stack: error.stack }
        : String(error),
    });
    const result = fail(safeError.code, `${safeError.message} (correlationId: ${safeError.correlationId})`, safeError.suggestion);
    return {
      content: result.content.map((c) => ({ type: "text" as const, text: c.text })),
      isError: result.isError,
      structuredContent: withDuration(result.structuredContent, Date.now() - startTime),
    } as const;
  }
});

server.onerror = (error: Error) => {
  log("Protocol/transport error", error.message);
};

// ─── Prompts ────────────────────────────────────────────────────────────────

server.setRequestHandler(ListPromptsRequestSchema, async () => {
  log("ListPrompts request received");
  return { prompts: SPE_PROMPTS };
});

server.setRequestHandler(GetPromptRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  log(`GetPrompt request: ${name}`);
  return getPromptMessages(name, args ?? {});
});

// ─── Resources (reference architectures) ────────────────────────────────────

server.setRequestHandler(ListResourcesRequestSchema, async () => {
  log("ListResources request received");
  return { resources: SPE_RESOURCES };
});

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const { uri } = request.params;
  log(`ReadResource request: ${uri}`);
  return readResource(uri);
});

// ─── Start ──────────────────────────────────────────────────────────────────

export async function startServer(config: ServerConfig) {
  log("Starting SharePoint Embedded MCP Server...");

  // SAFE-003 (read-only mode) / SAFE-004 (tool allowlist): build the tool policy
  // once from config (read-only mode and/or an allowlist profile or CSV). When
  // neither is set, `activePolicy` stays null and every tool is advertised and
  // callable.
  activePolicy = buildToolPolicy(TOOLS, config.readOnly ?? false, config.tools);
  if (activePolicy.readOnly || activePolicy.allow) {
    const parts: string[] = [];
    if (activePolicy.readOnly) parts.push("read-only mode (mutating tools rejected)");
    if (config.tools) parts.push(`tool allowlist '${config.tools}'`);
    const visible = TOOLS.filter((t) => isToolListed(t, activePolicy)).length;
    console.error(
      `[SPE MCP Server] Tool policy active: ${parts.join(" + ") || "restricted"} — ${visible}/${TOOLS.length} tools exposed`,
    );
  }

  // Stamp outbound `az` / `azd` traffic for aggregate attribution. The Azure
  // CLI and Developer CLI append AZURE_HTTP_USER_AGENT to their User-Agent on
  // every ARM request. Respect any value the user already set.
  if (!process.env.AZURE_HTTP_USER_AGENT) {
    process.env.AZURE_HTTP_USER_AGENT = USER_AGENT;
  }

  // Connect transport first so MCP `initialize` handshake works immediately
  const transport = new StdioServerTransport();
  try {
    await server.connect(transport);
  } catch (error) {
    log("Failed to connect transport", error instanceof Error ? error.message : String(error));
    throw error;
  }
  log("Server connected and ready for requests");
  // User-facing startup status. Emitted on stderr (not stdout) for the same
  // reason as log() above: stdout carries the MCP JSON-RPC protocol only.
  console.error("[SPE MCP Server] Started and ready for connections");

  if (config.clientId) {
    // Pre-provisioned-app mode: an owning app already exists with SPE scopes.
    // Resolve tenant (discover from az when not supplied) and initialize MSAL.
    let tenantId = config.tenantId;
    if (!tenantId) {
      const identity = await getSignedInIdentity().catch(() => null);
      tenantId = identity?.tenantId ?? "organizations";
    }
    setAuthConfig({ clientId: config.clientId, tenantId });
    log("Initializing authentication (pre-provisioned app)...");
    try {
      await initializeAuth();
      log("Authentication ready");
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      log(`Auth initialization failed — will retry on first tool call: ${msg}`);
      console.error("[SPE MCP Server] Auth failed at startup. Will retry when a tool is called.");
    }
  } else {
    // Bootstrap mode (default): no owning app yet. Control-plane operations use
    // the Azure CLI bootstrap token; SPE provisioning creates the owning app on
    // demand (Phase 1). Verify az is available and report the signed-in identity.
    log("Bootstrap mode — no --client-id; using Azure CLI for the control plane");
    // Prime MSAL auth from persisted provisioning state so owning-app SPE/Graph
    // calls work regardless of which tool runs first. Without this, read tools
    // that don't call setAuthConfig themselves (container_list, container_get,
    // billing_check, container_type_list, content_*) throw "Auth not configured"
    // when one of them is the first Graph call of the session.
    const persisted = readState();
    if (persisted.appId && persisted.tenantId) {
      setAuthConfig({ clientId: persisted.appId, tenantId: persisted.tenantId });
      log(`Primed auth from persisted state (owning app ${persisted.appId}, tenant ${persisted.tenantId})`);
    }
    try {
      await assertAzCli();
      const identity = await getSignedInIdentity();
      if (identity) {
        console.error(
          `[SPE MCP Server] Bootstrap ready — signed in as ${identity.username} (tenant ${identity.tenantId})`,
        );
      } else {
        console.error(
          "[SPE MCP Server] Azure CLI installed but not signed in. Run `az login --allow-no-subscriptions`.",
        );
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`[SPE MCP Server] ${msg}`);
    }
  }
}
