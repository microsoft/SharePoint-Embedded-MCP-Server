// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Telemetry opt-out tests.
 *
 * The product `User-Agent` token is the only Microsoft-bound attribution signal
 * this build emits, so it is gated behind `SPE_COLLECT_TELEMETRY`. It is ON by
 * default and suppressed only when the variable is explicitly falsy. These tests
 * pin that contract so the documented opt-out stays wired to real behavior.
 */
import { describe, it, expect, afterEach } from "vitest";
import { telemetryEnabled, productUserAgent, USER_AGENT } from "./user-agent.js";

const saved = process.env.SPE_COLLECT_TELEMETRY;

afterEach(() => {
  if (saved === undefined) {
    delete process.env.SPE_COLLECT_TELEMETRY;
  } else {
    process.env.SPE_COLLECT_TELEMETRY = saved;
  }
});

describe("telemetry opt-out (SPE_COLLECT_TELEMETRY)", () => {
  it("is on by default when the variable is unset", () => {
    delete process.env.SPE_COLLECT_TELEMETRY;
    expect(telemetryEnabled()).toBe(true);
    expect(productUserAgent()).toBe(USER_AGENT);
  });

  it.each(["false", "0", "no", "off", "FALSE", " Off "])(
    "opts out when set to %j (drops the product token)",
    (value) => {
      process.env.SPE_COLLECT_TELEMETRY = value;
      expect(telemetryEnabled()).toBe(false);
      expect(productUserAgent()).toBeUndefined();
    },
  );

  it.each(["true", "1", "yes", "on", ""])(
    "stays on for non-falsy value %j",
    (value) => {
      process.env.SPE_COLLECT_TELEMETRY = value;
      expect(telemetryEnabled()).toBe(true);
      expect(productUserAgent()).toBe(USER_AGENT);
    },
  );
});
