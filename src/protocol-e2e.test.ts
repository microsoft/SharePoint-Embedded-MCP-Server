// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * TEST-001 — MCP protocol-level end-to-end harness.
 *
 * HARNESS APPROACH: spawn the built server (`dist/cli.js start`) as a child
 * process and drive it with the real MCP SDK `Client` over the SDK's
 * `StdioClientTransport`. This exercises the genuine wire protocol — the
 * `initialize` handshake, JSON-RPC framing, ListTools serialization (handler
 * stripping), and the CallTool dispatch/gating pipeline — exactly as a real MCP
 * host would. We prefer spawn over an in-memory transport pair because the
 * server (`src/index.ts`) owns a module-level `Server` singleton that always
 * connects its own `StdioServerTransport`; there is no exported handle to bind
 * an in-memory pair to without refactoring production code. Spawning proved
 * reliable on Windows (verified before committing).
 *
 * OFFLINE/DETERMINISTIC: the server connects its transport BEFORE auth and only
 * LOGS (never throws) on Azure-CLI failure, so list/unknown/gate paths answer
 * without any tenant, Graph, or network access. We point the child's HOME /
 * USERPROFILE at an isolated empty dir so persisted provisioning state is empty
 * and the content-plane gate is reliably CLOSED. Every `tools/call` carries a
 * per-request timeout so a hang fails the individual assertion rather than
 * stalling the whole suite.
 */

import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// repo root = parent of src/
const REPO_ROOT = resolve(__dirname, "..");
const CLI_ENTRY = join(REPO_ROOT, "dist", "cli.js");

// Per-call timeout (ms): a gate/dispatch hang should fail the specific
// assertion fast, not block the suite. Generous enough to absorb child-process
// spawn jitter on CI.
const CALL_TIMEOUT_MS = 8000;

interface StructuredError {
  ok?: boolean;
  error?: { code?: string; message?: string; suggestion?: string };
  durationMs?: number;
}

describe("MCP protocol-level e2e (spawned dist/cli.js start)", () => {
  let client: Client;
  let transport: StdioClientTransport;
  let isolatedHome: string;

  beforeAll(async () => {
    // Self-build guard: this suite drives the *built* server (dist/cli.js). The
    // `ci` script and CI workflow build before test, but a direct `vitest` run
    // (or test-before-build ordering) may not have dist/ yet — so build it once
    // here if missing, rather than failing with an opaque "Connection closed".
    if (!existsSync(CLI_ENTRY)) {
      execSync("npm run build", { cwd: REPO_ROOT, stdio: "ignore" });
    }

    // Isolated, empty HOME/USERPROFILE => empty persisted state => content gate
    // is closed and no prior run can leak `contentAccessGranted: true`.
    isolatedHome = mkdtempSync(join(tmpdir(), "spe-mcp-e2e-home-"));

    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (typeof v === "string") env[k] = v;
    }
    env.USERPROFILE = isolatedHome;
    env.HOME = isolatedHome;
    // Force bootstrap mode (no pre-provisioned app); keeps auth non-blocking.
    delete env.SPE_CLIENT_ID;
    delete env.SPE_TENANT_ID;
    delete env.SPE_READ_ONLY;
    delete env.SPE_TOOLS;

    transport = new StdioClientTransport({
      command: process.execPath,
      args: [CLI_ENTRY, "start"],
      env,
      cwd: REPO_ROOT,
      // Swallow the server's stderr diagnostics so they don't pollute test output.
      stderr: "ignore",
    });

    client = new Client({ name: "spe-mcp-e2e-test", version: "0.0.0" }, {});
    // connect() performs the MCP `initialize` handshake.
    await client.connect(transport);
  }, 90000);

  afterAll(async () => {
    try {
      await client?.close();
    } catch {
      /* ignore */
    }
    try {
      await transport?.close();
    } catch {
      /* ignore */
    }
    try {
      if (isolatedHome) rmSync(isolatedHome, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  // (a) initialize handshake succeeds; serverInfo name is `spe-mcp-server`.
  it("completes the initialize handshake and reports serverInfo name", () => {
    const info = client.getServerVersion();
    expect(info).toBeDefined();
    expect(info?.name).toBe("spe-mcp-server");
    // Capabilities negotiated during initialize should advertise tools.
    expect(client.getServerCapabilities()?.tools).toBeDefined();
  });

  // (b) tools/list returns tools with NO handler field, each has inputSchema;
  //     spot-check a known tool and that container_delete is destructive.
  it("lists tools without leaking handlers and with correct annotations", async () => {
    const { tools } = await client.listTools(undefined, { timeout: CALL_TIMEOUT_MS });
    expect(tools.length).toBeGreaterThan(0);

    for (const tool of tools) {
      // Handler must never cross the wire.
      expect(tool).not.toHaveProperty("handler");
      expect(tool.inputSchema).toBeDefined();
      expect(tool.inputSchema.type).toBe("object");
    }

    // Spot-check a stable, well-known tool exists.
    const names = tools.map((t) => t.name);
    expect(names).toContain("container_list");

    // Destructive tool carries destructiveHint:true via annotations.
    const del = tools.find((t) => t.name === "container_delete");
    expect(del).toBeDefined();
    expect(del?.annotations?.destructiveHint).toBe(true);
  });

  // (c) tools/call happy path on a SAFE, no-network tool. content_access_grant
  //     with no confirm returns guidance content and touches no Graph/Azure/state.
  it("calls a safe no-network tool (content_access_grant) successfully", async () => {
    const res = await client.callTool(
      { name: "content_access_grant", arguments: {} },
      undefined,
      { timeout: CALL_TIMEOUT_MS },
    );
    expect(res.isError).toBeFalsy();
    const content = res.content as Array<{ type: string; text: string }>;
    expect(content[0].text).toContain("Enable content access?");
  });

  // (d) tools/call unknown tool => isError, code UNKNOWN_TOOL.
  it("returns isError + UNKNOWN_TOOL for an unknown tool", async () => {
    const res = await client.callTool(
      { name: "this_tool_does_not_exist", arguments: {} },
      undefined,
      { timeout: CALL_TIMEOUT_MS },
    );
    expect(res.isError).toBe(true);
    const sc = res.structuredContent as StructuredError | undefined;
    expect(sc?.error?.code).toBe("UNKNOWN_TOOL");
    const content = res.content as Array<{ type: string; text: string }>;
    expect(content.some((c) => /unknown tool/i.test(c.text))).toBe(true);
  });

  // (e) Content-gate fail-closed: a content tool BEFORE any grant => isError,
  //     returns the gate message, does NOT hang, and makes no Graph call.
  it("fails closed on a content-plane tool before content access is granted", async () => {
    const res = await client.callTool(
      { name: "content_search", arguments: { containerId: "no-such-container", query: "anything" } },
      undefined,
      { timeout: CALL_TIMEOUT_MS },
    );
    expect(res.isError).toBe(true);
    const content = res.content as Array<{ type: string; text: string }>;
    // Gate message — proves we stopped at the wrapper, not at a Graph error.
    expect(content[0].text).toContain("Content access not enabled");
  });

  // (f) Confirm-gate: permanent-delete WITHOUT confirm => isError,
  //     CONFIRMATION_REQUIRED, returns quickly with no real delete.
  it("requires confirmation for container_delete permanent-delete", async () => {
    const res = await client.callTool(
      { name: "container_delete", arguments: { containerId: "x", action: "permanent-delete" } },
      undefined,
      { timeout: CALL_TIMEOUT_MS },
    );
    expect(res.isError).toBe(true);
    const sc = res.structuredContent as StructuredError | undefined;
    expect(sc?.error?.code).toBe("CONFIRMATION_REQUIRED");
  });
});
