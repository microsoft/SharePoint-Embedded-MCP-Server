// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Unit tests for the shared input-validation helpers.
 */

import { describe, it, expect } from "vitest";
import { requireString, validationError } from "./validation.js";
import type { McpToolResult } from "./types.js";

describe("requireString", () => {
  it("accepts and trims a non-empty string", () => {
    const r = requireString("  hello  ", "query");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe("hello");
  });

  it.each([undefined, null, 123, {}, [], true])(
    "rejects non-string / missing value (%p) with a clean envelope",
    (value) => {
      const r = requireString(value, "query");
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.isError).toBe(true);
        expect(r.error.content[0].text).toBe("Error: query is required");
      }
    },
  );

  it("rejects an empty / whitespace-only string", () => {
    for (const v of ["", "   "]) {
      const r = requireString(v, "url");
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.content[0].text).toBe("Error: url is required");
    }
  });
});

describe("validationError", () => {
  it("builds the standard error envelope", () => {
    const e = validationError("formats must be a non-empty array");
    expect(e.isError).toBe(true);
    expect(e.content[0].text).toBe("Error: formats must be a non-empty array");
  });
});

describe("documented usage example (module JSDoc)", () => {
  // Mirrors the `@example` in validation.ts: guard a handler argument, return the
  // envelope on failure, use the trimmed value on success — no `as string` cast.
  function handlerGuard(args: Record<string, unknown>): string | McpToolResult {
    const parsed = requireString(args.containerId, "containerId");
    if (!parsed.ok) return parsed.error;
    return parsed.value;
  }

  it("returns the trimmed value for a valid argument", () => {
    expect(handlerGuard({ containerId: "  c1  " })).toBe("c1");
  });

  it("returns the standard error envelope for a missing / non-string argument", () => {
    for (const bad of [{}, { containerId: 123 }, { containerId: "" }]) {
      const r = handlerGuard(bad);
      expect(typeof r).not.toBe("string");
      if (typeof r !== "string") {
        expect(r.isError).toBe(true);
        expect(r.content[0].text).toBe("Error: containerId is required");
      }
    }
  });
});
