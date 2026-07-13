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

/**
 * Product-name segment of {@link USER_AGENT}, without the version. Kept as a
 * single source of truth so the emitted token and the prefix checks used to
 * recognize/strip it (see {@link isProductUserAgent}) can never drift apart.
 */
const PRODUCT_NAME = "spe-mcp-server";

export const USER_AGENT = `${PRODUCT_NAME}/${PACKAGE_VERSION}`;

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

/**
 * Whether `value` is this tool's product attribution token, for any version
 * (i.e. `spe-mcp-server/<anything>`). Used to recognize — and strip on opt-out —
 * a token this process may have left in the environment on a prior run, without
 * disturbing any unrelated value the user set for their own attribution.
 */
export function isProductUserAgent(value: string | undefined): boolean {
  return typeof value === "string" && value.startsWith(`${PRODUCT_NAME}/`);
}

/**
 * Apply the product `User-Agent` attribution policy to an outbound header set,
 * mutating and returning it.
 *
 * - Attribution ON: stamp the product token, but only when the caller has not
 *   already supplied a `User-Agent` (a caller-supplied header still wins,
 *   preserving prior precedence).
 * - Opted out: guarantee no `User-Agent` survives — including one supplied by a
 *   caller — so the documented opt-out cannot be bypassed, accidentally or by a
 *   future call site. Both header-name casings are removed.
 */
export function applyProductUserAgent(
  headers: Record<string, string>,
): Record<string, string> {
  const ua = productUserAgent();
  if (ua) {
    if (headers["User-Agent"] === undefined && headers["user-agent"] === undefined) {
      headers["User-Agent"] = ua;
    }
  } else {
    delete headers["User-Agent"];
    delete headers["user-agent"];
  }
  return headers;
}
