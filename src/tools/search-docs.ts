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
import { defineTool, z } from "../tooling/define-tool.js";
import { fail, ok } from "../responses.js";

/** Bias queries toward SharePoint Embedded so generic terms resolve in-context. */
function scopeToSpe(query: string): string {
  const q = query.trim();
  return /sharepoint embedded|\bspe\b/i.test(q) ? q : `${q} (SharePoint Embedded)`;
}

const searchDocsSchema = z.object({
  query: z.string().trim().min(1, "query is required").describe(
    "The developer's documentation question or keywords (e.g., 'how many trial container types per tenant', 'register container type on consuming tenant').",
  ),
});

const fetchDocSchema = z.object({
  url: z.string().trim().min(1, "url is required").describe("The Microsoft Learn documentation page URL to fetch in full."),
});

function firstValidationMessage(error: z.ZodError): string {
  const issue = error.issues[0];
  if (issue?.path[0] === "query") return "query is required";
  if (issue?.path[0] === "url") return "url is required";
  return issue?.message ?? "Invalid documentation tool arguments";
}

export const searchDocsTool = defineTool({
  name: "docs_search",
  description:
    "Search official Microsoft Learn documentation for SharePoint Embedded and Microsoft Graph. " +
    "Use this to answer developer questions about container types, containers, registration, " +
    "permissions, billing, Graph API endpoints, and SPE concepts — instead of relying on prior " +
    "knowledge, which may be outdated. Returns ranked excerpts with titles and doc URLs. " +
    "Follow up with docs_fetch to read a full page when an excerpt is insufficient.",
  annotations: {
    readOnly: true,
    idempotent: true,
    plane: "control",
  },
  schema: searchDocsSchema,
  validationErrorMessage: firstValidationMessage,
  handler: async (args) => {
    const query = args.query;
    try {
      const text = await searchDocs(scopeToSpe(query));
      return ok({ query, text }, `## Microsoft Learn results for: ${query}\n\n${text}`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      return fail("UPSTREAM", `searching Microsoft Learn: ${msg}`);
    }
  },
});

export const fetchDocTool = defineTool({
  name: "docs_fetch",
  description:
    "Fetch the full markdown content of a Microsoft Learn documentation page by URL " +
    "(typically a 'learn.microsoft.com' URL returned by docs_search). " +
    "Use when a search excerpt is not enough to answer accurately.",
  schema: fetchDocSchema,
  validationErrorMessage: firstValidationMessage,
  handler: async (args) => {
    const url = args.url;
    try {
      const text = await fetchDoc(url);
      return ok({ url, text }, text);
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      return fail("UPSTREAM", `fetching Microsoft Learn page: ${msg}`);
    }
  },
});
