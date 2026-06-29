// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Tool: content_file_upload
 *
 * Upload content to a container. Small content goes via simple PUT.
 */

import { getContainerDrive, uploadSmallFile } from "../graph-client.js";
import { requireContentAccess } from "./content-access.js";
import type { McpTool } from "../types.js";

export const uploadFileTool: McpTool = {
  name: "content_file_upload",
  annotations: { plane: "content", requiresConsent: true },
  description:
    "Upload text content to a file in a SharePoint Embedded container. " +
    "Provide the content as a string. For binary/large files, use the resumable upload pattern.",
  inputSchema: {
    type: "object" as const,
    properties: {
      containerId: {
        type: "string",
        description: "The container ID.",
      },
      fileName: {
        type: "string",
        description: "Target file name (e.g., 'report.txt').",
      },
      content: {
        type: "string",
        description: "The text content to upload.",
      },
      folderPath: {
        type: "string",
        description: "Optional folder path (e.g., 'Documents/Reports'). Defaults to root.",
      },
    },
    required: ["containerId", "fileName", "content"],
  },
  handler: async (args) => {
    const gate = requireContentAccess();
    if (gate) return gate;

    const containerId = args.containerId as string;
    const fileName = args.fileName as string;
    const content = args.content as string;
    const folderPath = (args.folderPath as string) ?? "";

    if (!containerId || !fileName || content === undefined) {
      return {
        content: [{ type: "text", text: "Error: containerId, fileName, and content are required" }],
        isError: true,
      };
    }

    const drive = await getContainerDrive(containerId);
    const targetPath = folderPath ? `/${folderPath}/${fileName}` : `/${fileName}`;
    const item = await uploadSmallFile(drive.id, targetPath, content);

    let output = `## File Uploaded\n\n`;
    output += `| Property | Value |\n|----------|-------|\n`;
    output += `| **File** | ${item.name} |\n`;
    output += `| **Size** | ${item.size ?? 0} bytes |\n`;
    output += `| **Path** | ${targetPath} |\n`;
    output += `| **Item ID** | \`${item.id}\` |\n`;
    if (item.webUrl) output += `| **URL** | ${item.webUrl} |\n`;

    return { content: [{ type: "text", text: output }] };
  },
};
