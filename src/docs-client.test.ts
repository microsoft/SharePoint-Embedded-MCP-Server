// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  listTools: vi.fn(),
  callTool: vi.fn(),
  close: vi.fn(),
  transport: vi.fn(),
}));
vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class {
    connect = mocks.connect;
    listTools = mocks.listTools;
    callTool = mocks.callTool;
    close = mocks.close;
  },
}));
vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: class {
    constructor(url: URL) { mocks.transport(url); }
  },
}));

import { closeDocsClient, fetchDoc, resolveDocsEndpoint, searchDocs } from "./docs-client.js";

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("SPE_LEARN_MCP_URL", "");
  vi.stubEnv("SPE_ALLOW_INSECURE_DOCS_ENDPOINT", "");
  vi.spyOn(console, "error").mockImplementation(() => {});
  mocks.listTools.mockResolvedValue({
    tools: [
      { name: "microsoft_docs_search", inputSchema: { properties: { query: { type: "string" } } } },
      { name: "microsoft_docs_fetch", inputSchema: { properties: { url: { type: "string" } } } },
    ],
  });
  mocks.callTool.mockResolvedValue({ content: [{ type: "text", text: "  documentation  " }] });
});

afterEach(async () => {
  await closeDocsClient();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("Learn endpoint resolution", () => {
  it.each([undefined, "", "  "])("defaults an empty override (%p)", (override) => {
    expect(resolveDocsEndpoint(override)).toBe("https://learn.microsoft.com/api/mcp");
  });

  it("accepts HTTPS Learn subdomains and trims the override", () => {
    expect(resolveDocsEndpoint(" https://sub.learn.microsoft.com/api/mcp ")).toBe(
      "https://sub.learn.microsoft.com/api/mcp",
    );
  });

  it("rejects malformed URLs and lookalike hosts", () => {
    expect(() => resolveDocsEndpoint("not a URL")).toThrow("not a valid URL");
    expect(() => resolveDocsEndpoint("https://learn.microsoft.com.example.test")).toThrow("only learn.microsoft.com");
  });

  it.each(["1", " true ", "YES", "On"])("honors explicit insecure opt-in %p", (flag) => {
    vi.stubEnv("SPE_ALLOW_INSECURE_DOCS_ENDPOINT", flag);
    expect(resolveDocsEndpoint("http://localhost:9000/mcp")).toBe("http://localhost:9000/mcp");
    expect(resolveDocsEndpoint("http://learn.microsoft.com/api/mcp")).toBe("http://learn.microsoft.com/api/mcp");
  });

  it.each(["0", "false", "off"])("rejects non-HTTPS without opt-in %p", (flag) => {
    vi.stubEnv("SPE_ALLOW_INSECURE_DOCS_ENDPOINT", flag);
    expect(() => resolveDocsEndpoint("http://learn.microsoft.com/api/mcp")).toThrow("https is required");
  });
});

describe("schema-discovered documentation calls", () => {
  it("reuses one connection and keeps only text blocks in order", async () => {
    mocks.callTool.mockResolvedValue({
      content: [
        { type: "image", data: "ignored" }, null,
        { type: "text", text: 123 },
        { type: "text", text: " first " }, { type: "text", text: "second " },
      ],
    });
    expect(await searchDocs("containers")).toBe("first \n\nsecond");
    expect(await fetchDoc("https://learn.microsoft.com/page")).toBe("first \n\nsecond");
    expect(mocks.connect).toHaveBeenCalledTimes(1);
    expect(mocks.listTools).toHaveBeenCalledTimes(1);
    expect(mocks.transport).toHaveBeenCalledWith(new URL("https://learn.microsoft.com/api/mcp"));
    expect(mocks.callTool).toHaveBeenNthCalledWith(1,
      { name: "microsoft_docs_search", arguments: { query: "containers" } },
      undefined, { timeout: 25000 },
    );
    expect(mocks.callTool).toHaveBeenNthCalledWith(2,
      { name: "microsoft_docs_fetch", arguments: { url: "https://learn.microsoft.com/page" } },
      undefined, { timeout: 25000 },
    );
  });

  it.each([
    [{ properties: { prompt: { type: "string" }, query: { type: "string" } }, required: ["missing", "prompt"] }, "prompt"],
    [{ properties: { query: { type: "string" } } }, "query"],
    [{ properties: { count: { type: "number" } }, required: ["count"] }, "count"],
    [{}, "question"],
    [undefined, "question"],
  ])("builds arguments from discovered schema %p", async (inputSchema, key) => {
    mocks.listTools.mockResolvedValue({ tools: [{ name: "renamed_SEARCH_tool", inputSchema }] });
    expect(await searchDocs("SPE")).toBe("documentation");
    expect(mocks.callTool).toHaveBeenCalledWith(
      { name: "renamed_SEARCH_tool", arguments: { [key]: "SPE" } },
      undefined, { timeout: 25000 },
    );
  });

  it("discovers renamed fetch tools and URI parameters", async () => {
    mocks.listTools.mockResolvedValue({ tools: [
      { name: "unrelated" },
      { name: "new_FETCH_page", inputSchema: { properties: { uri: { type: "string" } } } },
    ] });
    expect(await fetchDoc("https://learn.microsoft.com/page")).toBe("documentation");
    expect(mocks.callTool).toHaveBeenCalledWith(
      { name: "new_FETCH_page", arguments: { uri: "https://learn.microsoft.com/page" } },
      undefined, { timeout: 25000 },
    );
  });

  it("prefers exact tool names over substring matches", async () => {
    mocks.listTools.mockResolvedValue({ tools: [
      { name: "other_search" }, { name: "microsoft_docs_search" },
    ] });
    await searchDocs("SPE");
    expect(mocks.callTool.mock.calls[0][0].name).toBe("microsoft_docs_search");
  });

  it("reports available tools when discovery has no matching tool", async () => {
    mocks.listTools.mockResolvedValue({ tools: [{ name: "other" }] });
    await expect(searchDocs("SPE")).rejects.toThrow("Available: other");
    expect(mocks.callTool).not.toHaveBeenCalled();
  });

  it.each([undefined, {}, { content: {} }, { content: [] }, { content: [{ type: "text", text: "  " }] }])(
    "rejects empty or non-text payloads (%p)", async (result) => {
      mocks.callTool.mockResolvedValue(result);
      await expect(searchDocs("SPE")).rejects.toThrow("search returned no text content");
      await expect(fetchDoc("https://learn.microsoft.com/page")).rejects.toThrow(
        "fetch returned no content for https://learn.microsoft.com/page",
      );
    },
  );

  it("coalesces concurrent initial connections", async () => {
    let release!: () => void;
    mocks.connect.mockReturnValue(new Promise<void>((resolve) => { release = resolve; }));
    const search = searchDocs("SPE");
    const fetch = fetchDoc("https://learn.microsoft.com/page");
    expect(mocks.connect).toHaveBeenCalledTimes(1);
    release();
    expect(await Promise.all([search, fetch])).toEqual(["documentation", "documentation"]);
    expect(mocks.listTools).toHaveBeenCalledTimes(1);
  });

  it.each([new Error("offline"), "offline"])("allows a fresh connection after failure (%p)", async (error) => {
    mocks.connect.mockRejectedValueOnce(error);
    await expect(searchDocs("SPE")).rejects.toThrow("Failed to connect to Microsoft Learn MCP");
    expect(await searchDocs("retry")).toBe("documentation");
    expect(mocks.connect).toHaveBeenCalledTimes(2);
  });

  it("retries discovery after listTools fails", async () => {
    mocks.listTools.mockRejectedValueOnce(new Error("discovery failed"));
    await expect(searchDocs("SPE")).rejects.toThrow("discovery failed");
    expect(await searchDocs("retry")).toBe("documentation");
    expect(mocks.connect).toHaveBeenCalledTimes(2);
  });

  it("propagates tool-call failures without returning stale content", async () => {
    mocks.callTool.mockRejectedValueOnce(new Error("call failed"));
    await expect(searchDocs("SPE")).rejects.toThrow("call failed");
    expect(await searchDocs("retry")).toBe("documentation");
    expect(mocks.connect).toHaveBeenCalledTimes(1);
  });

  it("resets discovery on close even when transport shutdown fails", async () => {
    await searchDocs("SPE");
    mocks.close.mockRejectedValueOnce(new Error("already closed"));
    await closeDocsClient();
    await closeDocsClient();
    expect(mocks.close).toHaveBeenCalledTimes(1);
    await fetchDoc("https://learn.microsoft.com/page");
    expect(mocks.connect).toHaveBeenCalledTimes(2);
  });
});
