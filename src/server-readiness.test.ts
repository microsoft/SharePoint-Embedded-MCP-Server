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

vi.mock("node:net", () => ({
  connect: vi.fn(() => {
    const socket = new EventEmitter() as EventEmitter & {
      destroy: () => void;
      setTimeout: (ms: number, cb: () => void) => void;
    };
    socket.destroy = () => {};
    socket.setTimeout = () => {};
    queueMicrotask(() => {
      if (connectBehavior === "connect") socket.emit("connect");
      else socket.emit("error", new Error("ECONNREFUSED"));
    });
    return socket;
  }),
}));

import { waitForServerReady } from "./server-readiness.js";

beforeEach(() => {
  vi.clearAllMocks();
  connectBehavior = "connect";
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
});
