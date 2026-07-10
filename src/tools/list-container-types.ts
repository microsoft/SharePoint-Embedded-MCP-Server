// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Tool: container_type_list
 *
 * Lists all SharePoint Embedded container types in the tenant.
 * Useful for discovering existing container types before creating new ones,
 * and for checking the 1:1 owning app relationship.
 */

import { listContainerTypes } from "../graph-client.js";
import { ok } from "../responses.js";
import { clientSafeMessage } from "../errors.js";
import { paginate, pageFooter, parsePageArgs } from "./pagination.js";
import type { McpTool } from "../types.js";

export const listContainerTypesTool: McpTool = {
  name: "container_type_list",
  annotations: { readOnly: true },
  description:
    "List all SharePoint Embedded container types in the tenant. " +
    "Shows container type IDs, display names, owning applications, and billing classification. " +
    "Use this to check existing container types before creating new ones " +
    "(each owning app can have exactly one container type). " +
    "Supports pagination via `top` (page size, max 200) and `skip` (offset).",
  inputSchema: {
    type: "object" as const,
    properties: {
      top: {
        type: "number",
        description: "Maximum container types to return in this page (default 50, max 200).",
      },
      skip: {
        type: "number",
        description: "Number of container types to skip (offset). Use the nextToken/skip from a prior page to continue.",
      },
    },
  },
  handler: async (args) => {
    try {
      const containerTypes = await listContainerTypes();

      if (containerTypes.length === 0) {
        return ok({ items: [], totalCount: 0, hasMore: false }, "No container types found in this tenant.");
      }

      const pageArgs = parsePageArgs(args);
      const page = paginate(containerTypes, pageArgs);

      let output = `## Container Types (${page.items.length})\n\n`;
      output += `| Container Type ID | Display Name | Owning App | Billing |\n`;
      output += `|-------------------|-------------|------------|----------|\n`;
      for (const ct of page.items) {
        output += `| \`${ct.containerTypeId}\` | ${ct.displayName ?? "—"} | \`${ct.owningAppId ?? "—"}\` | ${ct.billingClassification ?? "—"} |\n`;
      }
      output += pageFooter(page, pageArgs.skip);

      return ok(page, output);
    } catch (error) {
      return {
        content: [{ type: "text" as const, text: `Error listing container types: ${clientSafeMessage(error)}` }],
        isError: true,
      };
    }
  },
};
