// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Unit tests for the tool registry and server setup.
 *
 * Validates that all tools are registered, have valid schemas,
 * and the MCP server dispatches correctly.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const protocol = vi.hoisted(() => ({
  server: undefined as import("@modelcontextprotocol/sdk/server/index.js").Server | undefined,
}));

vi.mock("@modelcontextprotocol/sdk/server/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@modelcontextprotocol/sdk/server/index.js")>();
  return {
    ...actual,
    Server: class extends actual.Server {
      constructor(...args: ConstructorParameters<typeof actual.Server>) {
        super(...args);
        protocol.server = this;
      }
    },
  };
});

vi.mock("../graph-client.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../graph-client.js")>(),
  grantContainerTypeAppPermission: vi.fn(async (_ct: string, appId: string, delegatedPermissions: string[], applicationPermissions: string[]) => ({
    appId, delegatedPermissions, applicationPermissions,
  })),
  listContainerTypeAppPermissions: vi.fn(async () => [
    { appId: "app-2", delegatedPermissions: ["full"], applicationPermissions: ["none"] },
  ]),
  revokeContainerTypeAppPermission: vi.fn(async () => undefined),
}));

vi.mock("../state.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../state.js")>(),
  readState: vi.fn(),
}));

// Mock auth to avoid real MSAL initialization
vi.mock("../auth.js", () => ({
  getAccessToken: vi.fn().mockResolvedValue("mock-token"),
  initializeAuth: vi.fn().mockResolvedValue(undefined),
  setAuthConfig: vi.fn(),
}));

// Get tool list by reading index.ts tool registration
// We re-import the tools directly to validate their metadata
import { listContainerTypesTool } from "../tools/list-container-types.js";
import { createContainerTypeTool } from "../tools/create-container-type.js";
import { listContainersTool } from "../tools/list-containers.js";
import { getContainerTool } from "../tools/get-container.js";
import { managePermissionsTool } from "../tools/manage-permissions.js";
import { archiveRestoreTool } from "../tools/archive-restore.js";
import { deleteContainerTool } from "../tools/delete-container.js";
import { uploadFileTool } from "../tools/upload-file.js";
import { createFolderTool } from "../tools/create-folder.js";
import { searchContentTool } from "../tools/search-content.js";
import { previewFileTool } from "../tools/preview-file.js";
import { manageSharingTool } from "../tools/manage-sharing.js";
import { checkBillingTool } from "../tools/check-billing.js";
import { setupBillingTool } from "../tools/setup-billing.js";
import { searchDocsTool, fetchDocTool } from "../tools/search-docs.js";
import { statusTool } from "../tools/status.js";
import { createAppTool } from "../tools/create-app.js";
import { registerContainerTypeTool } from "../tools/register-container-type.js";
import { getContainerTypeTool, updateContainerTypeTool, deleteContainerTypeTool } from "../tools/container-type-crud.js";
import { grantContainerTypeOwnerTool, listContainerTypeOwnersTool, revokeContainerTypeOwnerTool } from "../tools/container-type-permissions.js";
import { addContainerTypeAppGrantTool, listContainerTypeAppGrantsTool, removeContainerTypeAppGrantTool } from "../tools/container-type-app-grants.js";
import { getContainerTypeRegistrationTool, listContainerTypeRegistrationsTool, deleteContainerTypeRegistrationTool } from "../tools/container-type-registration.js";
import { createContainerTool } from "../tools/create-container.js";
import { updateContainerTool } from "../tools/update-container.js";
import { listDeletedContainersTool } from "../tools/list-deleted-containers.js";
import { provisionTool } from "../tools/provision.js";
import { listSubscriptionsTool, listResourceGroupsTool } from "../tools/list-azure.js";
import { hydrateConfigTool } from "../tools/hydrate-config.js";
import { scaffoldTool } from "../tools/scaffold.js";
import { seedSampleDataTool } from "../tools/seed-sample-data.js";
import { runLocalTool } from "../tools/run-local.js";
import { deployAzureTool } from "../tools/deploy-azure.js";
import { grantContentAccessTool, revokeContentAccessTool } from "../tools/content-access.js";
import { cleanupTool } from "../tools/cleanup.js";
import type { McpTool } from "../types.js";
import * as graph from "../graph-client.js";
import { readState } from "../state.js";
import { getSessionId } from "../session.js";

const ALL_TOOLS: McpTool[] = [
  statusTool,
  createAppTool,
  provisionTool,
  listContainerTypesTool,
  createContainerTypeTool,
  registerContainerTypeTool,
  getContainerTypeTool,
  updateContainerTypeTool,
  deleteContainerTypeTool,
  grantContainerTypeOwnerTool,
  listContainerTypeOwnersTool,
  revokeContainerTypeOwnerTool,
  addContainerTypeAppGrantTool,
  listContainerTypeAppGrantsTool,
  removeContainerTypeAppGrantTool,
  getContainerTypeRegistrationTool,
  listContainerTypeRegistrationsTool,
  deleteContainerTypeRegistrationTool,
  createContainerTool,
  listContainersTool,
  getContainerTool,
  updateContainerTool,
  managePermissionsTool,
  archiveRestoreTool,
  deleteContainerTool,
  listDeletedContainersTool,
  uploadFileTool,
  createFolderTool,
  searchContentTool,
  previewFileTool,
  manageSharingTool,
  checkBillingTool,
  setupBillingTool,
  listSubscriptionsTool,
  listResourceGroupsTool,
  hydrateConfigTool,
  scaffoldTool,
  seedSampleDataTool,
  runLocalTool,
  deployAzureTool,
  grantContentAccessTool,
  revokeContentAccessTool,
  cleanupTool,
  searchDocsTool,
  fetchDocTool,
];

describe("Tool Registry", () => {
  it("has 45 canonical tools registered", () => {
    expect(ALL_TOOLS).toHaveLength(45);
  });

  it("all tools have unique names", () => {
    const names = ALL_TOOLS.map(t => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("all tool names use portable grouped snake_case format", () => {
    for (const tool of ALL_TOOLS) {
      // Permanent portable-format invariant (replaces the legacy /^spe_/ prefix check).
      expect(tool.name).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(tool.name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
      expect(tool.name.length).toBeLessThanOrEqual(64);
    }
  });

  it("all tools have descriptions", () => {
    for (const tool of ALL_TOOLS) {
      expect(tool.description).toBeTruthy();
      expect(tool.description.length).toBeGreaterThan(20);
    }
  });

  it("all tools have valid input schemas", () => {
    for (const tool of ALL_TOOLS) {
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.inputSchema.properties).toBeDefined();
    }
  });

  it("all tools have handler functions", () => {
    for (const tool of ALL_TOOLS) {
      expect(typeof tool.handler).toBe("function");
    }
  });

  it("tool names match expected catalog", () => {
    const expected = [
      "status_get",
      "project_app_create",
      "project_provision",
      "container_type_list",
      "container_type_create",
      "container_type_register",
      "container_type_get",
      "container_type_update",
      "container_type_delete",
      "container_type_grant_owner",
      "container_type_owners_list",
      "container_type_revoke_owner",
      "container_type_registration_app_grant_add",
      "container_type_registration_app_grants_list",
      "container_type_registration_app_grant_remove",
      "container_type_registration_get",
      "container_type_registration_list",
      "container_type_registration_delete",
      "container_create",
      "container_list",
      "container_get",
      "container_update",
      "container_permissions_manage",
      "container_archive_restore",
      "container_delete",
      "container_deleted_list",
      "content_file_upload",
      "content_folder_create",
      "content_search",
      "content_file_preview",
      "content_sharing_manage",
      "billing_check",
      "billing_setup",
      "azure_subscriptions_list",
      "azure_resource_groups_list",
      "project_hydrate_config",
      "project_scaffold",
      "project_seed_sample_data",
      "project_run_local",
      "project_deploy",
      "content_access_grant",
      "content_access_revoke",
      "project_cleanup",
      "docs_search",
      "docs_fetch",
    ];
    const actual = ALL_TOOLS.map(t => t.name).sort();
    expect(actual).toEqual(expected.sort());
  });

  const APP_GRANT_CASES = [
    {
      label: "add",
      canonical: "container_type_registration_app_grant_add",
      compatibility: "container_type_app_grant_add",
      tool: addContainerTypeAppGrantTool,
      args: { appId: "app-2" },
    },
    {
      label: "list",
      canonical: "container_type_registration_app_grants_list",
      compatibility: "container_type_app_grants_list",
      tool: listContainerTypeAppGrantsTool,
      args: {},
    },
    {
      label: "remove",
      canonical: "container_type_registration_app_grant_remove",
      compatibility: "container_type_app_grant_remove",
      tool: removeContainerTypeAppGrantTool,
      args: { appId: "app-2" },
    },
  ];

  describe("App grant registration names over MCP", () => {
    const client = new Client({ name: "app-grant-regression", version: "1.0.0" });
    const handlerSpies = APP_GRANT_CASES.map(({ tool }) => vi.spyOn(tool, "handler"));

    beforeAll(async () => {
      vi.mocked(readState).mockReturnValue({
        appId: "app-1",
        tenantId: "t-1",
        containerTypeId: "ct-1",
        confirmedSessionId: getSessionId(),
      });
      await import("../index.js");
      if (!protocol.server) throw new Error("The MCP server was not created");
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await protocol.server.connect(serverTransport);
      await client.connect(clientTransport);
    });

    beforeEach(() => {
      vi.clearAllMocks();
    });

    afterAll(async () => {
      await client.close();
      await protocol.server?.close();
      for (const spy of handlerSpies) spy.mockRestore();
    });

    it("discovers unique canonical tools followed by deprecated compatibility entries", async () => {
      const { tools } = await client.listTools();
      expect(tools).toHaveLength(48);
      expect(new Set(tools.map(({ name }) => name)).size).toBe(tools.length);
      const grantNames = new Set(APP_GRANT_CASES.flatMap(({ canonical, compatibility }) => [canonical, compatibility]));
      expect(tools.filter(({ name }) => grantNames.has(name)).map(({ name }) => name)).toEqual([
        ...APP_GRANT_CASES.map(({ canonical }) => canonical),
        ...APP_GRANT_CASES.map(({ compatibility }) => compatibility),
      ]);
    });

    for (const { label, canonical, compatibility, tool, args } of APP_GRANT_CASES) {
      it(`${label}: discovers equivalent schemas and annotation values for both names`, async () => {
        const { tools } = await client.listTools();
        const canonicalEntry = tools.find(({ name }) => name === canonical);
        const compatibilityEntry = tools.find(({ name }) => name === compatibility);
        expect(canonicalEntry).toBeDefined();
        expect(compatibilityEntry).toBeDefined();
        expect(canonicalEntry?.description).toBe(tool.description);
        expect(canonicalEntry?.description).toContain("container type registration");
        expect(compatibilityEntry?.description).toBe(`Deprecated: use ${canonical}. ${tool.description}`);
        expect(canonicalEntry?.inputSchema).toEqual(tool.inputSchema);
        expect(compatibilityEntry?.inputSchema).toEqual(canonicalEntry?.inputSchema);
        expect(canonicalEntry?.annotations?.readOnlyHint).toBe(tool.annotations?.readOnly);
        expect(canonicalEntry?.annotations?.destructiveHint).toBe(tool.annotations?.destructive);
        expect(canonicalEntry?.annotations?.idempotentHint).toBe(tool.annotations?.idempotent);
        expect(compatibilityEntry?.annotations?.readOnlyHint).toBe(canonicalEntry?.annotations?.readOnlyHint);
        expect(compatibilityEntry?.annotations?.destructiveHint).toBe(canonicalEntry?.annotations?.destructiveHint);
        expect(compatibilityEntry?.annotations?.idempotentHint).toBe(canonicalEntry?.annotations?.idempotentHint);
      });

      it(`${label}: canonical and compatibility calls invoke the same exported handler`, async () => {
        const canonicalResult = await client.callTool({ name: canonical, arguments: args });
        const compatibilityResult = await client.callTool({ name: compatibility, arguments: args });
        expect(canonicalResult.isError).toBeFalsy();
        expect(compatibilityResult.isError).toBeFalsy();
        expect(compatibilityResult.content).toEqual(canonicalResult.content);
        expect(tool.handler).toHaveBeenCalledTimes(2);
        expect(tool.handler).toHaveBeenNthCalledWith(1, args);
        expect(tool.handler).toHaveBeenNthCalledWith(2, args);
        if (label === "add") {
          expect(graph.grantContainerTypeAppPermission).toHaveBeenCalledTimes(2);
          expect(graph.grantContainerTypeAppPermission).toHaveBeenCalledWith("ct-1", "app-2", ["full"], ["none"]);
        } else if (label === "list") {
          expect(graph.listContainerTypeAppPermissions).toHaveBeenCalledTimes(2);
          expect(graph.listContainerTypeAppPermissions).toHaveBeenCalledWith("ct-1");
        } else {
          expect(graph.revokeContainerTypeAppPermission).toHaveBeenCalledTimes(2);
          expect(graph.revokeContainerTypeAppPermission).toHaveBeenCalledWith("ct-1", "app-2");
        }
      });
    }

    it("both remove discovery entries recommend the canonical list tool", async () => {
      const { tools } = await client.listTools();
      for (const name of [
        "container_type_registration_app_grant_remove",
        "container_type_app_grant_remove",
      ]) {
        expect(tools.find((tool) => tool.name === name)?.inputSchema.properties?.appId).toMatchObject({
          description: expect.stringContaining("container_type_registration_app_grants_list"),
        });
      }
    });

    it("both remove names reject missing appId with the structured protocol error before invoking the handler", async () => {
      for (const name of [
        "container_type_registration_app_grant_remove",
        "container_type_app_grant_remove",
      ]) {
        const result = await client.callTool({ name, arguments: {} });
        expect(result.isError).toBe(true);
        expect(result.structuredContent).toMatchObject({
          ok: false,
          error: { code: "INVALID_ARGS", message: "Missing required argument: appId" },
        });
        expect(result.content).toEqual(expect.arrayContaining([
          expect.objectContaining({ type: "text", text: expect.stringContaining("Missing required argument: appId") }),
        ]));
      }
      expect(removeContainerTypeAppGrantTool.handler).not.toHaveBeenCalled();
      expect(graph.revokeContainerTypeAppPermission).not.toHaveBeenCalled();
    });

    it("both remove names preserve canonical list guidance in the missing-appId handler response", async () => {
      for (const name of [
        "container_type_registration_app_grant_remove",
        "container_type_app_grant_remove",
      ]) {
        const result = await client.callTool({ name, arguments: { appId: "" } });
        expect(result.isError).toBe(true);
        expect(result.content).toEqual(expect.arrayContaining([
          expect.objectContaining({
            type: "text",
            text: "Error: appId is required (see container_type_registration_app_grants_list).",
          }),
        ]));
      }
      expect(removeContainerTypeAppGrantTool.handler).toHaveBeenCalledTimes(2);
      expect(graph.revokeContainerTypeAppPermission).not.toHaveBeenCalled();
    });
  });
});

describe("Tool Input Validation", () => {
  it("tools with required params list them in schema", () => {
    // Tools that should have required params
    const toolsWithRequired = [
      createContainerTypeTool,
      getContainerTool,
      managePermissionsTool,
      archiveRestoreTool,
      deleteContainerTool,
      uploadFileTool,
      createFolderTool,
      searchContentTool,
      previewFileTool,
      manageSharingTool,
      listResourceGroupsTool,
    ];

    for (const tool of toolsWithRequired) {
      expect(tool.inputSchema.required?.length).toBeGreaterThan(0);
    }
  });

  it("listContainerTypes has no required params", () => {
    expect(listContainerTypesTool.inputSchema.required).toBeUndefined();
  });

  it("container_list and billing_check have no required params (default containerTypeId from state)", () => {
    // These read tools default the container type from provisioning state, so a
    // 0-knowledge developer can call them with no arguments after provisioning.
    expect(listContainersTool.inputSchema.required).toBeUndefined();
    expect(checkBillingTool.inputSchema.required).toBeUndefined();
  });
});
