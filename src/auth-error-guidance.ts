// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Actionable guidance for the SERVER-SIDE Microsoft Entra app-registration /
 * redirect-URI sign-in failures that otherwise surface in the
 * scaffolded React SPA as an opaque 400:
 *   - AADSTS9002326 — cross-origin token redemption refused because this app's
 *     origin is not registered as a Single-Page Application (SPA) redirect URI.
 *   - AADSTS50011  — redirect URI mismatch (the current origin is not listed on
 *     the owning Entra app registration).
 *
 * The point is to tell the user this is a SERVER-SIDE Entra app-registration
 * issue (not a client bug, not a stale/not-reloaded dev server) and exactly how
 * to fix it, showing the precise origin that must be registered.
 *
 * This is the canonical, unit-tested copy. A byte-for-byte copy of this function
 * is embedded in the runnable React sample (`samples/react-spa-functions/src/
 * App.tsx`) so the shipped app shows the same guidance; `auth-error-guidance.test.ts`
 * asserts the sample stays in sync. The function is intentionally self-contained
 * (no module-scope references) and uses string concatenation (no template
 * literals) so the embedded copy reads identically.
 */
export function interpretAuthError(errorText: string, origin: string): string | null {
  const text = errorText || "";
  const isCrossOrigin = text.includes("AADSTS9002326");
  const isRedirectMismatch = text.includes("AADSTS50011");
  if (!isCrossOrigin && !isRedirectMismatch) {
    return null;
  }
  const cause = isCrossOrigin
    ? "AADSTS9002326: Entra refused to redeem the sign-in code because the request came from a cross-origin Single-Page Application (SPA) caller whose origin is not registered."
    : "AADSTS50011: redirect URI mismatch — this app's current origin is not listed as a redirect URI on the owning Entra app registration.";
  const azBody =
    '"{\\"spa\\":{\\"redirectUris\\":[\\"' + origin + '\\"]}}"';
  return [
    "Sign-in failed because of a SERVER-SIDE Microsoft Entra app-registration issue.",
    "",
    "This is NOT a bug in this app and NOT a stale or not-reloaded dev server: the",
    "owning Entra app registration is missing a Single-Page Application (SPA) redirect",
    "URI for this app's origin, so re-running the same client build keeps failing.",
    "",
    cause,
    "",
    "Fix: add this app's origin as a Single-page application (SPA) redirect URI on the",
    "owning Entra app registration:",
    "",
    "    " + origin,
    "",
    "How to apply it:",
    "  - Newly provisioned apps: re-run provisioning / deploy — it now adds this SPA",
    "    redirect URI automatically.",
    "  - An app created before that fix (or a deployed origin not yet added): add it",
    "    manually —",
    "      Portal: Entra ID > App registrations > (this app) > Authentication >",
    "        Add a platform > Single-page application > Redirect URI:",
    "          " + origin,
    "      or with Azure CLI (replace <objectId> with the app registration object id):",
    "        az rest --method PATCH --uri \"https://graph.microsoft.com/v1.0/applications/<objectId>\" --headers \"Content-Type=application/json\" --body " +
      azBody,
    "",
    "Entra app-registration changes are server-side: re-provision / redeploy to apply",
    "them. They are NOT picked up by client hot-reload.",
  ].join("\n");
}
