// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Unit tests for the container-type registration CRUDL tools, the recycle-bin
 * list tool, and container_update (rename) — the operations added to close the
 * container-type teardown gap.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../graph-client.js", () => ({
  getContainerTypeRegistration: vi.fn(),
  listContainerTypeRegistrations: vi.fn(),
  deleteContainerTypeRegistration: vi.fn(),
  listContainers: vi.fn(),
  listDeletedContainers: vi.fn(),
  updateContainer: vi.fn(),
}));

// Deterministic state regardless of the dev machine's ~/.spe-mcp/state.json.
vi.mock("../state.js", () => ({
  readState: vi.fn(() => ({ appId: "app-1", tenantId: "tenant-1", containerTypeId: "ct-1", containerId: "cid-1" })),
  writeState: vi.fn(),
}));
vi.mock("../auth.js", () => ({ setAuthConfig: vi.fn() }));

import * as graph from "../graph-client.js";
import { AppError } from "../errors.js";
import {
  getContainerTypeRegistrationTool,
  listContainerTypeRegistrationsTool,
  deleteContainerTypeRegistrationTool,
} from "../tools/container-type-registration.js";
import { listDeletedContainersTool } from "../tools/list-deleted-containers.js";
import { updateContainerTool } from "../tools/update-container.js";

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── container_type_registration_get / _list ─────────────────────────────────

describe("container_type_registration_get", () => {
  it("reads a registration and defaults the id from state", async () => {
    vi.mocked(graph.getContainerTypeRegistration).mockResolvedValue({
      id: "ct-1",
      registeredByAppId: "app-1",
      applicationPermissionGrants: [{ appId: "app-1", delegatedPermissions: ["full"], applicationPermissions: ["full"] }],
    });
    const r = await getContainerTypeRegistrationTool.handler({});
    expect(graph.getContainerTypeRegistration).toHaveBeenCalledWith("ct-1");
    expect(r.content[0].text).toContain("Container Type Registration");
    expect(r.content[0].text).toContain("app-1");
  });
});

describe("container_type_registration_list", () => {
  it("lists registrations", async () => {
    vi.mocked(graph.listContainerTypeRegistrations).mockResolvedValue([
      { id: "ct-1", registeredByAppId: "app-1" },
      { id: "ct-2", registeredByAppId: "app-2" },
    ]);
    const r = await listContainerTypeRegistrationsTool.handler({});
    expect(r.content[0].text).toContain("Container Type Registrations (2)");
    expect(r.content[0].text).toContain("ct-2");
  });

  it("handles an empty tenant", async () => {
    vi.mocked(graph.listContainerTypeRegistrations).mockResolvedValue([]);
    const r = await listContainerTypeRegistrationsTool.handler({});
    expect(r.content[0].text).toContain("No container type registrations");
  });
});

// ─── container_type_registration_delete ──────────────────────────────────────

describe("container_type_registration_delete", () => {
  it("requires confirm and surfaces blockers in the preview", async () => {
    vi.mocked(graph.listContainers).mockResolvedValue([{ id: "c1" } as never]);
    vi.mocked(graph.listDeletedContainers).mockResolvedValue([{ id: "d1" } as never, { id: "d2" } as never]);

    const r = await deleteContainerTypeRegistrationTool.handler({ containerTypeId: "ct-1" });
    expect(graph.deleteContainerTypeRegistration).not.toHaveBeenCalled();
    expect(r.content[0].text).toContain("Confirm delete registration");
    expect(r.content[0].text).toContain("1 live container(s)");
    expect(r.content[0].text).toContain("2 recycle-bin container(s)");
  });

  it("fails fast (no DELETE) when confirmed but containers still exist", async () => {
    vi.mocked(graph.listContainers).mockResolvedValue([{ id: "c1" } as never]);
    vi.mocked(graph.listDeletedContainers).mockResolvedValue([]);

    const r = await deleteContainerTypeRegistrationTool.handler({ containerTypeId: "ct-1", confirm: true });
    expect(graph.deleteContainerTypeRegistration).not.toHaveBeenCalled();
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("still has 1 live container(s)");
    expect(r.content[0].text).toContain("container_deleted_list");
  });

  it("deletes the registration when confirmed and empty", async () => {
    vi.mocked(graph.listContainers).mockResolvedValue([]);
    vi.mocked(graph.listDeletedContainers).mockResolvedValue([]);
    vi.mocked(graph.deleteContainerTypeRegistration).mockResolvedValue(undefined);

    const r = await deleteContainerTypeRegistrationTool.handler({ containerTypeId: "ct-1", confirm: true });
    expect(graph.deleteContainerTypeRegistration).toHaveBeenCalledWith("ct-1");
    expect(r.isError).toBeFalsy();
    expect(r.content[0].text).toContain("Deleted container type registration");
  });

  it("treats NOT_FOUND as already-deleted (idempotent)", async () => {
    vi.mocked(graph.listContainers).mockResolvedValue([]);
    vi.mocked(graph.listDeletedContainers).mockResolvedValue([]);
    vi.mocked(graph.deleteContainerTypeRegistration).mockRejectedValue(
      new AppError("NOT_FOUND", "Resource not found"),
    );
    const r = await deleteContainerTypeRegistrationTool.handler({ containerTypeId: "ct-1", confirm: true });
    expect(r.isError).toBeFalsy();
    expect(r.content[0].text).toContain("already deleted");
  });

  it("maps a server-side CONFLICT to actionable guidance", async () => {
    vi.mocked(graph.listContainers).mockResolvedValue([]);
    vi.mocked(graph.listDeletedContainers).mockResolvedValue([]);
    vi.mocked(graph.deleteContainerTypeRegistration).mockRejectedValue(
      new AppError("CONFLICT", "Graph API conflict (409)"),
    );
    const r = await deleteContainerTypeRegistrationTool.handler({ containerTypeId: "ct-1", confirm: true });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("container_deleted_list");
  });
});

// ─── container_deleted_list (recycle bin) ─────────────────────────────────────

describe("container_deleted_list", () => {
  it("lists recycle-bin containers filtered by the provisioned container type by default", async () => {
    vi.mocked(graph.listDeletedContainers).mockResolvedValue([
      { id: "d1", displayName: "Gone", containerTypeId: "ct-1" } as never,
    ]);
    const r = await listDeletedContainersTool.handler({});
    expect(graph.listDeletedContainers).toHaveBeenCalledWith("ct-1");
    expect(r.content[0].text).toContain("Deleted Containers (recycle bin)");
    expect(r.content[0].text).toContain("Gone");
  });

  it("can list across all container types", async () => {
    vi.mocked(graph.listDeletedContainers).mockResolvedValue([]);
    const r = await listDeletedContainersTool.handler({ allContainerTypes: true });
    expect(graph.listDeletedContainers).toHaveBeenCalledWith(undefined);
    expect(r.content[0].text).toContain("No soft-deleted containers");
  });
});

// ─── container_update (rename) ────────────────────────────────────────────────

describe("container_update", () => {
  it("renames a container and syncs persisted state", async () => {
    const state = await import("../state.js");
    vi.mocked(graph.updateContainer).mockResolvedValue({ id: "cid-1", displayName: "New Name" } as never);
    const r = await updateContainerTool.handler({ displayName: "New Name" });
    expect(graph.updateContainer).toHaveBeenCalledWith("cid-1", { displayName: "New Name", description: undefined });
    expect(vi.mocked(state.writeState)).toHaveBeenCalledWith({ containerName: "New Name" });
    expect(r.content[0].text).toContain("Container Updated");
    expect(r.content[0].text).toContain("New Name");
  });

  it("rejects when nothing to update", async () => {
    const r = await updateContainerTool.handler({ containerId: "cid-9" });
    expect(graph.updateContainer).not.toHaveBeenCalled();
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("nothing to update");
  });
});
