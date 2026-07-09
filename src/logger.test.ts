// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Unit tests for the shared stderr logger (src/logger.ts).
 *
 * These lock the EXACT output format so the WI-15 consolidation of the two
 * previously-duplicated `log()` helpers (auth + index) stays behavior-
 * preserving. Both variants must remain byte-for-byte identical to what those
 * modules emitted before the refactor:
 *   - index style: `[<iso>] [MCP] <message>`  (+ JSON.stringify(data))
 *   - auth  style: `[<iso>] [Auth] [<level>] <message>`  (+ raw data)
 * Every line MUST go to stderr (console.error), never stdout.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { createLogger } from "./logger.js";

// A fixed instant so the leading `[<iso>]` timestamp is deterministic.
const FIXED_ISO = "2020-01-02T03:04:05.678Z";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function spyConsoleError() {
  return vi.spyOn(console, "error").mockImplementation(() => {});
}

describe("createLogger — index (MCP) style", () => {
  it("emits `[<iso>] [MCP] <message>` on stderr with no level tag", () => {
    vi.useFakeTimers().setSystemTime(new Date(FIXED_ISO));
    const spy = spyConsoleError();

    createLogger("MCP", { stringifyData: true }).log("hello world");

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(`[${FIXED_ISO}] [MCP] hello world`);
  });

  it("JSON.stringifies the data argument as a second console.error arg", () => {
    vi.useFakeTimers().setSystemTime(new Date(FIXED_ISO));
    const spy = spyConsoleError();

    createLogger("MCP", { stringifyData: true }).log("with data", { a: 1, b: "x" });

    expect(spy).toHaveBeenCalledWith(
      `[${FIXED_ISO}] [MCP] with data`,
      JSON.stringify({ a: 1, b: "x" }),
    );
  });
});

describe("createLogger — auth (Auth) style", () => {
  it("emits `[<iso>] [Auth] [<level>] <message>` per severity", () => {
    vi.useFakeTimers().setSystemTime(new Date(FIXED_ISO));
    const spy = spyConsoleError();

    const logger = createLogger("Auth", { severity: true });
    logger.log("info line");
    logger.debug("debug line");
    logger.warn("warn line");
    logger.error("error line");

    expect(spy.mock.calls).toEqual([
      [`[${FIXED_ISO}] [Auth] [info] info line`],
      [`[${FIXED_ISO}] [Auth] [debug] debug line`],
      [`[${FIXED_ISO}] [Auth] [warn] warn line`],
      [`[${FIXED_ISO}] [Auth] [error] error line`],
    ]);
  });

  it("passes the data argument through RAW (not stringified)", () => {
    vi.useFakeTimers().setSystemTime(new Date(FIXED_ISO));
    const spy = spyConsoleError();

    const err = new Error("boom");
    createLogger("Auth", { severity: true }).error("failed", err);

    expect(spy).toHaveBeenCalledWith(`[${FIXED_ISO}] [Auth] [error] failed`, err);
  });

  it("emit() honors the explicit level argument", () => {
    vi.useFakeTimers().setSystemTime(new Date(FIXED_ISO));
    const spy = spyConsoleError();

    createLogger("Auth", { severity: true }).emit("warn", "manual");

    expect(spy).toHaveBeenCalledWith(`[${FIXED_ISO}] [Auth] [warn] manual`);
  });
});
