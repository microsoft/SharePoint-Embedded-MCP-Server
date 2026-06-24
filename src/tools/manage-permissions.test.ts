// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Unit tests for container_permissions_manage, focused on role validation.
 *
 * Regression: the handler previously defaulted a missing/invalid `role` to
 * "writer" and passed arbitrary strings straight to Graph. It must now reject
 * invalid or missing roles for add/update with a clear validation-error
 * envelope and must never silently default.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../graph-client.js", () => ({
  addContainerPermission: vi.fn(),
  updateContainerPermission: vi.fn(),
  removeContainerPermission: vi.fn(),
}));

import * as graph from "../graph-client.js";
import { managePermissionsTool } from "../tools/manage-permissions.js";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("container_permissions_manage role validation", () => {
  it("rejects add with an invalid role and does not call Graph", async () => {
    const r = await managePermissionsTool.handler({
      containerId: "c1", action: "add", userPrincipalName: "user@contoso.com", role: "admin",
    });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("invalid role");
    expect(r.content[0].text).toContain("reader, writer, manager, owner");
    expect(graph.addContainerPermission).not.toHaveBeenCalled();
  });

  it("rejects add with a missing role (no silent default to writer)", async () => {
    const r = await managePermissionsTool.handler({
      containerId: "c1", action: "add", userPrincipalName: "user@contoso.com",
    });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("missing");
    expect(graph.addContainerPermission).not.toHaveBeenCalled();
  });

  it("rejects update with an invalid role and does not call Graph", async () => {
    const r = await managePermissionsTool.handler({
      containerId: "c1", action: "update", permissionId: "p1", role: "superuser",
    });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("invalid role");
    expect(graph.updateContainerPermission).not.toHaveBeenCalled();
  });

  it("rejects update with a missing role", async () => {
    const r = await managePermissionsTool.handler({
      containerId: "c1", action: "update", permissionId: "p1",
    });
    expect(r.isError).toBe(true);
    expect(graph.updateContainerPermission).not.toHaveBeenCalled();
  });

  it.each(["reader", "writer", "manager", "owner"])(
    "accepts valid role '%s' for add",
    async (role) => {
      vi.mocked(graph.addContainerPermission).mockResolvedValue({ id: "perm1", roles: [role] });
      const r = await managePermissionsTool.handler({
        containerId: "c1", action: "add", userPrincipalName: "user@contoso.com", role,
      });
      expect(r.isError).toBeFalsy();
      expect(graph.addContainerPermission).toHaveBeenCalledWith("c1", "user@contoso.com", role);
      expect(r.content[0].text).toContain(role);
    },
  );

  it("passes a validated role through on update", async () => {
    vi.mocked(graph.updateContainerPermission).mockResolvedValue(undefined);
    const r = await managePermissionsTool.handler({
      containerId: "c1", action: "update", permissionId: "p1", role: "manager",
    });
    expect(r.isError).toBeFalsy();
    expect(graph.updateContainerPermission).toHaveBeenCalledWith("c1", "p1", "manager");
    expect(r.content[0].text).toContain("manager");
  });

  it("does not require a role for remove", async () => {
    vi.mocked(graph.removeContainerPermission).mockResolvedValue(undefined);
    const r = await managePermissionsTool.handler({
      containerId: "c1", action: "remove", permissionId: "p1",
    });
    expect(r.isError).toBeFalsy();
    expect(graph.removeContainerPermission).toHaveBeenCalledWith("c1", "p1");
  });

  it("still validates containerId/action before role", async () => {
    const r = await managePermissionsTool.handler({ action: "add", role: "reader" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("containerId and action are required");
  });
});
