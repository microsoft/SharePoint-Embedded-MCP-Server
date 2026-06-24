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
import type { McpTool } from "../types.js";

export const deleteContainerTool: McpTool = {
  name: "container_delete",
  description:
    "Delete or restore a SharePoint Embedded container. " +
    "soft-delete: moves to 93-day recycle bin. " +
    "permanent-delete: irreversible removal. " +
    "restore: recovers a soft-deleted container from the recycle bin.",
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
