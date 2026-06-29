// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Tool: content_folder_create
 *
 * Create a folder (or nested folder path) inside a container.
 */

import { createFolder, getContainerDrive, listDriveChildren } from "../graph-client.js";
import { requireContentAccess } from "./content-access.js";
import type { McpTool } from "../types.js";

export const createFolderTool: McpTool = {
  name: "content_folder_create",
  annotations: { plane: "content", requiresConsent: true },
  description:
    "Create a folder or nested folder path inside a SharePoint Embedded container. " +
    "Intermediate folders are created automatically. Already-existing folders are skipped.",
  inputSchema: {
    type: "object" as const,
    properties: {
      containerId: {
        type: "string",
        description: "The container ID.",
      },
      folderPath: {
        type: "string",
        description: "Folder path to create (e.g., 'Documents/Reports/Q1').",
      },
    },
    required: ["containerId", "folderPath"],
  },
  handler: async (args) => {
    const gate = requireContentAccess();
    if (gate) return gate;

    const containerId = args.containerId as string;
    const folderPath = args.folderPath as string;

    if (!containerId || !folderPath) {
      return {
        content: [{ type: "text", text: "Error: containerId and folderPath are required" }],
        isError: true,
      };
    }

    const drive = await getContainerDrive(containerId);
    const segments = folderPath.replace(/^\/+|\/+$/g, "").split("/");
    let currentParent = "root";
    const results: Array<{ name: string; id: string; status: string }> = [];

    for (const segment of segments) {
      try {
        const folder = await createFolder(drive.id, currentParent, segment);
        currentParent = folder.id;
        results.push({ name: segment, id: folder.id, status: "created" });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (msg.includes("nameAlreadyExists") || msg.includes("already exists")) {
          // Folder exists — find it and navigate into it
          const children = await listDriveChildren(drive.id, currentParent === "root" ? undefined : currentParent);
          const existing = children.find(c => c.name === segment && c.folder);
          if (existing) {
            currentParent = existing.id;
            results.push({ name: segment, id: existing.id, status: "exists" });
          } else {
            throw new Error(`Folder '${segment}' conflict but could not find it`);
          }
        } else {
          throw error;
        }
      }
    }

    let output = `## Folders Created\n\n`;
    output += `| Folder | ID | Status |\n|--------|----|---------|\n`;
    for (const r of results) {
      output += `| ${r.name} | \`${r.id}\` | ${r.status} |\n`;
    }
    output += `\n**Leaf folder ID:** \`${currentParent}\``;

    return { content: [{ type: "text", text: output }] };
  },
};
