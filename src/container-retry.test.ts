// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Unit tests for container-create retry classification.
 *
 * The strings here are the REAL wrapped forms produced by `graphRequest`
 * (graph-client.ts): 403 → "Access denied: ...", 404 → "Resource not found: ...",
 * 400/other → "Graph API error (<status>): ...". The classifier must:
 *   • fail fast on a 404 typo'd/unknown containerTypeId,
 *   • STILL retry a genuine registration-propagation 403 (which the over-broad
 *     "everything 403/404 is permanent" fix had silently disabled),
 *   • honor an explicit propagation phrase even when wrapped in a 403/404.
 */

import { describe, it, expect } from "vitest";
import {
  CONTAINER_CREATE_MAX_ATTEMPTS,
  containerCreateBackoffMs,
  isContainerPropagationError,
  toClassifiableError,
} from "./container-retry.js";
import { AppError } from "./errors.js";

describe("isContainerPropagationError — classification", () => {
  // Permanent — must fail fast (return false). These are the real 404/400/403 forms.
  it.each([
    // repro: a wrong/typo'd containerTypeId → 404 Resource not found.
    "Resource not found: ItemNotFound - The container type does not exist",
    "Resource not found: itemNotFound",
    "Graph API error (404): ItemNotFound",
    "Graph API error (400): invalidRequest — malformed containerTypeId",
    "Graph API error (400): Bad Request",
    // a bare 403 (wrong app / missing registration) now fails fast
    // instead of burning the full ~150s propagation backoff.
    "Access denied: AccessDenied",
    "Access denied: The caller is not authorized to perform the operation",
  ])("classifies a permanent 404/400/403 error as NON-retryable: %s", (msg) => {
    expect(isContainerPropagationError(msg)).toBe(false);
  });

  // Transient — genuine registration propagation / infra blips (return true).
  it.each([
    // 403 that DOES carry a propagation phrase still retries (phrase priority).
    "Access denied: container type is not registered on this tenant yet",
    // Explicit propagation/replication signals (any wrapping).
    "Container type registration is still propagating",
    "Grant is replicating across the content tier",
    "Service is temporarily unavailable, please try again",
    "Graph API error (503): request timed out",
    // Genuinely-transient infrastructure signals (5xx / 429 / network).
    "Graph API error (503): service unavailable",
    "Graph API error (429): too many requests",
    "Graph API error (500): server error",
    "ECONNRESET: network error",
  ])("classifies a propagation/transient signal as retryable: %s", (msg) => {
    expect(isContainerPropagationError(msg)).toBe(true);
  });

  it("prioritizes a propagation phrase even when wrapped in a 404", () => {
    // A 404 that explicitly says it is still propagating should retry, not
    // fail fast — body-phrase priority over bare status.
    expect(
      isContainerPropagationError("Resource not found: type not yet registered, propagating"),
    ).toBe(true);
  });

  it("treats an unknown/empty error as NON-retryable (fail fast)", () => {
    expect(isContainerPropagationError("")).toBe(false);
    expect(isContainerPropagationError("Some unexpected failure")).toBe(false);
  });

  it("exposes a bounded attempt cap and increasing backoff", () => {
    expect(CONTAINER_CREATE_MAX_ATTEMPTS).toBe(5);
    expect(containerCreateBackoffMs(1)).toBe(15_000);
    expect(containerCreateBackoffMs(2)).toBe(30_000);
    expect(containerCreateBackoffMs(4)).toBe(60_000);
  });
});

describe("isContainerPropagationError — HTTP-status-first classification (WI-08)", () => {
  // Transient by STATUS: 429 throttling or any 5xx → retry, regardless of the
  // message wording.
  it.each([429, 500, 502, 503, 504])(
    "classifies status %i as retryable (transient)",
    (status) => {
      const err = new AppError("UPSTREAM", "Graph API error", { status });
      expect(isContainerPropagationError(toClassifiableError(err))).toBe(true);
    },
  );

  // Permanent by STATUS: client errors fail fast — no phrase present.
  it.each([400, 403, 404, 409])(
    "classifies status %i as NON-retryable (permanent) when no propagation phrase",
    (status) => {
      const err = new AppError("FORBIDDEN", "Access denied: AccessDenied", { status });
      expect(isContainerPropagationError(toClassifiableError(err))).toBe(false);
    },
  );

  it("retries a 403 that CARRIES a propagation phrase (phrase overrides status)", () => {
    // The real "propagation wrapped in a 403" case — must NOT regress.
    const err = new AppError("FORBIDDEN", "Access denied: not registered yet", { status: 403 });
    expect(isContainerPropagationError(toClassifiableError(err))).toBe(true);
  });

  it("retries a 404 that CARRIES a propagation phrase (phrase overrides status)", () => {
    const err = new AppError("NOT_FOUND", "Resource not found: still propagating", { status: 404 });
    expect(isContainerPropagationError(toClassifiableError(err))).toBe(true);
  });

  // Statusless (raw network/library error) → fall back to the transient-infra
  // string allowlist.
  it.each(["econnreset", "max retries exceeded", "socket hang up: etimedout"])(
    "retries a statusless network error via the string allowlist: %s",
    (message) => {
      const err = new Error(message);
      expect(isContainerPropagationError(toClassifiableError(err))).toBe(true);
    },
  );

  it("fails fast on a statusless, non-infra error", () => {
    const err = new Error("Access denied: AccessDenied");
    expect(isContainerPropagationError(toClassifiableError(err))).toBe(false);
  });

  it("toClassifiableError extracts status from AppError and message-only from Error", () => {
    expect(toClassifiableError(new AppError("X", "boom", { status: 503 }))).toEqual({
      status: 503,
      message: "boom",
    });
    expect(toClassifiableError(new Error("plain"))).toEqual({ message: "plain" });
    expect(toClassifiableError("weird")).toEqual({ message: "weird" });
  });
});

/**
 * Drive the SAME retry loop the tools use, counting attempts, to prove:
 *   • the 404 typo path makes exactly ONE attempt (fast-fail), and
 *   • a genuine propagation 403 retries and then succeeds.
 * We replicate the loop here (no timers) to assert call-counts deterministically.
 */
async function runRetryLoop(
  create: () => Promise<string>,
): Promise<{ attempts: number; ok: boolean; lastError: string }> {
  let attempts = 0;
  let lastError = "";
  for (let attempt = 1; attempt <= CONTAINER_CREATE_MAX_ATTEMPTS; attempt++) {
    attempts = attempt;
    try {
      await create();
      return { attempts, ok: true, lastError: "" };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      if (attempt < CONTAINER_CREATE_MAX_ATTEMPTS && isContainerPropagationError(lastError)) {
        continue; // backoff omitted in test
      }
      return { attempts, ok: false, lastError };
    }
  }
  return { attempts, ok: false, lastError };
}

describe("container-create retry loop — call-count behavior", () => {
  it("a 404 typo'd containerTypeId fails fast in ONE attempt", async () => {
    let calls = 0;
    const result = await runRetryLoop(async () => {
      calls += 1;
      throw new Error("Resource not found: ItemNotFound - container type does not exist");
    });
    expect(calls).toBe(1);
    expect(result.attempts).toBe(1);
    expect(result.ok).toBe(false);
  });

  it("a bare 403 (access denied) fails fast in ONE attempt", async () => {
    let calls = 0;
    const result = await runRetryLoop(async () => {
      calls += 1;
      throw new Error("Access denied: AccessDenied");
    });
    expect(calls).toBe(1);
    expect(result.attempts).toBe(1);
    expect(result.ok).toBe(false);
  });

  it("a genuine propagation 403 (phrase-bearing) retries, then succeeds once the grant lands", async () => {
    let calls = 0;
    const result = await runRetryLoop(async () => {
      calls += 1;
      if (calls < 3) throw new Error("Access denied: not registered yet");
      return "container-id";
    });
    expect(calls).toBe(3); // failed twice (phrase-bearing 403), succeeded on the 3rd
    expect(result.ok).toBe(true);
  });

  it("a persistent propagation 403 retries up to the bounded cap, then fails", async () => {
    let calls = 0;
    const result = await runRetryLoop(async () => {
      calls += 1;
      throw new Error("Access denied: not registered yet");
    });
    expect(calls).toBe(CONTAINER_CREATE_MAX_ATTEMPTS); // bounded, not unbounded
    expect(result.ok).toBe(false);
  });
});
