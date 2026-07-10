// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Unit tests for the TCP readiness probe.
 *
 * node:net is mocked so no real sockets open. `connectBehavior` controls whether
 * a connection attempt succeeds ('connect') or fails ('error'); timeouts are
 * kept tiny so the never-ready path resolves fast.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";

let connectBehavior: "connect" | "error" = "connect";
// Optional per-host override: when set, a host present here uses its mapped
// behavior; hosts not present fall back to `connectBehavior`.
let hostBehavior: Record<string, "connect" | "error"> | null = null;

vi.mock("node:net", () => ({
  connect: vi.fn((opts: { host?: string }) => {
    const host = opts?.host ?? "";
    const socket = new EventEmitter() as EventEmitter & {
      destroy: () => void;
      setTimeout: (ms: number, cb: () => void) => void;
    };
    socket.destroy = () => {};
    socket.setTimeout = () => {};
    queueMicrotask(() => {
      const behavior = hostBehavior && host in hostBehavior ? hostBehavior[host] : connectBehavior;
      if (behavior === "connect") socket.emit("connect");
      else socket.emit("error", new Error("ECONNREFUSED"));
    });
    return socket;
  }),
}));

import { waitForServerReady } from "./server-readiness.js";

beforeEach(() => {
  vi.clearAllMocks();
  connectBehavior = "connect";
  hostBehavior = null;
});

describe("waitForServerReady", () => {
  it("resolves true as soon as a connection is accepted", async () => {
    connectBehavior = "connect";
    const ready = await waitForServerReady(5173, { timeoutMs: 100, intervalMs: 5 });
    expect(ready).toBe(true);
  });

  it("resolves false when the port never accepts a connection within the timeout", async () => {
    connectBehavior = "error";
    const ready = await waitForServerReady(5173, { timeoutMs: 20, intervalMs: 5 });
    expect(ready).toBe(false);
  });

  it("makes at least one attempt even with a zero timeout", async () => {
    connectBehavior = "connect";
    const ready = await waitForServerReady(5173, { timeoutMs: 0 });
    expect(ready).toBe(true);
  });

  it("detects a server bound to IPv6 ::1 only (Vite default) even though 127.0.0.1 refuses", async () => {
    // Vite 6 binds `localhost`, which on Windows is IPv6 `::1` only. An IPv4-only
    // probe would miss it; the dual-stack probe must still succeed.
    hostBehavior = { "127.0.0.1": "error", "::1": "connect" };
    const ready = await waitForServerReady(5173, { timeoutMs: 100, intervalMs: 5 });
    expect(ready).toBe(true);
  });

  it("detects a server bound to IPv4 127.0.0.1 only even though ::1 refuses", async () => {
    hostBehavior = { "127.0.0.1": "connect", "::1": "error" };
    const ready = await waitForServerReady(5173, { timeoutMs: 100, intervalMs: 5 });
    expect(ready).toBe(true);
  });
});
