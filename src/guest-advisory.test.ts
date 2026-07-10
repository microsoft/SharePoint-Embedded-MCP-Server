// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Unit tests for the NON-BLOCKING guest (B2B) sign-in advisory helpers.
 *
 * These prove the `#EXT#` guest heuristic and that the advisory is purely
 * informational — it returns a note for a guest, nothing for a member, and
 * never blocks/rejects. (PR #3 review — WI-11 guest handling.)
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { isLikelyGuestUpn, guestSignInAdvisory } from "./guest-advisory.js";

describe("isLikelyGuestUpn", () => {
  it("is true for a B2B guest UPN carrying the #EXT# marker", () => {
    expect(isLikelyGuestUpn("alice_corp.com#EXT#@resourcetenant.onmicrosoft.com")).toBe(true);
  });

  it("matches #EXT# case-insensitively", () => {
    expect(isLikelyGuestUpn("bob_corp.com#ext#@resourcetenant.onmicrosoft.com")).toBe(true);
    expect(isLikelyGuestUpn("bob_corp.com#Ext#@resourcetenant.onmicrosoft.com")).toBe(true);
  });

  it("is false for a normal member UPN", () => {
    expect(isLikelyGuestUpn("alice@contoso.com")).toBe(false);
    expect(isLikelyGuestUpn("dev@x.com")).toBe(false);
  });

  it("is false for undefined / empty input", () => {
    expect(isLikelyGuestUpn(undefined)).toBe(false);
    expect(isLikelyGuestUpn("")).toBe(false);
  });
});

describe("guestSignInAdvisory", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns an informational note mentioning guest + member for a guest identity", () => {
    const note = guestSignInAdvisory("alice_corp.com#EXT#@resourcetenant.onmicrosoft.com");
    expect(note).not.toBe("");
    expect(note).toContain("guest (B2B)");
    expect(note).toContain("member");
    // Informational, not an error marker.
    expect(note).toContain("Heads-up");
  });

  it("returns an empty string for a member identity (no note, non-blocking)", () => {
    expect(guestSignInAdvisory("alice@contoso.com")).toBe("");
    expect(guestSignInAdvisory(undefined)).toBe("");
  });

  it("logs a single non-blocking warning for a guest and nothing for a member", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    guestSignInAdvisory("alice_corp.com#EXT#@resourcetenant.onmicrosoft.com");
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(String(errSpy.mock.calls[0][0])).toContain("[warn]");

    errSpy.mockClear();
    guestSignInAdvisory("alice@contoso.com");
    expect(errSpy).not.toHaveBeenCalled();
  });
});
