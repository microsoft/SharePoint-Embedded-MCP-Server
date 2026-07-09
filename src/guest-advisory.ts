// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * NON-BLOCKING guest (B2B) sign-in advisories for control-plane operations.
 *
 * Guest/B2B sign-in is a fully supported, legitimate scenario (a corporate
 * identity invited into an SPE test/resource tenant). The authoritative
 * wrong-tenant protection lives in auth.ts and keys on the ISSUED TOKEN's tenant
 * (`isWrongTenantToken`) — NOT on guest status. Nothing here gates, rejects, or
 * throws: these helpers only surface an informational heads-up, because guest
 * accounts frequently lack permission to create Entra apps or own container
 * types, so a guest whose control-plane call later fails with an authorization
 * error gets an actionable hint up front. (PR #3 review.)
 */

import { createLogger } from "./logger.js";

// Reuse the auth-domain stderr format ([<iso>] [Auth] [<level>] <message>) —
// guest sign-in is an identity concern — WITHOUT importing auth.ts, so the
// sensitive token/account-selection logic there stays untouched.
const advisoryLogger = createLogger("Auth", { severity: true });

/**
 * Heuristic: does this UPN look like a B2B **guest** identity?
 *
 * When an account is invited as a guest into a resource tenant, its UPN *within
 * that tenant* carries the `#EXT#` marker, e.g.
 * `alice_corp.com#EXT#@resourcetenant.onmicrosoft.com`. We match `#EXT#`
 * case-insensitively.
 *
 * This is a NON-AUTHORITATIVE hint used only to surface a non-blocking heads-up;
 * it never gates, rejects, or changes control flow. Guest/B2B sign-in remains
 * fully supported (see auth.ts `getCachedAccount` / `isWrongTenantToken`, which
 * verify the issued token's tenant, not guest status).
 *
 * Exported for unit testing.
 */
export function isLikelyGuestUpn(upn?: string): boolean {
  return !!upn && /#EXT#/i.test(upn);
}

/**
 * The human-readable guest advisory text. Kept as a single constant so the
 * stderr log line and the user-visible note stay in sync.
 */
const GUEST_SIGN_IN_ADVISORY =
  "You appear to be signed in with a **guest (B2B)** account. Guest accounts often lack " +
  "permission to create Entra apps or own SharePoint Embedded container types. If a control-plane " +
  "step fails with an authorization error, sign in with a **member** account of the target tenant " +
  "and retry.";

/**
 * NON-BLOCKING guest sign-in advisory for control-plane operations.
 *
 * When the signed-in control-plane identity (the Azure CLI UPN) looks like a
 * B2B guest, emit a one-time warning to stderr and return an informational note
 * (a Markdown blockquote) for the calling tool to append to its user-visible
 * output. For a member identity it returns `""` and logs nothing.
 *
 * This is purely advisory: it does NOT block, reject, throw, or alter control
 * flow — guest/B2B sign-in remains fully supported.
 *
 * @param username The Azure CLI UPN from `getSignedInIdentity()`.
 * @returns A Markdown note to append to tool output, or `""` for a member.
 */
export function guestSignInAdvisory(username?: string): string {
  if (!isLikelyGuestUpn(username)) return "";
  advisoryLogger.warn(
    `Signed-in control-plane identity ${username} looks like a B2B guest — guest accounts often ` +
      "lack permission to create Entra apps or own container types. If control-plane calls fail with " +
      "authorization errors, sign in with a member account of the target tenant. (Non-blocking heads-up.)",
  );
  return `\n\n> \u2139\uFE0F **Heads-up:** ${GUEST_SIGN_IN_ADVISORY}`;
}
