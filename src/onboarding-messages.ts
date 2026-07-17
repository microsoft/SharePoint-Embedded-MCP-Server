// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * NON-BLOCKING onboarding / consent guidance strings for the owning-app flow.
 *
 * These helpers only produce human-readable text — they never open a browser,
 * block provisioning, throw, or change control flow. They exist so the
 * user-visible copy for three onboarding moments lives in one tested place:
 *
 *   1. `adminConsentSection` — appended to `project_app_create` output so the
 *      caller gets a copy-paste **tenant-wide admin-consent** link right after
 *      the owning app is created (or reused) and its SPE permissions requested.
 *      The app's SPE permissions still need an admin to consent; a Global Admin
 *      can grant tenant-wide with the link, and a non-admin can forward it.
 *   2. `byoAppStartupNote` — the startup line for the **bring-your-own-app**
 *      path (a pre-created owning app supplied via `--owning-app-client-id`/`SPE_CLIENT_ID`).
 *   3. `azLoginNotSignedInMessage` — the Azure CLI token-mode "not signed in" line,
 *      which now tells the user to **restart** the server after `az login` so the
 *      new sign-in is picked up (auth/session is stamped at startup).
 *
 * The admin-consent URL only ever contains a tenant id and a PUBLIC client id —
 * never a token, secret, or credential. (PR #3 review.)
 */

/**
 * Microsoft identity platform **tenant-wide admin consent** endpoint. Hitting
 * this URL (as an admin) grants the requested delegated/application permissions
 * for the whole tenant in one step. See:
 * https://learn.microsoft.com/entra/identity-platform/v2-admin-consent
 */
const LOGIN_AUTHORITY = "https://login.microsoftonline.com";

/**
 * Tenant fallback used only when the real signed-in tenant id is genuinely
 * unavailable. `organizations` targets "any work/school account" — a valid
 * multi-tenant authority — so the link still works; we call out the fallback so
 * the caller can substitute their exact tenant id/GUID for a tenant-scoped grant.
 */
const TENANT_FALLBACK = "organizations";

/**
 * Build the tenant-wide admin-consent URL for an owning app.
 *
 * Prefers the REAL signed-in tenant id so consent is scoped to the caller's
 * tenant; falls back to {@link TENANT_FALLBACK} only when the tenant id is
 * missing/blank. The URL contains solely the tenant id and the app's PUBLIC
 * client id — no secret is ever included.
 *
 * @param clientId The owning app's Application (client) ID.
 * @param tenantId The signed-in tenant id/GUID. Falls back when missing.
 * @returns `https://login.microsoftonline.com/{tenant}/adminconsent?client_id={clientId}`
 */
export function adminConsentUrl(clientId: string, tenantId?: string): string {
  const tenant = tenantId && tenantId.trim() !== "" ? tenantId.trim() : TENANT_FALLBACK;
  return `${LOGIN_AUTHORITY}/${tenant}/adminconsent?client_id=${clientId}`;
}

/**
 * The Markdown "Grant admin consent" section appended to owning-app tool output.
 *
 * Presents a copy-paste tenant-wide admin-consent link and explains both roles:
 * a Global Administrator can grant consent for the entire tenant with the link,
 * while a non-admin should forward the link to their tenant admin. Purely
 * informational — it does NOT block, open a browser, or throw; the first SPE
 * call still prompts for any consent that has not been granted yet.
 *
 * @param clientId The owning app's Application (client) ID (public).
 * @param tenantId The signed-in tenant id/GUID (preferred); a fallback is noted.
 * @returns A Markdown section to append to the tool's user-visible output.
 */
export function adminConsentSection(clientId: string, tenantId?: string): string {
  const url = adminConsentUrl(clientId, tenantId);
  const usedFallback = !(tenantId && tenantId.trim() !== "");
  const fallbackNote = usedFallback
    ? "\n\n> ℹ️ The signed-in tenant id was unavailable, so this link targets " +
      "`organizations` (any work/school account). Replace it with your tenant id/GUID " +
      "for a tenant-scoped grant."
    : "";
  return (
    "\n\n### Grant admin consent\n\n" +
    "The owning app's SharePoint Embedded permissions must be **admin-consented** before the app " +
    "can sign in. If consent has not already been granted for this app, open this **tenant-wide " +
    "admin-consent** link (copy-paste):\n\n" +
    `\`\`\`text\n${url}\n\`\`\`\n\n` +
    "- **If you are a Global Administrator** (or Privileged Role Administrator), opening this link " +
    "grants consent for the **entire tenant** in one step.\n" +
    "- **If you are NOT an admin**, copy the link above and send it to your tenant admin so they can " +
    "grant tenant-wide consent on your behalf.\n\n" +
    "> This step is **informational** — provisioning is not blocked on consent. The first " +
    "SharePoint Embedded call will still prompt for any consent that has not yet been granted." +
    fallbackNote
  );
}

/**
 * Startup line for the **bring-your-own-app** path: the caller has already
 * pre-created an owning Entra application (its client id supplied via
 * `--owning-app-client-id` / `SPE_CLIENT_ID`) and wants the server to sign in AS that app,
 * so no owning app is provisioned. Emitted on stderr at startup.
 *
 * @param clientId The pre-created owning app's client id.
 * @param tenantId The resolved tenant id.
 * @returns A single stderr status line.
 */
export function byoAppStartupNote(clientId: string, tenantId: string): string {
  return (
    `[SPE MCP Server] Bring-your-own-app mode — signing in as your pre-created owning app ` +
    `${clientId} (tenant ${tenantId}). No owning app will be provisioned; the server uses this app for ` +
    `all SharePoint Embedded operations.`
  );
}

/**
 * Azure CLI token-mode "Azure CLI installed but not signed in" line, extended with
 * restart guidance. Auth and session state are stamped at server startup, so
 * after `az login` completes the user must **restart** the MCP server for the
 * new sign-in to take effect — a restart begins a fresh session and re-primes
 * authentication.
 *
 * @returns The full stderr status line including restart guidance.
 */
export function azLoginNotSignedInMessage(): string {
  return (
    "[SPE MCP Server] Azure CLI installed but not signed in. Run `az login --allow-no-subscriptions`, " +
    "then RESTART the MCP server so it picks up your new sign-in — auth and session state are stamped at " +
    "startup, so a restart begins a fresh session and re-primes authentication."
  );
}
