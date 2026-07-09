// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Resource-group existence verification for guided standard billing (PR #3 review).
 *
 * When a subscription has no resource groups, the guided target helper prompts
 * the user for a NEW resource-group name (the server cannot create the group
 * itself). Previously it proceeded with whatever name was entered; a typo /
 * non-existent group only failed LATER at `createSyntexAccount` — AFTER the
 * container type had been created, stranding it. The fix probes the entered name
 * with `resourceGroupExists` and, on a definitive "missing", returns actionable
 * guidance and fails COST-FREE (before any CT/billing resource is created). An
 * indeterminate probe (az missing / auth / transient) degrades to the prior
 * behavior (proceed with the name). The auto-select-singleton and multi-RG
 * elicit paths are unchanged — they never probe.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../azure-cli.js", () => ({
  listSubscriptions: vi.fn(),
  listResourceGroups: vi.fn(),
  resourceGroupExists: vi.fn(),
}));
vi.mock("../elicitation.js", () => ({
  elicitChoice: vi.fn(),
  elicitText: vi.fn(),
}));

import * as azureCli from "../azure-cli.js";
import * as elicitation from "../elicitation.js";
import { resolveStandardBillingTarget } from "../tools/standard-billing-target.js";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("resolveStandardBillingTarget — resource-group existence check (PR #3 review)", () => {
  it("0 RGs + entered name that does NOT exist → cost-free guidance, does not proceed", async () => {
    vi.mocked(azureCli.listResourceGroups).mockResolvedValue([]);
    vi.mocked(elicitation.elicitText).mockResolvedValue({ resolved: true, value: "typo-rg" });
    vi.mocked(azureCli.resourceGroupExists).mockResolvedValue(false);

    const r = await resolveStandardBillingTarget({ azureSubscriptionId: "sub-1" });

    // The entered name was probed against the chosen subscription.
    expect(azureCli.resourceGroupExists).toHaveBeenCalledWith("typo-rg", "sub-1");
    // Fail cost-free: unresolved, with actionable create-then-re-run guidance and
    // NOT an error envelope (agent-guided, non-blocking).
    expect(r.resolved).toBe(false);
    if (r.resolved) throw new Error("expected unresolved");
    expect(r.result.isError).toBeFalsy();
    expect(r.result.content[0].text).toContain("does not exist");
    expect(r.result.content[0].text).toContain("az group create");
    expect(r.result.content[0].text).toContain("typo-rg");
  });

  it("0 RGs + entered name that EXISTS → proceeds (verified)", async () => {
    vi.mocked(azureCli.listResourceGroups).mockResolvedValue([]);
    vi.mocked(elicitation.elicitText).mockResolvedValue({ resolved: true, value: "real-rg" });
    vi.mocked(azureCli.resourceGroupExists).mockResolvedValue(true);

    const r = await resolveStandardBillingTarget({ azureSubscriptionId: "sub-1" });

    expect(azureCli.resourceGroupExists).toHaveBeenCalledWith("real-rg", "sub-1");
    expect(r.resolved).toBe(true);
    if (!r.resolved) throw new Error("expected resolved");
    expect(r.resourceGroup).toBe("real-rg");
    expect(r.azureSubscriptionId).toBe("sub-1");
    expect(r.notes.join(" ")).toContain("verified");
  });

  it("0 RGs + entered name but probe is INDETERMINATE (undefined) → proceeds (unverified, prior behavior)", async () => {
    vi.mocked(azureCli.listResourceGroups).mockResolvedValue([]);
    vi.mocked(elicitation.elicitText).mockResolvedValue({ resolved: true, value: "maybe-rg" });
    vi.mocked(azureCli.resourceGroupExists).mockResolvedValue(undefined);

    const r = await resolveStandardBillingTarget({ azureSubscriptionId: "sub-1" });

    expect(azureCli.resourceGroupExists).toHaveBeenCalledWith("maybe-rg", "sub-1");
    expect(r.resolved).toBe(true);
    if (!r.resolved) throw new Error("expected resolved");
    expect(r.resourceGroup).toBe("maybe-rg");
    expect(r.notes.join(" ")).toContain("could not verify");
  });

  it("preserves the auto-select-singleton path — a lone listed RG is used WITHOUT probing", async () => {
    vi.mocked(azureCli.listResourceGroups).mockResolvedValue([
      { name: "solo-rg", location: "eastus", id: "/subscriptions/sub-1/resourceGroups/solo-rg" },
    ]);

    const r = await resolveStandardBillingTarget({ azureSubscriptionId: "sub-1" });

    expect(elicitation.elicitText).not.toHaveBeenCalled();
    expect(azureCli.resourceGroupExists).not.toHaveBeenCalled(); // listed RGs are not re-probed
    expect(r.resolved).toBe(true);
    if (!r.resolved) throw new Error("expected resolved");
    expect(r.resourceGroup).toBe("solo-rg");
  });

  it("preserves the multi-RG elicit path — chosen listed RG is used WITHOUT probing", async () => {
    vi.mocked(azureCli.listResourceGroups).mockResolvedValue([
      { name: "rg-a", location: "eastus", id: "/subscriptions/sub-1/resourceGroups/rg-a" },
      { name: "rg-b", location: "eastus", id: "/subscriptions/sub-1/resourceGroups/rg-b" },
    ]);
    vi.mocked(elicitation.elicitChoice).mockResolvedValue({ resolved: true, value: "rg-b" });

    const r = await resolveStandardBillingTarget({ azureSubscriptionId: "sub-1" });

    expect(elicitation.elicitChoice).toHaveBeenCalled();
    expect(azureCli.resourceGroupExists).not.toHaveBeenCalled();
    expect(r.resolved).toBe(true);
    if (!r.resolved) throw new Error("expected resolved");
    expect(r.resourceGroup).toBe("rg-b");
  });
});
