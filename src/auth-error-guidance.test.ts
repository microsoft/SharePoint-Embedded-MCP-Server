// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Unit tests for the React SPA sign-in guidance.
 *
 * Focus: the `interpretAuthError` helper that turns an opaque Microsoft Entra
 * sign-in failure into clear, actionable guidance for the SERVER-SIDE
 * app-registration / redirect-URI errors (AADSTS9002326 cross-origin SPA token
 * redemption, AADSTS50011 redirect URI mismatch), plus a drift guard asserting
 * the runnable React sample (`samples/react-spa-functions`) embeds the same
 * helper and routes its MSAL error paths through it. The sample is the single
 * source of truth for the shipped app, so we read it through the real scaffolder
 * (`findArchitecture(...).files()`).
 */

import { describe, it, expect } from "vitest";
import { interpretAuthError } from "./auth-error-guidance.js";
import { findArchitecture } from "./reference-architectures.js";
import { LOCAL_DEV_PORT, LOCAL_SPA_REDIRECT_URI } from "./constants.js";

const SPA_ORIGIN = "https://swa-abc123.azurestaticapps.net";
const LOCAL_ORIGIN = "http://localhost:5173";

describe("interpretAuthError — AADSTS9002326 (cross-origin SPA token redemption)", () => {
  const msg = interpretAuthError(
    "AADSTS9002326: Cross-origin token redemption is permitted only for the 'Single-Page Application' client-type.",
    SPA_ORIGIN,
  );

  it("returns guidance (not null)", () => {
    expect(msg).not.toBeNull();
  });

  it("identifies it as a server-side Entra app-registration issue", () => {
    expect(msg).toContain("SERVER-SIDE");
    expect(msg).toContain("app-registration");
  });

  it("makes clear it is not a client bug or a stale dev server", () => {
    expect(msg).toContain("NOT a bug in this app");
    expect(msg).toContain("NOT a stale");
    expect(msg).toContain("hot-reload");
  });

  it("states the concrete fix: register the origin as a SPA redirect URI", () => {
    expect(msg).toContain("Single-page application");
    expect(msg).toContain("redirect URI");
  });

  it("shows the exact, copy-pasteable origin to register", () => {
    expect(msg).toContain(SPA_ORIGIN);
    // and includes an az rest PATCH body that registers the origin as a SPA URI
    expect(msg).toContain("redirectUris");
    expect(msg).toContain(`[\\"${SPA_ORIGIN}\\"]`);
  });

  it("explains how to apply it (re-provision/deploy or add manually)", () => {
    expect(msg).toContain("re-run provisioning");
    expect(msg).toContain("Authentication");
    expect(msg).toContain("az rest --method PATCH");
  });

  it("references the originating error code", () => {
    expect(msg).toContain("AADSTS9002326");
  });
});

describe("interpretAuthError — AADSTS50011 (redirect URI mismatch)", () => {
  const msg = interpretAuthError(
    "AADSTS50011: The redirect URI specified in the request does not match the redirect URIs configured for the application.",
    LOCAL_ORIGIN,
  );

  it("returns guidance (not null)", () => {
    expect(msg).not.toBeNull();
  });

  it("identifies it as a server-side app-registration / redirect-URI issue", () => {
    expect(msg).toContain("SERVER-SIDE");
    expect(msg).toContain("app-registration");
    expect(msg).toContain("redirect URI");
  });

  it("shows the exact origin and the SPA fix", () => {
    expect(msg).toContain(LOCAL_ORIGIN);
    expect(msg).toContain("Single-page application");
  });

  it("references the originating error code", () => {
    expect(msg).toContain("AADSTS50011");
  });
});

describe("interpretAuthError — unrelated errors fall through to generic handling", () => {
  it("returns null for an unrelated AADSTS error", () => {
    expect(interpretAuthError("AADSTS50058: Silent sign-in was not possible.", LOCAL_ORIGIN)).toBeNull();
  });

  it("returns null for a non-auth network error", () => {
    expect(interpretAuthError("TypeError: Failed to fetch", LOCAL_ORIGIN)).toBeNull();
  });

  it("returns null for empty/missing error text", () => {
    expect(interpretAuthError("", LOCAL_ORIGIN)).toBeNull();
  });
});

describe("the react-spa-functions sample embeds the interpreter and wires it into the UI error path", () => {
  const files = findArchitecture("react-spa-functions")!.files("demo-app");
  const app = files["src/App.tsx"];

  it("embeds the interpretAuthError helper", () => {
    expect(app).toContain("function interpretAuthError(errorText: string, origin: string): string | null");
  });

  it("interprets the same AAD error codes the unit tests cover", () => {
    expect(app).toContain("AADSTS9002326");
    expect(app).toContain("AADSTS50011");
    expect(app).toContain("SERVER-SIDE");
  });

  it("uses window.location.origin so the message shows the running origin", () => {
    expect(app).toContain("interpretAuthError(text, window.location.origin)");
  });

  it("routes the sign-in and Graph error paths through explainAuthError", () => {
    expect(app).toContain("function explainAuthError(e: unknown): string | null");
    expect(app).toContain("setError(explainAuthError(e) ?? `Sign-in failed:");
    expect(app).toContain("setError(explainAuthError(e) ?? `Could not list containers:");
    expect(app).toContain("setError(explainAuthError(e) ?? `Could not list files:");
    expect(app).toContain("setError(explainAuthError(e) ?? `Could not create container:");
  });

  it("still exports a valid-looking App component", () => {
    expect(app).toContain("export function App()");
  });
});

describe("single source for the local dev port", () => {
  it("derives LOCAL_SPA_REDIRECT_URI from LOCAL_DEV_PORT (no hand-kept literal)", () => {
    expect(LOCAL_SPA_REDIRECT_URI).toBe(`http://localhost:${LOCAL_DEV_PORT}`);
  });

  it("keeps the dev port resolving to 5173", () => {
    expect(LOCAL_DEV_PORT).toBe(5173);
    expect(LOCAL_SPA_REDIRECT_URI).toBe("http://localhost:5173");
  });

  it("the sample's Vite server.port matches the shared dev port — no drift, no stray literal", () => {
    const viteConfig = findArchitecture("react-spa-functions")!.files("demo-app")["vite.config.ts"];
    expect(viteConfig).toContain(`port: ${LOCAL_DEV_PORT}`);
    expect(LOCAL_SPA_REDIRECT_URI).toContain(String(LOCAL_DEV_PORT));
  });
});
