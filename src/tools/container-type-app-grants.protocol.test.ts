// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CALL_TIMEOUT_MS, startProtocolServer, type ProtocolServer } from "../../test/protocol-server.js";

describe("container-type app grants over the MCP wire", () => {
  let server: ProtocolServer;
  beforeAll(async () => { server = await startProtocolServer(); }, 90000);
  afterAll(async () => { await server?.close(); });

  it("publishes a concise add description with grant semantics and defaults", async () => {
    const { tools } = await server.client.listTools(undefined, { timeout: CALL_TIMEOUT_MS });
    const tool = tools.find((entry) => entry.name === "container_type_registration_app_grant_add");
    expect(tool).toBeDefined();
    const description = tool?.description ?? "";
    expect(description.length).toBeGreaterThanOrEqual(10);
    expect(description.length).toBeLessThanOrEqual(500);
    expect(description.trim().replace(/\s+/g, " ").length).toBeLessThanOrEqual(500);
    expect(description).toContain("SharePoint Embedded container type registration (Microsoft Graph v1.0)");
    expect(description).toContain("delegated/application");
    expect(description).toContain("Idempotent upsert");
    expect(description).toContain("same appId's permissions are overwritten");
    expect(description).toContain("other grants are preserved");
    expect(description).toContain("container_type_register, which replaces all grants");
    expect(description).toContain("provisioned container type and owning appId");
    expect(description).toContain("delegated `full`");
    expect(description).toContain("application (app-only) `none` (opt-in)");
  });

  it("discovers registration-scoped app-grant tools without legacy aliases", async () => {
    const { tools } = await server.client.listTools(undefined, { timeout: CALL_TIMEOUT_MS });
    const names = tools.map((tool) => tool.name);
    for (const [name, required] of [
      ["container_type_registration_app_grant_add", []],
      ["container_type_registration_app_grants_list", []],
      ["container_type_registration_app_grant_remove", ["appId"]],
    ] as const) {
      expect(names.filter((entry) => entry === name)).toHaveLength(1);
      const tool = tools.find((entry) => entry.name === name);
      expect(tool?.description).toContain("container type registration");
      expect(tool?.description).toContain("Microsoft Graph v1.0");
      expect(tool?.inputSchema.required ?? []).toEqual(required);
    }
    expect(tools.find((tool) => tool.name === "container_type_registration_app_grants_list")?.annotations?.readOnlyHint).toBe(true);
    expect(tools.find((tool) => tool.name === "container_type_registration_app_grant_remove")?.annotations?.destructiveHint).toBe(true);
    for (const name of [
      "container_type_app_grant_add",
      "container_type_app_grants_list",
      "container_type_app_grant_remove",
    ]) {
      expect(names).not.toContain(name);
    }
  });

  it.each([
    "container_type_registration_app_grant_add",
    "container_type_registration_app_grants_list",
    "container_type_registration_app_grant_remove",
  ])("dispatches %s to its handler offline with no provisioning state", async (name) => {
    const result = await server.client.callTool(
      { name, arguments: { appId: "app-test" } },
      undefined,
      { timeout: CALL_TIMEOUT_MS },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      { type: "text", text: "Error: no containerTypeId provided and none in provisioning state." },
    ]);
  });

  it.each([
    "container_type_app_grant_add",
    "container_type_app_grants_list",
    "container_type_app_grant_remove",
  ])("returns the existing UNKNOWN_TOOL response for removed name %s", async (name) => {
    const result = await server.client.callTool(
      { name, arguments: { appId: "app-test" } },
      undefined,
      { timeout: CALL_TIMEOUT_MS },
    );
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      ok: false,
      error: { code: "UNKNOWN_TOOL", message: `Unknown tool: ${name}` },
      durationMs: expect.any(Number),
    });
    expect(result.content).toContainEqual({ type: "text", text: `Error: Unknown tool: ${name}` });
  });
});
