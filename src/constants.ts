// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Shared SPE MCP constants — single source of truth for values that MUST agree
 * across otherwise-independent modules.
 *
 * the local dev-server port lived in two places that had to match by
 * hand — the SPA redirect URI registered on the owning app (graph-client.ts) and
 * the generated app's Vite `server.port` (react-spa-template.ts). If one changed,
 * browser sign-in silently broke (AADSTS9002326). Both now derive from the single
 * `LOCAL_DEV_PORT` below so the registered redirect URI and the served dev port
 * can never drift.
 */

/**
 * Port the scaffolded React SPA's Vite dev server listens on during local dev.
 * Change this in ONE place to move the local dev origin everywhere that matters
 * (the registered SPA redirect URI and the emitted Vite config).
 */
export const LOCAL_DEV_PORT = 5173;

/**
 * Local origin of the scaffolded React SPA's Vite dev server, derived from
 * {@link LOCAL_DEV_PORT}. The generated app authenticates with MSAL.js using
 * `redirectUri: window.location.origin` (auth-code + PKCE), which Entra only
 * honours for a redirect URI registered under the app's `spa` platform — so this
 * exact value is registered on the owning app at create/reuse time.
 */
export const LOCAL_SPA_REDIRECT_URI = `http://localhost:${LOCAL_DEV_PORT}`;
