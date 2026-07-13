// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Static product identifier stamped on outbound Microsoft Graph and Azure CLI
 * (`az` / `azd`) requests for aggregate traffic attribution.
 *
 * This is a constant product/version token. It carries NO per-user, per-tenant,
 * or personal data, opens NO separate telemetry channel, and rides only on the
 * Graph/ARM calls the tool already makes on the user's behalf (e.g. creating a
 * container type). The SharePoint Embedded service can filter request logs on
 * this token to measure how much traffic this tool drives.
 *
 * Because it is the only Microsoft-bound attribution signal this build emits,
 * it is treated as telemetry for opt-out purposes: it is ON by default and is
 * suppressed via the `SPE_COLLECT_TELEMETRY` environment variable (see
 * {@link telemetryEnabled} / {@link productUserAgent}).
 *
 * The version segment is derived from package.json (the single source of truth)
 * via {@link PACKAGE_VERSION}, so it can never drift out of sync on release.
 */
import { PACKAGE_VERSION } from "./version.js";

export const USER_AGENT = `spe-mcp-server/${PACKAGE_VERSION}`;

/**
 * Whether the product `User-Agent` attribution token should be stamped on
 * outbound Graph/ARM requests.
 *
 * Attribution is ON by default and is opted out by setting
 * `SPE_COLLECT_TELEMETRY` to a falsy value (`false`, `0`, `no`, or `off`,
 * case-insensitive). Any other value — or leaving it unset — keeps it on.
 */
export function telemetryEnabled(
  value: string | undefined = process.env.SPE_COLLECT_TELEMETRY,
): boolean {
  if (value === undefined) return true;
  return !["0", "false", "no", "off"].includes(value.trim().toLowerCase());
}

/**
 * The product `User-Agent` token to stamp on outbound requests, or `undefined`
 * when attribution is opted out via {@link telemetryEnabled}. Callers omit the
 * header entirely when this returns `undefined`.
 */
export function productUserAgent(): string | undefined {
  return telemetryEnabled() ? USER_AGENT : undefined;
}
