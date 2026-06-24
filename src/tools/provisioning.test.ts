// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Unit tests for Phase 1 provisioning tools:
 * project_app_create, container_type_register, container_create.
 * Graph client, bootstrap, auth, and state are mocked so these run offline.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../graph-client.js", () => ({
  findApplicationByName: vi.fn(),
  findApplicationByAppId: vi.fn(),
  createApplication: vi.fn(),
  addSpePermissions: vi.fn(),
  addSpaRedirectUris: vi.fn(),
  registerContainerType: vi.fn(),
  createContainer: vi.fn(),
  activateContainer: vi.fn(),
}));
vi.mock("../bootstrap.js", () => ({
  bootstrapTokenProvider: vi.fn(async () => "boot-token"),
  getSignedInIdentity: vi.fn(),
}));
vi.mock("../auth.js", () => ({ setAuthConfig: vi.fn() }));

const stateStore: Record<string, unknown> = {};
vi.mock("../state.js", () => ({
  readState: vi.fn(() => ({ ...stateStore })),
  writeState: vi.fn((patch: Record<string, unknown>) => {
    Object.assign(stateStore, patch);
    return { ...stateStore };
  }),
}));

import * as graph from "../graph-client.js";
import * as bootstrap from "../bootstrap.js";
import { setAuthConfig } from "../auth.js";
import { createAppTool } from "../tools/create-app.js";
import { registerContainerTypeTool } from "../tools/register-container-type.js";
import { createContainerTool } from "../tools/create-container.js";

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of Object.keys(stateStore)) delete stateStore[k];
});

// ─── project_app_create ──────────────────────────────────────────────────────────

describe("project_app_create", () => {
  it("creates an owning app, adds permissions, persists state, points auth at it", async () => {
    vi.mocked(bootstrap.getSignedInIdentity).mockResolvedValue({ tenantId: "t-1", username: "dev@x.com" });
    vi.mocked(graph.findApplicationByName).mockResolvedValue(null);
    vi.mocked(graph.createApplication).mockResolvedValue({ appId: "app-1", objectId: "obj-1", displayName: "My App" });

    const result = await createAppTool.handler({ displayName: "My App" });

    expect(result.isError).toBeFalsy();
    expect(graph.createApplication).toHaveBeenCalledWith("My App", expect.any(Function));
    expect(graph.addSpePermissions).toHaveBeenCalledWith("obj-1", expect.any(Function));
    expect(setAuthConfig).toHaveBeenCalledWith({ clientId: "app-1", tenantId: "t-1" });
    expect(result.content[0].text).toContain("app-1");
    expect(stateStore.appId).toBe("app-1");
  });

  it("reuses an existing app (idempotent) without creating", async () => {
    vi.mocked(bootstrap.getSignedInIdentity).mockResolvedValue({ tenantId: "t-1", username: "dev@x.com" });
    vi.mocked(graph.findApplicationByName).mockResolvedValue({ appId: "app-9", objectId: "obj-9", displayName: "Existing" });

    const result = await createAppTool.handler({ displayName: "Existing" });

    expect(graph.createApplication).not.toHaveBeenCalled();
    expect(result.content[0].text).toContain("Found");
    expect(stateStore.appId).toBe("app-9");
  });

  it("targets an explicit displayName even when state holds a different appId", async () => {
    stateStore.appId = "persisted-app";
    vi.mocked(bootstrap.getSignedInIdentity).mockResolvedValue({ tenantId: "t-1", username: "dev@x.com" });
    vi.mocked(graph.findApplicationByName).mockResolvedValue({ appId: "named-app", objectId: "obj-2", displayName: "Other App" });

    const result = await createAppTool.handler({ displayName: "Other App" });

    expect(result.isError).toBeFalsy();
    // Explicit name -> resolve BY NAME, not by the persisted appId.
    expect(graph.findApplicationByName).toHaveBeenCalledWith("Other App", expect.any(Function));
    expect(graph.findApplicationByAppId).not.toHaveBeenCalled();
    expect(stateStore.appId).toBe("named-app");
  });

  it("asks before reusing a remembered app when no displayName/appSelection is given", async () => {
    stateStore.appId = "persisted-app";
    stateStore.appDisplayName = "Remembered App";
    vi.mocked(bootstrap.getSignedInIdentity).mockResolvedValue({ tenantId: "t-1", username: "dev@x.com" });

    const result = await createAppTool.handler({});

    // Elicitation, not a silent resume.
    expect(result.content[0].text).toContain("Reuse");
    expect(result.content[0].text).toContain("appSelection=reuse");
    expect(graph.findApplicationByAppId).not.toHaveBeenCalled();
    expect(graph.findApplicationByName).not.toHaveBeenCalled();
    expect(graph.createApplication).not.toHaveBeenCalled();
  });

  it("resumes the persisted appId when reuse is chosen", async () => {
    stateStore.appId = "persisted-app";
    vi.mocked(bootstrap.getSignedInIdentity).mockResolvedValue({ tenantId: "t-1", username: "dev@x.com" });
    vi.mocked(graph.findApplicationByAppId).mockResolvedValue({ appId: "persisted-app", objectId: "obj-3", displayName: "SPE Builder App" });

    const result = await createAppTool.handler({ appSelection: "reuse" });

    expect(result.isError).toBeFalsy();
    expect(graph.findApplicationByAppId).toHaveBeenCalledWith("persisted-app", expect.any(Function));
    expect(graph.findApplicationByName).not.toHaveBeenCalled();
    expect(stateStore.appId).toBe("persisted-app");
  });

  it("errors when not signed into az", async () => {
    vi.mocked(bootstrap.getSignedInIdentity).mockResolvedValue(null);

    const result = await createAppTool.handler({});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("az login");
    expect(graph.createApplication).not.toHaveBeenCalled();
  });
});

// ─── container_type_register ─────────────────────────────────────────────

describe("container_type_register", () => {
  it("registers using state defaults", async () => {
    stateStore.containerTypeId = "ct-1";
    stateStore.appId = "app-1";

    const result = await registerContainerTypeTool.handler({});

    expect(graph.registerContainerType).toHaveBeenCalledWith("ct-1", "app-1");
    expect(result.content[0].text).toContain("Registered");
  });

  it("errors when no owning app is available", async () => {
    stateStore.containerTypeId = "ct-1";

    const result = await registerContainerTypeTool.handler({});

    expect(result.isError).toBe(true);
    expect(graph.registerContainerType).not.toHaveBeenCalled();
  });
});

// ─── container_create ────────────────────────────────────────────────────

describe("container_create", () => {
  it("creates and activates a container, persisting state", async () => {
    stateStore.containerTypeId = "ct-1";
    vi.mocked(graph.createContainer).mockResolvedValue({
      id: "c-1", displayName: "Files", containerTypeId: "ct-1", status: "inactive",
    });

    const result = await createContainerTool.handler({ displayName: "Files" });

    expect(graph.createContainer).toHaveBeenCalledWith("ct-1", "Files");
    expect(graph.activateContainer).toHaveBeenCalledWith("c-1");
    expect(result.content[0].text).toContain("Container Created");
    expect(stateStore.containerId).toBe("c-1");
  });

  it("does not re-activate an already-active container", async () => {
    stateStore.containerTypeId = "ct-1";
    vi.mocked(graph.createContainer).mockResolvedValue({
      id: "c-2", displayName: "Files", containerTypeId: "ct-1", status: "active",
    });

    await createContainerTool.handler({ displayName: "Files" });

    expect(graph.activateContainer).not.toHaveBeenCalled();
  });

  it("errors when no container type is available", async () => {
    const result = await createContainerTool.handler({ displayName: "Files" });
    expect(result.isError).toBe(true);
    expect(graph.createContainer).not.toHaveBeenCalled();
  });

  // permanent errors must fail fast (no ~150s propagation hang).
  it("fails fast on a permanent invalid containerTypeId (no retry)", async () => {
    stateStore.containerTypeId = "bad-ct";
    vi.mocked(graph.createContainer).mockRejectedValue(
      new Error("Resource not found: container type does not exist"),
    );

    const result = await createContainerTool.handler({ displayName: "Files" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("after 1 attempt");
    // Exactly one attempt — no transient-style retry/backoff.
    expect(graph.createContainer).toHaveBeenCalledTimes(1);
    expect(graph.activateContainer).not.toHaveBeenCalled();
  });

  it("retries through a registration-propagation delay, then succeeds", async () => {
    vi.useFakeTimers();
    try {
      stateStore.containerTypeId = "ct-1";
      vi.mocked(graph.createContainer)
        .mockRejectedValueOnce(new Error("Container type is not registered on this tenant yet"))
        .mockResolvedValueOnce({
          id: "c-9", displayName: "Files", containerTypeId: "ct-1", status: "active",
        });

      const promise = createContainerTool.handler({ displayName: "Files" });
      // Advance past the first backoff (15s) so the retry runs.
      await vi.advanceTimersByTimeAsync(15_000);
      const result = await promise;

      expect(result.isError).toBeFalsy();
      expect(graph.createContainer).toHaveBeenCalledTimes(2);
      expect(result.content[0].text).toContain("Container Created");
      expect(stateStore.containerId).toBe("c-9");
    } finally {
      vi.useRealTimers();
    }
  });
});
