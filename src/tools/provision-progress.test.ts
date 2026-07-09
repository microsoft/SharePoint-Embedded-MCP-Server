// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * WI-16: long-running provisioning UX.
 *
 * Verifies that when project_provision fails MID-FLOW, the error return includes
 * a summary of the steps completed so far (partial progress) so a
 * partially-provisioned, idempotent run is debuggable and resumable — rather
 * than surfacing only the terminal error text. Covers both the standard-billing
 * failure path and the generic catch-all (a throw from any later Graph call).
 * External effects (Graph, az, MSAL, fs) are mocked so these run offline.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

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

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of Object.keys(stateStore)) delete stateStore[k];
});

describe("project_provision — partial progress on mid-flow failure (WI-16)", () => {
  it("includes completed steps when a later Graph call throws (catch-all path)", async () => {
    vi.mocked(graph.findApplicationByName).mockResolvedValue(null);
    vi.mocked(graph.createApplication).mockResolvedValue({ appId: "app-1", objectId: "obj-1", displayName: "App" });
    vi.mocked(graph.createContainerType).mockResolvedValue({ containerTypeId: "ct-1", owningAppId: "app-1", displayName: "App Container Type" });
    // The app + container type steps succeed; registration then throws mid-flow.
    vi.mocked(graph.registerContainerType).mockRejectedValue(new Error("Graph 500: registration failed"));

    const r = await provisionTool.handler({ appDisplayName: "App", billingClassification: "trial" });

    expect(r.isError).toBe(true);
    // Terminal error text is preserved …
    expect(r.content[0].text).toContain("Graph 500: registration failed");
    // … AND the steps completed before the failure are surfaced.
    expect(r.content[0].text).toContain("Progress before this stop");
    expect(r.content[0].text).toContain("Created owning app");
    expect(r.content[0].text).toContain("Created container type");
    // Shows where it stopped and that the flow is resumable.
    expect(r.content[0].text).toContain("Stopped at");
    expect(r.content[0].text).toContain("re-run `project_provision`");
    // Registration never succeeded, so it must NOT appear as a completed step.
    expect(r.content[0].text).not.toContain("Registered container type on tenant");
  });

  it("includes completed steps when standard billing account creation fails", async () => {
    vi.mocked(graph.findApplicationByName).mockResolvedValue(null);
    vi.mocked(graph.createApplication).mockResolvedValue({ appId: "app-1", objectId: "obj-1", displayName: "App" });
    vi.mocked(graph.createContainerType).mockResolvedValue({ containerTypeId: "ct-1", owningAppId: "app-1", displayName: "App Container Type", billingClassification: "standard" });
    vi.mocked(azureCli.createSyntexAccount).mockRejectedValueOnce(new Error("ARM 409"));

    const r = await provisionTool.handler({ appDisplayName: "App", billingClassification: "standard", azureSubscriptionId: "sub-1", resourceGroup: "rg-1", region: "eastus", confirmBilling: true });

    expect(r.isError).toBe(true);
    // Existing behaviour (rollback) is preserved …
    expect(r.content[0].text).toContain("rolled back");
    // … plus the partial-steps summary now accompanies the failure.
    expect(r.content[0].text).toContain("Progress before this stop");
    expect(r.content[0].text).toContain("Created owning app");
    expect(r.content[0].text).toContain("Microsoft.Syntex provider");
    expect(r.content[0].text).toContain("Created container type");
  });

  it("emits each completed step to the server log for live progress", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      vi.mocked(graph.findApplicationByName).mockResolvedValue(null);
      vi.mocked(graph.createApplication).mockResolvedValue({ appId: "app-1", objectId: "obj-1", displayName: "App" });
      vi.mocked(graph.createContainerType).mockResolvedValue({ containerTypeId: "ct-1", owningAppId: "app-1", displayName: "App Container Type" });
      // Reset registration to succeed (a prior test may leave it rejecting —
      // vi.clearAllMocks clears call history but not implementations).
      vi.mocked(graph.registerContainerType).mockResolvedValue(undefined as never);
      vi.mocked(graph.createContainer).mockResolvedValue({ id: "c-1", displayName: "Default Container", containerTypeId: "ct-1", status: "active" });

      const r = await provisionTool.handler({ appDisplayName: "App", billingClassification: "trial" });

      expect(r.isError).toBeFalsy();
      const logged = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
      // Live step logging is prefixed and numbered so operators see movement.
      expect(logged).toContain("[Provision] step 1:");
      expect(logged).toContain("Created owning app");
      expect(logged).toContain("Created container");
    } finally {
      errSpy.mockRestore();
    }
  });
});
