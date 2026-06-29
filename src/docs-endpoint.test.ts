// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, it, expect } from "vitest";
import { resolveDocsEndpoint } from "./docs-client.js";

describe("resolveDocsEndpoint (SEC-007)", () => {
  it("defaults to the first-party Learn MCP endpoint when no override is set", () => {
    expect(resolveDocsEndpoint(undefined, false)).toBe("https://learn.microsoft.com/api/mcp");
    expect(resolveDocsEndpoint("", false)).toBe("https://learn.microsoft.com/api/mcp");
  });

  it("allows an override that stays on learn.microsoft.com (or a subdomain)", () => {
    expect(resolveDocsEndpoint("https://learn.microsoft.com/api/mcp", false)).toBe(
      "https://learn.microsoft.com/api/mcp",
    );
    expect(resolveDocsEndpoint("https://test.learn.microsoft.com/api/mcp", false)).toBe(
      "https://test.learn.microsoft.com/api/mcp",
    );
  });

  it("refuses an off-domain override unless explicitly allowed", () => {
    expect(() => resolveDocsEndpoint("https://evil.example.com/api/mcp", false)).toThrow(
      /only learn\.microsoft\.com is allowed/i,
    );
  });

  it("permits an off-domain override when SPE_ALLOW_INSECURE_DOCS_ENDPOINT is set", () => {
    expect(resolveDocsEndpoint("http://127.0.0.1:8080/mcp", true)).toBe("http://127.0.0.1:8080/mcp");
  });

  it("requires https for the allowed Learn host unless insecure is allowed", () => {
    expect(() => resolveDocsEndpoint("http://learn.microsoft.com/api/mcp", false)).toThrow(
      /https is required/i,
    );
    // The insecure escape hatch still permits http on the allowed host (e.g. a local proxy).
    expect(resolveDocsEndpoint("http://learn.microsoft.com/api/mcp", true)).toBe(
      "http://learn.microsoft.com/api/mcp",
    );
  });

  it("rejects a malformed override URL", () => {
    expect(() => resolveDocsEndpoint("not-a-url", false)).toThrow(/not a valid URL/i);
  });

  it("does not allow a look-alike host that merely contains the allowed host", () => {
    expect(() => resolveDocsEndpoint("https://learn.microsoft.com.evil.io/api/mcp", false)).toThrow(
      /only learn\.microsoft\.com is allowed/i,
    );
  });
});
