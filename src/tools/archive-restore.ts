// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Tool: container_archive_restore
 *
 * Archive (lock) or restore (unlock) a container.
 */

import { getContainer, lockContainer, unlockContainer } from "../graph-client.js";
import type { McpTool } from "../types.js";

export const archiveRestoreTool: McpTool = {
  name: "container_archive_restore",
  annotations: { plane: "control" },
  description:
    "Archive (lock to read-only) or restore (unlock) a SharePoint Embedded container. " +
    "Archived containers are in cold storage — content is read-only.",
  inputSchema: {
    type: "object" as const,
    properties: {
      containerId: {
        type: "string",
        description: "The container ID.",
      },
      action: {
        type: "string",
        enum: ["archive", "restore"],
        description: "'archive' to lock (read-only), 'restore' to unlock.",
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

    const container = await getContainer(containerId);

    if (action === "archive") {
      if (container.lockState === "lockedReadOnly") {
        return {
          content: [{
            type: "text",
            text: `Container "${container.displayName}" is already archived (lockState: lockedReadOnly).`,
          }],
        };
      }
      await lockContainer(containerId);
      return {
        content: [{
          type: "text",
          text: `Container "${container.displayName}" archived (locked to read-only). Use action 'restore' to unlock.`,
        }],
      };
    }

    if (action === "restore") {
      if (container.lockState === "unlocked" || !container.lockState) {
        return {
          content: [{
            type: "text",
            text: `Container "${container.displayName}" is already unlocked.`,
          }],
        };
      }
      await unlockContainer(containerId);
      return {
        content: [{
          type: "text",
          text: `Container "${container.displayName}" restored (unlocked). Content is now writable.`,
        }],
      };
    }

    return {
      content: [{ type: "text", text: `Unknown action: ${action}. Use 'archive' or 'restore'.` }],
      isError: true,
    };
  },
};
