// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Shared helpers for the container-type control-plane tools.
 *
 * Both `container-type-permissions.ts` (beta `permissions`/owner role) and
 * `container-type-app-grants.ts` (v1.0 `applicationPermissionGrants`) point MSAL
 * at the owning app and default the container type to the provisioned one, and
 * both format errors identically. That logic is centralized here so the two tool
 * modules stay DRY (see PR #3 review comments r3531896108, r3531803187).
 */

import { setAuthConfig } from "../auth.js";
import { readState } from "../state.js";

/** A standard MCP error result: `Error: <text>` with `isError: true`. */
export function err(text: string) {
  return { content: [{ type: "text" as const, text: `Error: ${text}` }], isError: true };
}

/** Narrow an unknown thrown value to a human-readable reason string. */
export function reason(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Point MSAL at the owning app (so SPE control-plane calls use its token) and
 * return the provisioned owning-app id and container-type id as defaults.
 *
 * For app-grants the container-type id doubles as the registration id.
 */
export function authContainerTypeState(): { containerTypeId?: string; appId?: string } {
  const state = readState();
  if (state.appId && state.tenantId) {
    setAuthConfig({ clientId: state.appId, tenantId: state.tenantId });
  }
  return { containerTypeId: state.containerTypeId, appId: state.appId };
}
