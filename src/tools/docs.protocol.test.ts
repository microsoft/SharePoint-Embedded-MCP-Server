// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CALL_TIMEOUT_MS, startProtocolServer, type ProtocolServer, type StructuredError } from "../../test/protocol-server.js";

describe("documentation validation over the MCP wire", () => {
  let server: ProtocolServer;
  beforeAll(async () => { server = await startProtocolServer(); }, 90000);
  afterAll(async () => { await server?.close(); });

  it.each([
    "not a URL", "/relative/page",
    "http://learn.microsoft.com/page", "ftp://learn.microsoft.com/page",
    "https://example.test/page", "https://sub.learn.microsoft.com/page",
    "https://learn.microsoft.com.example.test/page",
    "https://user@learn.microsoft.com/page", "https://user:pass@learn.microsoft.com/page",
    "https://:pass@learn.microsoft.com/page", "https://learn.microsoft.com:8443/page",
  ])("rejects unsupported docs_fetch page URL %p over the wire", async (url) => {
    const result = await server.client.callTool(
      { name: "docs_fetch", arguments: { url } },
      undefined,
      { timeout: CALL_TIMEOUT_MS },
    );
    expect(result.isError).toBe(true);
    const sc = result.structuredContent as StructuredError | undefined;
    expect(sc?.ok).toBe(false);
    expect(sc?.error?.code).toBe("INVALID_ARGS");
    expect(sc?.error?.message).toContain(
      "url must be an HTTPS URL on learn.microsoft.com without userinfo or a non-default port",
    );
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0].text).toContain(
      "url must be an HTTPS URL on learn.microsoft.com without userinfo or a non-default port",
    );
  });

  describe.each([
    ["docs_search", "query"],
    ["docs_fetch", "url"],
  ])("%s input validation over the wire", (name, field) => {
    it.each([123, {}, [], true, null, "", " \t\r\n"])(
      "returns actionable INVALID_ARGS for invalid input (%p)",
      async (value) => {
        const result = await server.client.callTool(
          { name, arguments: { [field]: value } },
          undefined,
          { timeout: CALL_TIMEOUT_MS },
        );

        expect(result.isError).toBe(true);
        const sc = result.structuredContent as StructuredError | undefined;
        expect(sc?.ok).toBe(false);
        expect(sc?.error?.code).toBe("INVALID_ARGS");
        expect(sc?.error?.message).toContain(`${field} is required`);
        const content = result.content as Array<{ type: string; text: string }>;
        expect(content[0].text).toContain(`${field} is required`);
        expect(JSON.stringify(result)).not.toMatch(/TypeError|\.trim|is not a function/i);
      },
    );

    it.each([{}, { arguments: {} }])(
      "returns actionable INVALID_ARGS when arguments are missing (%p)",
      async (args) => {
        const result = await server.client.callTool(
          { name, ...args },
          undefined,
          { timeout: CALL_TIMEOUT_MS },
        );

        expect(result.isError).toBe(true);
        const sc = result.structuredContent as StructuredError | undefined;
        expect(sc?.ok).toBe(false);
        expect(sc?.error?.code).toBe("INVALID_ARGS");
        expect(sc?.error?.message).toContain(`${field} is required`);
        const content = result.content as Array<{ type: string; text: string }>;
        expect(content[0].text).toContain(`${field} is required`);
        expect(JSON.stringify(result)).not.toMatch(/TypeError|\.trim|is not a function/i);
      },
    );
  });
});
