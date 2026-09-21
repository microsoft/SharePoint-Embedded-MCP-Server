// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Unit tests for the reuse-path SPA redirect advisory (spa-redirect-advisory.ts).
 *
 * The advisory turns a swallowed best-effort `addSpaRedirectUris` failure into a
 * visible, copy-pasteable fix so a reused owning app that could not be
 * self-repaired does not silently break the scaffolded SPA sign-in with
 * AADSTS9002326.
 */

import { describe, it, expect } from "vitest";
import { LOCAL_SPA_REDIRECT_URI } from "./constants.js";
import {
  isSpaRedirectConfirmed,
  spaRedirectUnconfirmedWarning,
} from "./spa-redirect-advisory.js";

describe("isSpaRedirectConfirmed", () => {
  it("is NOT confirmed when the helper swallowed a best-effort failure (undefined)", () => {
    expect(isSpaRedirectConfirmed(undefined)).toBe(false);
  });

  it("is confirmed when the returned list includes the local SPA redirect URI", () => {
    expect(
      isSpaRedirectConfirmed({ added: [], redirectUris: [LOCAL_SPA_REDIRECT_URI] }),
    ).toBe(true);
  });

  it("is confirmed when the URI is present with a trailing slash / different case", () => {
    expect(
      isSpaRedirectConfirmed({
        added: [],
        redirectUris: ["HTTP://LOCALHOST:5173/"],
      }),
    ).toBe(true);
  });

  it("is NOT confirmed when the list does not contain the local origin", () => {
    expect(
      isSpaRedirectConfirmed({
        added: ["https://app.example.net"],
        redirectUris: ["https://app.example.net"],
      }),
    ).toBe(false);
  });
});

describe("spaRedirectUnconfirmedWarning", () => {
  const warning = spaRedirectUnconfirmedWarning("client-abc", "obj-xyz");

  it("flags an action is needed and names the failing error code", () => {
    expect(warning).toContain("Action needed");
    expect(warning).toContain("AADSTS9002326");
  });

  it("names the exact app (client id + object id) so the right app is edited", () => {
    expect(warning).toContain("client-abc");
    expect(warning).toContain("obj-xyz");
  });

  it("gives a copy-pasteable az rest PATCH that adds the local SPA redirect URI", () => {
    expect(warning).toContain("az rest --method PATCH");
    expect(warning).toContain("applications/obj-xyz");
    expect(warning).toContain(`[\\"${LOCAL_SPA_REDIRECT_URI}\\"]`);
  });

  it("gives an az rest GET to verify the change landed", () => {
    expect(warning).toContain("az rest --method GET");
    expect(warning).toContain("$select=appId,spa");
  });

  it("frames it as a non-blocking heads-up, not a failure", () => {
    expect(warning).toContain("heads-up");
  });
});
