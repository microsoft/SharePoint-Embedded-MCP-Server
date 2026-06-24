// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Unit tests for the container-type CRUD + owner-permission tools.
 * graph-client / auth / bootstrap / state are mocked so these run offline.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../graph-client.js", () => ({
  getSignedInUser: vi.fn(async () => ({ id: "user-1", userPrincipalName: "admin@x.com" })),
  grantContainerTypeOwner: vi.fn(async () => ({ id: "perm-1", roles: ["owner"], grantedToV2: { user: { id: "user-1" } } })),
  listContainerTypePermissions: vi.fn(async () => [{ id: "perm-1", roles: ["owner"], grantedToV2: { user: { id: "user-1" } } }]),
  revokeContainerTypePermission: vi.fn(async () => undefined),
  getContainerType: vi.fn(async () => ({ containerTypeId: "ct-1", displayName: "CT", owningAppId: "app-1", billingClassification: "trial" })),
  updateContainerType: vi.fn(async () => ({ containerTypeId: "ct-1", displayName: "Renamed", owningAppId: "app-1" })),
  deleteContainerType: vi.fn(async () => undefined),
  listContainerTypes: vi.fn(async () => [{ containerTypeId: "ct-1", owningAppId: "app-1", displayName: "CT", billingClassification: "trial" }]),
}));
vi.mock("../auth.js", () => ({ setAuthConfig: vi.fn() }));
vi.mock("../bootstrap.js", () => ({ bootstrapTokenProvider: vi.fn(async () => "boot") }));

const stateStore: Record<string, unknown> = {};
vi.mock("../state.js", () => ({ readState: vi.fn(() => ({ ...stateStore })) }));

import * as graph from "../graph-client.js";
import { grantContainerTypeOwnerTool, listContainerTypeOwnersTool, revokeContainerTypeOwnerTool } from "../tools/container-type-permissions.js";
import { getContainerTypeTool, updateContainerTypeTool, deleteContainerTypeTool } from "../tools/container-type-crud.js";

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of Object.keys(stateStore)) delete stateStore[k];
  Object.assign(stateStore, { appId: "app-1", tenantId: "t-1", containerTypeId: "ct-1" });
});

describe("container_type_grant_owner", () => {
  it("grants owner to the signed-in user by default and reports PCA creation", async () => {
    const r = await grantContainerTypeOwnerTool.handler({});
    expect(graph.getSignedInUser).toHaveBeenCalled();
    expect(graph.grantContainerTypeOwner).toHaveBeenCalledWith("ct-1", "user-1");
    expect(r.isError).toBeFalsy();
    expect(r.content[0].text).toContain("owner");
    expect(r.content[0].text).toContain("public client");
  });

  it("uses an explicit userId without resolving the signed-in user", async () => {
    await grantContainerTypeOwnerTool.handler({ userId: "user-2" });
    expect(graph.getSignedInUser).not.toHaveBeenCalled();
    expect(graph.grantContainerTypeOwner).toHaveBeenCalledWith("ct-1", "user-2");
  });

  it("errors when no container type is known", async () => {
    delete stateStore.containerTypeId;
    const r = await grantContainerTypeOwnerTool.handler({});
    expect(r.isError).toBe(true);
    expect(graph.grantContainerTypeOwner).not.toHaveBeenCalled();
  });
});

describe("container_type_owners_list / revoke", () => {
  it("lists owners", async () => {
    const r = await listContainerTypeOwnersTool.handler({});
    expect(graph.listContainerTypePermissions).toHaveBeenCalledWith("ct-1");
    expect(r.content[0].text).toContain("perm-1");
  });

  it("revokes by permission id", async () => {
    const r = await revokeContainerTypeOwnerTool.handler({ permissionId: "perm-1" });
    expect(graph.revokeContainerTypePermission).toHaveBeenCalledWith("ct-1", "perm-1");
    expect(r.isError).toBeFalsy();
  });

  it("requires a permission id to revoke", async () => {
    const r = await revokeContainerTypeOwnerTool.handler({});
    expect(r.isError).toBe(true);
    expect(graph.revokeContainerTypePermission).not.toHaveBeenCalled();
  });
});

describe("container_type_get / update", () => {
  it("gets the container type", async () => {
    const r = await getContainerTypeTool.handler({});
    expect(graph.getContainerType).toHaveBeenCalledWith("ct-1");
    expect(r.content[0].text).toContain("ct-1");
  });

  it("updates the display name", async () => {
    const r = await updateContainerTypeTool.handler({ displayName: "Renamed" });
    // The beta Update fileStorageContainerType API uses `name` (not displayName).
    expect(graph.updateContainerType).toHaveBeenCalledWith("ct-1", { name: "Renamed" });
    expect(r.isError).toBeFalsy();
  });

  it("errors when there is nothing to update", async () => {
    const r = await updateContainerTypeTool.handler({});
    expect(r.isError).toBe(true);
    expect(graph.updateContainerType).not.toHaveBeenCalled();
  });
});

describe("container_type_delete — trial-only policy", () => {
  it("requires confirmation", async () => {
    const r = await deleteContainerTypeTool.handler({});
    expect(r.content[0].text).toContain("Confirm delete");
    expect(graph.deleteContainerType).not.toHaveBeenCalled();
  });

  it("deletes a trial container type with confirm=true", async () => {
    const r = await deleteContainerTypeTool.handler({ confirm: true });
    expect(graph.deleteContainerType).toHaveBeenCalledWith("ct-1");
    expect(r.isError).toBeFalsy();
  });

  it("PROTECTS a standard container type without the override", async () => {
    vi.mocked(graph.listContainerTypes).mockResolvedValueOnce([
      { containerTypeId: "ct-1", owningAppId: "app-1", displayName: "CT", billingClassification: "standard" },
    ]);
    const r = await deleteContainerTypeTool.handler({ confirm: true });
    expect(r.isError).toBe(true);
    expect(graph.deleteContainerType).not.toHaveBeenCalled();
  });

  it("deletes a standard container type with deleteStandard=true", async () => {
    vi.mocked(graph.listContainerTypes).mockResolvedValueOnce([
      { containerTypeId: "ct-1", owningAppId: "app-1", displayName: "CT", billingClassification: "standard" },
    ]);
    const r = await deleteContainerTypeTool.handler({ confirm: true, deleteStandard: true });
    expect(graph.deleteContainerType).toHaveBeenCalledWith("ct-1");
    expect(r.isError).toBeFalsy();
  });
});
