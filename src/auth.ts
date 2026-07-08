// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Authentication module for the SPE MCP Server.
 *
 * Auth strategy waterfall (modeled after enghub-mcp-server-tools):
 *   1. Silent (cached refresh token via MSAL + file cache)
 *   2. Interactive browser (PKCE with localhost redirect)
 *   3. Device code flow (headless fallback)
 *
 * Tokens are persisted to a local file that is PARTITIONED by tenant + client
 * (~/.spe-mcp/token-cache.<tenantId>.<clientId>.json) so that accounts from
 * different tenants never co-mingle. This prevents a stale account cached from a
 * prior tenant from interfering on a tenant switch.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { ensureSecureDir, writeSecureFile } from "./secure-fs.js";
import {
  type AccountInfo,
  type AuthenticationResult,
  type Configuration,
  type DeviceCodeRequest,
  type ICachePlugin,
  InteractionRequiredAuthError,
  LogLevel,
  PublicClientApplication,
  type SilentFlowRequest,
} from "@azure/msal-node";
import open from "open";
import { AppError } from "./errors.js";
import { readState } from "./state.js";

// ─── Constants ──────────────────────────────────────────────────────────────

// Microsoft Graph scopes needed for SPE operations.
// FileStorageContainer.Manage.All — container read/manage as owning app
// FileStorageContainer.Selected — selected-container delegated access
// FileStorageContainerType.Manage.All — create/manage container types (app role, owning tenant)
// FileStorageContainerTypeReg.Manage.All — register container types
const DEFAULT_SCOPES = [
  "https://graph.microsoft.com/FileStorageContainer.Manage.All",
  "https://graph.microsoft.com/FileStorageContainer.Selected",
  "https://graph.microsoft.com/FileStorageContainerType.Manage.All",
  "https://graph.microsoft.com/FileStorageContainerTypeReg.Manage.All",
];

function envTruthy(value: string | undefined): boolean {
  return !!value && /^(1|true|yes|on)$/i.test(value.trim());
}

// Best-effort detection of an environment where opening a browser will fail or
// be pointless: CI, or a Linux box with no display server (headless server / SSH
// / dev container). Used only to flip the DEFAULT for interactive sign-in; an
// explicit SPE_INTERACTIVE / SPE_NON_INTERACTIVE always wins.
function isLikelyHeadlessEnv(): boolean {
  if (envTruthy(process.env.CI)) return true;
  if (
    process.platform === "linux" &&
    !process.env.DISPLAY &&
    !process.env.WAYLAND_DISPLAY
  ) {
    return true;
  }
  return false;
}

// Interactive sign-in is ENABLED BY DEFAULT, even over stdio (no TTY): a LOCAL
// MCP server can open a browser on the user's machine for consent — far better
// than forcing them to run `spe-mcp auth` in a terminal and restart. It is
// turned OFF by default in obvious automation/headless environments (CI, Linux
// with no DISPLAY) so a tool call never silently blocks on a browser that can't
// open. Explicit overrides always win: SPE_INTERACTIVE=1 forces it on,
// SPE_NON_INTERACTIVE=1 forces it off.
let interactiveEnabled =
  envTruthy(process.env.SPE_INTERACTIVE) ||
  (!envTruthy(process.env.SPE_NON_INTERACTIVE) && !isLikelyHeadlessEnv());

// Whether the device-code prompt (printed to stderr) can actually be seen by a
// human. Over stdio in an MCP host, stderr is usually NOT visible, so a
// device-code wait would hang invisibly — we only offer device code on a TTY and
// otherwise fail fast with an actionable error after the browser attempt.
function deviceCodeIsVisible(): boolean {
  return process.stderr.isTTY === true;
}

/** Force interactive mode (used by `spe-mcp auth` CLI command). */
export function setInteractiveMode(): void {
  interactiveEnabled = true;
}

// Device code timeout: 2 min interactive, 10 min headless (user needs time
// to find the auth prompt in stderr / MCP logs).
const DEVICE_CODE_TIMEOUT_MS = process.stderr.isTTY ? 120_000 : 600_000;

// ─── Configuration ──────────────────────────────────────────────────────────

export interface AuthConfig {
  clientId: string;
  tenantId: string;
  /** Override default Graph scopes */
  scopes?: string[];
}

let authConfig: AuthConfig | null = null;
let pca: PublicClientApplication | null = null;

export function setAuthConfig(config: AuthConfig): void {
  const prev = authConfig;
  const tenantChanged = !!prev && prev.tenantId !== config.tenantId;
  const clientChanged = !!prev && prev.clientId !== config.clientId;
  authConfig = config;

  // (C) On a tenant/client switch, drop any in-memory MSAL state so a stale
  // account from the previous tenant cannot be reused. On-disk tokens are
  // already isolated by the per-tenant cache file (see getCacheFilePath), but
  // the in-process PublicClientApplication + readiness promise must also be
  // reset so the next acquisition rebuilds against the new authority.
  if (tenantChanged || clientChanged) {
    log(
      `Auth config changed (tenant ${prev?.tenantId} -> ${config.tenantId}); ` +
        "resetting in-memory MSAL state to avoid stale-account reuse",
    );
    resetInMemoryAuthState();
  }
}

/**
 * Reset in-memory MSAL state (PublicClientApplication + readiness promise).
 * Does NOT touch on-disk token caches.
 */
function resetInMemoryAuthState(): void {
  // Settle any in-flight readiness promise FIRST so concurrent awaiters
  // (getAccessToken's `await authReadyPromise`, or a second initializeAuth
  // caller) don't hang on a promise that could never settle once the
  // resolve/reject handles are dropped below.
  //
  // Reject (not resolve): the pending init was started against the OLD
  // authority, so completing it as "ready" would be wrong after a tenant/client
  // switch. getAccessToken's catch around the await falls through to on-demand
  // acquisition against the NEW config, so a rejection here degrades gracefully.
  // The in-flight promise already has a no-op `.catch()` attached in
  // initializeAuth, so rejecting it cannot raise an unhandled rejection.
  authReadyReject?.(
    new AppError("AUTH_RESET", "Auth state was reset (tenant/client switch) while initializing.", {
      safeMessage: "Authentication was reset because the tenant or app changed; retry.",
      suggestion:
        "Retry the operation; the server will re-initialize auth against the new tenant/app.",
    }),
  );
  pca = null;
  authReadyPromise = null;
  authReadyResolve = null;
  authReadyReject = null;
}

/**
 * Actionable message shown when a control-plane SPE operation is attempted
 * before an owning Entra app is configured. SPE container-type / container /
 * billing operations need a delegated token from an owning app that holds the
 * SPE Graph permissions — the Azure CLI bootstrap token cannot carry those
 * scopes. This message tells the agent/user exactly how to proceed.
 */
export const OWNING_APP_REQUIRED_MESSAGE =
  "No owning SharePoint Embedded app is configured yet. SharePoint Embedded " +
  "operations need an owning Entra app with the SPE Graph permissions. Run the " +
  "`project_app_create` tool to create (or reuse) one — the server then signs in " +
  "as that app automatically, no restart needed. Alternatively, start the server " +
  "with `--client-id <appId> --tenant-id <tenantId>` for an existing owning app.";

/**
 * Whether a previously-provisioned or explicitly-configured owning SPE app
 * exists to acquire a delegated token with: either auth is already configured
 * in-process, or an owning app is persisted in state (the server primes from it
 * at startup / on demand).
 *
 * NOTE: this reports that an owning app is AVAILABLE, not that the auth module is
 * already primed (`getConfig()` gates on the in-process `authConfig`). Use it for
 * readiness/guidance messaging, not as a precondition that token acquisition will
 * succeed without sign-in.
 */
export function isOwningAppConfigured(): boolean {
  if (authConfig) return true;
  const persisted = readState();
  return !!(persisted.appId && persisted.tenantId);
}

function getConfig(): AuthConfig {
  if (!authConfig) {
    // Typed, actionable precondition (not the old internal "call setAuthConfig"
    // message). Flows through toSafeError/clientSafeMessage so every control-plane
    // SPE tool surfaces the same "create an owning app first" guidance.
    throw new AppError("OWNING_APP_REQUIRED", "Auth not configured (no owning app).", {
      safeMessage: OWNING_APP_REQUIRED_MESSAGE,
      suggestion: "Run project_app_create, then retry.",
    });
  }
  return authConfig;
}

function getScopes(): string[] {
  return authConfig?.scopes ?? DEFAULT_SCOPES;
}

function getAuthority(): string {
  return `https://login.microsoftonline.com/${getConfig().tenantId}`;
}

// ─── Logging ────────────────────────────────────────────────────────────────

function log(message: string, data?: unknown): void {
  const timestamp = new Date().toISOString();
  if (data !== undefined) {
    console.error(`[${timestamp}] [Auth] ${message}`, data);
  } else {
    console.error(`[${timestamp}] [Auth] ${message}`);
  }
}

// ─── File-Based Cache Plugin ────────────────────────────────────────────────
// Persists the MSAL token cache to a tenant+client-partitioned file under
// ~/.spe-mcp/. Partitioning by tenant (and client) guarantees accounts from
// different tenants never co-mingle, which is the root cause of the
// tenant-switch silent-auth failures and wrong-tenant-token hazard.

const CACHE_DIR = join(homedir(), ".spe-mcp");
// Legacy single-file cache used before per-tenant partitioning. Kept only so
// that clearCachedToken() can clean it up; it is never read on the hot path.
const LEGACY_CACHE_FILE = join(CACHE_DIR, "token-cache.json");

/** Make a value safe to embed in a filename (GUIDs are already safe; be defensive). */
function sanitizeForFilename(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}

/**
 * Derive the token-cache file path for a given auth config. Partitioned by
 * tenantId and clientId so two different tenants (or client apps) always resolve
 * to distinct files. Falls back to the legacy single-file path only when no
 * tenant is configured yet (should not happen on normal auth paths).
 *
 * Exported for unit testing.
 */
export function getCacheFilePath(config: AuthConfig | null = authConfig): string {
  if (config?.tenantId) {
    const tenant = sanitizeForFilename(config.tenantId);
    const client = config.clientId ? sanitizeForFilename(config.clientId) : "default";
    return join(CACHE_DIR, `token-cache.${tenant}.${client}.json`);
  }
  return LEGACY_CACHE_FILE;
}

function ensureCacheDir(): void {
  ensureSecureDir(CACHE_DIR);
}

const fileCachePlugin: ICachePlugin = {
  beforeCacheAccess: async (cacheContext) => {
    const cacheFile = getCacheFilePath();
    try {
      if (existsSync(cacheFile)) {
        const cached = readFileSync(cacheFile, "utf-8");
        cacheContext.tokenCache.deserialize(cached);
        log(`Token cache loaded from file (${basename(cacheFile)})`);
      }
    } catch (error) {
      log("Failed to read cache file:", error);
    }
  },
  afterCacheAccess: async (cacheContext) => {
    if (cacheContext.cacheHasChanged) {
      const cacheFile = getCacheFilePath();
      try {
        ensureCacheDir();
        const serialized = cacheContext.tokenCache.serialize();
        // SEC-003: token cache holds refresh tokens — owner-only (0o600).
        writeSecureFile(cacheFile, serialized);
        log(`Token cache written to file (${basename(cacheFile)})`);
      } catch (error) {
        log("Failed to write cache file:", error);
      }
    }
  },
};

// ─── Auth Readiness Guard ───────────────────────────────────────────────────

let authReadyResolve: (() => void) | null = null;
let authReadyReject: ((err: Error) => void) | null = null;
let authReadyPromise: Promise<void> | null = null;

function ensurePcaInitialized(): PublicClientApplication {
  if (!pca) {
    throw new Error(
      "MSAL PublicClientApplication not initialized. Call initializeAuth() first.",
    );
  }
  return pca;
}

// ─── Helper: Cached Account ─────────────────────────────────────────────────

/**
 * Extract the HOME tenant id from an MSAL homeAccountId.
 * Format is "<oid>.<homeTenantId>" (both GUIDs). The home tenant is the segment
 * after the final '.'. Returns undefined if it cannot be parsed.
 *
 * Exported for unit testing.
 */
export function homeTenantOf(account: Pick<AccountInfo, "homeAccountId">): string | undefined {
  const id = account.homeAccountId;
  if (!id) return undefined;
  const dot = id.lastIndexOf(".");
  if (dot < 0 || dot === id.length - 1) return undefined;
  return id.slice(dot + 1);
}

/**
 * Choose the cached account that belongs to the configured tenant.
 *
 * Hardened: the cache can hold accounts from MULTIPLE tenants —
 * including GUEST records. Under a given authority, AccountInfo.tenantId is the
 * AUTHORITY tenant for ALL of them, so it cannot discriminate; the HOME tenant
 * (homeAccountId "<oid>.<homeTenantId>") is authoritative. We ONLY return an
 * account whose home tenant matches the configured tenant. If there is no match
 * we return null (forcing interactive auth) instead of falling back to the
 * first cached account, which previously risked handing back a WRONG-TENANT
 * token on a tenant switch.
 *
 * When no tenant is configured we cannot discriminate, so the first account is
 * returned (legacy behavior; off the normal configured-auth path).
 *
 * Exported for unit testing.
 */
export function selectAccountForTenant(
  accounts: AccountInfo[],
  configuredTenant: string | undefined,
): AccountInfo | null {
  if (accounts.length === 0) return null;
  if (!configuredTenant) return accounts[0];
  return accounts.find((a) => homeTenantOf(a) === configuredTenant) ?? null;
}

export async function getCachedAccount(): Promise<AccountInfo | null> {
  const cache = ensurePcaInitialized().getTokenCache();
  const accounts = await cache.getAllAccounts();
  if (accounts.length === 0) {
    log("No cached accounts found");
    return null;
  }

  const configuredTenant = authConfig?.tenantId;
  const chosen = selectAccountForTenant(accounts, configuredTenant);

  if (chosen) {
    log(
      `Selected cached account ${chosen.username} ` +
        `(homeAccountId=${chosen.homeAccountId}, homeTenant=${homeTenantOf(chosen)}; ` +
        `${accounts.length} cached; home-tenant match)`,
    );
    return chosen;
  }

  // No account whose HOME tenant equals the configured tenant. This is the
  // normal guest / B2B case: e.g. signing into an SPE resource/test tenant with
  // a corporate identity whose home tenant differs. The on-disk cache is
  // partitioned by (tenant, client) — see getCacheFilePath — so every account in
  // it was obtained under the configured authority and is valid to TRY. We
  // therefore attempt silent acquisition for such an account rather than forcing
  // interactive. The authoritative wrong-tenant protection is the check on the
  // ISSUED TOKEN's tenant (see isWrongTenantToken, enforced in acquireTokenSilent)
  // — not the account's home tenant, which is only a heuristic and wrongly
  // excludes guests.
  const candidate = accounts[0];
  log(
    `No home-tenant match for configured tenant ${configuredTenant}; ` +
      `attempting silent acquisition for partitioned-cache account ${candidate.username} ` +
      `(homeTenant=${homeTenantOf(candidate)}; guest/B2B) — issued-token tenant will be verified`,
  );
  return candidate;
}

// ─── Auth Flow: Silent ──────────────────────────────────────────────────────

/**
 * Authoritative wrong-tenant guard.
 *
 * Returns true when an issued token's tenant does NOT match the configured
 * tenant. We read the tenant from the MSAL result (`tenantId`, falling back to
 * the bound account's `tenantId`) — this is the tenant the token was actually
 * minted for, which is the correct signal for "is this the right tenant," unlike
 * the account's HOME tenant (a guest's home tenant legitimately differs from the
 * resource tenant they hold a valid token for). When the configured tenant or
 * the issued tenant is unknown we do not block (cannot prove a mismatch).
 *
 * Exported for unit testing.
 */
export function isWrongTenantToken(
  result: Pick<AuthenticationResult, "tenantId" | "account">,
  configuredTenant: string | undefined,
): boolean {
  if (!configuredTenant) return false;
  const issuedTenant = result.tenantId || result.account?.tenantId;
  if (!issuedTenant) return false;
  return issuedTenant !== configuredTenant;
}

async function acquireTokenSilent(account: AccountInfo): Promise<AuthenticationResult | null> {
  try {
    log("Attempting silent token acquisition...");
    const silentRequest: SilentFlowRequest = {
      scopes: getScopes(),
      account,
    };
    const result = await ensurePcaInitialized().acquireTokenSilent(silentRequest);

    // Authoritative wrong-tenant protection: verify the tenant the token was
    // issued for, not the account's home tenant. This both (a) allows guest/B2B
    // accounts whose home tenant differs from the configured resource tenant and
    // (b) still refuses a token that was actually minted for the wrong tenant.
    const configuredTenant = authConfig?.tenantId;
    if (isWrongTenantToken(result, configuredTenant)) {
      const issuedTenant = result.tenantId || result.account?.tenantId;
      log(
        `Silent token tenant ${issuedTenant} does not match configured tenant ` +
          `${configuredTenant} — rejecting to avoid a wrong-tenant token`,
      );
      return null;
    }

    log("Silent token acquisition succeeded");
    return result;
  } catch (error) {
    if (error instanceof InteractionRequiredAuthError) {
      const accountHomeTenant = homeTenantOf(account);
      const configuredTenant = authConfig?.tenantId;
      if (configuredTenant && accountHomeTenant && accountHomeTenant !== configuredTenant) {
        log(
          `Silent acquisition failed — interaction required (account home tenant ` +
            `${accountHomeTenant} does not match configured tenant ${configuredTenant})`,
        );
      } else {
        log("Silent acquisition failed — interaction required");
      }
      return null;
    }
    log("Silent acquisition failed:", error);
    throw error instanceof Error ? error : new Error(String(error));
  }
}

// ─── Auth Flow: Device Code ─────────────────────────────────────────────────

async function acquireTokenByDeviceCode(): Promise<AuthenticationResult> {
  log("Starting device code flow...");

  const deviceCodeRequest: DeviceCodeRequest = {
    scopes: getScopes(),
    deviceCodeCallback: (response) => {
      console.error(`\n${"=".repeat(60)}`);
      console.error("  AUTHENTICATION REQUIRED");
      console.error("=".repeat(60));
      console.error(`\n  To sign in, open your browser to:\n`);
      console.error(`    ${response.verificationUri}\n`);
      console.error(`  And enter the code:\n`);
      console.error(`    ${response.userCode}\n`);
      console.error(`  ${response.message}`);
      console.error(`${"=".repeat(60)}\n`);
    },
    cancel: false,
  };

  const timeoutId = setTimeout(() => {
    deviceCodeRequest.cancel = true;
  }, DEVICE_CODE_TIMEOUT_MS);

  try {
    const result = await ensurePcaInitialized().acquireTokenByDeviceCode(deviceCodeRequest);
    if (!result) {
      throw new Error("Device code flow returned no result");
    }
    log("Device code flow succeeded");
    return result;
  } finally {
    clearTimeout(timeoutId);
  }
}

// ─── Auth Flow: Interactive Browser ─────────────────────────────────────────

async function acquireTokenInteractive(): Promise<AuthenticationResult> {
  log("Starting interactive browser flow...");
  try {
    const result = await ensurePcaInitialized().acquireTokenInteractive({
      scopes: getScopes(),
      openBrowser: async (url) => {
        log(`Opening browser for auth: ${url}`);
        await open(url);
      },
      successTemplate:
        "<h1>Authentication successful!</h1><p>You can close this window and return to your terminal.</p>",
      errorTemplate:
        "<h1>Authentication failed</h1><p>Please close this window and try again.</p>",
    });
    if (!result) {
      throw new Error("Interactive flow returned no result");
    }
    log("Interactive flow succeeded");
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    throw new Error(`Interactive authentication failed: ${message}`, { cause: error });
  }
}

// ─── Interactive Waterfall ──────────────────────────────────────────────────

async function acquireTokenInteractiveWithFallbacks(): Promise<AuthenticationResult> {
  const strategies: Array<{ name: string; fn: () => Promise<AuthenticationResult> }> = [];

  // NOTE: Azure CLI is intentionally NOT in the waterfall here.
  // `az account get-access-token` returns a token under Azure CLI's own
  // client ID, which won't carry the SPE delegated scopes
  // (FileStorageContainer.Selected, etc.) that are registered on OUR app.
  // SPE requires tokens obtained via our specific app registration.

  // Interactive sign-in is attempted by default (browser first, device code as
  // fallback) — even over stdio, since a local server can open the user's
  // browser. SPE_NON_INTERACTIVE disables this for automation/CI.
  if (interactiveEnabled) {
    strategies.push({ name: "interactive browser", fn: acquireTokenInteractive });
    // Only fall back to device code when its stderr prompt is actually visible
    // (a TTY). Over stdio the code would print where no one can see it and the
    // call would hang for up to 10 minutes — so we skip it and fail fast below.
    if (deviceCodeIsVisible()) {
      strategies.push({ name: "device code", fn: acquireTokenByDeviceCode });
    }
  }

  let lastError: Error | undefined;
  for (const strategy of strategies) {
    try {
      const result = await strategy.fn();
      log(`Authentication succeeded (${strategy.name})`);
      return result;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      log(`${strategy.name} failed, trying next...`, lastError.message);
    }
  }

  if (!interactiveEnabled) {
    throw new AppError(
      "AUTH_REQUIRED",
      "No cached credentials and interactive sign-in is disabled (SPE_NON_INTERACTIVE).",
      {
        safeMessage:
          "No cached credentials and interactive sign-in is disabled (SPE_NON_INTERACTIVE). " +
          "Run `spe-mcp auth --client-id <appId> --tenant-id <tenantId>` in a terminal to " +
          "pre-cache a token, then retry.",
        suggestion: "Pre-cache a token with `spe-mcp auth`, or unset SPE_NON_INTERACTIVE.",
      },
    );
  }

  throw new AppError("AUTH_FAILED", `Authentication failed. All sign-in methods exhausted. ${lastError?.message}`, {
    safeMessage:
      "Sign-in did not complete. A browser should have opened for you to consent to the SPE " +
      "app — complete it and retry. If no browser opened (headless/remote), run " +
      "`spe-mcp auth --client-id <appId> --tenant-id <tenantId>` in a terminal, then retry.",
    suggestion: "Complete the browser consent and retry.",
  });
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Initialize authentication at server startup.
 */
export async function initializeAuth(): Promise<void> {
  if (authReadyPromise) {
    return authReadyPromise;
  }

  log("Initializing authentication...");
  const config = getConfig();

  authReadyPromise = new Promise<void>((resolve, reject) => {
    authReadyResolve = resolve;
    authReadyReject = reject;
  });
  authReadyPromise.catch(() => {});

  try {
    const msalConfig: Configuration = {
      auth: {
        clientId: config.clientId,
        authority: getAuthority(),
      },
      cache: {
        cachePlugin: fileCachePlugin,
      },
      system: {
        loggerOptions: {
          logLevel: LogLevel.Warning,
          loggerCallback: (_level, message) => log(`[MSAL] ${message}`),
          piiLoggingEnabled: false,
        },
      },
    };

    pca = new PublicClientApplication(msalConfig);

    const account = await getCachedAccount();
    if (account) {
      const result = await acquireTokenSilent(account);
      if (result) {
        log("Authentication ready (silent)");
        authReadyResolve?.();
        return;
      }
      log("Cached account found but silent acquisition failed, need interactive login");
    }

    await acquireTokenInteractiveWithFallbacks();
    authReadyResolve?.();
  } catch (error) {
    authReadyReject?.(error instanceof Error ? error : new Error(String(error)));
    authReadyResolve = null;
    authReadyReject = null;
    authReadyPromise = null;
    throw error;
  }
}

/**
 * Get a valid access token for Microsoft Graph.
 * Called on every HTTP request. Uses silent acquisition with fallback.
 */
export async function getAccessToken(): Promise<string> {
  log("getAccessToken called");

  if (authReadyPromise) {
    try {
      await authReadyPromise;
    } catch {
      log("Auth init promise was rejected — proceeding to acquire token directly");
    }
  }

  if (!pca) {
    log("PCA not initialized — creating now for on-demand auth");
    const config = getConfig();
    pca = new PublicClientApplication({
      auth: {
        clientId: config.clientId,
        authority: getAuthority(),
      },
      cache: { cachePlugin: fileCachePlugin },
      system: {
        loggerOptions: {
          logLevel: LogLevel.Warning,
          loggerCallback: (_level, message) => log(`[MSAL] ${message}`),
          piiLoggingEnabled: false,
        },
      },
    });
  }

  const account = await getCachedAccount();
  if (account) {
    const result = await acquireTokenSilent(account);
    if (result) {
      return result.accessToken;
    }
  }

  log("Silent acquisition unavailable, falling back to interactive methods...");
  const result = await acquireTokenInteractiveWithFallbacks();
  return result.accessToken;
}

/**
 * Authenticate interactively (for `spe-mcp auth` CLI command).
 */
export async function authenticateInteractively(): Promise<void> {
  const config = getConfig();
  pca = new PublicClientApplication({
    auth: {
      clientId: config.clientId,
      authority: getAuthority(),
    },
    cache: { cachePlugin: fileCachePlugin },
    system: {
      loggerOptions: {
        logLevel: LogLevel.Warning,
        loggerCallback: (_level, message) => log(`[MSAL] ${message}`),
        piiLoggingEnabled: false,
      },
    },
  });

  const account = await getCachedAccount();
  if (account) {
    const result = await acquireTokenSilent(account);
    if (result) {
      console.log(`Already authenticated as ${account.username}`);
      return;
    }
  }

  await acquireTokenInteractiveWithFallbacks();
}

/**
 * Clear cached tokens (logout). Removes the current tenant's partitioned cache
 * file as well as the legacy single-file cache, and evicts any in-memory
 * accounts. Safe to call when files do not exist.
 */
export async function clearCachedToken(): Promise<void> {
  try {
    log("Clearing cached tokens...");
    const { unlinkSync } = await import("node:fs");
    const filesToRemove = new Set([getCacheFilePath(), LEGACY_CACHE_FILE]);
    for (const file of filesToRemove) {
      try {
        if (existsSync(file)) {
          unlinkSync(file);
          log(`Removed cache file (${basename(file)})`);
        }
      } catch { /* ignore */ }
    }

    if (pca) {
      const tokenCache = pca.getTokenCache();
      const accounts = await tokenCache.getAllAccounts();
      for (const account of accounts) {
        await tokenCache.removeAccount(account);
      }
    }

    log("Cached tokens cleared");
  } catch (error) {
    log("Failed to clear cached tokens:", error);
    throw error;
  }
}

// ─── Test seam ──────────────────────────────────────────────────────────────
// Internal hooks used ONLY by unit tests to inject/inspect in-memory state
// without performing real interactive authentication. Not part of the public API.

export const __testing = {
  /** Inject a (possibly fake) PublicClientApplication so getCachedAccount can run. */
  setPca(value: PublicClientApplication | null): void {
    pca = value;
  },
  /** Read the current in-memory PublicClientApplication (null after a reset). */
  getPca(): PublicClientApplication | null {
    return pca;
  },
  /**
   * Reproduce the in-flight readiness state that initializeAuth() establishes
   * while an acquisition is still pending (see initializeAuth): a pending
   * authReadyPromise with its resolve/reject handles captured into module state,
   * plus the same no-op `.catch()` so a later reset-driven rejection can never
   * surface as an unhandled rejection. Returns the pending promise so a test can
   * assert how it settles (e.g. that resetInMemoryAuthState rejects rather than
   * abandons it). Kept as a test seam so the hang can be asserted hermetically,
   * without invoking real MSAL interactive sign-in.
   */
  primeInflightReadiness(): Promise<void> {
    authReadyPromise = new Promise<void>((resolve, reject) => {
      authReadyResolve = resolve;
      authReadyReject = reject;
    });
    authReadyPromise.catch(() => {});
    return authReadyPromise;
  },
  /** Read the current in-memory readiness promise (null after a reset). */
  getAuthReadyPromise(): Promise<void> | null {
    return authReadyPromise;
  },
  /** Fully reset module auth state between tests. */
  reset(): void {
    authConfig = null;
    resetInMemoryAuthState();
  },
};
