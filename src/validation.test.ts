// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Unit tests for the shared input-validation helpers.
 */

import { describe, it, expect } from "vitest";
import { requireString, validationError } from "./validation.js";

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
