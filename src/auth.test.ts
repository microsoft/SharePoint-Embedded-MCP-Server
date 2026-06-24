// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Unit tests for tenant-safe token caching and account selection.
 *
 * These cover the regression where a cached identity from a prior tenant
 * interfered on a tenant switch:
 *   - per-tenant cache file partitioning (no co-mingling),
 *   - getCachedAccount() never returning a wrong-tenant account,
 *   - setAuthConfig() tenant change dropping stale in-memory state.
 */

import { afterEach, describe, expect, it } from "vitest";
import type { AccountInfo, PublicClientApplication } from "@azure/msal-node";
import {
  __testing,
  getCacheFilePath,
  getCachedAccount,
  homeTenantOf,
  selectAccountForTenant,
  setAuthConfig,
} from "./auth.js";

const TENANT_A = "475485dd-63d4-4f8c-af70-60f7a6c74940";
const TENANT_B = "99999999-9999-9999-9999-999999999999";
const CLIENT_ID = "11111111-2222-3333-4444-555555555555";

/** Build a minimal AccountInfo with a given home tenant. */
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
  return {
    getTokenCache: () => ({
      getAllAccounts: async () => accounts,
    }),
  } as unknown as PublicClientApplication;
}

afterEach(() => {
  __testing.reset();
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
  it("returns null (not a wrong-tenant account) when only a different tenant is cached", async () => {
    setAuthConfig({ clientId: CLIENT_ID, tenantId: TENANT_B });
    __testing.setPca(fakePca([account(TENANT_A, "stale@a.com")]));
    expect(await getCachedAccount()).toBeNull();
  });

  it("returns the matching account when a home-tenant match exists among guests", async () => {
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
