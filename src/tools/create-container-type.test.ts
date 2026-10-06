// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Unit tests for container_type_create.
 *
 * Focus: standard-billing prerequisite validation — parity with
 * project_provision. Graph client and state are mocked so these run offline.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../graph-client.js", () => ({
  createContainerType: vi.fn(),
  listContainerTypes: vi.fn(),
  registerContainerType: vi.fn(),
  deleteContainerType: vi.fn(),
}));

vi.mock("../azure-cli.js", async (importActual) => ({
  ...(await importActual<typeof import("../azure-cli.js")>()),
  ensureSyntexProviderRegistered: vi.fn(),
  // Guided standard-billing sub/RG selection (PR #3 review) lists these inline;
  // default to empty and let each test set the shape it needs.
  listSubscriptions: vi.fn(async () => []),
  listResourceGroups: vi.fn(async () => []),
  resourceGroupExists: vi.fn(),
}));

vi.mock("../elicitation.js", async (importActual) => {
  const actual = await importActual<typeof import("../elicitation.js")>();
  return { ...actual, elicitText: vi.fn(actual.elicitText) };
});

const stateStore: Record<string, unknown> = {};
vi.mock("../state.js", () => ({
  readState: vi.fn(() => ({ ...stateStore })),
  writeState: vi.fn((patch: Record<string, unknown>) => {
    Object.assign(stateStore, patch);
    return { ...stateStore };
  }),
}));

import * as graph from "../graph-client.js";
import * as azureCli from "../azure-cli.js";
import * as elicitation from "../elicitation.js";
import { createContainerTypeTool } from "../tools/create-container-type.js";
import { getSessionId } from "../session.js";

const VALID_SUBSCRIPTION_ID = "11111111-1111-1111-1111-111111111111";

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of Object.keys(stateStore)) delete stateStore[k];
  // An owning app is present for all cases (validation is about billing args).
  stateStore.appId = "app-1";
  // r-appgate: container_type_create is gated by the restart confirmation guard;
  // seed a confirmed session so the gate no-ops and the billing-validation logic
  // under test runs (gate behavior is covered in context-gate.test.ts).
  stateStore.confirmedSessionId = getSessionId();
  vi.mocked(graph.listContainerTypes).mockResolvedValue([]);
  // Reset the guided sub/RG listings to their empty defaults each test —
  // vi.clearAllMocks() clears call history but NOT mockResolvedValue
  // implementations, so without this a prior test's shape would leak forward.
  vi.mocked(azureCli.listSubscriptions).mockResolvedValue([]);
  vi.mocked(azureCli.listResourceGroups).mockResolvedValue([]);
  // Standard-billing Azure prerequisite succeeds by default; rollback tests
  // override this to reject.
  vi.mocked(azureCli.ensureSyntexProviderRegistered).mockResolvedValue({
    namespace: "Microsoft.Syntex",
    registrationState: "Registered",
  } as never);
});

describe("container_type_create — standard billing validation", () => {
  it("guides subscription selection inline (fallback) when standard billing lacks a subscription", async () => {
    // PR #3 review: instead of punting to azure_subscriptions_list +
    // azure_resource_groups_list and a manual re-invoke mid-creation, the tool
    // lists the subscriptions itself and (with >1) asks the user to pick. No
    // native elicitation is wired here, so elicitChoice degrades to the
    // agent-guided ask keyed on `azureSubscriptionId`.
    vi.mocked(azureCli.listSubscriptions).mockResolvedValue([
      { id: "sub-a", name: "Sub A", state: "Enabled" },
      { id: "sub-b", name: "Sub B", state: "Enabled" },
    ]);

    const result = await createContainerTypeTool.handler({
      displayName: "X",
      billingClassification: "standard",
    });

    expect(azureCli.listSubscriptions).toHaveBeenCalled();
    expect(result.content[0].text).toContain("azureSubscriptionId=sub-a");
    expect(result.content[0].text).toContain("azureSubscriptionId=sub-b");
    // No misconfigured Graph request, no false "created" success, and NOT the old
    // "run azure_subscriptions_list yourself" punt.
    expect(result.content[0].text).not.toContain("azure_subscriptions_list");
    expect(graph.createContainerType).not.toHaveBeenCalled();
    expect(graph.registerContainerType).not.toHaveBeenCalled();
    expect(result.content[0].text).not.toContain("Container Type Created");
  });

  it("guides resource-group selection inline (fallback) once a subscription is supplied", async () => {
    // Subscription supplied → the tool lists resource groups WITHIN it and asks
    // the user to pick (agent-guided fallback keyed on `resourceGroup`).
    vi.mocked(azureCli.listResourceGroups).mockResolvedValue([
      { name: "rg-x", location: "eastus", id: `/subscriptions/${VALID_SUBSCRIPTION_ID}/resourceGroups/rg-x` },
      { name: "rg-y", location: "westus", id: `/subscriptions/${VALID_SUBSCRIPTION_ID}/resourceGroups/rg-y` },
    ]);

    const result = await createContainerTypeTool.handler({
      displayName: "X",
      billingClassification: "standard",
      azureSubscriptionId: VALID_SUBSCRIPTION_ID,
    });

    expect(azureCli.listResourceGroups).toHaveBeenCalledWith(VALID_SUBSCRIPTION_ID);
    expect(result.content[0].text).toContain("resourceGroup=rg-x");
    expect(result.content[0].text).toContain("resourceGroup=rg-y");
    expect(graph.createContainerType).not.toHaveBeenCalled();
  });

  it("errors clearly when standard billing has no Azure subscriptions (no crash)", async () => {
    // Default mock returns zero subscriptions → a clear, non-crashing error that
    // points at `az login`, and nothing is created.
    const result = await createContainerTypeTool.handler({
      displayName: "X",
      billingClassification: "standard",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("az login");
    expect(graph.createContainerType).not.toHaveBeenCalled();
    expect(graph.registerContainerType).not.toHaveBeenCalled();
  });

  it("auto-selects a lone subscription + resource group and proceeds (no prompt)", async () => {
    // Exactly one of each → auto-selected without any elicitation, threaded into
    // the Graph create, and surfaced as a note in the result body.
    vi.mocked(azureCli.listSubscriptions).mockResolvedValue([
      { id: "only-sub", name: "Only Sub", state: "Enabled" },
    ]);
    vi.mocked(azureCli.listResourceGroups).mockResolvedValue([
      { name: "only-rg", location: "eastus", id: "/subscriptions/only-sub/resourceGroups/only-rg" },
    ]);
    vi.mocked(graph.createContainerType).mockResolvedValue({
      containerTypeId: "ct-1", owningAppId: "app-1", displayName: "X",
      billingClassification: "standard",
    });
    vi.mocked(graph.registerContainerType).mockResolvedValue(undefined as never);

    const result = await createContainerTypeTool.handler({
      displayName: "X",
      billingClassification: "standard",
    });

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("Using the only Azure subscription");
    expect(result.content[0].text).toContain("Using the only resource group");
    expect(graph.createContainerType).toHaveBeenCalledWith(
      expect.objectContaining({
        displayName: "X",
        owningAppId: "app-1",
        billingClassification: "standard",
        azureSubscriptionId: "only-sub",
        resourceGroup: "only-rg",
      }),
    );
  });

  it("proceeds with standard billing when subscription + resource group are supplied", async () => {
    vi.mocked(graph.createContainerType).mockResolvedValue({
      containerTypeId: "ct-1", owningAppId: "app-1", displayName: "X",
      billingClassification: "standard",
    });
    vi.mocked(graph.registerContainerType).mockResolvedValue(undefined as never);

    const result = await createContainerTypeTool.handler({
      displayName: "X",
      billingClassification: "standard",
      azureSubscriptionId: VALID_SUBSCRIPTION_ID,
      resourceGroup: "rg-1",
    });

    expect(result.isError).toBeFalsy();
    expect(graph.createContainerType).toHaveBeenCalledWith(
      expect.objectContaining({
        displayName: "X",
        owningAppId: "app-1",
        billingClassification: "standard",
        azureSubscriptionId: VALID_SUBSCRIPTION_ID,
        resourceGroup: "rg-1",
      }),
    );
  });

  it("rejects an invalid explicit resource group before Graph or Azure CLI calls", async () => {
    const result = await createContainerTypeTool.handler({
      displayName: "X",
      billingClassification: "standard",
      azureSubscriptionId: VALID_SUBSCRIPTION_ID,
      resourceGroup: "invalid resource group",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe(
      "Error: resourceGroup must be a valid Azure resource group name",
    );
    expect(graph.listContainerTypes).not.toHaveBeenCalled();
    expect(graph.createContainerType).not.toHaveBeenCalled();
    expect(azureCli.listSubscriptions).not.toHaveBeenCalled();
    expect(azureCli.listResourceGroups).not.toHaveBeenCalled();
    expect(azureCli.ensureSyntexProviderRegistered).not.toHaveBeenCalled();
  });

  it("rejects an empty guided resource group before probing or creating anything", async () => {
    vi.mocked(azureCli.listResourceGroups).mockResolvedValue([]);
    vi.mocked(elicitation.elicitText).mockResolvedValueOnce({
      resolved: true,
      value: "   ",
    });

    const result = await createContainerTypeTool.handler({
      displayName: "X",
      billingClassification: "standard",
      azureSubscriptionId: VALID_SUBSCRIPTION_ID,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe("Error: resourceGroup is required");
    expect(azureCli.resourceGroupExists).not.toHaveBeenCalled();
    expect(azureCli.ensureSyntexProviderRegistered).not.toHaveBeenCalled();
    expect(graph.listContainerTypes).not.toHaveBeenCalled();
    expect(graph.createContainerType).not.toHaveBeenCalled();
    expect(graph.registerContainerType).not.toHaveBeenCalled();
  });

  it("rejects an unsupported region before creating the (non-deletable) standard CT", async () => {
    const result = await createContainerTypeTool.handler({
      displayName: "X",
      billingClassification: "standard",
      azureSubscriptionId: VALID_SUBSCRIPTION_ID,
      resourceGroup: "rg-1",
      region: "westus2",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/not available for Microsoft\.Syntex/i);
    // Guard fires BEFORE creation so no non-deletable standard CT is stranded.
    expect(graph.createContainerType).not.toHaveBeenCalled();
  });

  it("allows standard billing with region omitted (billing_setup can default it later)", async () => {
    vi.mocked(graph.createContainerType).mockResolvedValue({
      containerTypeId: "ct-1", owningAppId: "app-1", displayName: "X",
      billingClassification: "standard",
    });
    vi.mocked(graph.registerContainerType).mockResolvedValue(undefined as never);

    const result = await createContainerTypeTool.handler({
      displayName: "X",
      billingClassification: "standard",
      azureSubscriptionId: VALID_SUBSCRIPTION_ID,
      resourceGroup: "rg-1",
    });

    expect(result.isError).toBeFalsy();
    expect(graph.createContainerType).toHaveBeenCalled();
  });

  it("leaves the trial path unchanged (no billing args required)", async () => {
    vi.mocked(graph.createContainerType).mockResolvedValue({
      containerTypeId: "ct-1", owningAppId: "app-1", displayName: "X",
      billingClassification: "trial",
    });
    vi.mocked(graph.registerContainerType).mockResolvedValue(undefined as never);

    const result = await createContainerTypeTool.handler({
      displayName: "X",
      billingClassification: "trial",
    });

    expect(result.isError).toBeFalsy();
    expect(graph.createContainerType).toHaveBeenCalledWith(
      expect.objectContaining({ billingClassification: "trial" }),
    );
    // Trial billing never runs the Azure Syntex prerequisite, so no rollback path.
    expect(azureCli.ensureSyntexProviderRegistered).not.toHaveBeenCalled();
    expect(graph.deleteContainerType).not.toHaveBeenCalled();
  });
});

describe("container_type_create — standard billing rollback", () => {
  beforeEach(() => {
    vi.mocked(graph.createContainerType).mockResolvedValue({
      containerTypeId: "ct-rollback", owningAppId: "app-1", displayName: "X",
      billingClassification: "standard",
    });
    vi.mocked(graph.registerContainerType).mockResolvedValue(undefined as never);
  });

  it("rolls back (deletes) the just-created container type when standard-billing setup fails", async () => {
    vi.mocked(azureCli.ensureSyntexProviderRegistered).mockRejectedValue(
      new Error("Microsoft.Syntex registration timed out"),
    );

    const result = await createContainerTypeTool.handler({
      displayName: "X",
      billingClassification: "standard",
      azureSubscriptionId: VALID_SUBSCRIPTION_ID,
      resourceGroup: "rg-1",
    });

    // Transactional rollback: the orphan CT is deleted and a clear error is returned.
    expect(graph.deleteContainerType).toHaveBeenCalledWith("ct-rollback");
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("rolled back");
    expect(result.content[0].text).toContain("Standard billing setup failed");
    // Registration must NOT proceed for a rolled-back container type.
    expect(graph.registerContainerType).not.toHaveBeenCalled();
  });

  it("warns when rollback ALSO fails so the orphan CT can be cleaned up manually", async () => {
    vi.mocked(azureCli.ensureSyntexProviderRegistered).mockRejectedValue(
      new Error("Microsoft.Syntex registration timed out"),
    );
    vi.mocked(graph.deleteContainerType).mockRejectedValue(new Error("DELETE 500"));

    const result = await createContainerTypeTool.handler({
      displayName: "X",
      billingClassification: "standard",
      azureSubscriptionId: VALID_SUBSCRIPTION_ID,
      resourceGroup: "rg-1",
    });

    expect(graph.deleteContainerType).toHaveBeenCalledWith("ct-rollback");
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("rollback ALSO failed");
    expect(result.content[0].text).toContain("ct-rollback");
  });

  it("does NOT roll back when standard-billing setup succeeds", async () => {
    const result = await createContainerTypeTool.handler({
      displayName: "X",
      billingClassification: "standard",
      azureSubscriptionId: VALID_SUBSCRIPTION_ID,
      resourceGroup: "rg-1",
    });

    expect(result.isError).toBeFalsy();
    expect(azureCli.ensureSyntexProviderRegistered).toHaveBeenCalledWith(VALID_SUBSCRIPTION_ID);
    expect(graph.deleteContainerType).not.toHaveBeenCalled();
    expect(graph.registerContainerType).toHaveBeenCalled();
  });
});

describe("container_type_create — enum/displayName validation", () => {
  it("rejects an out-of-enum billingClassification with NO Graph call", async () => {
    const result = await createContainerTypeTool.handler({
      displayName: "X",
      billingClassification: "free",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Invalid billingClassification 'free'");
    expect(result.content[0].text).toContain("trial, standard, directToCustomer");
    // Validation happens before any Graph call (including the existence probe).
    expect(graph.listContainerTypes).not.toHaveBeenCalled();
    expect(graph.createContainerType).not.toHaveBeenCalled();
    expect(result.content[0].text).not.toContain("Container Type Created");
  });

  it.each([123, "", "   ", {}, null, true])(
    "rejects a non-string / empty displayName (%p) with NO Graph call",
    async (displayName) => {
      const result = await createContainerTypeTool.handler({
        displayName,
      } as Record<string, unknown>);

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain(
        "displayName is required and must be a non-empty string",
      );
      expect(graph.createContainerType).not.toHaveBeenCalled();
    },
  );

  it("accepts the directToCustomer billing model", async () => {
    vi.mocked(graph.createContainerType).mockResolvedValue({
      containerTypeId: "ct-1", owningAppId: "app-1", displayName: "X",
      billingClassification: "directToCustomer",
    });
    vi.mocked(graph.registerContainerType).mockResolvedValue(undefined as never);

    const result = await createContainerTypeTool.handler({
      displayName: "X",
      billingClassification: "directToCustomer",
    });

    expect(result.isError).toBeFalsy();
    expect(graph.createContainerType).toHaveBeenCalledWith(
      expect.objectContaining({ billingClassification: "directToCustomer" }),
    );
  });
});

describe("container_type_create — trial-limit preflight", () => {
  const threeOtherTrials = [
    { containerTypeId: "ct-a", owningAppId: "other-a", displayName: "A", billingClassification: "trial" },
    { containerTypeId: "ct-b", owningAppId: "other-b", displayName: "B", billingClassification: "trial" },
    { containerTypeId: "ct-c", owningAppId: "other-c", displayName: "C", billingClassification: "trial" },
  ];

  it("fails with actionable guidance before creating a fourth trial container type", async () => {
    vi.mocked(graph.listContainerTypes).mockResolvedValue(threeOtherTrials as never);

    const result = await createContainerTypeTool.handler({
      displayName: "Fourth",
      billingClassification: "trial",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("maximum number of trial container types");
    expect(result.content[0].text).toContain("container_type_list");
    expect(result.content[0].text).toContain("container_type_delete");
    expect(graph.createContainerType).not.toHaveBeenCalled();
    expect(graph.registerContainerType).not.toHaveBeenCalled();
  });

  it("reuses an existing trial container type for the same owning app at the cap", async () => {
    vi.mocked(graph.listContainerTypes).mockResolvedValue([
      { containerTypeId: "ct-own", owningAppId: "app-1", displayName: "Mine", billingClassification: "trial" },
      { containerTypeId: "ct-b", owningAppId: "other-b", displayName: "B", billingClassification: "trial" },
      { containerTypeId: "ct-c", owningAppId: "other-c", displayName: "C", billingClassification: "trial" },
    ] as never);

    const result = await createContainerTypeTool.handler({
      displayName: "Mine",
      billingClassification: "trial",
    });

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).not.toContain("maximum number of trial container types");
    expect(graph.createContainerType).not.toHaveBeenCalled();
  });

  it("creates a trial container type when two trials already exist", async () => {
    vi.mocked(graph.listContainerTypes).mockResolvedValue([
      { containerTypeId: "ct-a", owningAppId: "other-a", displayName: "A", billingClassification: "trial" },
      { containerTypeId: "ct-b", owningAppId: "other-b", displayName: "B", billingClassification: "trial" },
    ] as never);
    vi.mocked(graph.createContainerType).mockResolvedValue({
      containerTypeId: "ct-new",
      owningAppId: "app-1",
      displayName: "Third",
      billingClassification: "trial",
    });
    vi.mocked(graph.registerContainerType).mockResolvedValue(undefined as never);

    const result = await createContainerTypeTool.handler({
      displayName: "Third",
      billingClassification: "trial",
    });

    expect(result.isError).toBeFalsy();
    expect(graph.createContainerType).toHaveBeenCalledWith(
      expect.objectContaining({ billingClassification: "trial", owningAppId: "app-1" }),
    );
  });

  it("does not apply the trial cap to standard billing", async () => {
    vi.mocked(graph.listContainerTypes).mockResolvedValue(threeOtherTrials as never);
    vi.mocked(azureCli.listSubscriptions).mockResolvedValue([
      { id: "sub-only", name: "Only", state: "Enabled" },
    ]);
    vi.mocked(azureCli.listResourceGroups).mockResolvedValue([
      { name: "rg-only", location: "eastus", id: "/subscriptions/sub-only/resourceGroups/rg-only" },
    ]);
    vi.mocked(graph.createContainerType).mockResolvedValue({
      containerTypeId: "ct-std",
      owningAppId: "app-1",
      displayName: "Std",
      billingClassification: "standard",
    });
    vi.mocked(graph.registerContainerType).mockResolvedValue(undefined as never);

    const result = await createContainerTypeTool.handler({
      displayName: "Std",
      billingClassification: "standard",
    });

    expect(result.isError).toBeFalsy();
    expect(graph.createContainerType).toHaveBeenCalledWith(
      expect.objectContaining({ billingClassification: "standard" }),
    );
  });
});
