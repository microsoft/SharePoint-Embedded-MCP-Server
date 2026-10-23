// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Strict, dependency-free SemVer 2.0.0 parsing and precedence comparison.
 *
 * WHY THIS EXISTS: the update-awareness check (see `update-check.ts`, SEC-008)
 * compares the installed version against version strings returned by the public
 * npm registry. Those strings are UNTRUSTED REMOTE INPUT, so they need strict
 * validation — not a lenient "coerce anything into a version" parse. Rather
 * than take a new runtime dependency for ~100 lines of fully specified logic,
 * the grammar from https://semver.org/spec/v2.0.0.html is implemented here.
 * The server ships a deliberately small runtime dependency set and this feature
 * adds nothing to it.
 *
 * SECURITY POSTURE:
 * - {@link parseSemver} is total: it never throws and returns `null` for
 *   anything that is not an exact match for the spec grammar. Leading `v`,
 *   leading zeroes, ranges (`^1.2.3`), partials (`1.2`), and whitespace are all
 *   rejected rather than "helpfully" coerced.
 * - Input longer than {@link MAX_VERSION_LENGTH} is rejected BEFORE the regex
 *   runs, so a hostile registry response cannot feed the matcher's nested
 *   quantifiers an unbounded string.
 * - Numeric core components must be safe integers; absurd inputs like a
 *   400-digit major version are rejected instead of silently losing precision.
 * - Numeric prerelease identifiers are compared as digit strings (length, then
 *   lexicographic) rather than via `Number`, so precedence stays exact even for
 *   identifiers beyond `Number.MAX_SAFE_INTEGER`.
 */

/**
 * Maximum accepted length of a version string. Well beyond any real published
 * version (npm's own limit is far lower) while bounding regex work on hostile
 * input.
 */
export const MAX_VERSION_LENGTH = 256;

/**
 * The official SemVer 2.0.0 grammar, anchored. Capture groups:
 * 1 major, 2 minor, 3 patch, 4 prerelease (dot-separated), 5 build metadata.
 */
const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

/** A version string that matched the SemVer 2.0.0 grammar exactly. */
export interface SemVer {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  /** Dot-separated prerelease identifiers; empty for a stable release. */
  readonly prerelease: readonly string[];
  /** Dot-separated build metadata; ignored for precedence, per spec §10. */
  readonly build: readonly string[];
  /** The exact input string that produced this value. */
  readonly raw: string;
}

/** A prerelease identifier consisting only of digits (spec: "numeric identifier"). */
const NUMERIC_IDENTIFIER = /^\d+$/;

/**
 * A channel name usable as an npm dist-tag: starts with a letter, then letters,
 * digits, or hyphens. Deliberately narrow so a hostile prerelease string can
 * never be spliced into a registry lookup or a user-visible notice.
 */
const CHANNEL_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

/**
 * Parse `input` as a SemVer 2.0.0 version.
 *
 * Returns `null` — never throws — for any non-string, empty string, over-long
 * string, or string that does not match the grammar exactly.
 */
export function parseSemver(input: unknown): SemVer | null {
  if (typeof input !== "string") return null;
  if (input.length === 0 || input.length > MAX_VERSION_LENGTH) return null;

  const match = SEMVER_PATTERN.exec(input);
  if (!match) return null;

  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (
    !Number.isSafeInteger(major) ||
    !Number.isSafeInteger(minor) ||
    !Number.isSafeInteger(patch)
  ) {
    return null;
  }

  return {
    major,
    minor,
    patch,
    prerelease: match[4] ? match[4].split(".") : [],
    build: match[5] ? match[5].split(".") : [],
    raw: input,
  };
}

/**
 * Compare two prerelease identifier lists per SemVer §11.4.
 *
 * - An empty list (a stable release) has HIGHER precedence than any prerelease.
 * - Numeric identifiers compare numerically and rank lower than alphanumeric.
 * - A shorter list of otherwise-equal identifiers has lower precedence.
 */
function comparePrerelease(a: readonly string[], b: readonly string[]): -1 | 0 | 1 {
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;

  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const left = a[index];
    const right = b[index];
    if (left === undefined) return -1;
    if (right === undefined) return 1;

    const leftNumeric = NUMERIC_IDENTIFIER.test(left);
    const rightNumeric = NUMERIC_IDENTIFIER.test(right);

    if (leftNumeric && rightNumeric) {
      // The grammar forbids leading zeroes, so digit-count then lexicographic
      // ordering is an exact numeric comparison with no precision loss.
      if (left.length !== right.length) return left.length < right.length ? -1 : 1;
      if (left !== right) return left < right ? -1 : 1;
      continue;
    }

    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    if (left !== right) return left < right ? -1 : 1;
  }

  return 0;
}

/**
 * Compare `a` and `b` by SemVer precedence: `-1` when `a < b`, `0` when equal,
 * `1` when `a > b`. Build metadata is ignored (spec §10).
 */
export function compareSemver(a: SemVer, b: SemVer): -1 | 0 | 1 {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  return comparePrerelease(a.prerelease, b.prerelease);
}

/** Whether `candidate` has strictly higher precedence than `current`. */
export function isNewer(candidate: SemVer, current: SemVer): boolean {
  return compareSemver(candidate, current) === 1;
}

/**
 * The release channel implied by a prerelease version — the first prerelease
 * identifier, when it is a plausible npm dist-tag name.
 *
 * `0.2.0-alpha.1` → `"alpha"`; `1.4.0-beta` → `"beta"`. Returns `null` for a
 * stable release, for a purely numeric prerelease (`1.0.0-1`), and for anything
 * that does not match {@link CHANNEL_PATTERN}.
 */
export function releaseChannel(version: SemVer): string | null {
  const first = version.prerelease[0];
  if (first === undefined) return null;
  const candidate = first.toLowerCase();
  return CHANNEL_PATTERN.test(candidate) ? candidate : null;
}
