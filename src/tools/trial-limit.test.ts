// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from "vitest";
import { MAX_TRIAL_CONTAINER_TYPES, trialLimitPreflight } from "./trial-limit.js";

const containerType = (billingClassification?: string | null) => ({ billingClassification });

describe("trialLimitPreflight", () => {
  it("uses the tenant cap of three trial container types", () => {
    expect(MAX_TRIAL_CONTAINER_TYPES).toBe(3);
  });

  it("does not block non-trial or unspecified billing", () => {
    const atCap = [containerType("trial"), containerType("trial"), containerType("trial")];

    expect(trialLimitPreflight("standard", atCap)).toBeNull();
    expect(trialLimitPreflight("directToCustomer", atCap)).toBeNull();
    expect(trialLimitPreflight(undefined, atCap)).toBeNull();
  });

  it("allows zero, one, or two existing trials", () => {
    expect(trialLimitPreflight("trial", [])).toBeNull();
    expect(trialLimitPreflight("trial", [containerType("trial")])).toBeNull();
    expect(
      trialLimitPreflight("trial", [containerType("trial"), containerType("trial")]),
    ).toBeNull();
  });

  it("returns actionable guidance at the cap", () => {
    const error = trialLimitPreflight("trial", [
      containerType("trial"),
      containerType("trial"),
      containerType("trial"),
    ]);

    expect(error).toContain("3 of 3");
    expect(error).toContain("maximum number of trial container types");
    expect(error).toContain("container_type_list");
    expect(error).toContain("container_type_delete");
    expect(error).toContain("standard");
  });

  it("blocks when the tenant is already over the cap", () => {
    const error = trialLimitPreflight("trial", [
      containerType("trial"),
      containerType("trial"),
      containerType("trial"),
      containerType("trial"),
    ]);

    expect(error).toContain("4 of 3");
  });

  it("counts only trial-classified container types", () => {
    const mixed = [
      containerType("trial"),
      containerType("standard"),
      containerType("directToCustomer"),
      containerType(null),
      containerType(undefined),
      containerType("trial"),
    ];

    expect(trialLimitPreflight("trial", mixed)).toBeNull();
    expect(trialLimitPreflight("trial", [...mixed, containerType("trial")])).not.toBeNull();
  });
});
