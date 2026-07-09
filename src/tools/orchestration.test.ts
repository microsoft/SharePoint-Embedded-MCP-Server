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
vi.mock("../azure-cli.js", async (importActual) => ({
  // Keep the REAL pure region helpers (isSyntexRegionSupported /
  // assertSyntexRegionSupported) so the pre-flight region validation runs for
  // real in tests; only the az-shelling functions are mocked.
  ...(await importActual<typeof import("../azure-cli.js")>()),
  ensureSyntexProviderRegistered: vi.fn(async () => ({ namespace: "Microsoft.Syntex", registrationState: "Registered" })),
  createSyntexAccount: vi.fn(async () => "/subscriptions/sub-1/resourceGroups/rg-1/providers/Microsoft.Syntex/accounts/acc-1"),
  getSyntexAccounts: vi.fn(async () => []),
  // Guided standard-billing sub/RG selection (PR #3 review) lists these inline;
  // default to empty and let each test set the shape it needs.
  listSubscriptions: vi.fn(async () => []),
  listResourceGroups: vi.fn(async () => []),
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
import * as bootstrap from "../bootstrap.js";
import { provisionTool } from "../tools/provision.js";
import { getSessionId } from "../session.js";
import { scaffoldTool } from "../tools/scaffold.js";
import { hydrateConfigTool } from "../tools/hydrate-config.js";
import { grantContentAccessTool, revokeContentAccessTool, isContentAccessGranted } from "../tools/content-access.js";
import { cleanupTool } from "../tools/cleanup.js";

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of Object.keys(stateStore)) delete stateStore[k];
  // Reset the guided sub/RG listings to their empty defaults each test —
  // vi.clearAllMocks() clears call history but NOT mockResolvedValue
  // implementations, so without this a prior test's shape would leak forward.
  vi.mocked(azureCli.listSubscriptions).mockResolvedValue([]);
  vi.mocked(azureCli.listResourceGroups).mockResolvedValue([]);
});

// ── project_provision ─────────────────────────────────────────────────────────────

describe("project_provision", () => {
  // Least-privilege intent (PR #3 review) is settled here so the ownerScope gate
  // is a resumable no-op for these end-to-end chains; the gate's own
  // elicit/persist behavior is covered separately in provision-prompt.test.ts.
  beforeEach(() => {
    stateStore.ownerScope = "selected";
  });

  it("elicits billing model when not provided", async () => {
    const r = await provisionTool.handler({ appDisplayName: "App" });
    expect(r.content[0].text).toContain("billing model");
    expect(graph.createApplication).not.toHaveBeenCalled();
  });

  it("guides subscription selection inline (fallback) when standard billing lacks a subscription", async () => {
    // PR #3 review: instead of punting to azure_subscriptions_list + a manual
    // re-invoke, the tool lists the subscriptions itself and (with >1) asks the
    // user to pick. No native elicitation is wired in tests, so elicitChoice
    // degrades to the agent-guided ask keyed on `azureSubscriptionId`.
    vi.mocked(azureCli.listSubscriptions).mockResolvedValue([
      { id: "sub-a", name: "Sub A", state: "Enabled" },
      { id: "sub-b", name: "Sub B", state: "Enabled" },
    ]);

    const r = await provisionTool.handler({ appDisplayName: "App", billingClassification: "standard" });

    // The tool ran the listing and surfaced a subscription choice (not the old
    // "run azure_subscriptions_list yourself" punt), and created nothing yet.
    expect(azureCli.listSubscriptions).toHaveBeenCalled();
    expect(r.content[0].text).toContain("azureSubscriptionId=sub-a");
    expect(r.content[0].text).toContain("azureSubscriptionId=sub-b");
    expect(r.content[0].text).not.toContain("azure_subscriptions_list");
    expect(graph.createApplication).not.toHaveBeenCalled();
  });

  it("guides resource-group selection inline (fallback) once a subscription is known", async () => {
    // With the subscription supplied, the tool lists resource groups WITHIN it
    // and asks the user to pick (agent-guided fallback keyed on `resourceGroup`).
    vi.mocked(azureCli.listResourceGroups).mockResolvedValue([
      { name: "rg-x", location: "eastus", id: "/subscriptions/sub-1/resourceGroups/rg-x" },
      { name: "rg-y", location: "westus", id: "/subscriptions/sub-1/resourceGroups/rg-y" },
    ]);

    const r = await provisionTool.handler({ appDisplayName: "App", billingClassification: "standard", azureSubscriptionId: "sub-1" });

    expect(azureCli.listResourceGroups).toHaveBeenCalledWith("sub-1");
    expect(r.content[0].text).toContain("resourceGroup=rg-x");
    expect(r.content[0].text).toContain("resourceGroup=rg-y");
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
    // Full-setup registers WITHOUT app-only permissions (exactly 2 args) — the
    // real registerContainerType then defaults applicationPermissions to ["none"]
    // (PR #3 review: least privilege; opt in to ["full"] only for daemon apps).
    expect(graph.registerContainerType).toHaveBeenCalledWith("ct-1", "app-1");
    expect(graph.grantContainerTypeOwner).toHaveBeenCalledWith("ct-1", "user-1");
    expect(graph.createContainer).toHaveBeenCalledWith("ct-1", "Default Container");
    expect(graph.activateContainer).toHaveBeenCalledWith("c-1");
    expect(r.content[0].text).toContain("SPE Provisioned");
    expect(r.content[0].text).toContain("app-1");
    expect(stateStore.containerId).toBe("c-1");
  });

  it("appends a NON-BLOCKING guest heads-up when signed in as a B2B guest — provisioning is NOT blocked (PR #3 review)", async () => {
    vi.mocked(bootstrap.getSignedInIdentity).mockResolvedValueOnce({
      tenantId: "t-1",
      username: "alice_corp.com#EXT#@resourcetenant.onmicrosoft.com",
    });
    vi.mocked(graph.findApplicationByName).mockResolvedValue(null);
    vi.mocked(graph.createApplication).mockResolvedValue({ appId: "app-1", objectId: "obj-1", displayName: "App" });
    vi.mocked(graph.createContainerType).mockResolvedValue({ containerTypeId: "ct-1", owningAppId: "app-1", displayName: "App Container Type" });
    vi.mocked(graph.createContainer).mockResolvedValue({ id: "c-1", displayName: "Default Container", containerTypeId: "ct-1", status: "inactive" });

    const r = await provisionTool.handler({ appDisplayName: "App", billingClassification: "trial" });

    // Not blocked: the full chain still runs and provisioning completes.
    expect(r.isError).toBeFalsy();
    expect(graph.createApplication).toHaveBeenCalled();
    expect(graph.createContainer).toHaveBeenCalledWith("ct-1", "Default Container");
    expect(r.content[0].text).toContain("SPE Provisioned");
    // The informational note is present.
    expect(r.content[0].text).toContain("guest (B2B)");
    expect(r.content[0].text).toContain("Heads-up");
  });

  it("does NOT append the guest note for a member identity", async () => {
    vi.mocked(graph.findApplicationByName).mockResolvedValue(null);
    vi.mocked(graph.createApplication).mockResolvedValue({ appId: "app-1", objectId: "obj-1", displayName: "App" });
    vi.mocked(graph.createContainerType).mockResolvedValue({ containerTypeId: "ct-1", owningAppId: "app-1", displayName: "App Container Type" });
    vi.mocked(graph.createContainer).mockResolvedValue({ id: "c-1", displayName: "Default Container", containerTypeId: "ct-1", status: "inactive" });

    // Default bootstrap mock signs in as the member `dev@x.com`.
    const r = await provisionTool.handler({ appDisplayName: "App", billingClassification: "trial" });

    expect(r.content[0].text).toContain("SPE Provisioned");
    expect(r.content[0].text).not.toContain("guest (B2B)");
    expect(r.content[0].text).not.toContain("Heads-up");
  });

  it("runs the standard chain: app -> CT(standard) -> RP -> Syntex account -> register -> container", async () => {
    vi.mocked(graph.findApplicationByName).mockResolvedValue(null);
    vi.mocked(graph.createApplication).mockResolvedValue({ appId: "app-1", objectId: "obj-1", displayName: "App" });
    vi.mocked(graph.createContainerType).mockResolvedValue({ containerTypeId: "ct-1", owningAppId: "app-1", displayName: "App Container Type", billingClassification: "standard" });
    vi.mocked(graph.createContainer).mockResolvedValue({ id: "c-1", displayName: "Default Container", containerTypeId: "ct-1", status: "active" });

    const r = await provisionTool.handler({ appDisplayName: "App", billingClassification: "standard", azureSubscriptionId: "sub-1", resourceGroup: "rg-1", region: "eastus", confirmBilling: true });

    expect(azureCli.ensureSyntexProviderRegistered).toHaveBeenCalledWith("sub-1");
    expect(azureCli.createSyntexAccount).toHaveBeenCalledWith("sub-1", "rg-1", "eastus", "ct-1");
    expect(graph.registerContainerType).toHaveBeenCalledWith("ct-1", "app-1");
    expect(r.content[0].text).toContain("SPE Provisioned");
    expect(stateStore.syntexAccountResourceId).toBe("/subscriptions/sub-1/resourceGroups/rg-1/providers/Microsoft.Syntex/accounts/acc-1");
  });

  // Financial-safety gate (per PR #3 review): standard billing must not create the
  // chargeable Microsoft.Syntex account without explicit confirmBilling=true.
  it("requires confirmBilling before the chargeable standard path — preview only, nothing created", async () => {
    vi.mocked(graph.findApplicationByName).mockResolvedValue(null);

    const r = await provisionTool.handler({ appDisplayName: "App", billingClassification: "standard", azureSubscriptionId: "sub-1", resourceGroup: "rg-1", region: "eastus" });

    expect(r.content[0].text).toContain("confirmBilling=true");
    expect(r.content[0].text).toContain("sub-1");
    // No owning app, container type, or billing account created without confirmation.
    expect(graph.createApplication).not.toHaveBeenCalled();
    expect(graph.createContainerType).not.toHaveBeenCalled();
    expect(azureCli.createSyntexAccount).not.toHaveBeenCalled();
  });

  it("skips the billing confirmation on a genuine same-target resume and creates NO new billing account", async () => {
    // A true resume: same remembered app + same subscription/RG, and a Syntex
    // account already exists for the reused container type.
    stateStore.appId = "app-1";
    stateStore.appDisplayName = "App";
    stateStore.azureSubscriptionId = "sub-1";
    stateStore.resourceGroup = "rg-1";
    stateStore.containerTypeId = "ct-1";
    stateStore.syntexAccountResourceId = "/subscriptions/sub-1/resourceGroups/rg-1/providers/Microsoft.Syntex/accounts/acc-1";
    stateStore.confirmedSessionId = getSessionId(); // context already confirmed → app gate does not fire
    vi.mocked(graph.findApplicationByName).mockResolvedValueOnce({ appId: "app-1", objectId: "obj-1", displayName: "App" });
    vi.mocked(graph.listContainerTypes).mockResolvedValueOnce([{ containerTypeId: "ct-1", owningAppId: "app-1", displayName: "App Container Type", billingClassification: "standard" }]);
    vi.mocked(azureCli.getSyntexAccounts).mockResolvedValueOnce([
      { id: "/subscriptions/sub-1/resourceGroups/rg-1/providers/Microsoft.Syntex/accounts/acc-1", properties: { identityId: "ct-1", provisioningState: "Succeeded" } },
    ]);
    vi.mocked(graph.createContainer).mockResolvedValueOnce({ id: "c-1", displayName: "Default Container", containerTypeId: "ct-1", status: "active" });

    const r = await provisionTool.handler({ appDisplayName: "App", billingClassification: "standard", azureSubscriptionId: "sub-1", resourceGroup: "rg-1", region: "eastus" });

    // Already-configured, same-target billing must not re-prompt, and must NOT
    // create a new chargeable account (it reuses the existing one).
    expect(r.content[0].text).not.toContain("Confirm standard (paid) billing");
    expect(azureCli.createSyntexAccount).not.toHaveBeenCalled();
    expect(graph.createContainerType).not.toHaveBeenCalled();
  });

  it("still requires confirmBilling when a stale Syntex id belongs to a DIFFERENT app/target (no silent charge)", async () => {
    // Stale scalar from a previous, unrelated standard build must NOT wave a new
    // chargeable account through — this is the financial-safety regression guard.
    stateStore.syntexAccountResourceId = "/subscriptions/old-sub/resourceGroups/old-rg/providers/Microsoft.Syntex/accounts/acc-old";
    stateStore.appDisplayName = "OldApp";
    stateStore.azureSubscriptionId = "old-sub";
    stateStore.resourceGroup = "old-rg";
    vi.mocked(graph.findApplicationByName).mockResolvedValue(null);

    const r = await provisionTool.handler({ appDisplayName: "NewApp", appSelection: "new", billingClassification: "standard", azureSubscriptionId: "sub-2", resourceGroup: "rg-2", region: "eastus" });

    expect(r.content[0].text).toContain("confirmBilling=true");
    expect(graph.createApplication).not.toHaveBeenCalled();
    expect(graph.createContainerType).not.toHaveBeenCalled();
    expect(azureCli.createSyntexAccount).not.toHaveBeenCalled();
  });

  it("rejects an unsupported standard billing region BEFORE creating anything (no orphaned CT)", async () => {
    // Regression: 'westus2' previously passed pre-flight, created a standard CT,
    // then failed at billing-account creation — and the CT could not be rolled
    // back ("Cannot delete container type for non trial"), stranding an orphan.
    // The region must be validated up front so nothing is created.
    vi.mocked(graph.findApplicationByName).mockResolvedValue(null);

    const r = await provisionTool.handler({ appDisplayName: "App", billingClassification: "standard", azureSubscriptionId: "sub-1", resourceGroup: "rg-1", region: "westus2", confirmBilling: true });

    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/not available for Microsoft\.Syntex/i);
    // Nothing was created — no app, no container type, no billing account.
    expect(graph.createApplication).not.toHaveBeenCalled();
    expect(graph.createContainerType).not.toHaveBeenCalled();
    expect(azureCli.createSyntexAccount).not.toHaveBeenCalled();
  });

  it("rolls back a just-created standard CT when the Syntex billing account fails", async () => {
    vi.mocked(graph.findApplicationByName).mockResolvedValue(null);
    vi.mocked(graph.createApplication).mockResolvedValue({ appId: "app-1", objectId: "obj-1", displayName: "App" });
    vi.mocked(graph.createContainerType).mockResolvedValue({ containerTypeId: "ct-1", owningAppId: "app-1", displayName: "App Container Type", billingClassification: "standard" });
    vi.mocked(azureCli.createSyntexAccount).mockRejectedValueOnce(new Error("ARM 409"));

    const r = await provisionTool.handler({ appDisplayName: "App", billingClassification: "standard", azureSubscriptionId: "sub-1", resourceGroup: "rg-1", region: "eastus", confirmBilling: true });

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

// ── ownerScope least-privilege intent (PR #3 review) ────────────────────────────────

describe("project_provision — ownerScope intent", () => {
  // A fresh, unconfirmed session with no recorded ownerScope must ask which
  // scope posture the owning app should take before provisioning.
  it("elicits ownerScope when unset and not resumable from state", async () => {
    const r = await provisionTool.handler({ appDisplayName: "App", billingClassification: "trial" });

    expect(r.content[0].text).toContain("manage ALL container types");
    // Both options are offered with their re-run hints, and nothing was created.
    expect(r.content[0].text).toContain("ownerScope=manage-all");
    expect(r.content[0].text).toContain("ownerScope=selected");
    expect(graph.createApplication).not.toHaveBeenCalled();
  });

  it("does NOT re-elicit when ownerScope is resumable from state", async () => {
    stateStore.ownerScope = "selected";
    vi.mocked(graph.findApplicationByName).mockResolvedValue(null);
    vi.mocked(graph.createApplication).mockResolvedValue({ appId: "app-1", objectId: "obj-1", displayName: "App" });
    vi.mocked(graph.createContainerType).mockResolvedValue({ containerTypeId: "ct-1", owningAppId: "app-1", displayName: "App Container Type" });
    vi.mocked(graph.createContainer).mockResolvedValue({ id: "c-1", displayName: "Default Container", containerTypeId: "ct-1", status: "inactive" });

    const r = await provisionTool.handler({ appDisplayName: "App", billingClassification: "trial" });

    expect(r.content[0].text).not.toContain("manage ALL container types");
    expect(graph.createApplication).toHaveBeenCalled();
  });

  it("manage-all persists ownerScope and sets owningAppManagesAllContainerTypes=true", async () => {
    vi.mocked(graph.findApplicationByName).mockResolvedValue(null);
    vi.mocked(graph.createApplication).mockResolvedValue({ appId: "app-1", objectId: "obj-1", displayName: "App" });
    vi.mocked(graph.createContainerType).mockResolvedValue({ containerTypeId: "ct-1", owningAppId: "app-1", displayName: "App Container Type" });
    vi.mocked(graph.createContainer).mockResolvedValue({ id: "c-1", displayName: "Default Container", containerTypeId: "ct-1", status: "inactive" });

    const r = await provisionTool.handler({ appDisplayName: "App", billingClassification: "trial", ownerScope: "manage-all" });

    expect(r.content[0].text).toContain("SPE Provisioned");
    // Broad admin/console intent → request the manage-all scope set and flag it.
    expect(graph.addSpePermissions).toHaveBeenCalledWith("obj-1", expect.any(Function), { ownerScope: "manage-all" });
    expect(stateStore.ownerScope).toBe("manage-all");
    expect(stateStore.owningAppManagesAllContainerTypes).toBe(true);
  });

  it("selected persists ownerScope; a freshly created selected app still holds Manage.All so the flag is true", async () => {
    vi.mocked(graph.findApplicationByName).mockResolvedValue(null);
    vi.mocked(graph.createApplication).mockResolvedValue({ appId: "app-1", objectId: "obj-1", displayName: "App" });
    vi.mocked(graph.createContainerType).mockResolvedValue({ containerTypeId: "ct-1", owningAppId: "app-1", displayName: "App Container Type" });
    vi.mocked(graph.createContainer).mockResolvedValue({ id: "c-1", displayName: "Default Container", containerTypeId: "ct-1", status: "inactive" });

    const r = await provisionTool.handler({ appDisplayName: "App", billingClassification: "trial", ownerScope: "selected" });

    expect(r.content[0].text).toContain("SPE Provisioned");
    // Least-privilege intent → the NARROW scope set is requested. But a freshly
    // CREATED app is still granted FileStorageContainerType.Manage.All (kept in the
    // selected set), so it CAN enumerate all container types → flag true. The false
    // case comes only from the runtime 403 self-correction for reused/external apps
    // that lack the scope (PR #3 review).
    expect(graph.addSpePermissions).toHaveBeenCalledWith("obj-1", expect.any(Function), { ownerScope: "selected" });
    expect(stateStore.ownerScope).toBe("selected");
    expect(stateStore.owningAppManagesAllContainerTypes).toBe(true);
  });

  it("does NOT stamp the managesAll flag from intent when reusing an existing app (defers to runtime detection)", async () => {
    // A reused/external app may or may not hold Manage.All, so the stamp must omit
    // the flag and let the runtime listContainerTypes 403-check decide (PR #3 review).
    vi.mocked(graph.findApplicationByName).mockResolvedValue({ appId: "app-x", objectId: "obj-x", displayName: "App" });
    vi.mocked(graph.createContainerType).mockResolvedValue({ containerTypeId: "ct-1", owningAppId: "app-x", displayName: "App Container Type" });
    vi.mocked(graph.createContainer).mockResolvedValue({ id: "c-1", displayName: "Default Container", containerTypeId: "ct-1", status: "inactive" });

    const r = await provisionTool.handler({ appDisplayName: "App", appSelection: "reuse", billingClassification: "trial", ownerScope: "selected" });

    expect(r.content[0].text).toContain("SPE Provisioned");
    expect(stateStore.ownerScope).toBe("selected");
    // graph-client is mocked, so the real runtime wrapper doesn't run → flag stays
    // unset for the reused app (not asserted true from intent).
    expect(stateStore.owningAppManagesAllContainerTypes).toBeUndefined();
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

  it("PAUSES when container listing fails (uncertain != empty), preserving app + state", async () => {
    Object.assign(stateStore, { appId: "app-1", appObjectId: "obj-1", containerTypeId: "ct-1", billingClassification: "trial" });
    vi.mocked(graph.listContainers).mockRejectedValueOnce(new Error("transient Graph error"));
    const r = await cleanupTool.handler({ confirm: true });
    expect(graph.deleteContainerTypeRegistration).not.toHaveBeenCalled();
    expect(graph.deleteContainerType).not.toHaveBeenCalled();
    expect(graph.deleteApplication).not.toHaveBeenCalled();
    expect(stateStore.containerTypeId).toBe("ct-1");
    expect(r.content[0].text).toContain("Cleanup Paused");
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
