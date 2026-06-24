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

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
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

// Device code timeout: 2 min interactive, 10 min headless (user needs time
// to find the auth prompt in stderr / MCP logs).
const DEVICE_CODE_TIMEOUT_MS = process.stderr.isTTY ? 120_000 : 600_000;

let isHeadless = !process.stderr.isTTY;

/** Force interactive mode (used by `spe-mcp auth` CLI command). */
export function setInteractiveMode(): void {
  isHeadless = false;
}

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
  pca = null;
  authReadyPromise = null;
  authReadyResolve = null;
  authReadyReject = null;
}

function getConfig(): AuthConfig {
  if (!authConfig) {
    throw new Error(
      "Auth not configured. Call setAuthConfig() with clientId and tenantId before using auth.",
    );
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
  if (!existsSync(CACHE_DIR)) {
    mkdirSync(CACHE_DIR, { recursive: true });
  }
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
        writeFileSync(cacheFile, serialized, "utf-8");
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

  if (!chosen) {
    log(
      `No cached account matches configured tenant ${configuredTenant} ` +
        `(${accounts.length} cached account(s) belong to other tenants); ` +
        "interactive authentication required to avoid a wrong-tenant token",
    );
    return null;
  }

  log(
    `Selected cached account ${chosen.username} ` +
      `(homeAccountId=${chosen.homeAccountId}, homeTenant=${homeTenantOf(chosen)}; ` +
      `${accounts.length} cached)`,
  );
  return chosen;
}

// ─── Auth Flow: Silent ──────────────────────────────────────────────────────

async function acquireTokenSilent(account: AccountInfo): Promise<AuthenticationResult | null> {
  try {
    log("Attempting silent token acquisition...");
    const silentRequest: SilentFlowRequest = {
      scopes: getScopes(),
      account,
    };
    const result = await ensurePcaInitialized().acquireTokenSilent(silentRequest);
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

  if (!isHeadless) {
    strategies.push({ name: "interactive browser", fn: acquireTokenInteractive });
    strategies.push({ name: "device code", fn: acquireTokenByDeviceCode });
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

  if (isHeadless) {
    throw new Error(
      "No cached credentials found. Run `spe-mcp auth` in a terminal to authenticate, then restart the server.",
    );
  }

  throw new Error(`Authentication failed. All sign-in methods exhausted.\n${lastError?.message}`);
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
  /** Fully reset module auth state between tests. */
  reset(): void {
    authConfig = null;
    resetInMemoryAuthState();
  },
};
