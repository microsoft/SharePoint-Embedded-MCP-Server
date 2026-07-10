// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Unit tests for project_hydrate_config azure.yaml emission.
 *
 * The bug: hydrate emitted a constant azure.yaml (name spe-app, language ts,
 * host staticwebapp), clobbering a C# (containerapp) scaffold — flipping the host
 * and renaming the service. These assert hydrate derives the descriptor from
 * the recorded scaffold architecture + projectName and won't destructively
 * overwrite an architecture-correct file.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const stateStore: Record<string, unknown> = {};
vi.mock("../state.js", () => ({
  readState: vi.fn(() => ({ ...stateStore })),
  writeState: vi.fn((patch: Record<string, unknown>) => {
    Object.assign(stateStore, patch);
    return { ...stateStore };
  }),
}));

import { hydrateConfigTool } from "../tools/hydrate-config.js";

const here = dirname(fileURLToPath(import.meta.url));
let dir: string;

beforeEach(() => {
  for (const k of Object.keys(stateStore)) delete stateStore[k];
  // Minimum state required for hydrate to run.
  stateStore.appId = "app-1";
  stateStore.containerTypeId = "ct-1";
  stateStore.tenantId = "t-1";
  dir = join(here, `__hydrate_tmp_${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("project_hydrate_config azure.yaml", () => {
  it("emits a Container Apps descriptor for a C# scaffold (correct host + name)", async () => {
    stateStore.scaffoldArchitecture = "csharp-web";
    stateStore.projectName = "contoso-web";

    const result = await hydrateConfigTool.handler({ targetDir: dir, formats: ["azureyaml"] });
    expect(result.isError).toBeFalsy();

    const yaml = readFileSync(join(dir, "azure.yaml"), "utf-8");
    expect(yaml).toContain("name: contoso-web");
    expect(yaml).toContain("language: dotnet");
    expect(yaml).toContain("host: containerapp");
    expect(yaml).not.toContain("host: staticwebapp");
  });

  it("emits a Static Web Apps descriptor for a React scaffold", async () => {
    stateStore.scaffoldArchitecture = "react-spa-functions";
    stateStore.projectName = "contoso-spa";

    await hydrateConfigTool.handler({ targetDir: dir, formats: ["azureyaml"] });

    const yaml = readFileSync(join(dir, "azure.yaml"), "utf-8");
    expect(yaml).toContain("name: contoso-spa");
    expect(yaml).toContain("language: ts");
    expect(yaml).toContain("host: staticwebapp");
    expect(yaml).not.toContain("host: appservice");
  });

  it("does NOT destructively overwrite an architecture-correct azure.yaml", async () => {
    stateStore.scaffoldArchitecture = "csharp-web";
    stateStore.projectName = "contoso-web";

    // Pre-existing correct (scaffolded) C# descriptor with extra custom content.
    const scaffolded =
      "name: contoso-web\nmetadata:\n  template: spe-builder-mcp\n" +
      "services:\n  web:\n    project: .\n    language: dotnet\n    host: containerapp\n# custom note\n";
    writeFileSync(join(dir, "azure.yaml"), scaffolded, "utf-8");

    const result = await hydrateConfigTool.handler({ targetDir: dir, formats: ["azureyaml"] });

    const yaml = readFileSync(join(dir, "azure.yaml"), "utf-8");
    expect(yaml).toBe(scaffolded); // untouched
    expect(result.content[0].text).toContain("kept existing");
  });

  it("merges only MISSING top-level keys into an existing azure.yaml, preserving custom content", async () => {
    // No scaffoldArchitecture recorded. The existing file already declares name
    // and services (with a custom host + a custom comment); hydrate must NOT
    // clobber any of it — it may only fill a missing top-level key (metadata).
    stateStore.projectName = "contoso-web";
    const preexisting =
      "name: contoso-web\nservices:\n  web:\n    host: appservice\n# custom note kept\n";
    writeFileSync(join(dir, "azure.yaml"), preexisting, "utf-8");

    const result = await hydrateConfigTool.handler({ targetDir: dir, formats: ["azureyaml"] });
    expect(result.isError).toBeFalsy();

    const yaml = readFileSync(join(dir, "azure.yaml"), "utf-8");
    // Custom/scaffold content survives verbatim.
    expect(yaml).toContain("name: contoso-web");
    expect(yaml).toContain("host: appservice"); // not flipped to staticwebapp
    expect(yaml).toContain("# custom note kept");
    // The missing managed top-level key is filled in.
    expect(yaml).toContain("metadata:");
    expect(result.content[0].text).toContain("merged; filled: metadata");
  });

  it("does NOT rewrite/clobber a stale azure.yaml — scaffold owns the architecture", async () => {
    stateStore.scaffoldArchitecture = "csharp-web";
    stateStore.projectName = "contoso-web";

    // A "stale" descriptor (old constant SWA output) plus user customization.
    // Previously hydrate clobbered this; now it must be preserved (only missing
    // top-level keys are filled), never overwritten.
    const preexisting =
      "name: spe-app\nservices:\n  web:\n    language: ts\n    host: staticwebapp\n# do not lose me\n";
    writeFileSync(join(dir, "azure.yaml"), preexisting, "utf-8");

    await hydrateConfigTool.handler({ targetDir: dir, formats: ["azureyaml"] });

    const yaml = readFileSync(join(dir, "azure.yaml"), "utf-8");
    // Existing values are preserved — not clobbered with the generated descriptor.
    expect(yaml).toContain("name: spe-app");
    expect(yaml).toContain("host: staticwebapp");
    expect(yaml).toContain("# do not lose me");
    // Only the missing top-level metadata key is added.
    expect(yaml).toContain("metadata:");
  });

  it("preserves the project name in the default (no architecture recorded)", async () => {
    stateStore.projectName = "just-a-name";

    await hydrateConfigTool.handler({ targetDir: dir, formats: ["azureyaml"] });

    const yaml = readFileSync(join(dir, "azure.yaml"), "utf-8");
    expect(yaml).toContain("name: just-a-name");
  });
});

describe("project_hydrate_config formats validation", () => {
  it("rejects an invalid format value with NO files written", async () => {
    const result = await hydrateConfigTool.handler({ targetDir: dir, formats: ["env", "bogus"] });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("invalid format(s): 'bogus'");
    expect(result.content[0].text).not.toContain("Config Hydrated");
    expect(existsSync(join(dir, ".env"))).toBe(false);
  });

  it("rejects an empty formats array instead of falsely reporting success", async () => {
    const result = await hydrateConfigTool.handler({ targetDir: dir, formats: [] });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("non-empty array");
    expect(result.content[0].text).not.toContain("Config Hydrated");
  });

  it("writes only the requested valid format", async () => {
    const result = await hydrateConfigTool.handler({ targetDir: dir, formats: ["env"] });

    expect(result.isError).toBeFalsy();
    expect(existsSync(join(dir, ".env"))).toBe(true);
    expect(existsSync(join(dir, "appsettings.Development.json"))).toBe(false);
    expect(result.content[0].text).toContain("Config Hydrated");
  });

  it("defaults to all three formats when omitted", async () => {
    const result = await hydrateConfigTool.handler({ targetDir: dir });

    expect(result.isError).toBeFalsy();
    expect(existsSync(join(dir, ".env"))).toBe(true);
    expect(existsSync(join(dir, "appsettings.Development.json"))).toBe(true);
    expect(existsSync(join(dir, "azure.yaml"))).toBe(true);
  });
});
