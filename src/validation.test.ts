// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Unit tests for the shared input-validation helpers.
 */

import { describe, it, expect } from "vitest";
import {
  requireString,
  validationError,
  isAzureSubscriptionId,
  isAzureResourceGroupName,
  requireAzureSubscriptionId,
  requireAzureResourceGroupName,
  assertAzureSubscriptionId,
  assertAzureResourceGroupName,
} from "./validation.js";
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

const VALID_SUBSCRIPTION_ID = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
const VALID_RESOURCE_GROUP = "rg-spe-demo_01.(prod)";

// Shell metacharacters / argument-injection payloads that must never be
// accepted as an Azure identifier, even though process spawning is shell-free.
const INJECTION_PAYLOADS = [
  "sub &",
  "sub |",
  "sub ;",
  "sub``",
  "sub$()",
  "sub >",
  "sub %%",
  "sub !!",
  "s\nub",
  "--query",
  "-g",
];

describe("isAzureSubscriptionId", () => {
  it("accepts a canonical GUID", () => {
    expect(isAzureSubscriptionId(VALID_SUBSCRIPTION_ID)).toBe(true);
  });

  it.each([...INJECTION_PAYLOADS, "not-a-guid", "3fa85f64", "", 123, null, undefined])(
    "rejects invalid / injection input (%p)",
    (value) => {
      expect(isAzureSubscriptionId(value)).toBe(false);
    },
  );
});

describe("isAzureResourceGroupName", () => {
  it.each(["rg1", "my_group", "a", VALID_RESOURCE_GROUP, "group-1"])(
    "accepts a valid resource-group name (%p)",
    (value) => {
      expect(isAzureResourceGroupName(value)).toBe(true);
    },
  );

  it.each([
    ...INJECTION_PAYLOADS,
    "-startsWithHyphen",
    "endsWithDot.",
    "has space",
    "",
    `${"a".repeat(91)}`,
  ])("rejects invalid / injection input (%p)", (value) => {
    expect(isAzureResourceGroupName(value)).toBe(false);
  });
});

describe("requireAzureSubscriptionId", () => {
  it("accepts and returns a trimmed GUID", () => {
    const r = requireAzureSubscriptionId(`  ${VALID_SUBSCRIPTION_ID}  `);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(VALID_SUBSCRIPTION_ID);
  });

  it.each(INJECTION_PAYLOADS)("rejects injection payload (%p) with a GUID message", (value) => {
    const r = requireAzureSubscriptionId(value);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.isError).toBe(true);
      expect(r.error.content[0].text).toBe(
        "Error: subscriptionId must be a valid Azure subscription ID (GUID)",
      );
    }
  });

  it("uses the standard required message when the value is missing", () => {
    const r = requireAzureSubscriptionId(undefined);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.content[0].text).toBe("Error: subscriptionId is required");
  });
});

describe("requireAzureResourceGroupName", () => {
  it("accepts and returns a trimmed name", () => {
    const r = requireAzureResourceGroupName("  rg-1  ");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe("rg-1");
  });

  it.each(INJECTION_PAYLOADS)("rejects injection payload (%p) with a name message", (value) => {
    const r = requireAzureResourceGroupName(value);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.content[0].text).toBe(
        "Error: resourceGroup must be a valid Azure resource group name",
      );
    }
  });
});

describe("assertAzureSubscriptionId", () => {
  it("does not throw for a valid GUID", () => {
    expect(() => assertAzureSubscriptionId(VALID_SUBSCRIPTION_ID)).not.toThrow();
  });

  it.each(INJECTION_PAYLOADS)("throws a generic error for injection payload (%p)", (value) => {
    expect(() => assertAzureSubscriptionId(value)).toThrow("Invalid Azure subscription ID");
  });
});

describe("assertAzureResourceGroupName", () => {
  it("does not throw for a valid name", () => {
    expect(() => assertAzureResourceGroupName("rg-1")).not.toThrow();
  });

  it.each(INJECTION_PAYLOADS)("throws a generic error for injection payload (%p)", (value) => {
    expect(() => assertAzureResourceGroupName(value)).toThrow(
      "Invalid Azure resource group name",
    );
  });
});
