// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Unit tests for the shared Zod field builders (WI-07).
 *
 * These builders are the one source of truth for tool-argument validation, so
 * they get direct coverage for the trimming / GUID / clamping / path-normalizing
 * semantics AND for the idempotency contract the server dispatch relies on
 * (`parse(parse(x)) === parse(x)`).
 */

import { describe, it, expect } from "vitest";
import {
  GUID_REGEX,
  guid,
  nonEmptyString,
  positiveInt,
  folderPath,
  folderSegments,
} from "./fields.js";

describe("nonEmptyString", () => {
  it("accepts and trims a non-empty string", () => {
    const r = nonEmptyString("query").safeParse("  hello  ");
    expect(r.success).toBe(true);
    if (r.success) expect(r.data).toBe("hello");
  });

  it.each([undefined, null, 123, {}, [], true])(
    "rejects non-string / missing value (%p) with '<field> is required'",
    (value) => {
      const r = nonEmptyString("query").safeParse(value);
      expect(r.success).toBe(false);
      if (!r.success) expect(r.error.issues[0].message).toBe("query is required");
    },
  );

  it.each(["", "   ", "\t\n"])("rejects empty / whitespace-only (%p)", (value) => {
    const r = nonEmptyString("url").safeParse(value);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0].message).toBe("url is required");
  });
});

describe("guid", () => {
  const CANONICAL = "475485dd-63d4-4f8c-af70-60f7a6c74940";

  it("accepts a canonical GUID and trims surrounding whitespace", () => {
    const r = guid("tenantId").safeParse(`  ${CANONICAL}  `);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data).toBe(CANONICAL);
  });

  it("accepts upper-case hex", () => {
    expect(guid("id").safeParse(CANONICAL.toUpperCase()).success).toBe(true);
  });

  it.each(["not-a-guid", "12345", "", `${CANONICAL}-extra`, "475485dd63d44f8caf7060f7a6c74940"])(
    "rejects a non-GUID value (%p) with '<field> must be a GUID'",
    (value) => {
      const r = guid("tenantId").safeParse(value);
      expect(r.success).toBe(false);
      // "" trips the required check; everything else trips the regex.
      if (!r.success) expect(r.error.issues[0].message).toMatch(/tenantId (must be a GUID|is required)/);
    },
  );

  it("rejects a non-string value with '<field> is required'", () => {
    const r = guid("tenantId").safeParse(1234);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0].message).toBe("tenantId is required");
  });

  it("GUID_REGEX is anchored (no partial matches)", () => {
    expect(GUID_REGEX.test(CANONICAL)).toBe(true);
    expect(GUID_REGEX.test(`prefix ${CANONICAL}`)).toBe(false);
    expect(GUID_REGEX.test(`${CANONICAL} suffix`)).toBe(false);
  });
});

describe("positiveInt", () => {
  const schema = positiveInt({ default: 25, max: 200 });

  it("falls back to default for missing / non-finite / negative input", () => {
    expect(schema.parse(undefined)).toBe(25);
    expect(schema.parse(null)).toBe(25);
    expect(schema.parse("not a number")).toBe(25);
    expect(schema.parse(-5)).toBe(25);
    expect(schema.parse(Infinity)).toBe(25);
  });

  it("floors fractional input", () => {
    expect(schema.parse(3.9)).toBe(3);
  });

  it("coerces numeric strings", () => {
    expect(schema.parse("42")).toBe(42);
  });

  it("clamps to [1, max]", () => {
    expect(schema.parse(0)).toBe(1);
    expect(schema.parse(500)).toBe(200);
  });

  it("is idempotent: parse(parse(x)) === parse(x)", () => {
    for (const input of [0, 3.9, 500, -1, "42", undefined]) {
      const once = schema.parse(input);
      expect(schema.parse(once)).toBe(once);
    }
  });
});

describe("folderPath (required)", () => {
  const schema = folderPath("folderPath", { required: true });

  it.each([
    ["a/b/c", "a/b/c"],
    ["a//b", "a/b"],
    ["/leading", "leading"],
    ["trailing/", "trailing"],
    ["  spaced/ segments ", "spaced/segments"],
    ["Docs/Reports/Q1", "Docs/Reports/Q1"],
  ])("normalizes %p -> %p (empty segments dropped)", (input, expected) => {
    const r = schema.safeParse(input);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data).toBe(expected);
  });

  it.each(["/", "///", "  ", "", "//"])(
    "rejects a path that normalizes to zero segments (%p)",
    (input) => {
      const r = schema.safeParse(input);
      expect(r.success).toBe(false);
      if (!r.success) expect(r.error.issues[0].message).toBe("folderPath is required");
    },
  );

  it("rejects a non-string value", () => {
    expect(schema.safeParse(123).success).toBe(false);
    expect(schema.safeParse(undefined).success).toBe(false);
  });

  it("is idempotent for valid input", () => {
    const once = schema.parse("a//b");
    expect(once).toBe("a/b");
    expect(schema.parse(once)).toBe("a/b");
  });
});

describe("folderPath (optional)", () => {
  const schema = folderPath("folderPath", {});

  it("allows undefined (root)", () => {
    const r = schema.safeParse(undefined);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data).toBeUndefined();
  });

  it("normalizes to an empty string when the path is all slashes (root)", () => {
    const r = schema.safeParse("///");
    expect(r.success).toBe(true);
    if (r.success) expect(r.data).toBe("");
  });

  it("normalizes a real path", () => {
    const r = schema.safeParse("Documents//Reports/");
    expect(r.success).toBe(true);
    if (r.success) expect(r.data).toBe("Documents/Reports");
  });
});

describe("folderSegments", () => {
  it("splits a normalized path into non-empty segments", () => {
    expect(folderSegments("a/b/c")).toEqual(["a", "b", "c"]);
  });

  it("returns [] for empty / nullish input (root)", () => {
    expect(folderSegments("")).toEqual([]);
    expect(folderSegments(undefined)).toEqual([]);
    expect(folderSegments(null)).toEqual([]);
  });
});
