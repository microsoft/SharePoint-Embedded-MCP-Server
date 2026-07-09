// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Outbound HTTP helper for the SPE MCP Server's calls to Microsoft Graph and
 * Azure Resource Manager (ARM) REST APIs — parsing of the `Retry-After` header
 * for throttling/backoff (429 / 5xx) handling.
 *
 * This is NOT an MCP transport. The MCP transport for this server is stdio
 * (`StdioServerTransport`); MCP transport (how the client talks to this server)
 * and outbound HTTPS (how this server talks to Graph/ARM) are orthogonal — a
 * stdio MCP server still makes outbound HTTPS calls to Microsoft cloud APIs.
 */

export function parseRetryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number.parseInt(value, 10);
  if (Number.isFinite(seconds)) return seconds * 1000;
  const dateMs = Date.parse(value);
  if (!Number.isFinite(dateMs)) return undefined;
  return Math.max(0, dateMs - Date.now());
}
