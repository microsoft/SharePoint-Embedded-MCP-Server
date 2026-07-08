// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Shared Zod field builders for MCP tool argument schemas.
 *
 * These are the reusable primitives that tool schemas compose so that a single
 * Zod declaration is the one source of truth for BOTH the advertised JSON
 * `inputSchema` and the enforced runtime validation (see `define-tool.ts`).
 * Centralizing them keeps validation semantics — trimming, GUID shape, integer
 * clamping, folder-path normalization — identical across every tool instead of
 * being re-implemented (and drifting) per handler.
 *
 * All builders target `zod/v3`, matching the `ZodObject<ZodRawShape>` contract
 * that `defineTool` consumes.
 */

import { z } from "zod/v3";

/**
 * Canonical 8-4-4-4-12 hyphenated GUID, case-insensitive. Anchored so partial
 * matches are rejected. Shared by the `guid` builder and by tests that assert
 * identifiers are real GUIDs.
 */
export const GUID_REGEX = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * A required, non-empty string. Leading/trailing whitespace is trimmed; a value
 * that is missing, not a string, or whitespace-only fails with `"<field> is
 * required"` so a non-string argument never throws an uncaught TypeError.
 */
export function nonEmptyString(fieldName: string, description?: string) {
  const schema = z
    .string({ required_error: `${fieldName} is required`, invalid_type_error: `${fieldName} is required` })
    .trim()
    .min(1, `${fieldName} is required`);
  return description ? schema.describe(description) : schema;
}

/**
 * A string constrained to the canonical GUID shape. Trims first, then validates
 * against {@link GUID_REGEX}. Fails with `"<field> must be a GUID"`.
 */
export function guid(fieldName: string, description?: string) {
  const schema = z
    .string({ required_error: `${fieldName} is required`, invalid_type_error: `${fieldName} is required` })
    .trim()
    .regex(GUID_REGEX, `${fieldName} must be a GUID`);
  return description ? schema.describe(description) : schema;
}

/**
 * A sanitized, positive integer that mirrors the clamping done by
 * `pagination.ts` (`toPositiveInt`): coerces numbers/numeric strings, requires a
 * finite value `>= 0`, floors fractional input, then clamps to `[1, max]`. Any
 * missing / non-finite / negative input falls back to `default`.
 */
export function positiveInt(opts: { default: number; max: number; description?: string }) {
  const { default: fallback, max, description } = opts;
  const schema = z
    .unknown()
    .transform((value) => {
      const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
      const base = !Number.isFinite(n) || n < 0 ? fallback : Math.floor(n);
      return Math.min(Math.max(base, 1), max);
    });
  return description ? schema.describe(description) : schema;
}

/**
 * Normalize a slash-delimited folder path.
 *
 * Splits on `/`, trims each segment, and FILTERS OUT empty segments, so `"/"`,
 * `"///"`, and `"a//b"` never produce a blank segment. The transform returns the
 * surviving segments re-joined by `/` (an empty string when nothing remains).
 *
 * Why return a normalized STRING rather than a `string[]`? The transform must be
 * idempotent: the server validates arguments once at dispatch and `defineTool`
 * re-parses them inside the handler, so `parse(parse(x)) === parse(x)` has to
 * hold. `normalize("a//b") === "a/b"` and `normalize("a/b") === "a/b"`, so a
 * normalized string is a fixed point; a `string[]` would fail the second parse
 * (an array is not a `string`). Use {@link folderSegments} to split the result.
 *
 * @param opts.required when true, a path that normalizes to zero segments is
 *        rejected with `"<field> is required"`; when false (default) an empty
 *        result is allowed (callers treat it as "root").
 */
export function folderPath(
  fieldName: string,
  opts: { required?: boolean; description?: string } = {},
) {
  const { required = false, description } = opts;

  const normalize = (raw: string): string =>
    raw
      .split("/")
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .join("/");

  const transformed = z
    .string({ required_error: `${fieldName} is required`, invalid_type_error: `${fieldName} is required` })
    .transform((raw) => normalize(raw));

  const validated = required
    ? transformed.refine((normalized) => normalized.length > 0, { message: `${fieldName} is required` })
    : transformed;

  const schema = required ? validated : validated.optional();
  return description ? schema.describe(description) : schema;
}

/**
 * Split a normalized folder path (the output of a {@link folderPath} field) into
 * its non-empty segments. A missing or empty path yields `[]` (i.e. "root").
 */
export function folderSegments(normalized: string | undefined | null): string[] {
  return normalized ? normalized.split("/") : [];
}

export { z };
