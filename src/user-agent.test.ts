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
import {
  telemetryEnabled,
  productUserAgent,
  isProductUserAgent,
  applyProductUserAgent,
  USER_AGENT,
} from "./user-agent.js";

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

describe("isProductUserAgent", () => {
  it("recognizes this tool's product token for any version", () => {
    expect(isProductUserAgent(USER_AGENT)).toBe(true);
    expect(isProductUserAgent("spe-mcp-server/9.9.9-test")).toBe(true);
  });

  it("does not match unrelated or empty values", () => {
    expect(isProductUserAgent(undefined)).toBe(false);
    expect(isProductUserAgent("")).toBe(false);
    expect(isProductUserAgent("azsdk-js-arm/1.0.0")).toBe(false);
    expect(isProductUserAgent("my-own-tool/2.0")).toBe(false);
  });
});

describe("applyProductUserAgent (opt-out enforcement)", () => {
  it("stamps the product token when telemetry is on", () => {
    delete process.env.SPE_COLLECT_TELEMETRY;
    const headers = applyProductUserAgent({ "Content-Type": "application/json" });
    expect(headers["User-Agent"]).toBe(USER_AGENT);
  });

  it("does not overwrite a caller-supplied User-Agent when on", () => {
    delete process.env.SPE_COLLECT_TELEMETRY;
    const headers = applyProductUserAgent({ "User-Agent": "caller/1.0" });
    expect(headers["User-Agent"]).toBe("caller/1.0");
  });

  it("strips any User-Agent (both casings) when opted out", () => {
    process.env.SPE_COLLECT_TELEMETRY = "false";
    const headers = applyProductUserAgent({
      Authorization: "Bearer x",
      "User-Agent": "caller/1.0",
      "user-agent": "caller/1.0",
    });
    expect(headers["User-Agent"]).toBeUndefined();
    expect(headers["user-agent"]).toBeUndefined();
    // Unrelated headers are left intact.
    expect(headers.Authorization).toBe("Bearer x");
  });
});
