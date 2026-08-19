// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Actionable guidance for the Microsoft Entra app-registration / redirect-URI
 * sign-in failures that otherwise surface in the scaffolded React SPA as an
 * opaque 400:
 *   - AADSTS9002326 — cross-origin token redemption refused because this app's
 *     origin is not registered as a Single-Page Application (SPA) redirect URI.
 *   - AADSTS50011  — redirect URI mismatch (the current origin is not listed on
 *     the owning Entra app registration).
 *
 * These are almost always a configuration mismatch on the owning Entra app
 * registration — not a client code bug. The guidance leads with the most common
 * real-world cause we have seen: the running build's baked-in VITE_CLIENT_ID /
 * VITE_TENANT_ID point at a DIFFERENT app than the one the user added the
 * redirect URI to (a stale or mismatched .env), so it first has the user confirm
 * the app identity, then shows how to register the exact origin on THAT app.
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
    "Sign-in failed: Entra rejected this build's sign-in for its current origin.",
    "",
    cause,
    "",
    "This is almost always a configuration mismatch on the owning Entra app-registration,",
    "not a bug in this app's code. Check these two things, in order:",
    "",
    "1) Is this build signing in as the app you think it is? This SPA authenticates as the",
    "   VITE_CLIENT_ID / VITE_TENANT_ID baked into its .env at build time. If those were",
    "   hydrated from stale or mismatched state, you may have registered the redirect URI on",
    "   a DIFFERENT app than the one signing in. Confirm they match the app you are viewing",
    "   in the portal (Entra ID > App registrations > your app > Overview: Application",
    "   (client) ID and Directory (tenant) ID). If you change .env, rebuild — Vite bakes",
    "   these values in at build time, so a running dev server will not pick up an edit.",
    "",
    "2) Does THAT app list this exact origin as a Single-page application (SPA) redirect URI?",
    "   Look the app up by client id (display names are not unique) and check its spa block:",
    "     az rest --method GET --uri \"https://graph.microsoft.com/v1.0/applications?$filter=appId eq '<VITE_CLIENT_ID>'&$select=appId,spa\"",
    "   If spa.redirectUris does not include the origin below, add it:",
    "",
    "    " + origin,
    "",
    "   Portal: Entra ID > App registrations > (this app) > Authentication >",
    "     Add a platform > Single-page application > Redirect URI:",
    "       " + origin,
    "   or with Azure CLI (replace <objectId> with the app registration object id):",
    "     az rest --method PATCH --uri \"https://graph.microsoft.com/v1.0/applications/<objectId>\" --headers \"Content-Type=application/json\" --body " +
      azBody,
    "",
    "Newly provisioned apps get this SPA redirect URI automatically, so you can also just",
    "re-run provisioning / deploy to (re)apply it. App-registration changes take effect on",
    "the next sign-in but are not applied by client hot-reload, and a changed .env needs a",
    "rebuild.",
  ].join("\n");
}
