// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, it, expect } from "vitest";
import { SPE_SERVER_INSTRUCTIONS } from "./server-instructions.js";

/**
 * The primer is prepended to model context on every session, so it must stay
 * accurate and concise. These assertions lock in the load-bearing content (the
 * pieces a client relays to the model) and guard against silent drift or bloat.
 */
describe("SPE_SERVER_INSTRUCTIONS primer", () => {
  it("is a non-trivial, single string", () => {
    expect(typeof SPE_SERVER_INSTRUCTIONS).toBe("string");
    expect(SPE_SERVER_INSTRUCTIONS.length).toBeGreaterThan(200);
  });

  it("stays concise enough to be a cheap per-session context tax", () => {
    // ~4 chars/token heuristic; keep well under ~600 tokens so the primer never
    // becomes an expensive prefix on every request.
    expect(SPE_SERVER_INSTRUCTIONS.length).toBeLessThan(2400);
  });

  it("teaches the SPE mental model in build order", () => {
    const concepts = [
      "Owning application",
      "Container type",
      "Registration",
      "Containers",
      "Content",
    ];
    // Assert both presence AND the load-bearing order the primer relies on to
    // route "what must exist before X" — not just that the words appear.
    let prevIndex = -1;
    for (const concept of concepts) {
      const idx = SPE_SERVER_INSTRUCTIONS.indexOf(concept);
      expect(idx, `"${concept}" missing from primer`).toBeGreaterThan(-1);
      expect(idx, `"${concept}" out of order in primer`).toBeGreaterThan(prevIndex);
      prevIndex = idx;
    }
  });

  it("gives routing-first guidance that matches the real toolset", () => {
    // Every tool referenced here must exist in the registry; these are the
    // first-request entry points an agent should reach for.
    for (const tool of [
      "status_get",
      "project_provision",
      "project_app_create",
      "billing_check",
      "billing_setup",
      "docs_search",
      "docs_fetch",
    ]) {
      expect(SPE_SERVER_INSTRUCTIONS).toContain(tool);
    }
  });

  it("states the owning-app precondition using the typed error code", () => {
    // Keeps the primer consistent with the OWNING_APP_REQUIRED error tools throw.
    expect(SPE_SERVER_INSTRUCTIONS).toContain("OWNING_APP_REQUIRED");
    expect(SPE_SERVER_INSTRUCTIONS).toMatch(/no restart|does NOT leave/i);
  });

  it("cites the SharePoint Embedded Samples repo for solving customer problems", () => {
    expect(SPE_SERVER_INSTRUCTIONS).toContain(
      "https://github.com/microsoft/SharePoint-Embedded-Samples",
    );
  });
});
