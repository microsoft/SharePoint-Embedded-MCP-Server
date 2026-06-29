// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Tool: container_list
 *
 * Lists all containers for a given container type.
 */

import { listContainers } from "../graph-client.js";
import { fail, ok } from "../responses.js";
import { paginate, pageFooter, parsePageArgs } from "./pagination.js";
import type { McpTool } from "../types.js";

export const listContainersTool: McpTool = {
  name: "container_list",
  annotations: { readOnly: true },
  description:
    "List SharePoint Embedded containers for a container type. " +
    "Use this when you need to discover existing containers or look up a container ID. " +
    "Returns container IDs, names, status, and creation dates. " +
    "Supports pagination via `top` (page size, max 200) and `skip` (offset).",
  inputSchema: {
    type: "object" as const,
    properties: {
      containerTypeId: {
        type: "string",
        description: "The container type ID (GUID) to list containers for.",
      },
      top: {
        type: "number",
        description: "Maximum containers to return in this page (default 50, max 200).",
      },
      skip: {
        type: "number",
        description: "Number of containers to skip (offset). Use the nextToken/skip from a prior page to continue.",
      },
    },
    required: ["containerTypeId"],
  },
  handler: async (args) => {
    const containerTypeId = args.containerTypeId as string;
    if (!containerTypeId) {
      return fail("INVALID_ARGS", "containerTypeId is required", "Provide the container type ID (GUID) to list containers for.");
    }

    const containers = await listContainers(containerTypeId);

    if (containers.length === 0) {
      return ok(
        { items: [], totalCount: 0, hasMore: false, containerTypeId },
        `No containers found for container type ${containerTypeId}.`,
      );
    }

    const pageArgs = parsePageArgs(args);
    const page = paginate(containers, pageArgs);

    let output = `## Containers (${page.items.length})\n\n`;
    output += `| Container ID | Display Name | Status | Created |\n`;
    output += `|-------------|-------------|--------|----------|\n`;
    for (const c of page.items) {
      output += `| \`${c.id}\` | ${c.displayName ?? "—"} | ${c.status ?? "—"} | ${c.createdDateTime ?? "—"} |\n`;
    }
    output += pageFooter(page, pageArgs.skip);

    return ok({ ...page, containerTypeId }, output);
  },
};
