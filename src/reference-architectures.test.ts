// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Unit tests for the reference-architecture catalog.
 *
 * The scaffolder sources REAL committed sample apps under `samples/<id>` (the
 * single source of truth — built, linted, and CVE-scanned in CI) and applies the
 * caller's project name. These tests assert the catalog reads those samples and
 * that the C# sample keeps the ODSP security-approved azd shape (managed identity
 * + federated credential, no secrets, least-privilege AcrPull, subscription-scoped
 * main.bicep) — coverage carried over from the former azd-template generator test.
 */

import { describe, it, expect } from "vitest";
import { findArchitecture, REFERENCE_ARCHITECTURES, buildAzureYaml } from "./reference-architectures.js";

describe("reference-architecture catalog", () => {
  it("exposes the two v1 stacks", () => {
    expect(REFERENCE_ARCHITECTURES.map((a) => a.id).sort()).toEqual(["csharp-web", "react-spa-functions"]);
  });
});

describe("react-spa-functions sample", () => {
  const files = findArchitecture("react-spa-functions")!.files("my-app");

  it("reads the committed React sample tree", () => {
    for (const path of ["package.json", "index.html", "vite.config.ts", "tsconfig.json", "src/main.tsx", "src/App.tsx"]) {
      expect(Object.keys(files)).toContain(path);
    }
  });

  it("applies the caller's project name and ships hardened deps", () => {
    const pkg = JSON.parse(files["package.json"]) as { name: string; overrides?: Record<string, string> };
    expect(pkg.name).toBe("my-app");
    // The sample ships Node 18-safe, 0-npm-audit deps (Vite 6 + esbuild override).
    expect(pkg.overrides?.esbuild).toMatch(/0\.25/);
  });

  it("regenerates azure.yaml for the staticwebapp host", () => {
    expect(files["azure.yaml"]).toContain("host: staticwebapp");
    expect(files["azure.yaml"]).toContain("name: my-app");
    expect(files["azure.yaml"]).toContain("dist: dist");
  });

  it("does not leak build outputs (node_modules/dist) into the scaffold", () => {
    expect(Object.keys(files).some((f) => f.includes("node_modules/") || f.startsWith("dist/"))).toBe(false);
  });
});

describe("csharp-web sample (ODSP security-approved azd)", () => {
  const arch = findArchitecture("csharp-web");
  const files = arch!.files("demo-app");

  it("targets Azure Container Apps with the full secure infra file set", () => {
    expect(arch?.host).toBe("containerapp");
    expect(arch?.language).toBe("dotnet");
    for (const path of [
      "Program.cs", "appsettings.json", "Dockerfile", ".dockerignore", "bicepconfig.json",
      "infra/main.bicep", "infra/main.parameters.json", "infra/abbreviations.json",
      "infra/shared/identity.bicep", "infra/shared/registry.bicep", "infra/shared/apps-env.bicep",
      "infra/modules/fetch-container-image.bicep", "infra/app/web.bicep",
    ]) {
      expect(Object.keys(files)).toContain(path);
    }
  });

  it("renames the .csproj to the project name", () => {
    expect(Object.keys(files).filter((f) => f.endsWith(".csproj"))).toEqual(["demo-app.csproj"]);
  });

  it("regenerates azure.yaml with the Dockerfile build", () => {
    const yaml = files["azure.yaml"];
    expect(yaml).toContain("host: containerapp");
    expect(yaml).toContain("docker:");
    expect(yaml).toContain("path: ./Dockerfile");
  });

  it("main.bicep is subscription-scoped and provisions its own resource group", () => {
    const main = files["infra/main.bicep"];
    expect(main).toContain("targetScope = 'subscription'");
    expect(main).toContain("resource rg 'Microsoft.Resources/resourceGroups");
    expect(main).toContain("name: 'rg-${environmentName}'");
    expect(main).toContain("module identity './shared/identity.bicep'");
    expect(main).toContain("module web './app/web.bicep'");
    expect(main).toContain("loadJsonContent('./abbreviations.json')");
  });

  it("app/web.bicep uses a managed identity federated to the Entra app (no secret)", () => {
    const web = files["infra/app/web.bicep"];
    expect(web).toContain("Microsoft.ManagedIdentity/userAssignedIdentities");
    expect(web).toContain("type: 'UserAssigned'");
    expect(web).toContain("Microsoft.Graph/applications@v1.0");
    expect(web).toContain("federatedIdentityCredentials@v1.0");
    expect(web).toContain("SignedAssertionFromManagedIdentity");
    expect(web).toContain("085ca537-6565-41c2-aca7-db852babc212"); // FileStorageContainer.Selected
    expect(web).toContain("'azd-service-name': 'web'");
  });

  it("grants only least-privilege AcrPull via RBAC (ServicePrincipal)", () => {
    const web = files["infra/app/web.bicep"];
    expect(web).toContain("Microsoft.Authorization/roleAssignments");
    expect(web).toContain("7f951dda-4ed3-4680-a7ca-43fe172d538d"); // AcrPull role definition id
    expect(web).toContain("principalType: 'ServicePrincipal'");
  });

  it("contains no client secrets or registry admin credentials", () => {
    const blob = Object.values(files).join("\n").toLowerCase();
    expect(blob).not.toContain("clientsecret");
    expect(blob).not.toContain("client_secret");
    expect(blob).not.toContain('"password"');
    expect(files["infra/shared/registry.bicep"]).toContain("adminUserEnabled bool = false");
  });

  it("Dockerfile + csproj agree on the published assembly name (app.dll)", () => {
    expect(files["Dockerfile"]).toContain('ENTRYPOINT ["dotnet", "app.dll"]');
    expect(files["demo-app.csproj"]).toContain("<AssemblyName>app</AssemblyName>");
  });

  it("main.parameters.json wires the azd substitution tokens", () => {
    const params = files["infra/main.parameters.json"];
    expect(params).toContain("${AZURE_ENV_NAME}");
    expect(params).toContain("${AZURE_LOCATION}");
    expect(params).toContain("${AZURE_PRINCIPAL_ID}");
    expect(() => JSON.parse(params)).not.toThrow();
  });
});

describe("buildAzureYaml", () => {
  it("emits a docker build section for the containerapp host", () => {
    expect(buildAzureYaml("x", "dotnet", "containerapp")).toContain("path: ./Dockerfile");
  });
  it("emits a dist output for the staticwebapp host", () => {
    expect(buildAzureYaml("x", "js", "staticwebapp")).toContain("dist: dist");
  });
});
