// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Guided standard-billing subscription/resource-group selection (PR #3 review).
 *
 * These tests drive project_provision with NATIVE elicitation mocked so the
 * guided sub/RG helper resolves in-band (as a capable MCP client would). They
 * verify:
 *   1. multiple subs + RGs → the tool elicits BOTH and proceeds with the CHOSEN
 *      values (not the first) threaded all the way to createSyntexAccount.
 *   2. exactly one sub + one RG → auto-selected with NO prompt, and the choice is
 *      surfaced as a note.
 *   3. zero subs → a clear, non-crashing error; nothing is created.
 *   5. the confirmBilling financial-safety gate STILL fires after guided
 *      selection (no silent charge), and region validation still runs first.
 *
 * The agent-guided FALLBACK path (native elicitation unavailable) is covered in
 * orchestration.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

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
  // Keep the REAL region helpers so region validation runs for real; only the
  // az-shelling functions are mocked.
  ...(await importActual<typeof import("../azure-cli.js")>()),
  ensureSyntexProviderRegistered: vi.fn(async () => ({ namespace: "Microsoft.Syntex", registrationState: "Registered" })),
  createSyntexAccount: vi.fn(async () => "/subscriptions/sub/resourceGroups/rg/providers/Microsoft.Syntex/accounts/acc-1"),
  getSyntexAccounts: vi.fn(async () => []),
  listSubscriptions: vi.fn(async () => []),
  listResourceGroups: vi.fn(async () => []),
  // Default to "verified" so existing RG-path tests are unaffected; overridden
  // per-test for the 0-RG entered-name existence check (PR #3 review).
  resourceGroupExists: vi.fn(async () => true),
}));
vi.mock("../auth.js", () => ({ setAuthConfig: vi.fn() }));

// Native elicitation mocked: a capable client resolves the pick in-band. For the
// guided sub/RG picks we deliberately choose the LAST option to prove the CHOSEN
// value (not merely the first) threads through provisioning. Any other gate
// (not exercised here — state pre-seeds ownerScope) auto-resolves to its first.
// vi.hoisted so the spies exist when the mock factory runs during module load.
const { elicitChoiceMock, elicitTextMock } = vi.hoisted(() => ({
  elicitChoiceMock: vi.fn(
    async (_question: string, options: { value: string }[], paramName: string) => ({
      resolved: true as const,
      value:
        paramName === "azureSubscriptionId" || paramName === "resourceGroup"
          ? options[options.length - 1].value
          : options[0].value,
    }),
  ),
  elicitTextMock: vi.fn(async () => ({ resolved: false as const, result: null })),
}));
vi.mock("../elicitation.js", () => ({
  elicitChoice: elicitChoiceMock,
  elicitText: elicitTextMock,
  needChoice: vi.fn(() => ({ content: [{ type: "text", text: "needChoice" }] })),
}));

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
  // Settle least-privilege intent so the ownerScope gate is a resumable no-op and
  // the ONLY elicitation in these tests is the guided sub/RG selection.
  stateStore.ownerScope = "selected";
  // Happy-path Graph mocks for a full standard chain.
  vi.mocked(graph.findApplicationByName).mockResolvedValue(null);
  vi.mocked(graph.createApplication).mockResolvedValue({ appId: "app-1", objectId: "obj-1", displayName: "App" });
  vi.mocked(graph.createContainerType).mockResolvedValue({ containerTypeId: "ct-1", owningAppId: "app-1", displayName: "App Container Type", billingClassification: "standard" });
  vi.mocked(graph.createContainer).mockResolvedValue({ id: "c-1", displayName: "Default Container", containerTypeId: "ct-1", status: "active" });
});

describe("project_provision — guided standard-billing selection (native elicitation)", () => {
  it("elicits subscription AND resource group, then provisions with the CHOSEN values", async () => {
    vi.mocked(azureCli.listSubscriptions).mockResolvedValue([
      { id: "sub-8", name: "Sub 8", state: "Enabled" },
      { id: "sub-9", name: "Sub 9", state: "Enabled" },
    ]);
    vi.mocked(azureCli.listResourceGroups).mockResolvedValue([
      { name: "rg-8", location: "eastus", id: "/subscriptions/sub-9/resourceGroups/rg-8" },
      { name: "rg-9", location: "eastus", id: "/subscriptions/sub-9/resourceGroups/rg-9" },
    ]);

    const r = await provisionTool.handler({
      appDisplayName: "App",
      billingClassification: "standard",
      region: "eastus",
      confirmBilling: true,
    });

    // Both picks were elicited (subscription first, then resource group).
    expect(elicitChoiceMock).toHaveBeenCalledTimes(2);
    expect(elicitChoiceMock.mock.calls[0][2]).toBe("azureSubscriptionId");
    expect(elicitChoiceMock.mock.calls[1][2]).toBe("resourceGroup");
    // Resource groups were listed for the CHOSEN subscription (sub-9).
    expect(azureCli.listResourceGroups).toHaveBeenCalledWith("sub-9");
    // The chosen (last) values thread all the way to the billing account.
    expect(azureCli.createSyntexAccount).toHaveBeenCalledWith("sub-9", "rg-9", "eastus", "ct-1");
    expect(r.content[0].text).toContain("SPE Provisioned");
  });

  it("auto-selects a lone subscription and resource group without prompting", async () => {
    vi.mocked(azureCli.listSubscriptions).mockResolvedValue([
      { id: "solo-sub", name: "Solo Sub", state: "Enabled" },
    ]);
    vi.mocked(azureCli.listResourceGroups).mockResolvedValue([
      { name: "solo-rg", location: "eastus", id: "/subscriptions/solo-sub/resourceGroups/solo-rg" },
    ]);

    const r = await provisionTool.handler({
      appDisplayName: "App",
      billingClassification: "standard",
      region: "eastus",
      confirmBilling: true,
    });

    // Trivial single choices are auto-selected — no elicitation prompt.
    expect(elicitChoiceMock).not.toHaveBeenCalled();
    expect(azureCli.createSyntexAccount).toHaveBeenCalledWith("solo-sub", "solo-rg", "eastus", "ct-1");
    expect(r.content[0].text).toContain("Using the only Azure subscription");
    expect(r.content[0].text).toContain("Using the only resource group");
    expect(r.content[0].text).toContain("SPE Provisioned");
  });

  it("errors clearly when there are no Azure subscriptions (no crash, nothing created)", async () => {
    vi.mocked(azureCli.listSubscriptions).mockResolvedValue([]);

    const r = await provisionTool.handler({
      appDisplayName: "App",
      billingClassification: "standard",
      region: "eastus",
      confirmBilling: true,
    });

    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("az login");
    expect(elicitChoiceMock).not.toHaveBeenCalled();
    expect(graph.createApplication).not.toHaveBeenCalled();
    expect(azureCli.createSyntexAccount).not.toHaveBeenCalled();
  });

  it("STILL requires confirmBilling after guided selection — no silent charge", async () => {
    // Singletons auto-fill the target, but the financial-safety gate must still
    // fire because confirmBilling was not passed. This proves guided selection
    // runs BEFORE the gate and never bypasses it.
    vi.mocked(azureCli.listSubscriptions).mockResolvedValue([
      { id: "solo-sub", name: "Solo Sub", state: "Enabled" },
    ]);
    vi.mocked(azureCli.listResourceGroups).mockResolvedValue([
      { name: "solo-rg", location: "eastus", id: "/subscriptions/solo-sub/resourceGroups/solo-rg" },
    ]);

    const r = await provisionTool.handler({
      appDisplayName: "App",
      billingClassification: "standard",
      region: "eastus",
      // confirmBilling intentionally omitted
    });

    expect(r.content[0].text).toContain("Confirm standard (paid) billing");
    expect(r.content[0].text).toContain("confirmBilling=true");
    // The auto-selected target appears in the confirmation preview.
    expect(r.content[0].text).toContain("solo-sub");
    // Nothing chargeable was created.
    expect(graph.createApplication).not.toHaveBeenCalled();
    expect(graph.createContainerType).not.toHaveBeenCalled();
    expect(azureCli.createSyntexAccount).not.toHaveBeenCalled();
  });

  it("validates the region after guided selection and before creating anything", async () => {
    vi.mocked(azureCli.listSubscriptions).mockResolvedValue([
      { id: "solo-sub", name: "Solo Sub", state: "Enabled" },
    ]);
    vi.mocked(azureCli.listResourceGroups).mockResolvedValue([
      { name: "solo-rg", location: "westus2", id: "/subscriptions/solo-sub/resourceGroups/solo-rg" },
    ]);

    const r = await provisionTool.handler({
      appDisplayName: "App",
      billingClassification: "standard",
      region: "westus2", // unsupported for Microsoft.Syntex
      confirmBilling: true,
    });

    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/not available for Microsoft\.Syntex/i);
    // Region guard fires before creation, so nothing is stranded.
    expect(graph.createApplication).not.toHaveBeenCalled();
    expect(graph.createContainerType).not.toHaveBeenCalled();
    expect(azureCli.createSyntexAccount).not.toHaveBeenCalled();
  });

  it("fails cost-free when a user-entered resource group does not exist — nothing created (PR #3 review)", async () => {
    // One subscription (auto-selected) with ZERO resource groups drives the
    // elicitText "enter a new RG name" path; the entered name is then probed.
    vi.mocked(azureCli.listSubscriptions).mockResolvedValue([
      { id: "solo-sub", name: "Solo Sub", state: "Enabled" },
    ]);
    vi.mocked(azureCli.listResourceGroups).mockResolvedValue([]);
    // The agent supplies a name in-band...
    elicitTextMock.mockResolvedValueOnce({ resolved: true, value: "typo-rg" });
    // ...but it does not exist in the subscription.
    vi.mocked(azureCli.resourceGroupExists).mockResolvedValue(false);

    const r = await provisionTool.handler({
      appDisplayName: "App",
      billingClassification: "standard",
      region: "eastus",
      confirmBilling: true,
    });

    // The entered name was probed against the auto-selected subscription.
    expect(azureCli.resourceGroupExists).toHaveBeenCalledWith("typo-rg", "solo-sub");
    // Actionable, cost-free guidance is returned instead of proceeding.
    expect(r.content[0].text).toContain("does not exist");
    expect(r.content[0].text).toContain("az group create");
    // Fails BEFORE the region check, the confirmBilling gate, and any creation —
    // so no container type is stranded and no billing account is created.
    expect(graph.createApplication).not.toHaveBeenCalled();
    expect(graph.createContainerType).not.toHaveBeenCalled();
    expect(azureCli.createSyntexAccount).not.toHaveBeenCalled();
  });
});
