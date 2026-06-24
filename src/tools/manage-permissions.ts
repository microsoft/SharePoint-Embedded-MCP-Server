// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Tool: container_permissions_manage
 *
 * Add, update, or remove user permissions on a container.
 */

import {
  addContainerPermission,
  removeContainerPermission,
  updateContainerPermission,
} from "../graph-client.js";
import type { McpTool, McpToolResult } from "../types.js";

/** Roles accepted by the SPE container permissions API. Keep in sync with inputSchema.role.enum. */
const VALID_ROLES = ["reader", "writer", "manager", "owner"] as const;
type PermissionRole = (typeof VALID_ROLES)[number];

function isValidRole(value: unknown): value is PermissionRole {
  return typeof value === "string" && (VALID_ROLES as readonly string[]).includes(value);
}

/**
 * Validate the `role` input for actions that change a user's role (add/update).
 * Returns an error envelope when the role is missing or not one of VALID_ROLES,
 * or `null` when the role is valid.
 */
function roleValidationError(action: string, role: unknown): McpToolResult | null {
  if (isValidRole(role)) {
    return null;
  }
  const isMissing = role === undefined || role === null || role === "";
  const reason = isMissing
    ? `role is required for ${action} (missing)`
    : `invalid role '${String(role)}'`;
  return {
    content: [{
      type: "text",
      text:
        `Error: ${reason}. The 'role' parameter is required for ` +
        `action '${action}' and must be one of: ${VALID_ROLES.join(", ")}.`,
    }],
    isError: true,
  };
}

export const managePermissionsTool: McpTool = {
  name: "container_permissions_manage",
  description:
    "Add, update, or remove user permissions on a SharePoint Embedded container. " +
    "Valid roles: reader, writer, manager, owner.",
  inputSchema: {
    type: "object" as const,
    properties: {
      containerId: {
        type: "string",
        description: "The container ID.",
      },
      action: {
        type: "string",
        enum: ["add", "update", "remove"],
        description: "The permission action to perform.",
      },
      userPrincipalName: {
        type: "string",
        description: "User's UPN (e.g., user@contoso.com). Required for 'add'.",
      },
      role: {
        type: "string",
        enum: ["reader", "writer", "manager", "owner"],
        description: "Permission role. Required for 'add' and 'update'.",
      },
      permissionId: {
        type: "string",
        description: "Permission ID. Required for 'update' and 'remove'. Use container_get to find IDs.",
      },
    },
    required: ["containerId", "action"],
  },
  handler: async (args) => {
    const containerId = args.containerId as string;
    const action = args.action as string;
    const userPrincipalName = args.userPrincipalName as string | undefined;
    const role = args.role;
    const permissionId = args.permissionId as string | undefined;

    if (!containerId || !action) {
      return {
        content: [{ type: "text", text: "Error: containerId and action are required" }],
        isError: true,
      };
    }

    switch (action) {
      case "add": {
        if (!userPrincipalName) {
          return {
            content: [{ type: "text", text: "Error: userPrincipalName is required for add" }],
            isError: true,
          };
        }
        // Role must be explicitly provided and valid — never silently default
        // to a role (e.g. writer), which could grant broader access than intended.
        const roleErr = roleValidationError("add", role);
        if (roleErr) return roleErr;
        const roleValue = role as PermissionRole;
        try {
          const result = await addContainerPermission(containerId, userPrincipalName, roleValue);
          return {
            content: [{
              type: "text",
              text: `Permission added: ${userPrincipalName} = ${roleValue} (ID: \`${result.id}\`)`,
            }],
          };
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          if (msg.includes("409") || msg.toLowerCase().includes("conflict") || msg.toLowerCase().includes("already")) {
            return {
              content: [{
                type: "text",
                text: `User ${userPrincipalName} already has permissions. Use action 'update' with the permissionId to change the role.`,
              }],
            };
          }
          throw error;
        }
      }

      case "update": {
        if (!permissionId) {
          return {
            content: [{ type: "text", text: "Error: permissionId is required for update" }],
            isError: true,
          };
        }
        const roleErr = roleValidationError("update", role);
        if (roleErr) return roleErr;
        const roleValue = role as PermissionRole;
        await updateContainerPermission(containerId, permissionId, roleValue);
        return {
          content: [{
            type: "text",
            text: `Permission ${permissionId} updated to role: ${roleValue}`,
          }],
        };
      }

      case "remove": {
        if (!permissionId) {
          return {
            content: [{ type: "text", text: "Error: permissionId is required for remove" }],
            isError: true,
          };
        }
        await removeContainerPermission(containerId, permissionId);
        return {
          content: [{
            type: "text",
            text: `Permission ${permissionId} removed from container ${containerId}`,
          }],
        };
      }

      default:
        return {
          content: [{ type: "text", text: `Unknown action: ${action}. Use add, update, or remove.` }],
          isError: true,
        };
    }
  },
};
