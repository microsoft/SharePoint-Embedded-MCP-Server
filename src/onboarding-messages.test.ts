// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Unit tests for onboarding-messages.ts — the NON-BLOCKING onboarding/consent
 * guidance strings (PR #3 review). These are pure functions: they only build
 * text, so the tests assert URL shape, the admin/non-admin explanation, the
 * missing-tenant fallback, and — critically — that no secret ever leaks into the
 * admin-consent URL (only tenant id + public client id).
 */

import { describe, it, expect } from "vitest";
import {
  adminConsentUrl,
  adminConsentSection,
  byoAppStartupNote,
  azLoginNotSignedInMessage,
} from "./onboarding-messages.js";

describe("adminConsentUrl", () => {
  it("builds the tenant-wide admin-consent URL from tenant id + client id", () => {
    expect(adminConsentUrl("client-abc", "tenant-123")).toBe(
      "https://login.microsoftonline.com/tenant-123/adminconsent?client_id=client-abc",
    );
  });

  it("uses the REAL tenant id (not `common`/`organizations`) when available", () => {
    const url = adminConsentUrl("app-1", "00000000-0000-0000-0000-000000000009");
    expect(url).toContain("/00000000-0000-0000-0000-000000000009/adminconsent");
    expect(url).not.toContain("/common/");
    expect(url).not.toContain("/organizations/");
  });

  it("falls back to `organizations` when the tenant id is missing or blank", () => {
    expect(adminConsentUrl("app-1")).toBe(
      "https://login.microsoftonline.com/organizations/adminconsent?client_id=app-1",
    );
    expect(adminConsentUrl("app-1", "")).toContain("/organizations/adminconsent");
    expect(adminConsentUrl("app-1", "   ")).toContain("/organizations/adminconsent");
  });

  it("never includes a token/secret — only tenant id and public client id", () => {
    const url = adminConsentUrl("public-client-id", "tenant-1");
    expect(url).not.toMatch(/secret/i);
    expect(url).not.toMatch(/token/i);
    expect(url).not.toMatch(/password/i);
    // The only query parameter is client_id.
    const query = url.split("?")[1] ?? "";
    expect(query).toBe("client_id=public-client-id");
  });
});

describe("adminConsentSection", () => {
  it("embeds the copy-paste admin-consent URL with the given tenant + client id", () => {
    const section = adminConsentSection("client-abc", "tenant-123");
    expect(section).toContain(
      "https://login.microsoftonline.com/tenant-123/adminconsent?client_id=client-abc",
    );
    expect(section).toContain("Grant admin consent");
  });

  it("explains BOTH the Global Admin (tenant-wide) and non-admin (forward the link) paths", () => {
    const section = adminConsentSection("client-abc", "tenant-123");
    expect(section).toContain("Global Administrator");
    expect(section).toMatch(/entire tenant/i);
    expect(section).toMatch(/NOT an admin/i);
    expect(section).toMatch(/send it to your tenant admin/i);
  });

  it("is informational / non-blocking (states provisioning is not blocked on consent)", () => {
    const section = adminConsentSection("client-abc", "tenant-123");
    expect(section).toMatch(/informational/i);
    expect(section).toMatch(/not blocked on consent/i);
  });

  it("notes the fallback when the tenant id is unavailable", () => {
    const section = adminConsentSection("client-abc");
    expect(section).toContain("/organizations/adminconsent");
    expect(section).toMatch(/tenant id was unavailable/i);
  });

  it("does not leak any secret into the rendered section", () => {
    const section = adminConsentSection("public-client-id", "tenant-1");
    expect(section).not.toMatch(/client_secret/i);
    expect(section).not.toMatch(/access_token/i);
  });
});

describe("byoAppStartupNote", () => {
  it("clarifies the bring-your-own pre-created owning app scenario", () => {
    const note = byoAppStartupNote("byo-client", "byo-tenant");
    expect(note).toContain("[SPE MCP Server]");
    expect(note).toMatch(/bring-your-own-app/i);
    expect(note).toMatch(/pre-created owning app/i);
    expect(note).toContain("byo-client");
    expect(note).toContain("byo-tenant");
    expect(note).toMatch(/no owning app will be provisioned/i);
  });
});

describe("azLoginNotSignedInMessage", () => {
  it("tells the user to run az login AND restart the server afterward", () => {
    const msg = azLoginNotSignedInMessage();
    expect(msg).toContain("az login");
    expect(msg).toMatch(/restart/i);
    // Ties the restart to startup-stamped session/auth (re-primes on restart).
    expect(msg).toMatch(/fresh session/i);
    expect(msg).toMatch(/re-primes authentication/i);
  });
});
