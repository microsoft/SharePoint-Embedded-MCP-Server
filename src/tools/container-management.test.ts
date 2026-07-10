// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Unit tests for container management tools.
 *
 * Tests tool handler logic with mocked Graph client.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the graph-client module
vi.mock("../graph-client.js", () => ({
  listContainers: vi.fn(),
  getContainer: vi.fn(),
  getContainerDrive: vi.fn(),
  listContainerPermissions: vi.fn(),
  getCustomProperties: vi.fn(),
  addContainerPermission: vi.fn(),
  updateContainerPermission: vi.fn(),
  removeContainerPermission: vi.fn(),
  lockContainer: vi.fn(),
  unlockContainer: vi.fn(),
  deleteContainer: vi.fn(),
  permanentDeleteContainer: vi.fn(),
  restoreDeletedContainer: vi.fn(),
}));
// container_list defaults containerTypeId from provisioning state; mock it so the
// test never reads the developer's real ~/.spe-mcp/state.json.
vi.mock("../state.js", () => ({
  readState: vi.fn(() => ({})),
  writeState: vi.fn(),
}));

import * as graph from "../graph-client.js";
import * as state from "../state.js";
import { listContainersTool } from "../tools/list-containers.js";
import { getContainerTool } from "../tools/get-container.js";
import { managePermissionsTool } from "../tools/manage-permissions.js";
import { archiveRestoreTool } from "../tools/archive-restore.js";
import { deleteContainerTool } from "../tools/delete-container.js";

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── container_list ────────────────────────────────────────────────────

describe("container_list", () => {
  it("returns containers as markdown table", async () => {
    vi.mocked(graph.listContainers).mockResolvedValue([
      { id: "c1", displayName: "Test", containerTypeId: "ct1", status: "active", createdDateTime: "2026-01-01" },
    ]);

    const result = await listContainersTool.handler({ containerTypeId: "ct1" });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("Containers (1)");
    expect(result.content[0].text).toContain("Test");
    expect(graph.listContainers).toHaveBeenCalledWith("ct1");
  });

  it("handles empty container list", async () => {
    vi.mocked(graph.listContainers).mockResolvedValue([]);
    const result = await listContainersTool.handler({ containerTypeId: "ct1" });
    expect(result.content[0].text).toContain("No containers found");
  });

  it("requires containerTypeId", async () => {
    const result = await listContainersTool.handler({});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("required");
  });

  it("defaults containerTypeId from provisioning state when omitted", async () => {
    vi.mocked(state.readState).mockReturnValueOnce({ containerTypeId: "ct-from-state" });
    vi.mocked(graph.listContainers).mockResolvedValue([
      { id: "c1", displayName: "Test", containerTypeId: "ct-from-state", status: "active", createdDateTime: "2026-01-01" },
    ]);
    const result = await listContainersTool.handler({});
    expect(result.isError).toBeUndefined();
    expect(graph.listContainers).toHaveBeenCalledWith("ct-from-state");
  });
});

// ─── container_get ──────────────────────────────────────────────────────

describe("container_get", () => {
  it("returns container details with permissions and drive", async () => {
    vi.mocked(graph.getContainer).mockResolvedValue({
      id: "c1", displayName: "Test", containerTypeId: "ct1",
      status: "active", lockState: "unlocked", createdDateTime: "2026-01-01",
    });
    vi.mocked(graph.getContainerDrive).mockResolvedValue({
      id: "d1", webUrl: "https://example.com/drive", quota: { used: 1024, total: 1048576 },
    });
    vi.mocked(graph.listContainerPermissions).mockResolvedValue([
      { id: "p1", roles: ["owner"], grantedToV2: { user: { userPrincipalName: "user@test.com" } } },
    ]);
    vi.mocked(graph.getCustomProperties).mockRejectedValue(new Error("not found"));

    const result = await getContainerTool.handler({ containerId: "c1" });
    expect(result.content[0].text).toContain("Test");
    expect(result.content[0].text).toContain("owner");
    expect(result.content[0].text).toContain("user@test.com");
    expect(result.content[0].text).toContain("d1");
  });

  it("handles missing permissions gracefully", async () => {
    vi.mocked(graph.getContainer).mockResolvedValue({
      id: "c1", displayName: "Test", containerTypeId: "ct1", status: "active",
    });
    vi.mocked(graph.getContainerDrive).mockRejectedValue(new Error("403"));
    vi.mocked(graph.listContainerPermissions).mockRejectedValue(new Error("403"));
    vi.mocked(graph.getCustomProperties).mockRejectedValue(new Error("403"));

    const result = await getContainerTool.handler({ containerId: "c1" });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("Test");
    expect(result.content[0].text).toContain("unavailable");
  });

  it("requires containerId", async () => {
    const result = await getContainerTool.handler({});
    expect(result.isError).toBe(true);
  });
});

// ─── container_permissions_manage ─────────────────────────────────────────────────

describe("container_permissions_manage", () => {
  it("adds permission successfully", async () => {
    vi.mocked(graph.addContainerPermission).mockResolvedValue({
      id: "p1", roles: ["writer"],
    });

    const result = await managePermissionsTool.handler({
      containerId: "c1", action: "add", userPrincipalName: "user@test.com", role: "writer",
    });
    expect(result.content[0].text).toContain("Permission added");
    expect(result.content[0].text).toContain("user@test.com");
  });

  it("handles 409 conflict on add", async () => {
    vi.mocked(graph.addContainerPermission).mockRejectedValue(new Error("Graph API error (409): conflict"));

    const result = await managePermissionsTool.handler({
      containerId: "c1", action: "add", userPrincipalName: "user@test.com", role: "writer",
    });
    expect(result.content[0].text).toContain("already has permissions");
  });

  it("updates permission", async () => {
    vi.mocked(graph.updateContainerPermission).mockResolvedValue();
    const result = await managePermissionsTool.handler({
      containerId: "c1", action: "update", permissionId: "p1", role: "manager",
    });
    expect(result.content[0].text).toContain("updated");
  });

  // role validation / no silent default-to-writer on update.
  it("refuses to silently default role on update (no privilege change)", async () => {
    vi.mocked(graph.updateContainerPermission).mockResolvedValue();
    const result = await managePermissionsTool.handler({
      containerId: "c1", action: "update", permissionId: "p1", // no role
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("role is required for update");
    // Critical: must NOT have mutated the grant to a defaulted writer role.
    expect(graph.updateContainerPermission).not.toHaveBeenCalled();
  });

  it("rejects an invalid role with an actionable error (update)", async () => {
    const result = await managePermissionsTool.handler({
      containerId: "c1", action: "update", permissionId: "p1", role: "admin",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("invalid role 'admin'");
    expect(graph.updateContainerPermission).not.toHaveBeenCalled();
  });

  it("rejects an invalid role with an actionable error (add)", async () => {
    const result = await managePermissionsTool.handler({
      containerId: "c1", action: "add", userPrincipalName: "user@test.com", role: "superuser",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("invalid role 'superuser'");
    expect(graph.addContainerPermission).not.toHaveBeenCalled();
  });

  it("accepts a valid explicit role on update", async () => {
    vi.mocked(graph.updateContainerPermission).mockResolvedValue();
    const result = await managePermissionsTool.handler({
      containerId: "c1", action: "update", permissionId: "p1", role: "reader",
    });
    expect(result.isError).toBeFalsy();
    expect(graph.updateContainerPermission).toHaveBeenCalledWith("c1", "p1", "reader");
    expect(result.content[0].text).toContain("reader");
  });

  it("removes permission", async () => {
    vi.mocked(graph.removeContainerPermission).mockResolvedValue();
    const result = await managePermissionsTool.handler({
      containerId: "c1", action: "remove", permissionId: "p1",
    });
    expect(result.content[0].text).toContain("removed");
  });

  it("requires userPrincipalName for add", async () => {
    const result = await managePermissionsTool.handler({ containerId: "c1", action: "add" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("userPrincipalName");
  });

  it("requires permissionId for update/remove", async () => {
    const r1 = await managePermissionsTool.handler({ containerId: "c1", action: "update" });
    expect(r1.isError).toBe(true);
    const r2 = await managePermissionsTool.handler({ containerId: "c1", action: "remove" });
    expect(r2.isError).toBe(true);
  });
});

// ─── container_archive_restore ────────────────────────────────────────────────────

describe("container_archive_restore", () => {
  it("archives an active container", async () => {
    vi.mocked(graph.getContainer).mockResolvedValue({
      id: "c1", displayName: "Test", containerTypeId: "ct1", status: "active", lockState: "unlocked",
    });
    vi.mocked(graph.lockContainer).mockResolvedValue();

    const result = await archiveRestoreTool.handler({ containerId: "c1", action: "archive" });
    expect(result.content[0].text).toContain("archived");
    expect(graph.lockContainer).toHaveBeenCalledWith("c1");
  });

  it("skips archive if already locked", async () => {
    vi.mocked(graph.getContainer).mockResolvedValue({
      id: "c1", displayName: "Test", containerTypeId: "ct1", status: "active", lockState: "lockedReadOnly",
    });

    const result = await archiveRestoreTool.handler({ containerId: "c1", action: "archive" });
    expect(result.content[0].text).toContain("already archived");
    expect(graph.lockContainer).not.toHaveBeenCalled();
  });

  it("restores a locked container", async () => {
    vi.mocked(graph.getContainer).mockResolvedValue({
      id: "c1", displayName: "Test", containerTypeId: "ct1", status: "active", lockState: "lockedReadOnly",
    });
    vi.mocked(graph.unlockContainer).mockResolvedValue();

    const result = await archiveRestoreTool.handler({ containerId: "c1", action: "restore" });
    expect(result.content[0].text).toContain("restored");
  });

  it("skips restore if already unlocked", async () => {
    vi.mocked(graph.getContainer).mockResolvedValue({
      id: "c1", displayName: "Test", containerTypeId: "ct1", status: "active", lockState: "unlocked",
    });

    const result = await archiveRestoreTool.handler({ containerId: "c1", action: "restore" });
    expect(result.content[0].text).toContain("already unlocked");
  });
});

// ─── container_delete ───────────────────────────────────────────────────

describe("container_delete", () => {
  it("soft-deletes a container", async () => {
    vi.mocked(graph.getContainer).mockResolvedValue({
      id: "c1", displayName: "Test", containerTypeId: "ct1", status: "active",
    });
    vi.mocked(graph.deleteContainer).mockResolvedValue();

    const result = await deleteContainerTool.handler({ containerId: "c1", action: "soft-delete" });
    expect(result.content[0].text).toContain("soft-deleted");
    expect(result.content[0].text).toContain("93-day");
  });

  it("permanently deletes a container (with confirm=true)", async () => {
    vi.mocked(graph.permanentDeleteContainer).mockResolvedValue();
    const result = await deleteContainerTool.handler({ containerId: "c1", action: "permanent-delete", confirm: true });
    expect(result.content[0].text).toContain("permanently deleted");
    expect(result.content[0].text).toContain("IRREVERSIBLE");
    expect(graph.permanentDeleteContainer).toHaveBeenCalledWith("c1");
  });

  it("blocks permanent-delete without confirm and does NOT call Graph (SAFE-002)", async () => {
    const result = await deleteContainerTool.handler({ containerId: "c1", action: "permanent-delete" });
    expect(result.isError).toBe(true);
    expect((result.structuredContent as { error?: { code?: string } }).error?.code).toBe("CONFIRMATION_REQUIRED");
    expect(graph.permanentDeleteContainer).not.toHaveBeenCalled();
  });

  it("blocks permanent-delete when confirm is not strictly true (SAFE-002)", async () => {
    const result = await deleteContainerTool.handler({ containerId: "c1", action: "permanent-delete", confirm: "yes" });
    expect(result.isError).toBe(true);
    expect(graph.permanentDeleteContainer).not.toHaveBeenCalled();
  });

  it("restores a deleted container", async () => {
    vi.mocked(graph.restoreDeletedContainer).mockResolvedValue();
    const result = await deleteContainerTool.handler({ containerId: "c1", action: "restore" });
    expect(result.content[0].text).toContain("restored");
  });
});
