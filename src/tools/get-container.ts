// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Tool: container_get
 *
 * Get details of a single container including permissions and drive info.
 */

import {
  getContainer,
  getContainerDrive,
  getCustomProperties,
  listContainerPermissions,
} from "../graph-client.js";
import type { McpTool } from "../types.js";

export const getContainerTool: McpTool = {
  name: "container_get",
  description:
    "Get detailed information about a SharePoint Embedded container, " +
    "including its status, permissions, drive info, and custom properties.",
  inputSchema: {
    type: "object" as const,
    properties: {
      containerId: {
        type: "string",
        description: "The container ID to inspect.",
      },
    },
    required: ["containerId"],
  },
  handler: async (args) => {
    const containerId = args.containerId as string;
    if (!containerId) {
      return {
        content: [{ type: "text", text: "Error: containerId is required" }],
        isError: true,
      };
    }

    const container = await getContainer(containerId);

    let output = `## Container Details\n\n`;
    output += `| Property | Value |\n|----------|-------|\n`;
    output += `| **ID** | \`${container.id}\` |\n`;
    output += `| **Name** | ${container.displayName} |\n`;
    output += `| **Status** | ${container.status} |\n`;
    output += `| **Lock State** | ${container.lockState ?? "unlocked"} |\n`;
    output += `| **Container Type** | \`${container.containerTypeId}\` |\n`;
    output += `| **Created** | ${container.createdDateTime ?? "—"} |\n`;

    // Drive info (non-fatal if unavailable)
    try {
      const drive = await getContainerDrive(containerId);
      output += `| **Drive ID** | \`${drive.id}\` |\n`;
      if (drive.webUrl) output += `| **Drive URL** | ${drive.webUrl} |\n`;
      if (drive.quota) {
        const usedGB = (drive.quota.used / (1024 ** 3)).toFixed(2);
        output += `| **Storage Used** | ${usedGB} GB |\n`;
      }
    } catch {
      output += `| **Drive** | (unavailable) |\n`;
    }

    // Permissions (non-fatal)
    try {
      const perms = await listContainerPermissions(containerId);
      if (perms.length > 0) {
        output += `\n### Permissions (${perms.length})\n\n`;
        output += `| User | Role | Permission ID |\n|------|------|---------------|\n`;
        for (const p of perms) {
          const user = p.grantedToV2?.user?.userPrincipalName ?? p.grantedToV2?.user?.displayName ?? "(unknown)";
          output += `| ${user} | ${p.roles.join(", ")} | \`${p.id}\` |\n`;
        }
      }
    } catch {
      output += `\n> Permissions not available.\n`;
    }

    // Custom properties (non-fatal)
    try {
      const props = await getCustomProperties(containerId);
      const propKeys = Object.keys(props).filter(k => !k.startsWith("@odata"));
      if (propKeys.length > 0) {
        output += `\n### Custom Properties\n\n`;
        output += `| Key | Value | Searchable |\n|-----|-------|------------|\n`;
        for (const key of propKeys) {
          const p = props[key];
          output += `| ${key} | ${p.value} | ${p.isSearchable ? "yes" : "no"} |\n`;
        }
      }
    } catch {
      // No custom properties or access denied — skip silently
    }

    return { content: [{ type: "text", text: output }] };
  },
};
