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

vi.mock("../azure-cli.js", () => ({
  ensureSyntexProviderRegistered: vi.fn(),
}));

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
import { createContainerTypeTool } from "../tools/create-container-type.js";

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of Object.keys(stateStore)) delete stateStore[k];
  // An owning app is present for all cases (validation is about billing args).
  stateStore.appId = "app-1";
  vi.mocked(graph.listContainerTypes).mockResolvedValue([]);
  // Standard-billing Azure prerequisite succeeds by default; rollback tests
  // override this to reject.
  vi.mocked(azureCli.ensureSyntexProviderRegistered).mockResolvedValue({
    namespace: "Microsoft.Syntex",
    registrationState: "Registered",
  } as never);
});

describe("container_type_create — standard billing validation", () => {
  it("rejects standard billing without subscription + resource group (no Graph call, no false success)", async () => {
    const result = await createContainerTypeTool.handler({
      displayName: "X",
      billingClassification: "standard",
    });

    expect(result.isError).toBe(true);
    // Actionable guidance mirroring project_provision.
    expect(result.content[0].text).toContain("azure_subscriptions_list");
    expect(result.content[0].text).toContain("azure_resource_groups_list");
    // No misconfigured Graph request, no false "created" success.
    expect(graph.createContainerType).not.toHaveBeenCalled();
    expect(graph.registerContainerType).not.toHaveBeenCalled();
    expect(result.content[0].text).not.toContain("Container Type Created");
  });

  it("rejects standard billing when only the subscription is supplied (resource group still required)", async () => {
    const result = await createContainerTypeTool.handler({
      displayName: "X",
      billingClassification: "standard",
      azureSubscriptionId: "sub-1",
    });

    expect(result.isError).toBe(true);
    expect(graph.createContainerType).not.toHaveBeenCalled();
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
      azureSubscriptionId: "sub-1",
      resourceGroup: "rg-1",
    });

    expect(result.isError).toBeFalsy();
    expect(graph.createContainerType).toHaveBeenCalledWith(
      expect.objectContaining({
        displayName: "X",
        owningAppId: "app-1",
        billingClassification: "standard",
        azureSubscriptionId: "sub-1",
        resourceGroup: "rg-1",
      }),
    );
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
      azureSubscriptionId: "sub-1",
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
      azureSubscriptionId: "sub-1",
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
      azureSubscriptionId: "sub-1",
      resourceGroup: "rg-1",
    });

    expect(result.isError).toBeFalsy();
    expect(azureCli.ensureSyntexProviderRegistered).toHaveBeenCalledWith("sub-1");
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
