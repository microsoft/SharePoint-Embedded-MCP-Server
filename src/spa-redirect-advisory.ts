// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * NON-BLOCKING advisory for the owning-app REUSE path when the local
 * Single-page application (SPA) redirect URI could not be confirmed on the app.
 *
 * project_app_create self-repairs a REUSED owning app by adding the local Vite
 * dev origin (http://localhost:5173) to its `spa.redirectUris`. That add is
 * best-effort: if the signed-in identity lacks `Application.ReadWrite` on the
 * registration, `addSpaRedirectUris` logs and swallows the failure (returns
 * undefined). Left silent, the scaffolded React SPA then fails sign-in with
 * `AADSTS9002326` and the user has no hint why — this was the exact trap behind
 * a reported "I added the redirect URI and it still fails" repro.
 *
 * This helper turns that swallowed failure into a VISIBLE, copy-pasteable fix
 * WITHOUT blocking the tool (app reuse still succeeds). It only produces
 * human-readable text — it never opens a browser, blocks provisioning, throws,
 * or changes control flow. Kept in its own tested module so the copy lives in
 * one place (mirrors guest-advisory.ts / onboarding-messages.ts).
 */

import { LOCAL_SPA_REDIRECT_URI } from "./constants.js";

/**
 * Case- and trailing-slash-insensitive membership test for a redirect URI in a
 * list — matches the dedupe semantics of graph-client `mergeRedirectUris`, so a
 * URI already registered as e.g. `http://localhost:5173/` still counts as
 * present.
 */
function listHasRedirectUri(redirectUris: string[] | undefined, uri: string): boolean {
  if (!redirectUris) return false;
  const normalize = (u: string) => u.replace(/\/+$/, "").toLowerCase();
  const target = normalize(uri);
  return redirectUris.some((u) => normalize(u) === target);
}

/**
 * Whether the reuse-path SPA self-repair is CONFIRMED for a given
 * `addSpaRedirectUris` result.
 *
 * `undefined` means a best-effort failure was swallowed → NOT confirmed. A
 * defined result's `redirectUris` always includes the origin on success, so the
 * membership check is a defensive backstop (never a false "confirmed").
 *
 * @param result The value returned by `addSpaRedirectUris` (or undefined).
 * @returns true only when the local SPA redirect URI is known to be registered.
 */
export function isSpaRedirectConfirmed(
  result: { added: string[]; redirectUris: string[] } | undefined,
): boolean {
  return !!result && listHasRedirectUri(result.redirectUris, LOCAL_SPA_REDIRECT_URI);
}

/**
 * Build the NON-BLOCKING warning appended to `project_app_create` output when
 * the local SPA redirect URI could not be confirmed on a REUSED owning app.
 *
 * Names the app's client id + object id and gives the exact manual `az rest`
 * PATCH (and a GET to verify), so the user can self-repair even without
 * re-running the tool. Purely informational — it does NOT block, open a browser,
 * or throw; owning-app reuse still succeeds.
 *
 * @param clientId The reused app's Application (client) ID (public).
 * @param objectId The reused app's Entra object ID (for the Graph PATCH/GET).
 * @returns A Markdown section to append to the tool's user-visible output.
 */
export function spaRedirectUnconfirmedWarning(clientId: string, objectId: string): string {
  const azBody = '"{\\"spa\\":{\\"redirectUris\\":[\\"' + LOCAL_SPA_REDIRECT_URI + '\\"]}}"';
  return (
    "\n\n### ⚠️ Action needed: confirm the local SPA redirect URI\n\n" +
    "I could not confirm (or add) the Single-page application (SPA) redirect URI `" +
    LOCAL_SPA_REDIRECT_URI +
    "` on this reused owning app — most likely the signed-in identity lacks " +
    "`Application.ReadWrite` on the registration, so the automatic self-repair was skipped. " +
    "Until that origin is registered on **this exact app**, the scaffolded React SPA sign-in " +
    "fails with `AADSTS9002326`.\n\n" +
    "Fix it on the app with client ID `" +
    clientId +
    "` (object ID `" +
    objectId +
    "`):\n\n" +
    "```bash\n" +
    "az rest --method PATCH \\\n" +
    '  --uri "https://graph.microsoft.com/v1.0/applications/' +
    objectId +
    '" \\\n' +
    '  --headers "Content-Type=application/json" \\\n' +
    "  --body " +
    azBody +
    "\n```\n\n" +
    "Then verify it landed (the origin should appear under `spa.redirectUris`):\n\n" +
    "```bash\n" +
    "az rest --method GET \\\n" +
    '  --uri "https://graph.microsoft.com/v1.0/applications/' +
    objectId +
    '?$select=appId,spa"\n' +
    "```\n\n" +
    "> This is a **heads-up**, not a failure — the owning app is otherwise ready to use."
  );
}
