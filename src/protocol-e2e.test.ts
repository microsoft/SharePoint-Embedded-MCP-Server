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
 * reliable in the original harness; this split retains the same SDK transport.
 *
 * OFFLINE/DETERMINISTIC: the server connects its transport BEFORE auth and only
 * LOGS (never throws) on Azure-CLI failure, so list/unknown/gate paths answer
 * without any tenant, Graph, or network access. We point the child's HOME /
 * USERPROFILE at an isolated empty dir so persisted provisioning state is empty
 * and the content-plane gate is reliably CLOSED. Every `tools/call` carries a
 * per-request timeout so a hang fails the individual assertion rather than
 * stalling the whole suite.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { CALL_TIMEOUT_MS, startProtocolServer, type ProtocolServer, type StructuredError } from "../test/protocol-server.js";

describe("MCP protocol-level e2e (spawned dist/cli.js start)", () => {
  let client: Client;
  let server: ProtocolServer;

  beforeAll(async () => {
    server = await startProtocolServer();
    client = server.client;
  }, 90000);

  afterAll(async () => {
    await server?.close();
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
      !server.serverStderr.includes("Agent host attribution: vscode") &&
      Date.now() < deadline
    ) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    }
    expect(server.serverStderr).toContain(
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
