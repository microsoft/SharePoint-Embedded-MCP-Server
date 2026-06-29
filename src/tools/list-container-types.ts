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
import type { McpTool } from "../types.js";

async function executeListContainerTypes() {
  const containerTypes = await listContainerTypes();

  return {
    success: true,
    count: containerTypes.length,
    containerTypes,
  };
}

function formatResult(result: Awaited<ReturnType<typeof executeListContainerTypes>>): string {
  if (!result.success) {
    return "Error listing container types";
  }

  if (result.count === 0) {
    return "No container types found in this tenant.";
  }

  let output = `## Container Types (${result.count})\n\n`;
  output += `| Container Type ID | Display Name | Owning App | Billing |\n`;
  output += `|-------------------|-------------|------------|----------|\n`;

  for (const ct of result.containerTypes) {
    output += `| \`${ct.containerTypeId}\` | ${ct.displayName ?? "—"} | \`${ct.owningAppId ?? "—"}\` | ${ct.billingClassification ?? "—"} |\n`;
  }

  return output;
}

export const listContainerTypesTool: McpTool = {
  name: "container_type_list",
  annotations: { readOnly: true },
  description:
    "List all SharePoint Embedded container types in the tenant. " +
    "Shows container type IDs, display names, owning applications, and billing classification. " +
    "Use this to check existing container types before creating new ones " +
    "(each owning app can have exactly one container type).",
  inputSchema: {
    type: "object" as const,
    properties: {},
  },
  handler: async () => {
    try {
      const result = await executeListContainerTypes();
      return {
        content: [{ type: "text" as const, text: formatResult(result) }],
        isError: !result.success,
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      return {
        content: [{ type: "text" as const, text: `Error listing container types: ${msg}` }],
        isError: true,
      };
    }
  },
};
