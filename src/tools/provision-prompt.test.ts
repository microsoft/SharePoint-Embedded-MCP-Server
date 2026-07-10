// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * TEST-002 — provision golden-trajectory test.
 *
 * Locks the `provision_spe_app` guided prompt to its required *sequencing* so a
 * wording tweak stays green but a regression that drops or reorders a beat fails.
 * Assertions target stable substrings (tool names, key phrases) and relative
 * ordering rather than exact prose.
 *
 * Required trajectory beats:
 *   (i)   sign-in / status check FIRST
 *   (ii)  provisioning (owning app -> container type -> register -> container)
 *   (iii) an explicit "wait for the user to choose / confirm" step (no silent
 *         app reuse)
 *   (iv)  a billing choice point (trial vs standard)
 */

import { describe, expect, it } from "vitest";
import { getPromptMessages } from "../prompts.js";

function provisionText(idea = ""): string {
  const result = getPromptMessages("provision_spe_app", idea ? { idea } : {});
  // Shape: { description, messages: [{ role: "user", content: { type, text } }] }
  expect(result.messages).toHaveLength(1);
  const msg = result.messages[0];
  expect(msg.role).toBe("user");
  expect(msg.content.type).toBe("text");
  return msg.content.text;
}

describe("provision_spe_app golden trajectory", () => {
  it("returns a single user text message", () => {
    const text = provisionText();
    expect(typeof text).toBe("string");
    expect(text.length).toBeGreaterThan(0);
  });

  it("threads the caller's idea into the guidance when provided", () => {
    const text = provisionText("manage construction documents");
    expect(text).toContain("manage construction documents");
  });

  // (i) Sign-in / status check comes FIRST.
  it("(i) checks prerequisites / sign-in before anything else", () => {
    const text = provisionText();
    expect(text).toContain("status_get");
    expect(text).toContain("az login --allow-no-subscriptions");
    // status_get must precede the provisioning and billing steps.
    expect(text.indexOf("status_get")).toBeGreaterThanOrEqual(0);
    expect(text.indexOf("status_get")).toBeLessThan(text.indexOf("project_provision"));
  });

  // (ii) Provisioning step.
  //
  // NOTE/GAP: the prompt delegates the create owning app -> container type ->
  // register -> container ORDERING to the `project_provision` orchestrator tool
  // rather than spelling those four sub-steps out inline. We therefore assert
  // the provisioning beat that IS present (project_provision + billing
  // classification + the explicit owning-app reuse choice). 
  // TODO(TEST-002): if/when prompts.ts is revised to enumerate the
  // app -> container type -> register -> container sub-steps explicitly, tighten
  // this to assert that inline ordering. Owner: prompts.ts workstream.
  it("(ii) drives provisioning via project_provision with a billing classification", () => {
    const text = provisionText();
    expect(text).toContain("project_provision");
    expect(text).toContain("billingClassification");
    // The owning-app concept is surfaced as a user choice (not a hidden step).
    expect(text).toContain("owning app");
  });

  // (iii) Explicit wait-for-user / confirm step, and NO silent app reuse.
  it("(iii) waits for the user to choose and never silently reuses the last app", () => {
    const text = provisionText();
    expect(text).toContain("Never silently reuse the last app");
    expect(text.toLowerCase()).toContain("wait for the user");
  });

  // (iv) Billing choice point: trial vs standard.
  it("(iv) presents a billing choice point (trial vs standard)", () => {
    const text = provisionText();
    expect(text).toContain("Trial");
    expect(text).toContain("Standard");
    // Asked as a question to the user, not silently chosen.
    expect(text).toMatch(/ask the user/i);
  });

  // Cross-cutting: overall sequencing of the major beats is stable.
  it("orders the beats: sign-in -> billing -> provision -> scaffold", () => {
    const text = provisionText();
    const idxStatus = text.indexOf("status_get");
    const idxBilling = text.indexOf("Billing");
    const idxProvision = text.indexOf("project_provision");
    const idxScaffold = text.indexOf("project_scaffold");

    expect(idxStatus).toBeGreaterThanOrEqual(0);
    expect(idxBilling).toBeGreaterThan(idxStatus);
    expect(idxProvision).toBeGreaterThan(idxBilling);
    expect(idxScaffold).toBeGreaterThan(idxProvision);
  });
});
