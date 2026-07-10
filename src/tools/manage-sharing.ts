// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Tool: content_sharing_manage
 *
 * Create, list, or revoke sharing links for files.
 */

import {
  createSharingLink,
  getContainerDrive,
  getDriveItem,
  listDriveItemPermissions,
  revokeSharingLink,
} from "../graph-client.js";
import { requireContentAccess } from "./content-access.js";
import type { McpTool } from "../types.js";

export const manageSharingTool: McpTool = {
  name: "content_sharing_manage",
  annotations: { plane: "content", requiresConsent: true },
  description:
    "Create, list, or revoke sharing links for files in a SharePoint Embedded container.",
  inputSchema: {
    type: "object" as const,
    properties: {
      containerId: {
        type: "string",
        description: "The container ID.",
      },
      filePath: {
        type: "string",
        description: "Path to the file (e.g., 'report.pdf').",
      },
      action: {
        type: "string",
        enum: ["create", "list", "revoke"],
        description: "The sharing action.",
      },
      linkType: {
        type: "string",
        enum: ["view", "edit"],
        description: "For 'create': link type. Default: 'view'.",
      },
      linkScope: {
        type: "string",
        enum: ["anonymous", "organization", "users"],
        description: "For 'create': link scope. Default: 'organization'.",
      },
      permissionId: {
        type: "string",
        description: "For 'revoke': the permission ID to remove.",
      },
    },
    required: ["containerId", "filePath", "action"],
  },
  handler: async (args) => {
    const gate = requireContentAccess();
    if (gate) return gate;

    const containerId = args.containerId as string;
    const filePath = args.filePath as string;
    const action = args.action as string;
    const linkType = (args.linkType as string) ?? "view";
    const linkScope = (args.linkScope as string) ?? "organization";
    const permissionId = args.permissionId as string | undefined;

    if (!containerId || !filePath || !action) {
      return {
        content: [{ type: "text", text: "Error: containerId, filePath, and action are required" }],
        isError: true,
      };
    }

    const drive = await getContainerDrive(containerId);
    const itemPath = filePath.startsWith("/") ? filePath : `/${filePath}`;
    const item = await getDriveItem(drive.id, itemPath);

    switch (action) {
      case "create": {
        const link = await createSharingLink(drive.id, item.id, linkType, linkScope);
        return {
          content: [{
            type: "text",
            text: `Sharing link created for "${item.name}":\n` +
              `- **Type:** ${linkType}\n` +
              `- **Scope:** ${linkScope}\n` +
              `- **URL:** ${link.link?.webUrl ?? "(no URL)"}\n` +
              `- **Permission ID:** \`${link.id}\``,
          }],
        };
      }

      case "list": {
        const perms = await listDriveItemPermissions(drive.id, item.id);
        const links = perms.filter(p => p.link);
        if (links.length === 0) {
          return {
            content: [{ type: "text", text: `No sharing links found for "${item.name}".` }],
          };
        }
        let output = `## Sharing Links for "${item.name}" (${links.length})\n\n`;
        output += `| ID | Type | Scope | URL |\n|----|------|-------|-----|\n`;
        for (const l of links) {
          output += `| \`${l.id}\` | ${l.link?.type ?? "—"} | ${l.link?.scope ?? "—"} | ${l.link?.webUrl ?? "—"} |\n`;
        }
        return { content: [{ type: "text", text: output }] };
      }

      case "revoke": {
        if (!permissionId) {
          return {
            content: [{ type: "text", text: "Error: permissionId is required for revoke" }],
            isError: true,
          };
        }
        await revokeSharingLink(drive.id, item.id, permissionId);
        return {
          content: [{
            type: "text",
            text: `Sharing link ${permissionId} revoked from "${item.name}".`,
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
