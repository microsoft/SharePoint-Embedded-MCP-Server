// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Tool: content_file_upload
 *
 * Upload content to a container. Small content goes via simple PUT.
 *
 * Argument validation is declared once as a Zod schema (see `defineTool` and the
 * shared builders in `../tooling/fields.ts`). Note `content` is a plain
 * `z.string()` — an EMPTY string is a valid (empty) file, so only presence and
 * string type are enforced, not non-emptiness. `folderPath` is optional and
 * normalized (defaults to the container root).
 */

import { getContainerDrive, uploadSmallFile } from "../graph-client.js";
import { defineTool } from "../tooling/define-tool.js";
import { nonEmptyString, folderPath, z } from "../tooling/fields.js";
import { requireContentAccess } from "./content-access.js";
import { ok } from "../responses.js";

const schema = z.object({
  containerId: nonEmptyString("containerId", "The container ID."),
  fileName: nonEmptyString("fileName", "Target file name (e.g., 'report.txt')."),
  // Empty content is a valid empty file: enforce string type + presence only.
  content: z
    .string({ required_error: "content is required", invalid_type_error: "content must be a string" })
    .describe("The text content to upload."),
  folderPath: folderPath("folderPath", {
    description: "Optional folder path (e.g., 'Documents/Reports'). Defaults to root.",
  }),
});

export const uploadFileTool = defineTool({
  name: "content_file_upload",
  annotations: { plane: "content", requiresConsent: true },
  description:
    "Upload text content to a file in a SharePoint Embedded container. " +
    "Provide the content as a string. For binary/large files, use the resumable upload pattern.",
  schema,
  handler: async (args) => {
    const gate = requireContentAccess();
    if (gate) return gate;

    const { containerId, fileName, content } = args;
    // `folderPath` arrives normalized (no leading/trailing or empty segments), or
    // undefined/empty for the container root.
    const normalizedFolder = args.folderPath;

    const drive = await getContainerDrive(containerId);
    const targetPath = normalizedFolder ? `/${normalizedFolder}/${fileName}` : `/${fileName}`;
    const item = await uploadSmallFile(drive.id, targetPath, content);

    let output = `## File Uploaded\n\n`;
    output += `| Property | Value |\n|----------|-------|\n`;
    output += `| **File** | ${item.name} |\n`;
    output += `| **Size** | ${item.size ?? 0} bytes |\n`;
    output += `| **Path** | ${targetPath} |\n`;
    output += `| **Item ID** | \`${item.id}\` |\n`;
    if (item.webUrl) output += `| **URL** | ${item.webUrl} |\n`;

    return ok(
      { name: item.name, id: item.id, size: item.size ?? 0, path: targetPath, webUrl: item.webUrl },
      output,
    );
  },
});

