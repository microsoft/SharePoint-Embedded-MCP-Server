// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * TCP readiness probe for a locally-launched dev server.
 *
 * `project_run_local` spawns the dev server detached and previously returned the
 * URL as soon as the process *launched* — even though the server may not yet be
 * accepting connections (or may crash during startup after the spawn grace
 * window). Handing back a URL that 404s/refuses is a false success.
 *
 * `waitForServerReady` polls the derived port with a bounded TCP connect until
 * the server accepts a connection (ready) or the timeout elapses (not ready).
 * It is isolated in its own module so `project_run_local` can be unit-tested
 * with the probe mocked, while production uses a real `node:net` connect.
 */

import { connect } from "node:net";

export interface ReadinessOptions {
  /** Host to probe. Default: 127.0.0.1. */
  host?: string;
  /** Total time to wait for readiness before giving up. Default: 15000ms. */
  timeoutMs?: number;
  /** Delay between connection attempts. Default: 500ms. */
  intervalMs?: number;
  /** Per-attempt connect timeout. Default: 1000ms. */
  connectTimeoutMs?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Attempt a single TCP connection to `host:port`. Resolves true if the
 * connection is accepted (server is listening), false on any error/timeout.
 */
function tryConnect(host: string, port: number, connectTimeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const socket = connect({ host, port });
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(connectTimeoutMs, () => finish(false));
  });
}

/**
 * Poll `port` until it accepts a TCP connection or the overall timeout elapses.
 * Returns true once the server is reachable, false if it never became ready
 * within `timeoutMs`.
 */
export async function waitForServerReady(port: number, options: ReadinessOptions = {}): Promise<boolean> {
  const {
    host = "127.0.0.1",
    timeoutMs = 15_000,
    intervalMs = 500,
    connectTimeoutMs = 1_000,
  } = options;

  const deadline = Date.now() + timeoutMs;
  // Always make at least one attempt, even if timeoutMs is 0.
  for (;;) {
    if (await tryConnect(host, port, connectTimeoutMs)) return true;
    if (Date.now() >= deadline) return false;
    await sleep(intervalMs);
  }
}
