// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Shared, reusable input-validation helpers for MCP tool handlers.
 *
 * MCP clients can send arbitrary JSON, so a tool's declared inputSchema is not
 * enforced at the transport boundary — handlers must defend against missing or
 * wrong-typed arguments themselves. These helpers return the standard MCP error
 * envelope (`{ content, isError: true }`) so handlers fail with a clean,
 * actionable validation message instead of leaking an internal TypeError.
 *
 * NEW TOOLS should prefer the Zod-based {@link defineTool} factory + the shared
 * field builders in `./tooling/fields.ts`, which derive the advertised
 * `inputSchema` and the runtime check from one schema. These imperative helpers
 * remain for tools that have not yet migrated and for one-off guards.
 *
 * @example
 * // Guard a handler argument before use — no `as string` cast, no TypeError on
 * // a numeric/object/missing value:
 * import { requireString } from "../validation.js";
 *
 * const parsed = requireString(args.containerId, "containerId");
 * if (!parsed.ok) return parsed.error; // standard { isError: true } envelope
 * const containerId = parsed.value;     // trimmed, guaranteed non-empty string
 */

import type { McpToolResult } from "./types.js";

/** Build the standard validation-error envelope used across tools. */
export function validationError(message: string): McpToolResult {
  return {
    content: [{ type: "text" as const, text: `Error: ${message}` }],
    isError: true,
  };
}

/** Project names are preserved exactly: 1–64 ASCII alphanumerics, `_` or `-`,
 * starting with an alphanumeric. No trimming or implicit renaming.
 */
export const PROJECT_NAME_PATTERN = "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}(?![\\s\\S])";
const PROJECT_NAME_RE = new RegExp(PROJECT_NAME_PATTERN);
const PROJECT_NAME_ERROR =
  "projectName must be 1-64 ASCII letters, digits, hyphens or underscores, starting with a letter or digit";

export function requireProjectName(
  value: unknown,
): { ok: true; value: string } | { ok: false; error: McpToolResult } {
  if (typeof value !== "string" || value.length > 64 || !PROJECT_NAME_RE.test(value)) {
    return { ok: false, error: validationError(PROJECT_NAME_ERROR) };
  }
  return { ok: true, value };
}

export function assertProjectName(value: unknown): asserts value is string {
  const parsed = requireProjectName(value);
  if (!parsed.ok) throw new Error(PROJECT_NAME_ERROR);
}

/**
 * Require that `value` is a non-empty (after trim) string.
 *
 * Returns the trimmed string when valid. When `value` is missing, not a string,
 * or only whitespace, returns the standard error envelope with the message
 * `"<name> is required"` — identical for the missing and wrong-typed cases so a
 * non-string argument never throws an uncaught TypeError.
 */
export function requireString(
  value: unknown,
  name: string,
): { ok: true; value: string } | { ok: false; error: McpToolResult } {
  if (typeof value !== "string" || value.trim() === "") {
    return { ok: false, error: validationError(`${name} is required`) };
  }
  return { ok: true, value: value.trim() };
}

/**
 * Strict allowlist patterns for identifiers that are passed as arguments to the
 * Azure CLI. Even though process spawning is shell-free (see `./proc-exec.ts`),
 * validating these values before they become CLI arguments is defence in depth
 * and keeps malformed input from reaching Azure.
 */

/** Canonical Azure subscription ID form: a lowercase/uppercase GUID. */
const AZURE_SUBSCRIPTION_ID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * Azure resource-group naming rules: 1–90 chars of Unicode letters, decimal
 * digits, `_`, `.`, `(`, `)`, `-`; may not end with `.`. Azure permits a leading
 * hyphen, so CLI call sites must bind such names to their option unambiguously.
 */
const AZURE_RESOURCE_GROUP_RE = /^[\p{L}\p{Nd}_.()-]{1,90}$/u;

/** True when `value` is a syntactically valid Azure subscription ID (GUID). */
export function isAzureSubscriptionId(value: unknown): value is string {
  return typeof value === "string" && AZURE_SUBSCRIPTION_ID_RE.test(value);
}

/** True when `value` is a syntactically valid Azure resource-group name. */
export function isAzureResourceGroupName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    AZURE_RESOURCE_GROUP_RE.test(value) &&
    !value.endsWith(".")
  );
}

/**
 * Require that `value` is a valid Azure subscription ID (GUID). Returns the
 * trimmed value on success, or the standard MCP error envelope on failure.
 */
export function requireAzureSubscriptionId(
  value: unknown,
  name = "subscriptionId",
): { ok: true; value: string } | { ok: false; error: McpToolResult } {
  const parsed = requireString(value, name);
  if (!parsed.ok) return parsed;
  if (!isAzureSubscriptionId(parsed.value)) {
    return {
      ok: false,
      error: validationError(`${name} must be a valid Azure subscription ID (GUID)`),
    };
  }
  return { ok: true, value: parsed.value };
}

/**
 * Require that `value` is a valid Azure resource-group name. Returns the trimmed
 * value on success, or the standard MCP error envelope on failure.
 */
export function requireAzureResourceGroupName(
  value: unknown,
  name = "resourceGroup",
): { ok: true; value: string } | { ok: false; error: McpToolResult } {
  const parsed = requireString(value, name);
  if (!parsed.ok) return parsed;
  if (!isAzureResourceGroupName(parsed.value)) {
    return {
      ok: false,
      error: validationError(`${name} must be a valid Azure resource group name`),
    };
  }
  return { ok: true, value: parsed.value };
}

/**
 * Defence-in-depth assertion: throw if `value` is not a valid Azure subscription
 * ID. Used inside the concrete `az`-invoking helpers so a malformed value can
 * never reach the CLI even if a future caller bypasses the tool boundary. The
 * message is intentionally generic (no echoed input).
 */
export function assertAzureSubscriptionId(value: unknown): asserts value is string {
  if (!isAzureSubscriptionId(value)) {
    throw new Error("Invalid Azure subscription ID");
  }
}

/**
 * Defence-in-depth assertion: throw if `value` is not a valid Azure
 * resource-group name. Message is intentionally generic (no echoed input).
 */
export function assertAzureResourceGroupName(value: unknown): asserts value is string {
  if (!isAzureResourceGroupName(value)) {
    throw new Error("Invalid Azure resource group name");
  }
}
