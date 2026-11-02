// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Unit tests for the documentation tools (docs_search, docs_fetch).
 *
 * The Microsoft Learn MCP client is mocked so these run offline in CI.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../docs-client.js", () => ({
  searchDocs: vi.fn(),
  fetchDoc: vi.fn(),
}));

import * as docs from "../docs-client.js";
import { searchDocsTool, fetchDocTool } from "../tools/search-docs.js";

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── docs_search ─────────────────────────────────────────────────────────

describe("docs_search", () => {
  it("has correct metadata", () => {
    expect(searchDocsTool.name).toBe("docs_search");
    expect(searchDocsTool.inputSchema.required).toContain("query");
    expect(searchDocsTool.description.length).toBeGreaterThan(20);
  });

  it("returns Learn results for a query", async () => {
    vi.mocked(docs.searchDocs).mockResolvedValue("A container type defines the relationship...");

    const result = await searchDocsTool.handler({ query: "what is a container type" });

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("Microsoft Learn results");
    expect(result.content[0].text).toContain("container type");
    expect(docs.searchDocs).toHaveBeenCalledOnce();
  });

  it("scopes generic queries to SharePoint Embedded", async () => {
    vi.mocked(docs.searchDocs).mockResolvedValue("result");

    await searchDocsTool.handler({ query: "billing classifications" });

    const calledWith = vi.mocked(docs.searchDocs).mock.calls[0][0];
    expect(calledWith).toMatch(/SharePoint Embedded/i);
  });

  it("does not double-scope queries that already mention SPE", async () => {
    vi.mocked(docs.searchDocs).mockResolvedValue("result");

    await searchDocsTool.handler({ query: "SharePoint Embedded container limits" });

    const calledWith = vi.mocked(docs.searchDocs).mock.calls[0][0];
    expect(calledWith).toBe("SharePoint Embedded container limits");
  });

  it("requires a query", async () => {
    const result = await searchDocsTool.handler({});
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      ok: false,
      error: { code: "INVALID_ARGS", message: "query is required" },
    });
    expect(docs.searchDocs).not.toHaveBeenCalled();
  });

  it.each(["", " ", "\t\r\n"])(
    "rejects a blank query (%p) without calling Learn",
    async (query) => {
      const result = await searchDocsTool.handler({ query });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe("Error: query is required");
      expect(result.structuredContent).toMatchObject({
        ok: false,
        error: { code: "INVALID_ARGS", message: "query is required" },
      });
      expect(docs.searchDocs).not.toHaveBeenCalled();
    },
  );

  it.each([
    [" \tcontainer limits\r\n ", "container limits (SharePoint Embedded)"],
    [" \tSharePoint Embedded container limits\r\n ", "SharePoint Embedded container limits"],
  ])("trims a padded query (%p) before calling Learn", async (query, expectedQuery) => {
    vi.mocked(docs.searchDocs).mockResolvedValue("container limits result");

    const result = await searchDocsTool.handler({ query });

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("container limits result");
    expect(result.structuredContent).toMatchObject({
      ok: true,
      data: { query: query.trim(), text: "container limits result" },
    });
    expect(docs.searchDocs).toHaveBeenCalledExactlyOnceWith(expectedQuery);
  });

  it.each([123, {}, [], true, null])(
    "returns a clean validation error for a non-string query (%p) without throwing",
    async (query) => {
      const result = await searchDocsTool.handler({ query } as Record<string, unknown>);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe("Error: query is required");
      expect(result.structuredContent).toMatchObject({
        ok: false,
        error: { code: "INVALID_ARGS", message: "query is required" },
      });
      expect(docs.searchDocs).not.toHaveBeenCalled();
    },
  );

  it("surfaces upstream errors", async () => {
    vi.mocked(docs.searchDocs).mockRejectedValue(new Error("Learn MCP unreachable"));

    const result = await searchDocsTool.handler({ query: "containers" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Learn MCP unreachable");
  });
});

// ─── docs_fetch ───────────────────────────────────────────────────────────

describe("docs_fetch", () => {
  it("has correct metadata", () => {
    expect(fetchDocTool.name).toBe("docs_fetch");
    expect(fetchDocTool.inputSchema.required).toContain("url");
  });

  it("returns full page content", async () => {
    vi.mocked(docs.fetchDoc).mockResolvedValue("# Full page\n\nbody");

    const result = await fetchDocTool.handler({
      url: "https://learn.microsoft.com/sharepoint/dev/embedded/overview",
    });

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("Full page");
    expect(docs.fetchDoc).toHaveBeenCalledWith(
      "https://learn.microsoft.com/sharepoint/dev/embedded/overview",
    );
  });

  it("requires a url", async () => {
    const result = await fetchDocTool.handler({});
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      ok: false,
      error: { code: "INVALID_ARGS", message: "url is required" },
    });
    expect(docs.fetchDoc).not.toHaveBeenCalled();
  });

  it.each(["", " ", "\t\r\n"])(
    "rejects a blank url (%p) without calling Learn",
    async (url) => {
      const result = await fetchDocTool.handler({ url });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe("Error: url is required");
      expect(result.structuredContent).toMatchObject({
        ok: false,
        error: { code: "INVALID_ARGS", message: "url is required" },
      });
      expect(docs.fetchDoc).not.toHaveBeenCalled();
    },
  );

  it("trims a padded url before calling Learn", async () => {
    const url = "https://learn.microsoft.com/sharepoint/dev/embedded/overview";
    vi.mocked(docs.fetchDoc).mockResolvedValue("# Full page\n\nbody");

    const result = await fetchDocTool.handler({ url: ` \t${url}\r\n ` });

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toBe("# Full page\n\nbody");
    expect(result.structuredContent).toMatchObject({
      ok: true,
      data: { url, text: "# Full page\n\nbody" },
    });
    expect(docs.fetchDoc).toHaveBeenCalledExactlyOnceWith(url);
  });

  it.each([123, {}, [], true, null])(
    "returns a clean validation error for a non-string url (%p) without throwing",
    async (url) => {
      const result = await fetchDocTool.handler({ url } as Record<string, unknown>);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe("Error: url is required");
      expect(result.structuredContent).toMatchObject({
        ok: false,
        error: { code: "INVALID_ARGS", message: "url is required" },
      });
      expect(docs.fetchDoc).not.toHaveBeenCalled();
    },
  );
});
