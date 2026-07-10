// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Regression tests for the restart-confirmation gate error classification
 * (PR #3 review).
 *
 * On `contextChoice=confirm` the gate stamps the session confirmed, which writes
 * state to disk (writeState → writeSecureFile, a 0o600 write that can fail with
 * EACCES/EIO). The gate call was previously ABOVE each mutation tool's try/catch,
 * so such a write failure escaped the tool and surfaced through the generic
 * dispatch catch instead of the tool's own error classification. The fix moves
 * the gate INSIDE each handler's try so a stamp-write failure is classified by
 * that tool's own `err(...)` / `fail(...)` envelope, consistent with its other
 * errors.
 *
 * Here `writeState` is mocked to throw; each gated mutation tool must return its
 * own classified `isError` result (NOT reject/throw to the dispatcher).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// writeState throws (simulating a secure-file write failure on the confirm stamp);
// readState returns a gate-arming context (kept realistic though the confirm path
// stamps directly without reading).
vi.mock("../state.js", () => ({
  readState: vi.fn(() => ({ appId: "app-1", tenantId: "t-1", containerTypeId: "ct-1" })),
  writeState: vi.fn(() => {
    throw new Error("EACCES: permission denied, open '/home/dev/.spe/state.json'");
  }),
  clearState: vi.fn(),
}));
// Graph / bootstrap / auth are mocked so the tool modules import offline; none of
// their functions are reached because the gate throws first.
vi.mock("../graph-client.js", () => ({
  registerContainerType: vi.fn(),
  createContainerType: vi.fn(),
  deleteContainerType: vi.fn(),
  listContainerTypes: vi.fn(async () => []),
  grantContainerTypeAppPermission: vi.fn(),
  revokeContainerTypeAppPermission: vi.fn(),
  listContainerTypeAppPermissions: vi.fn(async () => []),
  getSignedInUser: vi.fn(async () => ({ id: "user-1", userPrincipalName: "admin@x.com" })),
  grantContainerTypeOwner: vi.fn(),
  listContainerTypePermissions: vi.fn(async () => []),
  revokeContainerTypePermission: vi.fn(),
}));
vi.mock("../bootstrap.js", () => ({
  bootstrapTokenProvider: vi.fn(async () => "boot"),
  getSignedInIdentity: vi.fn(async () => ({ tenantId: "t-1", username: "dev@x.com" })),
}));
vi.mock("../auth.js", () => ({ setAuthConfig: vi.fn() }));

import * as state from "../state.js";
import type { McpTool } from "../types.js";
import { registerContainerTypeTool } from "../tools/register-container-type.js";
import { createContainerTypeTool } from "../tools/create-container-type.js";
import { addContainerTypeAppGrantTool, removeContainerTypeAppGrantTool } from "../tools/container-type-app-grants.js";
import { grantContainerTypeOwnerTool, revokeContainerTypeOwnerTool } from "../tools/container-type-permissions.js";

beforeEach(() => {
  vi.clearAllMocks();
});

// Every control-plane MUTATION tool that wires the restart-confirmation gate.
// `contains` is the tool's own error-classifier prefix — proof the failure was
// handled by that tool, not the generic dispatcher.
const gatedTools: Array<{ label: string; tool: McpTool; contains: string }> = [
  { label: "container_type_register", tool: registerContainerTypeTool, contains: "registering container type" },
  { label: "container_type_create", tool: createContainerTypeTool, contains: "creating container type" },
  { label: "container_type_app_grant_add", tool: addContainerTypeAppGrantTool, contains: "granting app permission" },
  { label: "container_type_app_grant_remove", tool: removeContainerTypeAppGrantTool, contains: "removing app permission grant" },
  { label: "container_type_grant_owner", tool: grantContainerTypeOwnerTool, contains: "granting owner" },
  { label: "container_type_revoke_owner", tool: revokeContainerTypeOwnerTool, contains: "revoking owner" },
];

describe("restart-confirmation gate — stamp-write failure is tool-classified (PR #3 review)", () => {
  for (const { label, tool, contains } of gatedTools) {
    it(`${label}: contextChoice=confirm with a failing writeState returns a classified error (not a throw)`, async () => {
      // create requires a displayName to pass its schema before the gate runs.
      const args = tool === createContainerTypeTool ? { displayName: "Test CT", contextChoice: "confirm" } : { contextChoice: "confirm" };

      // Must RESOLVE to an error envelope — never reject to the dispatcher.
      const r = await tool.handler(args);

      expect(state.writeState).toHaveBeenCalledTimes(1); // the gate attempted the stamp
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toContain(contains); // classified by the tool itself
    });
  }
});
