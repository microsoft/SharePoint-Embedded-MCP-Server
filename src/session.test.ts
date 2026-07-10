// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Unit tests for the per-process session identity + confirmation helpers
 * (session.ts) — the core of the always-ask-on-restart behavior (GitHub PR #3
 * review, r-appgate).
 *
 * state.js is mocked with an in-memory store so stampContextConfirmed persists
 * through the same writeState the real helper uses, without touching disk.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ProvisioningState } from "./state.js";

let stateStore: ProvisioningState;

vi.mock("./state.js", () => ({
  readState: () => ({ ...stateStore }),
  writeState: (patch: Partial<ProvisioningState>) => {
    stateStore = { ...stateStore, ...patch };
    return { ...stateStore };
  },
}));

import {
  getSessionId,
  isContextConfirmedThisSession,
  stampContextConfirmed,
  isSessionConfirmed,
} from "./session.js";

beforeEach(() => {
  stateStore = {};
});

describe("getSessionId", () => {
  it("returns a stable, non-empty id within a process (two calls are equal)", () => {
    const a = getSessionId();
    const b = getSessionId();
    expect(a).toBeTruthy();
    expect(typeof a).toBe("string");
    expect(a).toBe(b);
  });
});

describe("isContextConfirmedThisSession", () => {
  it("is false when no confirmedSessionId is present", () => {
    expect(isContextConfirmedThisSession({})).toBe(false);
    expect(isContextConfirmedThisSession({ appId: "app-1" })).toBe(false);
  });

  it("is false when confirmedSessionId is a DIFFERENT (prior-session) id", () => {
    // Simulates state written by a previous process (restart => new SESSION_ID).
    expect(isContextConfirmedThisSession({ confirmedSessionId: "some-other-session" })).toBe(false);
  });

  it("is true only when confirmedSessionId matches the current session id", () => {
    expect(isContextConfirmedThisSession({ confirmedSessionId: getSessionId() })).toBe(true);
  });
});

describe("stampContextConfirmed", () => {
  it("writes confirmedSessionId (current session) and an ISO contextConfirmedAt", () => {
    stampContextConfirmed();

    expect(stateStore.confirmedSessionId).toBe(getSessionId());
    expect(stateStore.contextConfirmedAt).toBeTruthy();
    // Round-trips as a valid ISO-8601 timestamp.
    expect(new Date(stateStore.contextConfirmedAt as string).toISOString()).toBe(
      stateStore.contextConfirmedAt,
    );
  });

  it("merges an optional patch (e.g. resolved app fields) alongside the stamp", () => {
    stampContextConfirmed({ appId: "app-xyz", appDisplayName: "Contoso Docs App" });

    expect(stateStore.appId).toBe("app-xyz");
    expect(stateStore.appDisplayName).toBe("Contoso Docs App");
    expect(stateStore.confirmedSessionId).toBe(getSessionId());
  });

  it("makes the session read as confirmed afterward", () => {
    expect(isSessionConfirmed()).toBe(false);
    stampContextConfirmed();
    expect(isSessionConfirmed()).toBe(true);
    expect(isContextConfirmedThisSession({ ...stateStore })).toBe(true);
  });
});
