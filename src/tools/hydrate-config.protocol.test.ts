// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CALL_TIMEOUT_MS, startProtocolServer, type ProtocolServer } from "../../test/protocol-server.js";

describe("hydration over the MCP wire", () => {
  let server: ProtocolServer;
  beforeAll(async () => { server = await startProtocolServer(); }, 90000);
  afterAll(async () => { await server?.close(); });

  it("advertises the hydration purpose, supported formats, and optional arguments over tools/list", async () => {
    const { tools } = await server.client.listTools(undefined, { timeout: CALL_TIMEOUT_MS });
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
    const { client, isolatedHome } = server;
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
});
