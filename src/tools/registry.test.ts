// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Unit tests for the tool registry and server setup.
 *
 * Validates that all tools are registered, have valid schemas,
 * and the MCP server dispatches correctly.
 */

import { describe, it, expect, vi } from "vitest";

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
import { createContainerTool } from "../tools/create-container.js";
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
  createContainerTool,
  listContainersTool,
  getContainerTool,
  managePermissionsTool,
  archiveRestoreTool,
  deleteContainerTool,
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
  it("has 40 tools registered", () => {
    expect(ALL_TOOLS).toHaveLength(40);
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
      "container_type_app_grant_add",
      "container_type_app_grants_list",
      "container_type_app_grant_remove",
      "container_create",
      "container_list",
      "container_get",
      "container_permissions_manage",
      "container_archive_restore",
      "container_delete",
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
