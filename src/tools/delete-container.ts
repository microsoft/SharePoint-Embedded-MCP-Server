// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Tool: container_delete
 *
 * Soft-delete, permanently delete, or restore a container.
 */

import {
  deleteContainer,
  getContainer,
  permanentDeleteContainer,
  restoreDeletedContainer,
} from "../graph-client.js";
import { fail } from "../responses.js";
import type { McpTool } from "../types.js";

export const deleteContainerTool: McpTool = {
  name: "container_delete",
  description:
    "Delete or restore a SharePoint Embedded container. " +
    "Use this when you need to remove a container or recover one from the recycle bin. " +
    "soft-delete: moves to 93-day recycle bin. " +
    "permanent-delete: irreversible removal — requires confirm=true. " +
    "restore: recovers a soft-deleted container from the recycle bin. " +
    "DESTRUCTIVE: permanent-delete cannot be undone.",
  annotations: { destructive: true, plane: "control" },
  inputSchema: {
    type: "object" as const,
    properties: {
      containerId: {
        type: "string",
        description: "The container ID.",
      },
      action: {
        type: "string",
        enum: ["soft-delete", "permanent-delete", "restore"],
        description: "The delete action. 'permanent-delete' is IRREVERSIBLE.",
      },
      confirm: {
        type: "boolean",
        description:
          "Required for 'permanent-delete'. Set true to confirm irreversible permanent deletion.",
      },
    },
    required: ["containerId", "action"],
  },
  handler: async (args) => {
    const containerId = args.containerId as string;
    const action = args.action as string;

    if (!containerId || !action) {
      return {
        content: [{ type: "text", text: "Error: containerId and action are required" }],
        isError: true,
      };
    }

    switch (action) {
      case "soft-delete": {
        let name = containerId;
        try {
          const c = await getContainer(containerId);
          name = c.displayName;
        } catch { /* container may already be deleted */ }

        await deleteContainer(containerId);
        return {
          content: [{
            type: "text",
            text: `Container "${name}" soft-deleted (93-day recycle bin). Use action 'restore' to recover.`,
          }],
        };
      }

      case "permanent-delete": {
        // SAFE-002: never permanently delete without explicit confirmation.
        if (args.confirm !== true) {
          return fail(
            "CONFIRMATION_REQUIRED",
            `Permanent deletion of container ${containerId} is IRREVERSIBLE and was not confirmed.`,
            "Re-run container_delete with action='permanent-delete' and confirm=true to proceed.",
          );
        }
        await permanentDeleteContainer(containerId);
        return {
          content: [{
            type: "text",
            text: `Container ${containerId} permanently deleted. This action is IRREVERSIBLE.`,
          }],
        };
      }

      case "restore": {
        await restoreDeletedContainer(containerId);
        return {
          content: [{
            type: "text",
            text: `Container ${containerId} restored from recycle bin.`,
          }],
        };
      }

      default:
        return {
          content: [{ type: "text", text: `Unknown action: ${action}` }],
          isError: true,
        };
    }
  },
};
