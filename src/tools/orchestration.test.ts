// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Unit tests for Phase 2/3/5 tools: provision orchestrator, scaffold, hydrate
 * config, content access, and cleanup. External effects (Graph, az, MSAL, fs)
 * are mocked so these run offline.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── Mocks ────────────────────────────────────────────────────────────────────
vi.mock("../graph-client.js", () => ({
  findApplicationByName: vi.fn(),
  findApplicationByAppId: vi.fn(),
  createApplication: vi.fn(),
  addSpePermissions: vi.fn(),
  createContainerType: vi.fn(),
  listContainerTypes: vi.fn(async () => []),
  registerContainerType: vi.fn(),
  createContainer: vi.fn(),
  activateContainer: vi.fn(),
  deleteContainerType: vi.fn(),
  deleteContainerTypeRegistration: vi.fn(),
  listContainers: vi.fn(async () => []),
  listDeletedContainers: vi.fn(async () => []),
  deleteApplication: vi.fn(),
  getSignedInUser: vi.fn(async () => ({ id: "user-1", userPrincipalName: "admin@x.com" })),
  grantContainerTypeOwner: vi.fn(async () => ({ id: "perm-1", roles: ["owner"] })),
}));
vi.mock("../bootstrap.js", () => ({
  bootstrapTokenProvider: vi.fn(async () => "boot"),
  getSignedInIdentity: vi.fn(async () => ({ tenantId: "t-1", username: "dev@x.com" })),
}));
vi.mock("../azure-cli.js", () => ({
  ensureSyntexProviderRegistered: vi.fn(async () => ({ namespace: "Microsoft.Syntex", registrationState: "Registered" })),
  createSyntexAccount: vi.fn(async () => "/subscriptions/sub-1/resourceGroups/rg-1/providers/Microsoft.Syntex/accounts/acc-1"),
  getSyntexAccounts: vi.fn(async () => []),
}));
vi.mock("../auth.js", () => ({ setAuthConfig: vi.fn() }));

const stateStore: Record<string, unknown> = {};
vi.mock("../state.js", () => ({
  readState: vi.fn(() => ({ ...stateStore })),
  writeState: vi.fn((p: Record<string, unknown>) => { Object.assign(stateStore, p); return { ...stateStore }; }),
  clearState: vi.fn(() => { for (const k of Object.keys(stateStore)) delete stateStore[k]; }),
}));

import * as graph from "../graph-client.js";
import * as azureCli from "../azure-cli.js";
import { provisionTool } from "../tools/provision.js";
import { scaffoldTool } from "../tools/scaffold.js";
import { hydrateConfigTool } from "../tools/hydrate-config.js";
import { grantContentAccessTool, revokeContentAccessTool, isContentAccessGranted } from "../tools/content-access.js";
import { cleanupTool } from "../tools/cleanup.js";

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of Object.keys(stateStore)) delete stateStore[k];
});

// ── project_provision ─────────────────────────────────────────────────────────────

describe("project_provision", () => {
  it("elicits billing model when not provided", async () => {
    const r = await provisionTool.handler({ appDisplayName: "App" });
    expect(r.content[0].text).toContain("billing model");
    expect(graph.createApplication).not.toHaveBeenCalled();
  });

  it("asks for subscription/RG when standard billing lacks them", async () => {
    const r = await provisionTool.handler({ appDisplayName: "App", billingClassification: "standard" });
    expect(r.content[0].text).toContain("azure_subscriptions_list");
    expect(graph.createApplication).not.toHaveBeenCalled();
  });

  it("runs the full trial chain: app → CT → register → container", async () => {
    vi.mocked(graph.findApplicationByName).mockResolvedValue(null);
    vi.mocked(graph.createApplication).mockResolvedValue({ appId: "app-1", objectId: "obj-1", displayName: "App" });
    vi.mocked(graph.createContainerType).mockResolvedValue({ containerTypeId: "ct-1", owningAppId: "app-1", displayName: "App Container Type" });
    vi.mocked(graph.createContainer).mockResolvedValue({ id: "c-1", displayName: "Default Container", containerTypeId: "ct-1", status: "inactive" });

    const r = await provisionTool.handler({ appDisplayName: "App", billingClassification: "trial" });

    expect(graph.createApplication).toHaveBeenCalled();
    expect(graph.createContainerType).toHaveBeenCalled();
    expect(graph.registerContainerType).toHaveBeenCalledWith("ct-1", "app-1");
    expect(graph.grantContainerTypeOwner).toHaveBeenCalledWith("ct-1", "user-1");
    expect(graph.createContainer).toHaveBeenCalledWith("ct-1", "Default Container");
    expect(graph.activateContainer).toHaveBeenCalledWith("c-1");
    expect(r.content[0].text).toContain("SPE Provisioned");
    expect(r.content[0].text).toContain("app-1");
    expect(stateStore.containerId).toBe("c-1");
  });

  it("runs the standard chain: app -> CT(standard) -> RP -> Syntex account -> register -> container", async () => {
    vi.mocked(graph.findApplicationByName).mockResolvedValue(null);
    vi.mocked(graph.createApplication).mockResolvedValue({ appId: "app-1", objectId: "obj-1", displayName: "App" });
    vi.mocked(graph.createContainerType).mockResolvedValue({ containerTypeId: "ct-1", owningAppId: "app-1", displayName: "App Container Type", billingClassification: "standard" });
    vi.mocked(graph.createContainer).mockResolvedValue({ id: "c-1", displayName: "Default Container", containerTypeId: "ct-1", status: "active" });

    const r = await provisionTool.handler({ appDisplayName: "App", billingClassification: "standard", azureSubscriptionId: "sub-1", resourceGroup: "rg-1", region: "eastus" });

    expect(azureCli.ensureSyntexProviderRegistered).toHaveBeenCalledWith("sub-1");
    expect(azureCli.createSyntexAccount).toHaveBeenCalledWith("sub-1", "rg-1", "eastus", "ct-1");
    expect(graph.registerContainerType).toHaveBeenCalledWith("ct-1", "app-1");
    expect(r.content[0].text).toContain("SPE Provisioned");
    expect(stateStore.syntexAccountResourceId).toBe("/subscriptions/sub-1/resourceGroups/rg-1/providers/Microsoft.Syntex/accounts/acc-1");
  });

  it("rolls back a just-created standard CT when the Syntex billing account fails", async () => {
    vi.mocked(graph.findApplicationByName).mockResolvedValue(null);
    vi.mocked(graph.createApplication).mockResolvedValue({ appId: "app-1", objectId: "obj-1", displayName: "App" });
    vi.mocked(graph.createContainerType).mockResolvedValue({ containerTypeId: "ct-1", owningAppId: "app-1", displayName: "App Container Type", billingClassification: "standard" });
    vi.mocked(azureCli.createSyntexAccount).mockRejectedValueOnce(new Error("ARM 409"));

    const r = await provisionTool.handler({ appDisplayName: "App", billingClassification: "standard", azureSubscriptionId: "sub-1", resourceGroup: "rg-1", region: "eastus" });

    expect(graph.deleteContainerType).toHaveBeenCalledWith("ct-1");
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("rolled back");
    expect(graph.registerContainerType).not.toHaveBeenCalled();
  });

  it("asks before reusing a remembered app (no appDisplayName/appSelection)", async () => {
    stateStore.appId = "remembered-app";
    stateStore.appDisplayName = "Remembered App";

    const r = await provisionTool.handler({ billingClassification: "trial" });

    // The app gate precedes app resolution and billing — it just asks.
    expect(r.content[0].text).toContain("Reuse");
    expect(r.content[0].text).toContain("appSelection=reuse");
    expect(graph.findApplicationByAppId).not.toHaveBeenCalled();
    expect(graph.createApplication).not.toHaveBeenCalled();
  });

  it("reuses the remembered app when appSelection='reuse'", async () => {
    stateStore.appId = "remembered-app";
    stateStore.appDisplayName = "Remembered App";
    vi.mocked(graph.findApplicationByAppId).mockResolvedValue({ appId: "remembered-app", objectId: "obj-r", displayName: "Remembered App" });
    vi.mocked(graph.createContainerType).mockResolvedValue({ containerTypeId: "ct-1", owningAppId: "remembered-app", displayName: "Remembered App Container Type" });
    vi.mocked(graph.createContainer).mockResolvedValue({ id: "c-1", displayName: "Default Container", containerTypeId: "ct-1", status: "active" });

    const r = await provisionTool.handler({ billingClassification: "trial", appSelection: "reuse" });

    expect(graph.findApplicationByAppId).toHaveBeenCalledWith("remembered-app", expect.any(Function));
    expect(graph.findApplicationByName).not.toHaveBeenCalled();
    expect(graph.createApplication).not.toHaveBeenCalled();
    expect(r.content[0].text).toContain("Reused owning app");
    expect(r.content[0].text).toContain("SPE Provisioned");
  });
});

// ── project_scaffold ──────────────────────────────────────────────────────────────

describe("project_scaffold", () => {
  it("lists architectures when none chosen", async () => {
    const r = await scaffoldTool.handler({});
    expect(r.content[0].text).toContain("Which reference architecture");
    expect(r.content[0].text).toContain("react-spa-functions");
  });

  it("materializes the chosen architecture to disk", async () => {
    const dir = mkdtempSync(join(tmpdir(), "spe-scaffold-"));
    try {
      const r = await scaffoldTool.handler({ architecture: "react-spa-functions", targetDir: dir, projectName: "demo" });
      expect(r.isError).toBeFalsy();
      expect(existsSync(join(dir, "package.json"))).toBe(true);
      expect(existsSync(join(dir, "azure.yaml"))).toBe(true);
      expect(existsSync(join(dir, "infra/main.bicep"))).toBe(true);
      // The SPA can create containers (owning-app PCA) via the beta endpoint.
      const appTsx = readFileSync(join(dir, "src/App.tsx"), "utf-8");
      expect(appTsx).toContain("Create container");
      expect(appTsx).toContain("graph.microsoft.com/beta");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("errors on unknown architecture", async () => {
    const r = await scaffoldTool.handler({ architecture: "nope" });
    expect(r.isError).toBe(true);
  });
});

// ── project_hydrate_config ────────────────────────────────────────────────────────

describe("project_hydrate_config", () => {
  it("writes .env with provisioning state", async () => {
    Object.assign(stateStore, { tenantId: "t-1", appId: "app-1", containerTypeId: "ct-1", containerId: "c-1" });
    const dir = mkdtempSync(join(tmpdir(), "spe-hydrate-"));
    try {
      const r = await hydrateConfigTool.handler({ targetDir: dir, formats: ["env"] });
      expect(r.isError).toBeFalsy();
      const env = readFileSync(join(dir, ".env"), "utf-8");
      expect(env).toContain("CLIENT_ID=app-1");
      expect(env).toContain("CONTAINER_TYPE_ID=ct-1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("errors when nothing is provisioned", async () => {
    const r = await hydrateConfigTool.handler({});
    expect(r.isError).toBe(true);
  });
});

// ── content access ────────────────────────────────────────────────────────────

describe("content access", () => {
  it("requires confirmation before granting", async () => {
    const r = await grantContentAccessTool.handler({});
    expect(r.content[0].text).toContain("Enable content access");
    expect(isContentAccessGranted()).toBe(false);
  });

  it("grants with confirm=true and revokes", async () => {
    await grantContentAccessTool.handler({ confirm: true });
    expect(isContentAccessGranted()).toBe(true);
    await revokeContentAccessTool.handler({});
    expect(isContentAccessGranted()).toBe(false);
  });
});

// ── project_cleanup ───────────────────────────────────────────────────────────────

describe("project_cleanup", () => {
  it("requires confirmation", async () => {
    Object.assign(stateStore, { appId: "app-1", appObjectId: "obj-1", containerTypeId: "ct-1", billingClassification: "trial" });
    const r = await cleanupTool.handler({});
    expect(r.content[0].text).toContain("Confirm cleanup");
    expect(graph.deleteContainerType).not.toHaveBeenCalled();
  });

  it("deletes a TRIAL container type + owning app with confirm=true", async () => {
    Object.assign(stateStore, { appId: "app-1", appObjectId: "obj-1", containerTypeId: "ct-1", billingClassification: "trial" });
    const r = await cleanupTool.handler({ confirm: true });
    // Registration is deleted before the container type (teardown order).
    expect(graph.deleteContainerTypeRegistration).toHaveBeenCalledWith("ct-1");
    expect(graph.deleteContainerType).toHaveBeenCalledWith("ct-1");
    expect(graph.deleteApplication).toHaveBeenCalledWith("obj-1", expect.any(Function));
    expect(r.content[0].text).toContain("Cleanup Complete");
  });

  it("PAUSES and preserves app + state when containers still block a trial container type", async () => {
    Object.assign(stateStore, { appId: "app-1", appObjectId: "obj-1", containerTypeId: "ct-1", billingClassification: "trial" });
    vi.mocked(graph.listContainers).mockResolvedValueOnce([{ id: "c-1" } as never]);
    const r = await cleanupTool.handler({ confirm: true });
    expect(graph.deleteContainerTypeRegistration).not.toHaveBeenCalled();
    expect(graph.deleteContainerType).not.toHaveBeenCalled();
    expect(graph.deleteApplication).not.toHaveBeenCalled(); // app preserved (shared with containers)
    expect(stateStore.containerTypeId).toBe("ct-1"); // state retained for resume
    expect(r.content[0].text).toContain("Cleanup Paused");
    expect(r.content[0].text).toContain("1 live container(s)");
  });

  it("PRESERVES a standard container type + owning app without the override", async () => {
    Object.assign(stateStore, { appId: "app-1", appObjectId: "obj-1", containerTypeId: "ct-1", billingClassification: "standard" });
    const r = await cleanupTool.handler({ confirm: true });
    expect(graph.deleteContainerType).not.toHaveBeenCalled();
    expect(graph.deleteApplication).not.toHaveBeenCalled();
    expect(r.content[0].text).toContain("protected container type");
    // state is retained (not cleared) so the resources remain tracked
    expect(stateStore.containerTypeId).toBe("ct-1");
  });

  it("treats an unknown/missing classification as protected (fail safe)", async () => {
    Object.assign(stateStore, { appId: "app-1", appObjectId: "obj-1", containerTypeId: "ct-1" });
    const r = await cleanupTool.handler({ confirm: true });
    expect(graph.deleteContainerType).not.toHaveBeenCalled();
    expect(graph.deleteApplication).not.toHaveBeenCalled();
    expect(r.content[0].text).toContain("protected");
  });

  it("deletes a standard container type only with the explicit deleteStandard override", async () => {
    Object.assign(stateStore, { appId: "app-1", appObjectId: "obj-1", containerTypeId: "ct-1", billingClassification: "standard" });
    const r = await cleanupTool.handler({ confirm: true, deleteStandard: true });
    expect(graph.deleteContainerType).toHaveBeenCalledWith("ct-1");
    expect(graph.deleteApplication).toHaveBeenCalledWith("obj-1", expect.any(Function));
    expect(r.content[0].text).toContain("Override");
  });

  it("preview warns (and does not delete) for a protected direct-to-customer container type", async () => {
    Object.assign(stateStore, { appId: "app-1", appObjectId: "obj-1", containerTypeId: "ct-1", billingClassification: "directToCustomer" });
    const r = await cleanupTool.handler({});
    expect(r.content[0].text).toContain("Protected");
    expect(r.content[0].text).toContain("deleteStandard=true");
    expect(graph.deleteContainerType).not.toHaveBeenCalled();
  });
});
