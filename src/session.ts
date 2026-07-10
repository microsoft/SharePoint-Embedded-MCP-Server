// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Per-process session identity + owning-context confirmation helpers.
 *
 * Motivation (GitHub PR #3 review, r-appgate): the server must ALWAYS re-ask
 * the user "create a NEW owning app, or USE the EXISTING one from state?" on a
 * fresh start — a restart must never silently reuse whatever app the persisted
 * state happens to remember. Because each server restart is a new OS process,
 * we mint one stable id per process at module load: it differs across restarts
 * but is constant for the life of a single process. We treat the remembered
 * owning app + container type as "confirmed" only once the user has answered
 * under the CURRENT session id; a process that has not yet been confirmed is,
 * by definition, freshly restarted and must ask again.
 *
 * `SESSION_ID` is intentionally a module-level constant — do NOT regenerate it
 * per call, or every tool invocation would look like a new session and the
 * confirmation would never "stick" within a run.
 */

import { randomUUID } from "node:crypto";
import { readState, writeState, type ProvisioningState } from "./state.js";

/** Stable per-process id. New process (restart) ⇒ new id. */
const SESSION_ID = randomUUID();

/** The current process's session id (stable for the life of the process). */
export function getSessionId(): string {
  return SESSION_ID;
}

/**
 * True only when the given state was confirmed under THIS process's session id.
 * Takes state as a parameter (rather than reading it) so callers can pass an
 * already-loaded snapshot and tests can exercise it without stubbing readState.
 */
export function isContextConfirmedThisSession(state: ProvisioningState): boolean {
  return !!state.confirmedSessionId && state.confirmedSessionId === getSessionId();
}

/**
 * Mark the active owning app + container type as confirmed for THIS session and
 * persist any accompanying state (e.g., the resolved app fields). Subsequent
 * calls within the same process then proceed without re-asking; the next
 * restart starts unconfirmed again. Merges through writeState (0o600 secure
 * write) so existing state is preserved.
 */
export function stampContextConfirmed(patch?: Partial<ProvisioningState>): void {
  writeState({
    confirmedSessionId: getSessionId(),
    contextConfirmedAt: new Date().toISOString(),
    ...patch,
  });
}

/** Convenience: read state and report confirmation in one call. */
export function isSessionConfirmed(): boolean {
  return isContextConfirmedThisSession(readState());
}
