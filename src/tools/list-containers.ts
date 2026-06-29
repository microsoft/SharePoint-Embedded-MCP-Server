// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Tool: container_list
 *
 * Lists all containers for a given container type.
 */

import { listContainers } from "../graph-client.js";
import type { McpTool } from "../types.js";

export const listContainersTool: McpTool = {
  name: "container_list",
  annotations: { readOnly: true },
  description:
    "List all SharePoint Embedded containers for a container type. " +
    "Returns container IDs, names, status, and creation dates.",
  inputSchema: {
    type: "object" as const,
    properties: {
      containerTypeId: {
        type: "string",
        description: "The container type ID (GUID) to list containers for.",
      },
    },
    required: ["containerTypeId"],
  },
  handler: async (args) => {
    const containerTypeId = args.containerTypeId as string;
    if (!containerTypeId) {
      return {
        content: [{ type: "text", text: "Error: containerTypeId is required" }],
        isError: true,
      };
    }

    const containers = await listContainers(containerTypeId);

    if (containers.length === 0) {
      return {
        content: [{ type: "text", text: `No containers found for container type ${containerTypeId}.` }],
      };
    }

    let output = `## Containers (${containers.length})\n\n`;
    output += `| Container ID | Display Name | Status | Created |\n`;
    output += `|-------------|-------------|--------|----------|\n`;
    for (const c of containers) {
      output += `| \`${c.id}\` | ${c.displayName ?? "—"} | ${c.status ?? "—"} | ${c.createdDateTime ?? "—"} |\n`;
    }

    return { content: [{ type: "text", text: output }] };
  },
};
