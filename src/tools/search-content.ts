// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Tool: content_search
 *
 * Search for content across SPE containers using Microsoft Search API.
 */

import { searchContent } from "../graph-client.js";
import { requireContentAccess } from "./content-access.js";
import type { McpTool, SearchResponse } from "../types.js";

export const searchContentTool: McpTool = {
  name: "content_search",
  annotations: { readOnly: true, plane: "content", requiresConsent: true },
  description:
    "Search for files and content across SharePoint Embedded containers " +
    "using the Microsoft Search API with includeHiddenContent. " +
    "Note: newly uploaded files may take 1-5 minutes to appear in search results.",
  inputSchema: {
    type: "object" as const,
    properties: {
      query: {
        type: "string",
        description: "The search query string.",
      },
      maxResults: {
        type: "number",
        description: "Maximum results to return. Default: 25.",
      },
    },
    required: ["query"],
  },
  handler: async (args) => {
    const gate = requireContentAccess();
    if (gate) return gate;

    const query = args.query as string;
    const maxResults = (args.maxResults as number) ?? 25;

    if (!query) {
      return {
        content: [{ type: "text", text: "Error: query is required" }],
        isError: true,
      };
    }

    let response: SearchResponse;
    try {
      response = await searchContent(query, maxResults);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      // Microsoft Search needs a broader Graph scope than SPE's container scopes
      // (FileStorageContainer.*). Surface an actionable hint rather than a raw 403.
      if (/access denied|Files\.Read|Sites\.Read|forbidden|\b403\b/i.test(msg)) {
        return {
          content: [{
            type: "text",
            text:
              "Error: content_search uses the Microsoft Search API, which requires the owning app to have " +
              "**Files.Read.All** (or **Sites.Read.All**) delegated Microsoft Graph permission granted and " +
              "admin-consented — the SharePoint Embedded container scopes (FileStorageContainer.*) alone are not " +
              "sufficient. Add Files.Read.All to the owning app's API permissions in Entra (admin consent " +
              `required), then retry. Underlying error: ${msg}`,
          }],
          isError: true,
        };
      }
      return { content: [{ type: "text", text: `Error searching content: ${msg}` }], isError: true };
    }

    const hits = response.value?.[0]?.hitsContainers?.[0]?.hits ?? [];
    const total = response.value?.[0]?.hitsContainers?.[0]?.total ?? 0;

    if (hits.length === 0) {
      return {
        content: [{
          type: "text",
          text: `No results found for "${query}". Note: newly uploaded content may take 1-5 minutes to be indexed.`,
        }],
      };
    }

    let output = `## Search Results (${hits.length} of ${total})\n\n`;
    output += `| Name | Size | Modified | URL |\n|------|------|----------|-----|\n`;

    for (const hit of hits) {
      const r = hit.resource;
      const size = r.size ? `${(r.size / 1024).toFixed(1)} KB` : "—";
      output += `| ${r.name} | ${size} | ${r.lastModifiedDateTime ?? "—"} | ${r.webUrl ?? "—"} |\n`;
    }

    return { content: [{ type: "text", text: output }] };
  },
};
