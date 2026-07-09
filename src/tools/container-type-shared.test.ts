// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Unit tests for the shared container-type control-plane helpers extracted in
 * WI-32 (DRY of container-type-permissions.ts + container-type-app-grants.ts).
 * These lock the behavior that both tool modules now depend on. auth / state are
 * mocked so the tests run offline.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../auth.js", () => ({ setAuthConfig: vi.fn() }));

const stateStore: Record<string, unknown> = {};
vi.mock("../state.js", () => ({ readState: vi.fn(() => ({ ...stateStore })) }));

import { setAuthConfig } from "../auth.js";
import { authContainerTypeState, err, reason } from "./container-type-shared.js";

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of Object.keys(stateStore)) delete stateStore[k];
});

describe("err", () => {
  it("wraps text in a standard MCP error result", () => {
    expect(err("boom")).toEqual({
      content: [{ type: "text", text: "Error: boom" }],
      isError: true,
    });
  });
});

describe("reason", () => {
  it("returns the message for an Error", () => {
    expect(reason(new Error("nope"))).toBe("nope");
  });
  it("stringifies a non-Error value", () => {
    expect(reason("plain")).toBe("plain");
    expect(reason(42)).toBe("42");
  });
});

describe("authContainerTypeState", () => {
  it("points MSAL at the owning app and returns the state defaults", () => {
    Object.assign(stateStore, { appId: "app-1", tenantId: "t-1", containerTypeId: "ct-1" });
    const result = authContainerTypeState();
    expect(setAuthConfig).toHaveBeenCalledWith({ clientId: "app-1", tenantId: "t-1" });
    expect(result).toEqual({ containerTypeId: "ct-1", appId: "app-1" });
  });

  it("does NOT configure auth when appId/tenantId are missing", () => {
    Object.assign(stateStore, { containerTypeId: "ct-1" });
    const result = authContainerTypeState();
    expect(setAuthConfig).not.toHaveBeenCalled();
    expect(result).toEqual({ containerTypeId: "ct-1", appId: undefined });
  });
});
