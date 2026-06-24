// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Tools: docs_search, docs_fetch
 *
 * Proxy SharePoint Embedded / Microsoft Graph documentation questions to the
 * official Microsoft Learn MCP server. These make the SPE MCP server a grounded
 * "SPE knowledge expert" without shipping our own doc index — answers come from
 * current first-party documentation.
 *
 * The SPE server REQUIRES the Microsoft Learn MCP (https://learn.microsoft.com/api/mcp)
 * as an upstream dependency; see docs-client.ts.
 */

import { searchDocs, fetchDoc } from "../docs-client.js";
import type { McpTool } from "../types.js";
import { requireString } from "../validation.js";

/** Bias queries toward SharePoint Embedded so generic terms resolve in-context. */
function scopeToSpe(query: string): string {
  const q = query.trim();
  return /sharepoint embedded|\bspe\b/i.test(q) ? q : `${q} (SharePoint Embedded)`;
}

export const searchDocsTool: McpTool = {
  name: "docs_search",
  description:
    "Search official Microsoft Learn documentation for SharePoint Embedded and Microsoft Graph. " +
    "Use this to answer developer questions about container types, containers, registration, " +
    "permissions, billing, Graph API endpoints, and SPE concepts — instead of relying on prior " +
    "knowledge, which may be outdated. Returns ranked excerpts with titles and doc URLs. " +
    "Follow up with docs_fetch to read a full page when an excerpt is insufficient.",
  inputSchema: {
    type: "object" as const,
    properties: {
      query: {
        type: "string",
        description:
          "The developer's documentation question or keywords (e.g., 'how many trial container types per tenant', 'register container type on consuming tenant').",
      },
    },
    required: ["query"],
  },
  handler: async (args) => {
    // Validate BEFORE trimming so a non-string `query` returns a clean
    // validation envelope instead of throwing an uncaught TypeError.
    const validated = requireString(args.query, "query");
    if (!validated.ok) return validated.error;
    const query = validated.value;
    try {
      const text = await searchDocs(scopeToSpe(query));
      return {
        content: [
          { type: "text" as const, text: `## Microsoft Learn results for: ${query}\n\n${text}` },
        ],
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      return {
        content: [{ type: "text" as const, text: `Error searching Microsoft Learn: ${msg}` }],
        isError: true,
      };
    }
  },
};

export const fetchDocTool: McpTool = {
  name: "docs_fetch",
  description:
    "Fetch the full markdown content of a Microsoft Learn documentation page by URL " +
    "(typically a 'learn.microsoft.com' URL returned by docs_search). " +
    "Use when a search excerpt is not enough to answer accurately.",
  inputSchema: {
    type: "object" as const,
    properties: {
      url: {
        type: "string",
        description: "The Microsoft Learn documentation page URL to fetch in full.",
      },
    },
    required: ["url"],
  },
  handler: async (args) => {
    // Validate BEFORE trimming so a non-string `url` returns a clean
    // validation envelope instead of throwing an uncaught TypeError.
    const validated = requireString(args.url, "url");
    if (!validated.ok) return validated.error;
    const url = validated.value;
    try {
      const text = await fetchDoc(url);
      return { content: [{ type: "text" as const, text }] };
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      return {
        content: [{ type: "text" as const, text: `Error fetching Microsoft Learn page: ${msg}` }],
        isError: true,
      };
    }
  },
};
