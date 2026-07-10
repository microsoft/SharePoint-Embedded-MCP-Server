// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Tool: content_file_preview
 *
 * Generate a preview URL for a file in a container.
 */

import { getContainerDrive, getDriveItem, previewDriveItem } from "../graph-client.js";
import { requireContentAccess } from "./content-access.js";
import type { McpTool } from "../types.js";

export const previewFileTool: McpTool = {
  name: "content_file_preview",
  annotations: { readOnly: true, plane: "content", requiresConsent: true },
  description:
    "Generate a preview URL for a file in a SharePoint Embedded container. " +
    "The preview URL can be opened in a browser to view the file.",
  inputSchema: {
    type: "object" as const,
    properties: {
      containerId: {
        type: "string",
        description: "The container ID.",
      },
      filePath: {
        type: "string",
        description: "Path to the file (e.g., 'report.pdf' or 'Documents/report.pdf').",
      },
    },
    required: ["containerId", "filePath"],
  },
  handler: async (args) => {
    const gate = requireContentAccess();
    if (gate) return gate;

    const containerId = args.containerId as string;
    const filePath = args.filePath as string;

    if (!containerId || !filePath) {
      return {
        content: [{ type: "text", text: "Error: containerId and filePath are required" }],
        isError: true,
      };
    }

    const drive = await getContainerDrive(containerId);
    const itemPath = filePath.startsWith("/") ? filePath : `/${filePath}`;
    const item = await getDriveItem(drive.id, itemPath);
    const preview = await previewDriveItem(drive.id, item.id);

    let output = `## File Preview\n\n`;
    output += `| Property | Value |\n|----------|-------|\n`;
    output += `| **File** | ${item.name} |\n`;
    output += `| **Size** | ${item.size ? `${(item.size / 1024).toFixed(1)} KB` : "—"} |\n`;
    output += `| **Preview URL** | ${preview.getUrl} |\n`;

    return { content: [{ type: "text", text: output }] };
  },
};
