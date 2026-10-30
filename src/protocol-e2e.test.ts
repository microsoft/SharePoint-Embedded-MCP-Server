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

import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
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
  let serverStderr = "";

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
    env.SPE_DATA_DIR = join(isolatedHome, "data");
    // Force bootstrap mode (no pre-provisioned app); keeps auth non-blocking.
    delete env.SPE_CLIENT_ID;
    delete env.SPE_TENANT_ID;
    delete env.SPE_READ_ONLY;
    delete env.SPE_TOOLS;
    // SEC-008: keep this suite hermetic. The update check is fire-and-forget and
    // would otherwise reach registry.npmjs.org from a test process. Opting out
    // also exercises the documented kill switch over the real wire — using the
    // preferred public control (`SPE_NO_UPDATE_CHECK` is only a legacy alias).
    env.SPE_MCP_UPDATE_CHECK = "false";
    delete env.SPE_NO_UPDATE_CHECK;
    delete env.SPE_NPM_REGISTRY;

    transport = new StdioClientTransport({
      command: process.execPath,
      args: [CLI_ENTRY, "start"],
      env,
      cwd: REPO_ROOT,
      // Capture diagnostics without printing them so the real initialize-driven
      // agent-host classification can be asserted over the wire.
      stderr: "pipe",
    });
    transport.stderr?.on("data", (chunk) => {
      serverStderr += String(chunk);
    });

    client = new Client({ name: "Visual Studio Code", version: "0.0.0-test" }, {});
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

  it("classifies clientInfo after the initialized notification", async () => {
    const deadline = Date.now() + 2000;
    while (
      !serverStderr.includes("Agent host attribution: vscode") &&
      Date.now() < deadline
    ) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    }
    expect(serverStderr).toContain(
      "Agent host attribution: vscode (self-reported MCP clientInfo)",
    );
  });

  // (a2) The `initialize` result carries the server `instructions` primer over
  //      the real wire, so clients can prime the model before any tool call.
  it("returns the SPE domain primer via the initialize instructions field", () => {
    const instructions = client.getInstructions();
    expect(instructions).toBeTruthy();
    // Anchor on stable, load-bearing content: the routing precondition and the
    // samples-repo citation a client is expected to relay to the model.
    expect(instructions).toContain("OWNING_APP_REQUIRED");
    expect(instructions).toContain(
      "https://github.com/microsoft/SharePoint-Embedded-Samples",
    );
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

  it("advertises the hydration purpose, supported formats, and optional arguments over tools/list", async () => {
    const { tools } = await client.listTools(undefined, { timeout: CALL_TIMEOUT_MS });
    const hydrate = tools.find((tool) => tool.name === "project_hydrate_config");

    expect(hydrate).toBeDefined();
    expect(hydrate).not.toHaveProperty("handler");
    expect(hydrate?.description).toBe(
      "Write the current SharePoint Embedded provisioning details (tenant, client, container type, " +
      "container, subscription/resource group) into a project as .env, appsettings.Development.json, " +
      "and azure.yaml so a reference app can consume them. Run after provisioning.",
    );
    expect(hydrate?.inputSchema).toEqual({
      type: "object",
      properties: {
        targetDir: {
          type: "string",
          description: "Project directory to write into. Default: current directory.",
        },
        formats: {
          type: "array",
          items: { type: "string", enum: ["env", "appsettings", "azureyaml"] },
          description: "Which config files to write. Default: all three.",
        },
      },
    });
    expect(hydrate?.annotations?.readOnlyHint).not.toBe(true);
  });

  it("preserves project names as data over scaffold and hydration protocol calls", async () => {
    const stateFile = join(isolatedHome, "data", "state.json");
    for (const architecture of ["react-spa-functions", "csharp-web"]) {
      for (const projectName of ["a\n", "a: b", 'a"b', "---", null, 123, {}]) {
        const targetDir = join(isolatedHome, `invalid-${architecture}`);
        const before = existsSync(stateFile) ? readFileSync(stateFile, "utf-8") : undefined;
        const result = await client.callTool(
          { name: "project_scaffold", arguments: { architecture, targetDir, projectName } },
          undefined,
          { timeout: CALL_TIMEOUT_MS },
        );
        expect(result.isError).toBe(true);
        expect(existsSync(targetDir)).toBe(false);
        expect(existsSync(stateFile) ? readFileSync(stateFile, "utf-8") : undefined).toBe(before);
      }

      const targetDir = join(isolatedHome, architecture);
      const scaffold = await client.callTool(
        { name: "project_scaffold", arguments: { architecture, targetDir, projectName: "123" } },
        undefined,
        { timeout: CALL_TIMEOUT_MS },
      );
      expect(scaffold.isError).toBeFalsy();
      expect(readFileSync(join(targetDir, "azure.yaml"), "utf-8")).toContain('name: "123"\n');
      expect(JSON.parse(readFileSync(stateFile, "utf-8")).projectName).toBe("123");
    }

    for (const scaffoldArchitecture of [undefined, "react-spa-functions", "csharp-web"]) {
      const legacy = JSON.stringify({
        appId: "app-test", containerTypeId: "ct-test", projectName: "a\n", scaffoldArchitecture,
      });
      writeFileSync(stateFile, legacy);
      const targetDir = join(isolatedHome, `legacy-${scaffoldArchitecture ?? "fallback"}`);
      mkdirSync(targetDir);
      const original = "name: owner-name\n";
      writeFileSync(join(targetDir, "azure.yaml"), original);
      const result = await client.callTool(
        { name: "project_hydrate_config", arguments: { targetDir } },
        undefined,
        { timeout: CALL_TIMEOUT_MS },
      );
      expect(result.isError).toBe(true);
      expect(readdirSync(targetDir)).toEqual(["azure.yaml"]);
      expect(readFileSync(join(targetDir, "azure.yaml"), "utf-8")).toBe(original);
      expect(readFileSync(stateFile, "utf-8")).toBe(legacy);
    }
    rmSync(stateFile);
  });

  it("advertises container-type deletion safeguards and optional boolean controls over the wire", async () => {
    const { tools } = await client.listTools(undefined, { timeout: CALL_TIMEOUT_MS });
    const del = tools.find((tool) => tool.name === "container_type_delete");
    expect(del).toBeDefined();
    expect(del).not.toHaveProperty("handler");
    expect(del?.annotations?.destructiveHint).toBe(true);
    expect(del?.annotations?.readOnlyHint).not.toBe(true);
    expect(del?.description).toContain("Trial-only by default");
    expect(del?.description).toContain("direct-to-customer");
    expect(del?.description).toContain("PROTECTED");
    expect(del?.description).toContain("deleteStandard=true");
    expect(del?.description).toContain("Requires confirm=true");
    expect(del?.inputSchema.type).toBe("object");
    expect(del?.inputSchema.properties).toEqual({
      containerTypeId: {
        type: "string",
        description: expect.stringContaining("Default: the provisioned container type"),
      },
      confirm: {
        type: "boolean",
        description: expect.stringContaining("Must be true"),
      },
      deleteStandard: {
        type: "boolean",
        description: expect.stringContaining("Override to delete a STANDARD / direct-to-customer"),
      },
    });
    expect(del?.inputSchema.required ?? []).toEqual([]);
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

  // (g) SEC-008 update awareness: the opt-out must be total. With the kill
  //     switch set, no tool result may be decorated with an update notice or an
  //     `updateAvailable` payload. Only SAFE, no-network tools are used so the
  //     assertion stays hermetic and fast.
  it("never appends an update notice to tool results when the check is disabled", async () => {
    for (const name of ["content_access_grant", "this_tool_does_not_exist"]) {
      const res = await client.callTool({ name, arguments: {} }, undefined, {
        timeout: CALL_TIMEOUT_MS,
      });
      const text = (res.content as Array<{ type: string; text: string }>)
        .map((c) => c.text)
        .join("\n");
      expect(text, `${name} leaked an update notice`).not.toMatch(/Update available:/i);
      const sc = res.structuredContent as Record<string, unknown> | undefined;
      expect(sc?.updateAvailable, `${name} leaked an updateAvailable payload`).toBeUndefined();
    }
  });
});
