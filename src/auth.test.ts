// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Unit tests for tenant-safe token caching and account selection.
 *
 * These cover the regression where a cached identity from a prior tenant
 * interfered on a tenant switch:
 *   - per-tenant cache file partitioning (no co-mingling),
 *   - getCachedAccount() preferring a home-tenant match, and falling back to a
 *     partitioned-cache (guest/B2B) candidate to attempt silent — with the
 *     authoritative wrong-tenant guard on the ISSUED TOKEN (isWrongTenantToken),
 *   - setAuthConfig() tenant change dropping stale in-memory state.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AccountInfo,
  AuthenticationResult,
  DeviceCodeRequest,
  PublicClientApplication,
} from "@azure/msal-node";
import {
  __testing,
  formatLoginSuccessMessage,
  getAccessToken,
  getCacheFilePath,
  getCachedAccount,
  homeTenantOf,
  isOwningAppConfigured,
  isWrongTenantToken,
  OWNING_APP_REQUIRED_MESSAGE,
  renderAuthErrorHtml,
  renderAuthSuccessHtml,
  selectAccountForTenant,
  setAuthConfig,
} from "./auth.js";
import { AppError } from "./errors.js";
import { guid, GUID_REGEX } from "./tooling/fields.js";

const TENANT_A = "475485dd-63d4-4f8c-af70-60f7a6c74940";
const TENANT_B = "99999999-9999-9999-9999-999999999999";
const CLIENT_ID = "11111111-2222-3333-4444-555555555555";

/**
 * Build a minimal AccountInfo with a given HOME tenant.
 *
 * The home tenant is encoded here in `homeAccountId` ("<oid>.<homeTenant>") — it
 * is what `homeTenantOf()` parses, and it is NOT set by `setAuthConfig()`.
 * `setAuthConfig()` only records the CONFIGURED/resource tenant the server
 * targets; the two legitimately differ for guest/B2B accounts (home tenant ≠
 * resource tenant), which is why the tests supply them independently.
 */
function account(homeTenant: string, username: string, oid = "oid-0000"): AccountInfo {
  return {
    homeAccountId: `${oid}.${homeTenant}`,
    environment: "login.microsoftonline.com",
    tenantId: homeTenant,
    username,
    localAccountId: oid,
  } as AccountInfo;
}

/** A fake PCA whose token cache returns the supplied accounts. */
function fakePca(accounts: AccountInfo[]): PublicClientApplication {
  // getTokenCache carries an explicit return-type annotation. Without it, its
  // type is inferred through the outer `as unknown as PublicClientApplication`
  // cast and IntelliSense reports `getTokenCache` as implicitly `any` (ts7022,
  // "referenced directly or indirectly in its own initializer").
  return {
    getTokenCache: (): { getAllAccounts: () => Promise<AccountInfo[]> } => ({
      getAllAccounts: async () => accounts,
    }),
  } as unknown as PublicClientApplication;
}

afterEach(() => {
  __testing.reset();
});

describe("test identity constants", () => {
  // Tenant and client IDs are Entra directory GUIDs. Enforce the canonical GUID
  // shape on the fixtures so the auth tests cannot drift onto placeholder values
  // that would never occur in a real token/config. Scoped to tenant/client IDs
  // (container/containerType IDs are validated as opaque non-empty strings).
  const guidSchema = guid("id");

  it.each([
    ["TENANT_A", TENANT_A],
    ["TENANT_B", TENANT_B],
    ["CLIENT_ID", CLIENT_ID],
  ])("%s is a canonical GUID", (_name, value) => {
    expect(value).toMatch(GUID_REGEX);
    expect(guidSchema.safeParse(value).success).toBe(true);
  });

  it("the shared guid builder rejects a non-GUID id", () => {
    expect(guidSchema.safeParse("not-a-guid").success).toBe(false);
  });
});

describe("homeTenantOf", () => {
  it("extracts the home tenant from <oid>.<homeTenantId>", () => {
    expect(homeTenantOf({ homeAccountId: `abc.${TENANT_A}` })).toBe(TENANT_A);
  });

  it("returns undefined for missing or malformed ids", () => {
    expect(homeTenantOf({ homeAccountId: undefined as unknown as string })).toBeUndefined();
    expect(homeTenantOf({ homeAccountId: "no-dot" })).toBeUndefined();
    expect(homeTenantOf({ homeAccountId: "trailing." })).toBeUndefined();
  });
});

describe("getCacheFilePath — partitioning", () => {
  it("derives different cache files for different tenants (no co-mingling)", () => {
    const pathA = getCacheFilePath({ clientId: CLIENT_ID, tenantId: TENANT_A });
    const pathB = getCacheFilePath({ clientId: CLIENT_ID, tenantId: TENANT_B });
    expect(pathA).not.toBe(pathB);
    expect(pathA).toContain(TENANT_A);
    expect(pathB).toContain(TENANT_B);
  });

  it("partitions by client id as well", () => {
    const p1 = getCacheFilePath({ clientId: "client-one", tenantId: TENANT_A });
    const p2 = getCacheFilePath({ clientId: "client-two", tenantId: TENANT_A });
    expect(p1).not.toBe(p2);
  });

  it("falls back to the legacy single-file path when no tenant is configured", () => {
    expect(getCacheFilePath(null).endsWith("token-cache.json")).toBe(true);
  });

  it("uses the currently configured tenant when called with no argument", () => {
    setAuthConfig({ clientId: CLIENT_ID, tenantId: TENANT_A });
    expect(getCacheFilePath()).toContain(TENANT_A);
  });
});

describe("selectAccountForTenant — wrong-tenant hardening", () => {
  it("returns null when the only cached account belongs to a different tenant", () => {
    const accounts = [account(TENANT_A, "user@a.com")];
    expect(selectAccountForTenant(accounts, TENANT_B)).toBeNull();
  });

  it("returns the home-tenant match among multiple accounts (incl. a guest)", () => {
    const guest = account(TENANT_A, "guest@corp.com", "guest-oid");
    const member = account(TENANT_B, "member@b.com", "member-oid");
    const chosen = selectAccountForTenant([guest, member], TENANT_B);
    expect(chosen).toBe(member);
  });

  it("returns null when no cached account matches the configured tenant", () => {
    const accounts = [account(TENANT_A, "a@a.com"), account("99999999-0000-0000-0000-000000000000", "x@x.com")];
    expect(selectAccountForTenant(accounts, TENANT_B)).toBeNull();
  });

  it("returns the first account only when no tenant is configured (legacy path)", () => {
    const accounts = [account(TENANT_A, "a@a.com"), account(TENANT_B, "b@b.com")];
    expect(selectAccountForTenant(accounts, undefined)).toBe(accounts[0]);
  });

  it("returns null for an empty cache", () => {
    expect(selectAccountForTenant([], TENANT_A)).toBeNull();
  });
});

describe("getCachedAccount — end to end with injected cache", () => {
  it("falls back to a partitioned-cache (guest/B2B) candidate to attempt silent when no home-tenant match", async () => {
    // BUG-1 regression: the cache file is partitioned by (tenant, client), so an
    // account whose HOME tenant differs (a guest signed into the resource tenant)
    // is still valid to TRY. getCachedAccount must return it for a silent attempt
    // rather than returning null and forcing interactive sign-in. The real
    // wrong-tenant protection is the issued-token check (see isWrongTenantToken).
    setAuthConfig({ clientId: CLIENT_ID, tenantId: TENANT_B });
    const guest = account(TENANT_A, "guest@corp.com", "guest-oid");
    __testing.setPca(fakePca([guest]));
    expect(await getCachedAccount()).toBe(guest);
  });

  it("prefers the home-tenant match when one exists among guests", async () => {
    setAuthConfig({ clientId: CLIENT_ID, tenantId: TENANT_B });
    const member = account(TENANT_B, "member@b.com", "member-oid");
    __testing.setPca(fakePca([account(TENANT_A, "guest@corp.com", "guest-oid"), member]));
    expect(await getCachedAccount()).toBe(member);
  });

  it("returns null for an empty cache", async () => {
    setAuthConfig({ clientId: CLIENT_ID, tenantId: TENANT_A });
    __testing.setPca(fakePca([]));
    expect(await getCachedAccount()).toBeNull();
  });
});

describe("isWrongTenantToken — authoritative issued-token guard", () => {
  it("accepts a guest token whose issued tenant matches the configured tenant", () => {
    // Why the home and issued tenants differ here (a normal B2B flow, not a corner
    // case): a user whose HOME tenant is A can be invited as a guest into tenant B.
    // MSAL then mints a token ISSUED for the configured resource tenant B while the
    // account's home tenant stays A. Because the tenants legitimately differ, the
    // guard keys off the ISSUED tenant and MUST accept this token.
    const result = {
      tenantId: TENANT_B,
      account: account(TENANT_A, "guest@corp.com", "guest-oid"),
    };
    expect(isWrongTenantToken(result, TENANT_B)).toBe(false);
  });

  it("rejects a token actually minted for a different tenant", () => {
    const result = {
      tenantId: TENANT_A,
      account: account(TENANT_A, "stale@a.com"),
    };
    expect(isWrongTenantToken(result, TENANT_B)).toBe(true);
  });

  it("falls back to the account tenant when result.tenantId is absent", () => {
    const result = { tenantId: "", account: account(TENANT_A, "a@a.com") };
    expect(isWrongTenantToken(result, TENANT_B)).toBe(true);
    expect(isWrongTenantToken({ tenantId: "", account: account(TENANT_B, "b@b.com") }, TENANT_B)).toBe(false);
  });

  it("does not block when the configured or issued tenant is unknown", () => {
    expect(isWrongTenantToken({ tenantId: TENANT_A, account: undefined }, undefined)).toBe(false);
    expect(isWrongTenantToken({ tenantId: "", account: undefined }, TENANT_B)).toBe(false);
  });
});

describe("setAuthConfig — tenant switch resets stale in-memory state", () => {
  it("drops the in-memory PublicClientApplication on a tenant change", () => {
    setAuthConfig({ clientId: CLIENT_ID, tenantId: TENANT_A });
    __testing.setPca(fakePca([account(TENANT_A, "a@a.com")]));
    expect(__testing.getPca()).not.toBeNull();

    setAuthConfig({ clientId: CLIENT_ID, tenantId: TENANT_B });
    expect(__testing.getPca()).toBeNull();
  });

  it("drops the in-memory PublicClientApplication on a client change", () => {
    setAuthConfig({ clientId: "client-one", tenantId: TENANT_A });
    __testing.setPca(fakePca([account(TENANT_A, "a@a.com")]));
    setAuthConfig({ clientId: "client-two", tenantId: TENANT_A });
    expect(__testing.getPca()).toBeNull();
  });

  it("keeps in-memory state when the config is unchanged", () => {
    setAuthConfig({ clientId: CLIENT_ID, tenantId: TENANT_A });
    const pca = fakePca([account(TENANT_A, "a@a.com")]);
    __testing.setPca(pca);
    setAuthConfig({ clientId: CLIENT_ID, tenantId: TENANT_A });
    expect(__testing.getPca()).toBe(pca);
  });
});

describe("resetInMemoryAuthState — settles in-flight readiness (WI-06 hang fix)", () => {
  // Race a promise against a timeout so a REGRESSION surfaces as a clear test
  // failure instead of a suite-wide hang. On the fixed code the awaiter settles
  // in a microtask, so this resolves effectively instantly.
  function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
    return Promise.race([
      p,
      new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timeout: ${label}`)), ms)),
    ]);
  }

  it("rejects a previously-captured in-flight readiness promise with AUTH_RESET after a switch", async () => {
    // Model an initializeAuth() that is mid-flight (acquisition pending) against
    // the OLD authority.
    setAuthConfig({ clientId: CLIENT_ID, tenantId: TENANT_A });
    const inflight = __testing.primeInflightReadiness();
    expect(__testing.getAuthReadyPromise()).not.toBeNull();

    // A tenant switch drops in-memory MSAL state via resetInMemoryAuthState().
    setAuthConfig({ clientId: CLIENT_ID, tenantId: TENANT_B });

    // The captured promise MUST settle (reject) rather than be abandoned unsettled —
    // rejected because the pending init was against the old authority.
    await expect(inflight).rejects.toBeInstanceOf(AppError);
    await expect(inflight).rejects.toMatchObject({ code: "AUTH_RESET" });
    // Handles are dropped only AFTER the settle, and the module reference is cleared.
    expect(__testing.getAuthReadyPromise()).toBeNull();
  });

  it("rejects the in-flight readiness promise on a client change too", async () => {
    setAuthConfig({ clientId: "client-one", tenantId: TENANT_A });
    const inflight = __testing.primeInflightReadiness();
    setAuthConfig({ clientId: "client-two", tenantId: TENANT_A });
    await expect(inflight).rejects.toMatchObject({ code: "AUTH_RESET" });
  });

  it("releases a concurrent getAccessToken-style awaiter on a tenant switch (no hang)", async () => {
    // Concurrency regression: initializeAuth() is in flight, a concurrent caller
    // is parked on `await authReadyPromise` (getAccessToken's readiness guard),
    // and a tenant/client switch resets in-memory state. Before the fix the
    // resolve/reject handles were nulled WITHOUT settling the pending promise, so
    // this awaiter hung forever. We assert at the exact await site — hermetically,
    // without real MSAL interactive sign-in — that it is released.
    setAuthConfig({ clientId: CLIENT_ID, tenantId: TENANT_A });
    const inflight = __testing.primeInflightReadiness();

    let released = false;
    const awaiter = (async () => {
      // Mirror getAccessToken's guard: await readiness, swallow a rejection, then
      // fall through to on-demand acquisition against the NEW config.
      try {
        await inflight;
      } catch {
        // getAccessToken proceeds to acquire a token on demand here.
      }
      released = true;
    })();

    // Switch tenants mid-init -> resetInMemoryAuthState() settles the promise.
    setAuthConfig({ clientId: CLIENT_ID, tenantId: TENANT_B });

    await withTimeout(awaiter, 1000, "awaiter did not settle after reset (hang regression)");
    expect(released).toBe(true);
  });
});

describe("owning-app precondition guidance (UX)", () => {
  it("isOwningAppConfigured() is true once auth is configured", () => {
    setAuthConfig({ clientId: CLIENT_ID, tenantId: TENANT_A });
    expect(isOwningAppConfigured()).toBe(true);
  });

  it("OWNING_APP_REQUIRED_MESSAGE carries the actionable remediation guidance", () => {
    // Assert on the actionable substrings the user needs, not the exact prose
    // (which stays free to be reworded). Cover BOTH remediation paths plus the
    // restart-free promise so a regression that drops either path is caught:
    //   1. the primary fix — the project_app_create tool,
    expect(OWNING_APP_REQUIRED_MESSAGE).toMatch(/project_app_create/);
    //   2. that it takes effect with no restart,
    expect(OWNING_APP_REQUIRED_MESSAGE).toMatch(/no restart/i);
    //   3. the alternative for an already-provisioned app — the CLI flags.
    expect(OWNING_APP_REQUIRED_MESSAGE).toMatch(/--owning-app-client-id/);
    expect(OWNING_APP_REQUIRED_MESSAGE).toMatch(/--tenant-id/);
  });

  it("getAccessToken() throws a typed OWNING_APP_REQUIRED error when no owning app is configured", async () => {
    // authConfig=null regardless of on-disk state — getConfig() gates on it, so
    // this is deterministic and independent of the dev machine's ~/.spe-mcp state.
    __testing.reset();
    await expect(getAccessToken()).rejects.toMatchObject({
      code: "OWNING_APP_REQUIRED",
    });
    await expect(getAccessToken()).rejects.toBeInstanceOf(AppError);
  });
});

// ─── WI-14: login result messaging & next-step guidance ─────────────────────
describe("login result messaging (WI-14)", () => {
  const base = {
    clientId: CLIENT_ID,
    tenantId: TENANT_A,
    scopes: ["FileStorageContainer.Selected", "User.Read"],
  };

  it("success summary states the app, account, tenant, scopes and a real next tool", () => {
    const msg = formatLoginSuccessMessage({ ...base, account: "alice@contoso.com" });
    // Assert on stable structure/substrings, not the full brittle string.
    expect(msg).toMatch(/logged into your owning spe app successfully/i);
    expect(msg).toContain(CLIENT_ID);
    expect(msg).toContain(TENANT_A);
    expect(msg).toContain("alice@contoso.com");
    expect(msg).toContain("FileStorageContainer.Selected");
    expect(msg).toContain("User.Read");
    // Points the user at a REAL MCP tool rather than a vague instruction.
    expect(msg).toMatch(/status_get|project_provision/);
  });

  it("success summary omits the account line when the account is not yet known", () => {
    const msg = formatLoginSuccessMessage(base);
    expect(msg).not.toMatch(/Account:/);
    // Still reports what it does know.
    expect(msg).toContain(CLIENT_ID);
    expect(msg).toContain(TENANT_A);
  });

  it("browser success page includes app, tenant, scopes and a concrete next step", () => {
    const html = renderAuthSuccessHtml(base);
    expect(html).toMatch(/logged into your owning spe app successfully/i);
    expect(html).toContain(CLIENT_ID);
    expect(html).toContain(TENANT_A);
    expect(html).toContain("FileStorageContainer.Selected");
    expect(html).toMatch(/status_get|project_provision/);
  });

  it("browser success page HTML-escapes interpolated values", () => {
    const html = renderAuthSuccessHtml({ ...base, scopes: ['a<b>&"c'] });
    expect(html).toContain("a&lt;b&gt;&amp;&quot;c");
    expect(html).not.toContain('a<b>&"c');
  });

  it("browser error page gives actionable next steps, not a bare 'try again'", () => {
    const html = renderAuthErrorHtml();
    // The reviewer questioned whether a blind retry is the right guidance.
    expect(html.toLowerCase()).not.toContain("try again");
    // Actionable causes/fixes instead.
    expect(html).toMatch(/consent/i);
    expect(html).toMatch(/tenant/i);
    expect(html).toMatch(/redirect/i);
    // And a concrete terminal fallback.
    expect(html).toContain("spe-mcp auth");
  });
});

// ─── Device-code sign-in timeout (PR #3 review) ─────────────────────────────
// The Azure AD device code is valid ~15 minutes; MSAL polls the token endpoint
// until the user signs in or the code expires. A client-side cancel MUST NOT
// fire before that horizon — the previous fixed 10-min headless / 2-min TTY
// timeouts were SHORTER than the real code lifetime and would cancel a
// still-valid sign-in.
describe("device-code sign-in timeout", () => {
  const { DEVICE_CODE_LIFETIME_SECONDS, DEVICE_CODE_TIMEOUT_MS, deviceCodeCancelDelayMs } =
    __testing;

  it("bounds the cancel horizon at the ~15-min AAD device-code lifetime (never the old 600s/120s)", () => {
    // ~15 min = 900 s — the official AAD device-code lifetime.
    expect(DEVICE_CODE_LIFETIME_SECONDS).toBe(900);
    expect(DEVICE_CODE_TIMEOUT_MS).toBe(DEVICE_CODE_LIFETIME_SECONDS * 1000);
    // The horizon is at least the full code lifetime — the regression was a
    // shorter, premature bound.
    expect(DEVICE_CODE_TIMEOUT_MS).toBeGreaterThanOrEqual(DEVICE_CODE_LIFETIME_SECONDS * 1000);
    // Explicitly NOT the old premature values (2 min TTY / 10 min headless).
    expect(DEVICE_CODE_TIMEOUT_MS).not.toBe(600_000);
    expect(DEVICE_CODE_TIMEOUT_MS).not.toBe(120_000);
  });

  it("derives the cancel delay from the STS-reported expiresIn (seconds → ms)", () => {
    // expiresIn drives it: the real per-request lifetime flows straight through.
    expect(deviceCodeCancelDelayMs(900)).toBe(900_000);
    expect(deviceCodeCancelDelayMs(1200)).toBe(1_200_000);
    // …and it is never shorter than a valid expiresIn implies.
    expect(deviceCodeCancelDelayMs(900)).toBeGreaterThanOrEqual(
      DEVICE_CODE_LIFETIME_SECONDS * 1000,
    );
  });

  it("falls back to the ~15-min default when expiresIn is unknown or invalid", () => {
    // The timer is armed before the callback fires, so the default must equal the
    // full code lifetime (not a shorter value).
    expect(deviceCodeCancelDelayMs()).toBe(DEVICE_CODE_TIMEOUT_MS);
    expect(deviceCodeCancelDelayMs(undefined)).toBe(DEVICE_CODE_TIMEOUT_MS);
    expect(deviceCodeCancelDelayMs(0)).toBe(DEVICE_CODE_TIMEOUT_MS);
    expect(deviceCodeCancelDelayMs(-5)).toBe(DEVICE_CODE_TIMEOUT_MS);
    expect(deviceCodeCancelDelayMs(Number.NaN)).toBe(DEVICE_CODE_TIMEOUT_MS);
  });

  it("does not cancel a still-valid device code before it expires (expiresIn-driven, fake timers)", async () => {
    vi.useFakeTimers();
    // Silence the device-code prompt the flow prints to stderr.
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const EXPIRES_IN = 900; // seconds — what the STS returns
      let captured: DeviceCodeRequest | undefined;
      let resolvePca!: (r: AuthenticationResult) => void;
      const pcaPending = new Promise<AuthenticationResult>((res) => {
        resolvePca = res;
      });

      const fake = {
        acquireTokenByDeviceCode: (req: DeviceCodeRequest): Promise<AuthenticationResult> => {
          captured = req;
          // STS responds → callback fires with the real code lifetime.
          req.deviceCodeCallback({
            userCode: "ABCD-EFGH",
            deviceCode: "device-code-value",
            verificationUri: "https://microsoft.com/devicelogin",
            expiresIn: EXPIRES_IN,
            interval: 5,
            message: "To sign in, use a web browser to open the page…",
          });
          // Mirror MSAL: keep polling (stay pending) until the test settles us.
          return pcaPending;
        },
      } as unknown as PublicClientApplication;
      __testing.setPca(fake);

      const flow = __testing.acquireTokenByDeviceCode();
      // Let the async fn reach its await and the callback re-arm the timer.
      await Promise.resolve();

      // Native MSAL polling timeout is bound to the full code lifetime, not 600s.
      expect(captured?.timeout).toBe(DEVICE_CODE_LIFETIME_SECONDS);

      // Past the OLD 600s premature-cancel point, the code is still NOT cancelled.
      vi.advanceTimersByTime(601_000);
      expect(captured?.cancel).toBe(false);

      // Just shy of the real expiry — still valid.
      vi.advanceTimersByTime((EXPIRES_IN - 1) * 1000 - 601_000);
      expect(captured?.cancel).toBe(false);

      // At the code lifetime the safety-net cancel finally fires.
      vi.advanceTimersByTime(2_000);
      expect(captured?.cancel).toBe(true);

      // Let the flow settle so no promise is left dangling.
      resolvePca({ accessToken: "token" } as AuthenticationResult);
      await expect(flow).resolves.toMatchObject({ accessToken: "token" });
    } finally {
      consoleErr.mockRestore();
      vi.useRealTimers();
    }
  });
});
