// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Unit tests for project_hydrate_config output allowlisting and azure.yaml emission.
 *
 * The bug: hydrate emitted a constant azure.yaml (name spe-app, language ts,
 * host staticwebapp), clobbering a C# (containerapp) scaffold — flipping the host
 * and renaming the service. These assert hydrate derives the descriptor from
 * the recorded scaffold architecture + projectName and won't destructively
 * overwrite an architecture-correct file.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
import { scaffoldTool } from "../tools/scaffold.js";
import { writeState } from "../state.js";

const here = dirname(fileURLToPath(import.meta.url));
let dir: string;

beforeEach(() => {
  vi.clearAllMocks();
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

const invalidNames = [
  "", "a".repeat(65), " app", "app ", "a\n", "a\r\nb", "a\tb", "a\0b",
  'a"b', "a'b", "a: b", "---", "...", "&name", "*name", "{name}",
  null, 123, false, {}, [],
];

describe("project-name validation before filesystem or state changes", () => {
  it.each(invalidNames)("rejects direct scaffold input (%p) for both architectures", async (projectName) => {
    for (const architecture of ["react-spa-functions", "csharp-web"]) {
      const targetDir = join(dir, architecture);
      const before = { ...stateStore };
      const result = await scaffoldTool.handler({ architecture, targetDir, projectName });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("projectName must be");
      expect(existsSync(targetDir)).toBe(false);
      expect(stateStore).toEqual(before);
      expect(writeState).not.toHaveBeenCalled();
    }
  });

  it.each(["react-spa-functions", "csharp-web"])(
    "scaffolds %s with the exact accepted name and persists it",
    async (architecture) => {
      const result = await scaffoldTool.handler({ architecture, targetDir: dir, projectName: "true" });
      expect(result.isError).toBeFalsy();
      expect(readFileSync(join(dir, "azure.yaml"), "utf-8")).toContain('name: "true"\n');
      expect(writeState).toHaveBeenCalledWith({ scaffoldArchitecture: architecture, projectName: "true" });
    },
  );

  it.each(invalidNames)("rejects malformed legacy state (%p) without partial hydration", async (projectName) => {
    for (const scaffoldArchitecture of [undefined, "react-spa-functions", "csharp-web"]) {
      for (const existing of [false, true]) {
        Object.assign(stateStore, { scaffoldArchitecture, projectName });
        const targetDir = join(dir, `${scaffoldArchitecture ?? "fallback"}-${existing}`);
        const originalYaml = "name: owner-name\nservices:\n  web:\n    host: appservice\n";
        if (existing) {
          mkdirSync(targetDir);
          writeFileSync(join(targetDir, "azure.yaml"), originalYaml);
          writeFileSync(join(targetDir, ".env"), "owner env\n");
          writeFileSync(join(targetDir, "appsettings.Development.json"), "{}\n");
        }
        const before = { ...stateStore };
        const result = await hydrateConfigTool.handler({ targetDir });
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain("projectName must be");
        expect(result.content[0].text).not.toContain("Config Hydrated");
        if (existing) {
          expect(readFileSync(join(targetDir, "azure.yaml"), "utf-8")).toBe(originalYaml);
          expect(readFileSync(join(targetDir, ".env"), "utf-8")).toBe("owner env\n");
          expect(readFileSync(join(targetDir, "appsettings.Development.json"), "utf-8")).toBe("{}\n");
        } else {
          expect(existsSync(targetDir)).toBe(false);
        }
        expect(stateStore).toEqual(before);
        expect(writeState).not.toHaveBeenCalled();
      }
    }
  });

  it("precomputes the YAML merge before writing any selected output", async () => {
    mkdirSync(join(dir, "azure.yaml"));
    const result = await hydrateConfigTool.handler({ targetDir: dir });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Error hydrating config:");
    expect(readdirSync(dir)).toEqual(["azure.yaml"]);
  });

  it("rejects malformed saved names even for an env-only request", async () => {
    stateStore.projectName = "a\n";
    const result = await hydrateConfigTool.handler({ targetDir: dir, formats: ["env"] });
    expect(result.isError).toBe(true);
    expect(readdirSync(dir)).toEqual([]);
  });

  it.each([undefined, "react-spa-functions", "csharp-web"])(
    "fills missing managed blocks without adding hooks or replacing owner content (%p)",
    async (scaffoldArchitecture) => {
      Object.assign(stateStore, { scaffoldArchitecture, projectName: "null" });
      for (const hooks of ["", "hooks:\n  predeploy:\n    shell: sh\n    run: echo owner-note\n"]) {
        const original = "name: owner-name\nx-owner: keep\n" + hooks;
        writeFileSync(join(dir, "azure.yaml"), original);
        const result = await hydrateConfigTool.handler({ targetDir: dir, formats: ["azureyaml"] });
        expect(result.isError).toBeFalsy();
        const yaml = readFileSync(join(dir, "azure.yaml"), "utf-8");
        expect(yaml.startsWith(original)).toBe(true);
        expect(yaml.match(/^name:/gm)).toHaveLength(1);
        expect(yaml.match(/^hooks:/gm) ?? []).toHaveLength(hooks ? 1 : 0);
        expect(yaml).toContain(`host: ${scaffoldArchitecture === "csharp-web" ? "containerapp" : "staticwebapp"}`);
        expect(result.content[0].text).toContain("merged; filled: metadata, services");
        const again = await hydrateConfigTool.handler({ targetDir: dir, formats: ["azureyaml"] });
        expect(again.isError).toBeFalsy();
        expect(readFileSync(join(dir, "azure.yaml"), "utf-8")).toBe(yaml);
      }
    },
  );
});

describe("project_hydrate_config output contract", () => {
  it("writes only supported configuration and excludes unrelated persisted state from files and results", async () => {
    const unrelatedState = {
      appObjectId: "sentinel-app-object-id",
      appDisplayName: "sentinel-app-display-name",
      containerTypeName: "sentinel-container-type-name",
      syntexAccountResourceId: "sentinel-syntex-account-resource-id",
      containerName: "sentinel-container-name",
      confirmedSessionId: "sentinel-confirmed-session-id",
      contextConfirmedAt: "sentinel-context-confirmed-at",
      clientSecret: "sentinel-client-secret",
      accessToken: "sentinel-access-token",
      refreshToken: "sentinel-refresh-token",
      tokenCache: { credential: "sentinel-nested-token-cache" },
    };
    Object.assign(stateStore, unrelatedState, {
      tenantId: "tenant-allowed",
      appId: "client-allowed",
      containerTypeId: "container-type-allowed",
      containerId: "container-allowed",
      azureSubscriptionId: "subscription-allowed",
      resourceGroup: "resource-group-allowed",
      scaffoldArchitecture: "csharp-web",
      projectName: "contoso-config",
      contentAccessGranted: true,
      owningAppManagesAllContainerTypes: true,
      ownerScope: "manage-all",
      billingClassification: "standard",
    });

    const result = await hydrateConfigTool.handler({ targetDir: dir });

    expect(result.isError).toBeFalsy();
    expect(readdirSync(dir).sort()).toEqual([".env", "appsettings.Development.json", "azure.yaml"]);
    const env = readFileSync(join(dir, ".env"), "utf-8");
    expect(env.split("\n").filter((line) => line && !line.startsWith("#"))).toEqual([
      "TENANT_ID=tenant-allowed",
      "CLIENT_ID=client-allowed",
      "CONTAINER_TYPE_ID=container-type-allowed",
      "CONTAINER_ID=container-allowed",
      "VITE_TENANT_ID=tenant-allowed",
      "VITE_CLIENT_ID=client-allowed",
      "VITE_CONTAINER_TYPE_ID=container-type-allowed",
      "VITE_CONTAINER_ID=container-allowed",
      "AZURE_SUBSCRIPTION_ID=subscription-allowed",
      "AZURE_RESOURCE_GROUP=resource-group-allowed",
    ]);
    const settings = readFileSync(join(dir, "appsettings.Development.json"), "utf-8");
    expect(JSON.parse(settings)).toEqual({
      SharePointEmbedded: {
        TenantId: "tenant-allowed",
        ClientId: "client-allowed",
        ContainerTypeId: "container-type-allowed",
        ContainerId: "container-allowed",
      },
    });
    const yaml = readFileSync(join(dir, "azure.yaml"), "utf-8");
    expect(yaml).toBe(
      "# yaml-language-server: $schema=https://raw.githubusercontent.com/Azure/azure-dev/main/schemas/v1.0/azure.yaml.json\n" +
      'name: "contoso-config"\nmetadata:\n  template: spe-builder-mcp\n' +
      "services:\n  web:\n    project: .\n    language: dotnet\n    host: containerapp\n" +
      "    docker:\n      path: ./Dockerfile\n",
    );
    expect(result.content).toEqual([{
      type: "text",
      text:
        "## Config Hydrated\n\n" +
        `Wrote 3 file(s) to \`${dir}\`:\n\n` +
        "- `.env`\n- `appsettings.Development.json`\n- `azure.yaml`\n\n" +
        "| Key | Value |\n|-----|-------|\n" +
        "| TENANT_ID | `tenant-allowed` |\n" +
        "| CLIENT_ID | `client-allowed` |\n" +
        "| CONTAINER_TYPE_ID | `container-type-allowed` |\n" +
        "| CONTAINER_ID | `container-allowed` |\n",
    }]);
    const emitted = [env, settings, yaml, JSON.stringify(result)].join("\n");
    for (const [key, value] of Object.entries(unrelatedState)) {
      expect(emitted).not.toContain(key);
      expect(emitted).not.toContain(typeof value === "string" ? value : value.credential);
    }
  });

  it.each([
    { azureSubscriptionId: undefined, resourceGroup: undefined },
    { azureSubscriptionId: "", resourceGroup: "" },
    { azureSubscriptionId: "subscription-only", resourceGroup: undefined },
    { azureSubscriptionId: undefined, resourceGroup: "resource-group-only" },
  ])("preserves optional provisioning values: %j", async (optionalState) => {
    delete stateStore.tenantId;
    Object.assign(stateStore, optionalState);

    const result = await hydrateConfigTool.handler({ targetDir: dir });

    expect(result.isError).toBeFalsy();
    const assignments = [
      "TENANT_ID=",
      "CLIENT_ID=app-1",
      "CONTAINER_TYPE_ID=ct-1",
      "CONTAINER_ID=",
      "VITE_TENANT_ID=",
      "VITE_CLIENT_ID=app-1",
      "VITE_CONTAINER_TYPE_ID=ct-1",
      "VITE_CONTAINER_ID=",
    ];
    if (optionalState.azureSubscriptionId) {
      assignments.push(`AZURE_SUBSCRIPTION_ID=${optionalState.azureSubscriptionId}`);
    }
    if (optionalState.resourceGroup) {
      assignments.push(`AZURE_RESOURCE_GROUP=${optionalState.resourceGroup}`);
    }
    expect(readFileSync(join(dir, ".env"), "utf-8")
      .split("\n").filter((line) => line && !line.startsWith("#"))).toEqual(assignments);
    expect(JSON.parse(readFileSync(join(dir, "appsettings.Development.json"), "utf-8"))).toEqual({
      SharePointEmbedded: {
        TenantId: "",
        ClientId: "app-1",
        ContainerTypeId: "ct-1",
        ContainerId: "",
      },
    });
    expect(readFileSync(join(dir, "azure.yaml"), "utf-8")).toBe(
      "# yaml-language-server: $schema=https://raw.githubusercontent.com/Azure/azure-dev/main/schemas/v1.0/azure.yaml.json\n" +
      'name: "spe-app"\nmetadata:\n  template: spe-builder-mcp\n' +
      "services:\n  web:\n    project: .\n    language: ts\n    host: staticwebapp\n    dist: dist\n",
    );
    expect(result.content[0].text).toContain("| CONTAINER_ID | `(pending)` |");
  });
});

describe("project_hydrate_config azure.yaml", () => {
  it("emits a Container Apps descriptor for a C# scaffold (correct host + name)", async () => {
    stateStore.scaffoldArchitecture = "csharp-web";
    stateStore.projectName = "contoso-web";

    const result = await hydrateConfigTool.handler({ targetDir: dir, formats: ["azureyaml"] });
    expect(result.isError).toBeFalsy();

    const yaml = readFileSync(join(dir, "azure.yaml"), "utf-8");
    expect(yaml).toContain('name: "contoso-web"');
    expect(yaml).toContain("language: dotnet");
    expect(yaml).toContain("host: containerapp");
    expect(yaml).not.toContain("host: staticwebapp");
  });

  it("emits a Static Web Apps descriptor for a React scaffold", async () => {
    stateStore.scaffoldArchitecture = "react-spa-functions";
    stateStore.projectName = "contoso-spa";

    await hydrateConfigTool.handler({ targetDir: dir, formats: ["azureyaml"] });

    const yaml = readFileSync(join(dir, "azure.yaml"), "utf-8");
    expect(yaml).toContain('name: "contoso-spa"');
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
    expect(yaml).toContain('name: "just-a-name"');
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

  it.each([
    ["env", ".env"],
    ["appsettings", "appsettings.Development.json"],
    ["azureyaml", "azure.yaml"],
  ])("writes only the requested %s format", async (format, filename) => {
    const result = await hydrateConfigTool.handler({ targetDir: dir, formats: [format] });

    expect(result.isError).toBeFalsy();
    expect(readdirSync(dir)).toEqual([filename]);
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
