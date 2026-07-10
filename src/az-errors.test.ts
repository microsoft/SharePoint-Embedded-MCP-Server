// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Unit tests for the shared Azure CLI Conditional Access / claims error
 * classifier and guidance builder. Pure functions — no I/O.
 */

import { describe, it, expect } from "vitest";
import {
  isConditionalAccessOrClaimsError,
  conditionalAccessGuidance,
  asConditionalAccessError,
  ConditionalAccessError,
  enrichConditionalAccess,
  ARM_LOGIN_SCOPE,
} from "./az-errors.js";

describe("isConditionalAccessOrClaimsError", () => {
  const caMessages = [
    "AADSTS50076: Due to a configuration change made by your administrator, you must use multi-factor authentication.",
    "AADSTS50079: Due to a configuration change, the user is required to enroll in multifactor authentication.",
    "AADSTS50005: Device authentication is required.",
    "AADSTS53003: Access has been blocked by Conditional Access policies.",
    "AADSTS53000: Device is not in required device state.",
    "interaction_required: The resource requires user interaction.",
    "Interaction required to acquire token (InteractionRequired)",
    "Continuous access evaluation resulted in a claims challenge",
    "WWW-Authenticate: Bearer error=\"insufficient_claims\", claims=\"...\"",
    "The request requires Conditional Access step-up authentication",
    "Multi-Factor authentication is required for this operation",
    "MFA is required",
  ];

  it.each(caMessages)("returns true for CA/claims/MFA message: %s", (msg) => {
    expect(isConditionalAccessOrClaimsError(msg)).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isConditionalAccessOrClaimsError("CONDITIONAL ACCESS POLICY")).toBe(true);
    expect(isConditionalAccessOrClaimsError("aadsts50076 mfa")).toBe(true);
  });

  const nonCaMessages = [
    "Please run 'az login' to setup account.",
    "ERROR: Please run 'az login' to access your accounts.",
    "You are not logged in. Run az login.",
    "No subscription found",
    "spawn az ENOENT",
    "'az' is not recognized as an internal or external command",
    "Microsoft.Syntex billing account did not reach 'Succeeded'",
    "AADSTS70011: The provided value for scope is not valid.",
    "Some unrelated network timeout error",
  ];

  it.each(nonCaMessages)("returns false for non-CA message: %s", (msg) => {
    expect(isConditionalAccessOrClaimsError(msg)).toBe(false);
  });

  it("does NOT classify a plain not-logged-in / az login message as CA", () => {
    // This is the critical regression guard: CA must be a narrower, additional
    // branch — plain not-logged-in must fall through to the existing guidance.
    expect(isConditionalAccessOrClaimsError("az login required, please run 'az login'")).toBe(false);
  });
});

describe("conditionalAccessGuidance", () => {
  it("interpolates the tenant id and the exact remediation command", () => {
    const text = conditionalAccessGuidance("tenant-abc-123");
    expect(text).toContain("Conditional Access requires step-up authentication");
    expect(text).toContain(`az login --scope ${ARM_LOGIN_SCOPE} --tenant tenant-abc-123`);
    expect(text).toContain("SharePoint admin center");
    expect(text).toContain("out of scope");
  });

  it("uses a placeholder when the tenant id is unknown", () => {
    const text = conditionalAccessGuidance();
    expect(text).toContain("--tenant <your-tenant-id>");
  });
});

describe("asConditionalAccessError", () => {
  it("produces a ConditionalAccessError carrying tenant + guidance", () => {
    const err = asConditionalAccessError("tenant-xyz");
    expect(err).toBeInstanceOf(ConditionalAccessError);
    expect(err.tenantId).toBe("tenant-xyz");
    expect(err.message).toContain("az login --scope");
    expect(err.message).toContain("tenant-xyz");
  });
});

describe("enrichConditionalAccess", () => {
  it("returns the original error unchanged when not a CA failure", async () => {
    const original = new Error("plain not logged in: run az login");
    const result = await enrichConditionalAccess(original, async () => "t1");
    expect(result).toBe(original);
  });

  it("converts a CA error and resolves the tenant id via the resolver", async () => {
    const original = new Error("AADSTS50076: multi-factor authentication required");
    const result = await enrichConditionalAccess(original, async () => "tenant-from-resolver");
    expect(result).toBeInstanceOf(ConditionalAccessError);
    expect((result as ConditionalAccessError).message).toContain("tenant-from-resolver");
  });

  it("prefers an already-known tenant id on a ConditionalAccessError", async () => {
    const original = new ConditionalAccessError("ca with claims challenge", "known-tenant");
    const result = await enrichConditionalAccess(original, async () => "should-not-be-used");
    expect((result as ConditionalAccessError).message).toContain("known-tenant");
  });

  it("falls back to placeholder when the resolver throws", async () => {
    const original = new Error("conditional access blocked");
    const result = await enrichConditionalAccess(original, async () => {
      throw new Error("az account show failed");
    });
    expect((result as Error).message).toContain("<your-tenant-id>");
  });
});
