// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Unit tests for the strict, dependency-free SemVer 2.0.0 implementation used by
 * the update-awareness check (SEC-008).
 *
 * The version strings compared here arrive from the public npm registry, so the
 * parser is treated as a trust boundary: these tests assert that it is TOTAL
 * (never throws), that it rejects everything outside the spec grammar instead of
 * coercing it, and that precedence matches the ordering published in the spec.
 */

import { describe, it, expect } from "vitest";

import {
  MAX_VERSION_LENGTH,
  compareSemver,
  isNewer,
  parseSemver,
  releaseChannel,
} from "./semver.js";

/** Parse a version that the tests know is valid, failing loudly if it is not. */
function parseOrThrow(input: string) {
  const parsed = parseSemver(input);
  if (!parsed) throw new Error(`expected '${input}' to parse as SemVer`);
  return parsed;
}

describe("parseSemver", () => {
  it("parses a plain release", () => {
    expect(parseSemver("1.2.3")).toEqual({
      major: 1,
      minor: 2,
      patch: 3,
      prerelease: [],
      build: [],
      raw: "1.2.3",
    });
  });

  it("parses zeroes without treating them as leading zeroes", () => {
    expect(parseSemver("0.0.0")).toMatchObject({ major: 0, minor: 0, patch: 0 });
  });

  it("parses dot-separated prerelease identifiers", () => {
    expect(parseSemver("0.2.0-alpha.1")).toMatchObject({
      major: 0,
      minor: 2,
      patch: 0,
      prerelease: ["alpha", "1"],
      build: [],
    });
  });

  it("parses build metadata separately from the prerelease", () => {
    expect(parseSemver("1.0.0-rc.1+build.5")).toMatchObject({
      prerelease: ["rc", "1"],
      build: ["build", "5"],
    });
  });

  it("preserves the exact input in raw", () => {
    expect(parseOrThrow("10.20.30-beta.2+sha.abc").raw).toBe("10.20.30-beta.2+sha.abc");
  });

  it.each([
    ["a leading v", "v1.2.3"],
    ["a partial version", "1.2"],
    ["a major-only version", "1"],
    ["a caret range", "^1.2.3"],
    ["a tilde range", "~1.2.3"],
    ["an x-range", "1.2.x"],
    ["a wildcard", "*"],
    ["leading whitespace", " 1.2.3"],
    ["trailing whitespace", "1.2.3 "],
    ["an embedded newline", "1.2.3\n"],
    ["a leading zero in major", "01.2.3"],
    ["a leading zero in minor", "1.02.3"],
    ["a leading zero in patch", "1.2.03"],
    ["a leading zero in a numeric prerelease", "1.2.3-01"],
    ["a negative number", "-1.2.3"],
    ["a four-part version", "1.2.3.4"],
    ["an empty prerelease", "1.2.3-"],
    ["an empty prerelease identifier", "1.2.3-alpha..1"],
    ["an empty build", "1.2.3+"],
    ["a non-ASCII identifier", "1.2.3-\u00e9"],
    ["an underscore in the prerelease", "1.2.3-alpha_1"],
    ["a dist-tag name", "latest"],
    ["the empty string", ""],
  ])("rejects %s", (_label, input) => {
    expect(parseSemver(input)).toBeNull();
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["a number", 123],
    ["an object", { major: 1 }],
    ["an array", ["1.2.3"]],
    ["a boolean", true],
    ["a version-like object with toString", { toString: () => "1.2.3" }],
  ])("rejects the non-string %s without throwing", (_label, input) => {
    expect(() => parseSemver(input)).not.toThrow();
    expect(parseSemver(input)).toBeNull();
  });

  it("accepts a version exactly at the length ceiling", () => {
    const padding = "a".repeat(MAX_VERSION_LENGTH - "1.2.3-".length);
    const input = `1.2.3-${padding}`;
    expect(input).toHaveLength(MAX_VERSION_LENGTH);
    expect(parseSemver(input)).not.toBeNull();
  });

  it("rejects a version one character over the length ceiling before matching", () => {
    const input = `1.2.3-${"a".repeat(MAX_VERSION_LENGTH)}`;
    expect(input.length).toBeGreaterThan(MAX_VERSION_LENGTH);
    expect(parseSemver(input)).toBeNull();
  });

  it("rejects a pathological string quickly rather than backtracking", () => {
    // A classic catastrophic-backtracking shape; the length guard must reject it
    // before the regex ever runs.
    const hostile = `1.2.3-${"a.".repeat(5_000)}`;
    const started = Date.now();
    expect(parseSemver(hostile)).toBeNull();
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("rejects numeric components beyond the safe-integer range", () => {
    const huge = "9".repeat(40);
    expect(parseSemver(`${huge}.0.0`)).toBeNull();
    expect(parseSemver(`0.${huge}.0`)).toBeNull();
    expect(parseSemver(`0.0.${huge}`)).toBeNull();
  });
});

describe("compareSemver", () => {
  it("orders by major, then minor, then patch", () => {
    expect(compareSemver(parseOrThrow("1.0.0"), parseOrThrow("2.0.0"))).toBe(-1);
    expect(compareSemver(parseOrThrow("2.1.0"), parseOrThrow("2.0.9"))).toBe(1);
    expect(compareSemver(parseOrThrow("2.1.3"), parseOrThrow("2.1.4"))).toBe(-1);
    expect(compareSemver(parseOrThrow("2.1.3"), parseOrThrow("2.1.3"))).toBe(0);
  });

  it("ranks a prerelease below the matching release", () => {
    expect(compareSemver(parseOrThrow("1.0.0-alpha"), parseOrThrow("1.0.0"))).toBe(-1);
    expect(compareSemver(parseOrThrow("1.0.0"), parseOrThrow("1.0.0-alpha"))).toBe(1);
  });

  it("ignores build metadata for precedence (spec section 10)", () => {
    expect(compareSemver(parseOrThrow("1.0.0+a"), parseOrThrow("1.0.0+b"))).toBe(0);
    expect(compareSemver(parseOrThrow("1.0.0-rc.1+a"), parseOrThrow("1.0.0-rc.1+b"))).toBe(0);
  });

  it("reproduces the precedence chain published in the spec", () => {
    const ordered = [
      "1.0.0-alpha",
      "1.0.0-alpha.1",
      "1.0.0-alpha.beta",
      "1.0.0-beta",
      "1.0.0-beta.2",
      "1.0.0-beta.11",
      "1.0.0-rc.1",
      "1.0.0",
    ].map(parseOrThrow);

    for (let index = 0; index < ordered.length - 1; index += 1) {
      const lower = ordered[index]!;
      const higher = ordered[index + 1]!;
      expect(compareSemver(lower, higher)).toBe(-1);
      expect(compareSemver(higher, lower)).toBe(1);
      expect(compareSemver(lower, lower)).toBe(0);
    }
  });

  it("ranks numeric prerelease identifiers below alphanumeric ones", () => {
    expect(compareSemver(parseOrThrow("1.0.0-1"), parseOrThrow("1.0.0-alpha"))).toBe(-1);
  });

  it("compares numeric prerelease identifiers numerically, not lexically", () => {
    expect(compareSemver(parseOrThrow("1.0.0-alpha.2"), parseOrThrow("1.0.0-alpha.10"))).toBe(-1);
  });

  it("compares numeric prerelease identifiers beyond MAX_SAFE_INTEGER exactly", () => {
    const low = parseOrThrow("1.0.0-alpha.9007199254740993");
    const high = parseOrThrow("1.0.0-alpha.9007199254740994");
    expect(compareSemver(low, high)).toBe(-1);
    expect(compareSemver(high, low)).toBe(1);
  });

  it("ranks a shorter prerelease list below an otherwise-equal longer one", () => {
    expect(compareSemver(parseOrThrow("1.0.0-alpha"), parseOrThrow("1.0.0-alpha.1"))).toBe(-1);
  });
});

describe("isNewer", () => {
  it("is true only for strictly higher precedence", () => {
    const current = parseOrThrow("0.2.0-alpha.1");
    expect(isNewer(parseOrThrow("0.2.0-alpha.2"), current)).toBe(true);
    expect(isNewer(parseOrThrow("0.2.0"), current)).toBe(true);
    expect(isNewer(parseOrThrow("1.0.0"), current)).toBe(true);
    expect(isNewer(parseOrThrow("0.2.0-alpha.1"), current)).toBe(false);
    expect(isNewer(parseOrThrow("0.2.0-alpha.0"), current)).toBe(false);
    expect(isNewer(parseOrThrow("0.1.9"), current)).toBe(false);
  });

  it("does not treat a build-metadata-only difference as newer", () => {
    expect(isNewer(parseOrThrow("1.0.0+build.2"), parseOrThrow("1.0.0+build.1"))).toBe(false);
  });
});

describe("releaseChannel", () => {
  it("returns the first prerelease identifier", () => {
    expect(releaseChannel(parseOrThrow("0.2.0-alpha.1"))).toBe("alpha");
    expect(releaseChannel(parseOrThrow("1.4.0-beta"))).toBe("beta");
    expect(releaseChannel(parseOrThrow("2.0.0-rc.3"))).toBe("rc");
    expect(releaseChannel(parseOrThrow("2.0.0-next.1"))).toBe("next");
  });

  it("lower-cases the identifier so it matches a dist-tag", () => {
    expect(releaseChannel(parseOrThrow("1.0.0-Alpha.1"))).toBe("alpha");
  });

  it("accepts a hyphenated channel name", () => {
    expect(releaseChannel(parseOrThrow("1.0.0-next-major.1"))).toBe("next-major");
  });

  it("returns null for a stable release", () => {
    expect(releaseChannel(parseOrThrow("1.2.3"))).toBeNull();
    expect(releaseChannel(parseOrThrow("1.2.3+build.1"))).toBeNull();
  });

  it("returns null for a purely numeric prerelease", () => {
    expect(releaseChannel(parseOrThrow("1.0.0-1"))).toBeNull();
    expect(releaseChannel(parseOrThrow("1.0.0-0.3.7"))).toBeNull();
  });

  it("returns null for an identifier that could not be a safe dist-tag", () => {
    // Starts with a hyphen rather than a letter.
    expect(releaseChannel(parseOrThrow("1.0.0--alpha"))).toBeNull();
    // Longer than the 32-character ceiling.
    expect(releaseChannel(parseOrThrow(`1.0.0-${"a".repeat(33)}`))).toBeNull();
  });
});
