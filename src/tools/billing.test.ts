// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Unit tests for billing tools.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../graph-client.js", () => ({
  getContainerType: vi.fn(),
  listContainerTypes: vi.fn(),
}));
vi.mock("../azure-cli.js", () => ({
  ensureSyntexProviderRegistered: vi.fn(async () => ({ namespace: "Microsoft.Syntex", registrationState: "Registered" })),
  createSyntexAccount: vi.fn(async () => "/subscriptions/sub-1/resourceGroups/rg-test/providers/Microsoft.Syntex/accounts/acc-1"),
  getSyntexAccounts: vi.fn(async () => []),
}));
vi.mock("../state.js", () => ({
  readState: vi.fn(() => ({})),
  writeState: vi.fn(),
}));

import * as graph from "../graph-client.js";
import * as azureCli from "../azure-cli.js";
import * as state from "../state.js";
import { checkBillingTool } from "../tools/check-billing.js";
import { setupBillingTool } from "../tools/setup-billing.js";

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── billing_check ──────────────────────────────────────────────────────

describe("billing_check", () => {
  it("shows trial billing with expiry info", async () => {
    const created = new Date();
    created.setDate(created.getDate() - 5);
    vi.mocked(graph.getContainerType).mockResolvedValue({
      containerTypeId: "ct1",
      owningAppId: "app1",
      displayName: "Test CT",
      billingClassification: "trial",
      createdDateTime: created.toISOString(),
    });
    vi.mocked(graph.listContainerTypes).mockResolvedValue([
      { containerTypeId: "ct1", owningAppId: "app1", displayName: "Test CT", billingClassification: "trial" },
      { containerTypeId: "ct2", owningAppId: "app2", displayName: "CT 2", billingClassification: "trial" },
    ]);

    const result = await checkBillingTool.handler({ containerTypeId: "ct1" });
    expect(result.content[0].text).toContain("trial");
    expect(result.content[0].text).toContain("days remaining");
    expect(result.content[0].text).toContain("2 of 3 max");
  });

  it("shows standard billing with subscription", async () => {
    vi.mocked(graph.getContainerType).mockResolvedValue({
      containerTypeId: "ct1",
      owningAppId: "app1",
      displayName: "Prod CT",
      billingClassification: "standard",
      azureSubscriptionId: "sub-123",
    });

    const result = await checkBillingTool.handler({ containerTypeId: "ct1" });
    expect(result.content[0].text).toContain("standard");
    expect(result.content[0].text).toContain("sub-123");
  });

  it("requires containerTypeId", async () => {
    const r = await checkBillingTool.handler({});
    expect(r.isError).toBe(true);
  });

  it("defaults containerTypeId from provisioning state when omitted", async () => {
    vi.mocked(state.readState).mockReturnValueOnce({ containerTypeId: "ct-from-state" });
    vi.mocked(graph.getContainerType).mockResolvedValue({
      containerTypeId: "ct-from-state",
      owningAppId: "app1",
      displayName: "State CT",
      billingClassification: "standard",
    });
    const r = await checkBillingTool.handler({});
    expect(r.isError).toBeUndefined();
    expect(graph.getContainerType).toHaveBeenCalledWith("ct-from-state");
  });
});

// ─── billing_setup ──────────────────────────────────────────────────────

describe("billing_setup", () => {
  it("creates the Microsoft.Syntex billing account for a standard CT (confirm=true)", async () => {
    vi.mocked(graph.getContainerType).mockResolvedValue({
      containerTypeId: "ct1", owningAppId: "app1", displayName: "Test",
      billingClassification: "standard",
    });
    vi.mocked(azureCli.getSyntexAccounts).mockResolvedValue([]);

    const result = await setupBillingTool.handler({
      containerTypeId: "ct1", azureSubscriptionId: "sub-1", resourceGroup: "rg-test",
      region: "eastus", confirm: true,
    });

    expect(result.content[0].text).toContain("Standard Billing Configured");
    expect(result.content[0].text).toContain("standard");
    expect(result.content[0].text).toContain("irreversible");
    expect(azureCli.ensureSyntexProviderRegistered).toHaveBeenCalledWith("sub-1");
    expect(azureCli.createSyntexAccount).toHaveBeenCalledWith("sub-1", "rg-test", "eastus", "ct1");
  });

  // Owner decision: no SPO-admin plane -> a trial CT cannot be converted.
  it("refuses a non-standard (trial) CT and explains standard must be chosen at create time", async () => {
    vi.mocked(graph.getContainerType).mockResolvedValue({
      containerTypeId: "ct1", owningAppId: "app1", displayName: "Test",
      billingClassification: "trial",
    });

    const result = await setupBillingTool.handler({
      containerTypeId: "ct1", azureSubscriptionId: "sub-1", resourceGroup: "rg-test",
      region: "eastus", confirm: true,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("trial");
    expect(result.content[0].text).toMatch(/CREATE|created/);
    expect(azureCli.ensureSyntexProviderRegistered).not.toHaveBeenCalled();
    expect(azureCli.createSyntexAccount).not.toHaveBeenCalled();
  });

  // the irreversible standard setup must be gated by confirm.
  it("requires confirm=true before creating the billing account (preview only)", async () => {
    vi.mocked(graph.getContainerType).mockResolvedValue({
      containerTypeId: "ct1", owningAppId: "app1", displayName: "Test",
      billingClassification: "standard",
    });
    vi.mocked(azureCli.getSyntexAccounts).mockResolvedValue([]);

    const result = await setupBillingTool.handler({
      containerTypeId: "ct1", azureSubscriptionId: "sub-1", resourceGroup: "rg-test", region: "eastus",
    });

    expect(result.content[0].text).toContain("confirm=true");
    expect(result.content[0].text).toContain("CANNOT be reverted");
    expect(azureCli.ensureSyntexProviderRegistered).not.toHaveBeenCalled();
    expect(azureCli.createSyntexAccount).not.toHaveBeenCalled();
  });

  it("lists only the missing required fields (not ones that were provided)", async () => {
    // containerTypeId provided; subscription + resource group are missing from args and state.
    const result = await setupBillingTool.handler({ containerTypeId: "ct1" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("missing required arguments");
    expect(result.content[0].text).toContain("azureSubscriptionId");
    expect(result.content[0].text).toContain("resourceGroup");
    expect(azureCli.createSyntexAccount).not.toHaveBeenCalled();
  });

  it("is an idempotent no-op when a Succeeded Syntex account already exists for the CT", async () => {
    vi.mocked(graph.getContainerType).mockResolvedValue({
      containerTypeId: "ct1", owningAppId: "app1", displayName: "Test",
      billingClassification: "standard",
    });
    vi.mocked(azureCli.getSyntexAccounts).mockResolvedValue([
      { id: "/subscriptions/sub-1/resourceGroups/rg-test/providers/Microsoft.Syntex/accounts/acc-1",
        name: "acc-1", properties: { identityId: "ct1", provisioningState: "Succeeded" } },
    ]);

    const result = await setupBillingTool.handler({
      containerTypeId: "ct1", azureSubscriptionId: "sub-1", resourceGroup: "rg-test", region: "eastus",
    });

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toMatch(/already attached/i);
    expect(azureCli.createSyntexAccount).not.toHaveBeenCalled();
  });

  it("requires containerTypeId, subscription, and resource group", async () => {
    const r = await setupBillingTool.handler({ containerTypeId: "ct1" });
    expect(r.isError).toBe(true);
    expect(azureCli.createSyntexAccount).not.toHaveBeenCalled();
  });
});

// createSyntexAccount (az rest PUT shape) — exercises the REAL implementation
// via injected seams (no shelling out) to assert the ARM PUT url + body match
// the VS Code extension exactly.
describe("createSyntexAccount", () => {
  it("builds the exact ARM PUT url + body (api-version 2023-01-04-preview)", async () => {
    const { createSyntexAccount: realCreate } =
      await vi.importActual<typeof import("../azure-cli.js")>("../azure-cli.js");

    let capturedUrl = "";
    let capturedBody: unknown;
    const resourceId = await realCreate("sub-1", "rg-1", "eastus", "ct-1", {
      newAccountName: () => "11111111-1111-1111-1111-111111111111",
      putAccount: async (url, body) => {
        capturedUrl = url;
        capturedBody = body;
        return {
          id: "/subscriptions/sub-1/resourceGroups/rg-1/providers/Microsoft.Syntex/accounts/11111111-1111-1111-1111-111111111111",
          properties: { provisioningState: "Succeeded", identityId: "ct-1" },
        };
      },
    });

    expect(capturedUrl).toBe(
      "https://management.azure.com/subscriptions/sub-1/resourceGroups/rg-1/providers/Microsoft.Syntex/accounts/11111111-1111-1111-1111-111111111111?api-version=2023-01-04-preview",
    );
    expect(capturedBody).toEqual({
      location: "eastus",
      properties: {
        friendlyName: "CT_ct-1",
        service: "SPO",
        identityType: "ContainerType",
        identityId: "ct-1",
        feature: "RaaS",
        scope: "Global",
      },
    });
    expect(resourceId).toContain("/providers/Microsoft.Syntex/accounts/11111111-1111-1111-1111-111111111111");
  });

  it("polls until provisioningState=Succeeded when the PUT returns a non-terminal state", async () => {
    const { createSyntexAccount: realCreate } =
      await vi.importActual<typeof import("../azure-cli.js")>("../azure-cli.js");

    const states = ["Provisioning", "Provisioning", "Succeeded"];
    let i = 0;
    const resourceId = await realCreate("sub-1", "rg-1", "eastus", "ct-1", {
      newAccountName: () => "acc-uuid",
      sleep: async () => undefined,
      putAccount: async () => ({
        id: "/subscriptions/sub-1/resourceGroups/rg-1/providers/Microsoft.Syntex/accounts/acc-uuid",
        properties: { provisioningState: "Provisioning", identityId: "ct-1" },
      }),
      getAccount: async (id) => ({ id, properties: { provisioningState: states[Math.min(i++, 2)], identityId: "ct-1" } }),
    });

    expect(resourceId).toContain("acc-uuid");
  });

  it("cleans up the partial account and throws when provisioning Fails", async () => {
    const { createSyntexAccount: realCreate } =
      await vi.importActual<typeof import("../azure-cli.js")>("../azure-cli.js");

    const deleted: string[] = [];
    await expect(
      realCreate("sub-1", "rg-1", "eastus", "ct-1", {
        newAccountName: () => "bad-uuid",
        sleep: async () => undefined,
        putAccount: async () => ({
          id: "/subscriptions/sub-1/resourceGroups/rg-1/providers/Microsoft.Syntex/accounts/bad-uuid",
          properties: { provisioningState: "Provisioning", identityId: "ct-1" },
        }),
        getAccount: async (id) => ({ id, properties: { provisioningState: "Failed", identityId: "ct-1" } }),
        deleteAccount: async (id) => { deleted.push(id); },
      }),
    ).rejects.toThrow(/Failed/);
    expect(deleted).toHaveLength(1);
  });
});
