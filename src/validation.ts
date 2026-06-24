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
 */

import type { McpToolResult } from "./types.js";

/** Build the standard validation-error envelope used across tools. */
export function validationError(message: string): McpToolResult {
  return {
    content: [{ type: "text" as const, text: `Error: ${message}` }],
    isError: true,
  };
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
