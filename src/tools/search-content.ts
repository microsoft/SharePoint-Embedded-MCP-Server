// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Tool: content_search
 *
 * Search for content across SPE containers using Microsoft Search API.
 *
 * `query` is validated as a non-empty string via the shared field builders /
 * `defineTool`. Pagination is intentionally NOT strictly typed here: the schema
 * uses `.passthrough()` so back-compat aliases (`maxResults`→`top`,
 * `continuationToken`/`nextToken`→`skip`) survive validation and are sanitized by
 * `parsePageArgs`, which is the single source of truth for clamping page args.
 */

import { searchContent } from "../graph-client.js";
import { defineTool } from "../tooling/define-tool.js";
import { nonEmptyString, z } from "../tooling/fields.js";
import { requireContentAccess } from "./content-access.js";
import { ok, fail } from "../responses.js";
import { clientSafeMessage } from "../errors.js";
import { pageFromServerWindow, pageFooter, parsePageArgs } from "./pagination.js";
import type { SearchResponse } from "../types.js";

// Page-size / offset args accept a number OR a numeric string: `nextToken`/`skip`
// cursors are surfaced to callers as strings (see pageFooter), so we must not
// reject a string offset. `parsePageArgs` coerces + clamps whatever arrives.
const pageArg = (description: string) => z.union([z.number(), z.string()]).optional().describe(description);

const schema = z
  .object({
    query: nonEmptyString("query", "The search query string."),
    top: pageArg("Maximum results to return in this page (default 25, max 200). Alias: maxResults."),
    skip: pageArg("Number of results to skip (offset). Use the nextToken/skip from a prior page to continue."),
    maxResults: pageArg("Deprecated alias for `top`. Maximum results to return. Default: 25."),
  })
  // Preserve undeclared back-compat aliases (`continuationToken`, `nextToken`,
  // `limit`) so parsePageArgs can read them.
  .passthrough();

export const searchContentTool = defineTool({
  name: "content_search",
  annotations: { readOnly: true, plane: "content", requiresConsent: true },
  description:
    "Search for files and content across SharePoint Embedded containers " +
    "using the Microsoft Search API with includeHiddenContent. " +
    "Use this when you need to find files by keyword across a tenant's SPE content. " +
    "Content-gated: requires content access consent. " +
    "Supports pagination via `top` (page size, max 200) and `skip` (offset). " +
    "Note: newly uploaded files may take 1-5 minutes to appear in search results.",
  schema,
  handler: async (args) => {
    const gate = requireContentAccess();
    if (gate) return gate;

    const query = args.query;
    const { top, skip } = parsePageArgs(args, { defaultTop: 25 });

    let response: SearchResponse;
    try {
      response = await searchContent(query, top, skip);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      const safeMsg = clientSafeMessage(error);
      // Microsoft Search needs a broader Graph scope than SPE's container scopes
      // (FileStorageContainer.*). Surface an actionable hint rather than a raw 403.
      if (/access denied|Files\.Read|Sites\.Read|forbidden|\b403\b/i.test(msg)) {
        return fail(
          "FORBIDDEN",
          "content_search uses the Microsoft Search API, which requires the owning app to have " +
            "Files.Read.All (or Sites.Read.All) delegated Microsoft Graph permission granted and admin-consented — " +
            "the SharePoint Embedded container scopes (FileStorageContainer.*) alone are not sufficient.",
          "Add Files.Read.All to the owning app's API permissions in Entra (admin consent required), then retry. " +
            `Underlying error: ${safeMsg}`,
        );
      }
      return fail("UPSTREAM", `searching content: ${safeMsg}`);
    }

    const hits = response.value?.[0]?.hitsContainers?.[0]?.hits ?? [];
    const total = response.value?.[0]?.hitsContainers?.[0]?.total ?? 0;

    if (hits.length === 0) {
      return ok(
        { items: [], totalCount: total, hasMore: false, query },
        `No results found for "${query}". Note: newly uploaded content may take 1-5 minutes to be indexed.`,
      );
    }

    const page = pageFromServerWindow(hits, { top, skip }, total);

    let output = `## Search Results (${hits.length} of ${total})\n\n`;
    output += `| Name | Size | Modified | URL |\n|------|------|----------|-----|\n`;
    for (const hit of hits) {
      const r = hit.resource;
      const size = r.size ? `${(r.size / 1024).toFixed(1)} KB` : "—";
      output += `| ${r.name} | ${size} | ${r.lastModifiedDateTime ?? "—"} | ${r.webUrl ?? "—"} |\n`;
    }
    output += pageFooter(page, skip);

    return ok({ ...page, query }, output);
  },
});
