// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Unit tests for the container-type-registration application-permission-grant tools
 * (v1.0 `applicationPermissionGrants` on a container type registration).
 * graph-client / auth / state are mocked so these run offline.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../graph-client.js", () => ({
  grantContainerTypeAppPermission: vi.fn(async (_ct: string, appId: string, del: string[], app: string[]) => ({
    appId,
    delegatedPermissions: del,
    applicationPermissions: app,
  })),
  listContainerTypeAppPermissions: vi.fn(async () => [
    { appId: "app-1", delegatedPermissions: ["full"], applicationPermissions: ["full"] },
    { appId: "app-2", delegatedPermissions: ["read"], applicationPermissions: ["none"] },
  ]),
  revokeContainerTypeAppPermission: vi.fn(async () => undefined),
}));
vi.mock("../auth.js", () => ({ setAuthConfig: vi.fn() }));

const stateStore: Record<string, unknown> = {};
vi.mock("../state.js", () => ({ readState: vi.fn(() => ({ ...stateStore })) }));

import * as graph from "../graph-client.js";
import { setAuthConfig } from "../auth.js";
import { getSessionId } from "../session.js";
import {
  addContainerTypeAppGrantTool,
  listContainerTypeAppGrantsTool,
  removeContainerTypeAppGrantTool,
} from "./container-type-app-grants.js";

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of Object.keys(stateStore)) delete stateStore[k];
  // r-appgate: these tools are control-plane mutations gated by the restart
  // confirmation guard; seed a confirmed session so the gate no-ops and the
  // tool's own logic is exercised. The gate itself is covered in
  // context-gate.test.ts.
  Object.assign(stateStore, { appId: "app-1", tenantId: "t-1", containerTypeId: "ct-1", confirmedSessionId: getSessionId() });
});

describe("container_type_registration_app_grant_add", () => {
  it("defaults the container type + appId to state and grants `full` delegated / `none` app-only (opt-in)", async () => {
    const r = await addContainerTypeAppGrantTool.handler({});
    expect(setAuthConfig).toHaveBeenCalledWith({ clientId: "app-1", tenantId: "t-1" });
    expect(graph.grantContainerTypeAppPermission).toHaveBeenCalledWith("ct-1", "app-1", ["full"], ["none"]);
    expect(r.isError).toBeFalsy();
    expect(r.content[0].text).toContain("app-1");
  });

  it("opt-in: app-only permissions require an explicit `full` (least-privilege default otherwise)", async () => {
    await addContainerTypeAppGrantTool.handler({ appId: "app-2", applicationPermissions: ["full"] });
    expect(graph.grantContainerTypeAppPermission).toHaveBeenCalledWith("ct-1", "app-2", ["full"], ["full"]);
  });

  it("authorizes an explicit secondary app with custom permissions", async () => {
    const r = await addContainerTypeAppGrantTool.handler({
      appId: "app-2",
      delegatedPermissions: ["readContent", "writeContent"],
      applicationPermissions: ["none"],
    });
    expect(graph.grantContainerTypeAppPermission).toHaveBeenCalledWith(
      "ct-1",
      "app-2",
      ["readContent", "writeContent"],
      ["none"],
    );
    expect(r.content[0].text).toContain("readContent, writeContent");
  });

  it("accepts a comma-separated permissions string", async () => {
    await addContainerTypeAppGrantTool.handler({ appId: "app-2", delegatedPermissions: "read, write" });
    expect(graph.grantContainerTypeAppPermission).toHaveBeenCalledWith("ct-1", "app-2", ["read", "write"], ["none"]);
  });

  it("errors when no container type is known", async () => {
    delete stateStore.containerTypeId;
    const r = await addContainerTypeAppGrantTool.handler({});
    expect(r.isError).toBe(true);
    expect(graph.grantContainerTypeAppPermission).not.toHaveBeenCalled();
  });

  it("errors when no appId is known", async () => {
    delete stateStore.appId;
    const r = await addContainerTypeAppGrantTool.handler({});
    expect(r.isError).toBe(true);
    expect(graph.grantContainerTypeAppPermission).not.toHaveBeenCalled();
  });
});

describe("container_type_registration_app_grants_list", () => {
  it("lists grants for the provisioned container type", async () => {
    const r = await listContainerTypeAppGrantsTool.handler({});
    expect(graph.listContainerTypeAppPermissions).toHaveBeenCalledWith("ct-1");
    expect(r.content[0].text).toContain("app-1");
    expect(r.content[0].text).toContain("app-2");
  });

  it("reports an empty collection clearly", async () => {
    vi.mocked(graph.listContainerTypeAppPermissions).mockResolvedValueOnce([]);
    const r = await listContainerTypeAppGrantsTool.handler({ containerTypeId: "ct-9" });
    expect(graph.listContainerTypeAppPermissions).toHaveBeenCalledWith("ct-9");
    expect(r.content[0].text).toContain("No application permission grants");
  });
});

describe("container_type_registration_app_grant_remove", () => {
  it("removes a grant by appId", async () => {
    const r = await removeContainerTypeAppGrantTool.handler({ appId: "app-2" });
    expect(graph.revokeContainerTypeAppPermission).toHaveBeenCalledWith("ct-1", "app-2");
    expect(r.isError).toBeFalsy();
  });

  it("requires an appId", async () => {
    const r = await removeContainerTypeAppGrantTool.handler({});
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("see container_type_registration_app_grants_list");
    expect(graph.revokeContainerTypeAppPermission).not.toHaveBeenCalled();
  });
});

describe("registration app-grant public contract", () => {
  it.each([
    [addContainerTypeAppGrantTool, "container_type_registration_app_grant_add", { plane: "control" }, []],
    [listContainerTypeAppGrantsTool, "container_type_registration_app_grants_list", { readOnly: true }, []],
    [removeContainerTypeAppGrantTool, "container_type_registration_app_grant_remove", { destructive: true, plane: "control" }, ["appId"]],
  ] as const)("preserves registration-scoped names and metadata (%#)", (tool, name, annotations, required) => {
    expect(tool.name).toBe(name);
    expect(tool.annotations).toEqual(annotations);
    expect(tool.inputSchema.required ?? []).toEqual(required);
    expect(tool.description).toContain("container type registration");
    expect(tool.description).toContain("Microsoft Graph v1.0");
  });

  it.each([addContainerTypeAppGrantTool, removeContainerTypeAppGrantTool])(
    "$name still asks to confirm a remembered context before mutating grants",
    async (tool) => {
      delete stateStore.confirmedSessionId;
      const r = await tool.handler({ appId: "app-2" });
      expect(r.content[0].text).toContain("Confirm the active SharePoint Embedded context");
      expect(graph.grantContainerTypeAppPermission).not.toHaveBeenCalled();
      expect(graph.revokeContainerTypeAppPermission).not.toHaveBeenCalled();
      expect(setAuthConfig).not.toHaveBeenCalled();
    },
  );
});
