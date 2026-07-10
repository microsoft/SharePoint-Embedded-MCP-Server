// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Shared classification for SharePoint Embedded container-creation retries.
 *
 * Right after a container type is registered on a tenant, the grant takes
 * ~10–30s to propagate to the content tier, so the first `createContainer`
 * calls can fail transiently. Those — and only those — should be retried.
 *
 * ── The empirical shapes we must separate ──────────────────────────────────
 * `graphRequest` (graph-client.ts) wraps Graph failures into prefixed strings:
 *   403 → "Access denied: <error.message>"
 *   404 → "Resource not found: <error.message>"   (e.g. "...: ItemNotFound ...")
 *   400 → "Graph API error (400): <error.message>"
 *   other → "Graph API error (<status>): <error.message>"
 *
 * Two real-world cases look superficially alike but need OPPOSITE handling:
 *   • a WRONG/typo'd containerTypeId. The content tier reports the
 *     type does not exist → 404 "Resource not found". Retrying can NEVER fix a
 *     typo, yet the original heuristic (which matched 404/"not found" as
 *     propagation) burned ~150s of backoff (15+30+45+60s) before surfacing the
 *     same error. This MUST fail fast.
 *   • Genuine registration-propagation — a correctly-registered grant that has
 *     not yet replicated to the content tier. Empirically this surfaces as a
 *     403 "Access denied" (the content tier does not yet see the grant). This
 *     MUST retry through the propagation window.
 *
 * The original `isPropagationError` treated 403 AND 404 (and "access denied" /
 * "not found") all as transient — the root cause of the ~150s hang
 * on a 404 typo. An intermediate fix failed fast on 404 but still retried a bare
 * 403, so a genuinely-unauthorized caller (wrong app / missing registration)
 * still burned the full ~150s backoff window before surfacing the 403.
 *
 * ── Classification (HTTP-STATUS-FIRST, phrase override, string fallback) ─────
 * The thrown `AppError` already carries the numeric HTTP `status`
 * (`graphErrorForStatus` in graph-client.ts). We classify on that status rather
 * than sniffing substrings of the (localizable, format-drifting) message:
 *   1. An explicit propagation/replication PHRASE ("not registered", "not yet",
 *      "propagat", "replicat", "try again", "temporarily", "timeout") ALWAYS
 *      means transient — regardless of the 403/404 it is wrapped in. This keeps
 *      a genuine, correctly-registered grant retrying through replication (the
 *      real "propagation wrapped in a 403" case).
 *   2. By STATUS: `429` or any `5xx` → transient (retry); `400`/`403`/`404`/
 *      `409` → PERMANENT (fail fast). A wrong containerTypeId or an unauthorized
 *      caller can never be fixed by waiting, so we surface it on the FIRST
 *      attempt instead of burning ~150s of backoff. Any other explicit status
 *      with no phrase → fail fast.
 *   3. NO status (a raw network/library error such as ECONNRESET, or a bare
 *      thrown Error) → fall back to the explicit transient-infrastructure
 *      allowlist on the message string.
 *
 * Tradeoff (documented intentionally): a 403 emitted DURING genuine propagation
 * must carry one of the rule-1 phrases to be retried. Empirically the content
 * tier surfaces propagation as a phrase-bearing or 5xx response, so this is the
 * safe default; if a future bare-403-means-propagating signature appears, add it
 * to rule 1.
 *
 * Used by both `container_create` and `project_provision` (step 5) so the two
 * code paths classify retries identically.
 */

import { AppError } from "./errors.js";

/** Maximum container-create attempts (1 initial + up to 4 propagation retries). */
export const CONTAINER_CREATE_MAX_ATTEMPTS = 5;

/** Backoff before the next container-create attempt: 15s, 30s, 45s, 60s. */
export function containerCreateBackoffMs(attempt: number): number {
  return attempt * 15_000;
}

/**
 * Explicit propagation/replication phrases. These take priority over any HTTP
 * status: the content tier may wrap a "still propagating" condition behind a
 * 403/404, but the phrase is the authoritative transient signal.
 */
function hasPropagationPhrase(m: string): boolean {
  return (
    m.includes("not registered") ||
    m.includes("notregistered") ||
    m.includes("not yet") ||      // "not yet registered" / "not yet available"
    m.includes("propagat") ||     // propagating / propagation
    m.includes("replicat") ||     // replicating / replication
    m.includes("try again") ||
    m.includes("temporarily") ||
    m.includes("timeout") ||
    m.includes("timed out")
  );
}

/**
 * Definitively-permanent shapes that retrying cannot fix: a bare authorization
 * 403, a
 * 404 "Resource not found" (typo'd/unknown containerTypeId), or a 400 malformed
 * request. These fail fast — they are reached only AFTER rule 1 (phrase) has had
 * the chance to reclassify a genuinely-propagating case as transient.
 */
function isDefinitelyPermanent(m: string): boolean {
  return (
    m.includes("403") ||
    m.includes("access denied") ||
    m.includes("accessdenied") ||
    m.includes("unauthorized") ||
    m.includes("404") ||
    m.includes("not found") ||
    m.includes("notfound") ||
    m.includes("itemnotfound") ||
    m.includes("400") ||
    m.includes("invalidrequest") ||
    m.includes("bad request")
  );
}

/**
 * Genuinely-transient infrastructure signals — server errors, throttling,
 * timeouts and network blips — that are safe to retry through the propagation
 * window. This is the ONLY non-phrase path that retries (a bare 403 no longer
 * qualifies; see the file-level note for the fix).
 */
function isTransientInfraError(m: string): boolean {
  return (
    m.includes("500") ||
    m.includes("502") ||
    m.includes("503") ||
    m.includes("504") ||
    m.includes("429") ||
    m.includes("server error") ||
    m.includes("service unavailable") ||
    m.includes("network error") ||
    m.includes("econnreset") ||
    m.includes("etimedout") ||
    m.includes("max retries exceeded")
  );
}

/**
 * The minimal shape the classifier needs: the numeric HTTP `status` carried by
 * an {@link AppError} (set by `graphErrorForStatus`) plus the raw `message`. A
 * raw network/library error has no status; a Graph failure always does.
 */
export interface ClassifiableError {
  status?: number;
  message: string;
}

/** Extract the classifiable `{status, message}` shape from an unknown throw. */
export function toClassifiableError(error: unknown): ClassifiableError {
  if (error instanceof AppError) return { status: error.status, message: error.message };
  if (error instanceof Error) return { message: error.message };
  return { message: String(error) };
}

/**
 * Legacy string-only classification (no HTTP status available): phrase →
 * transient-infra allowlist → otherwise permanent. Retained for the statusless
 * path and for back-compat string callers.
 */
function classifyByMessage(m: string): boolean {
  if (hasPropagationPhrase(m)) return true; // propagation/replication phrase
  if (isTransientInfraError(m)) return true; // 5xx / 429 / network blip
  if (isDefinitelyPermanent(m)) return false; // bare 403 / 404 / 400
  return false; // unknown → fail fast
}

/**
 * True for conditions that should be retried through the registration-
 * propagation window. Classification is HTTP-STATUS-FIRST (see the file-level
 * comment for the full rationale and the deliberate phrase-over-status override):
 *   1. An explicit propagation/replication PHRASE always wins — a genuine,
 *      correctly-registered grant that is still replicating can surface wrapped
 *      in a 403/404 and MUST keep retrying.
 *   2. By status: 429 or any 5xx → transient (retry); 400/403/404/409 →
 *      permanent (fail fast). Any other explicit status with no phrase → fail
 *      fast.
 *   3. No status (network/library error) → fall back to the string allowlist of
 *      transient infrastructure signals.
 *
 * Accepts either the error object (preferred — carries `status`) or a bare
 * message string (back-compat with older string callers/tests).
 */
export function isContainerPropagationError(error: ClassifiableError | string): boolean {
  if (typeof error === "string") return classifyByMessage(error.toLowerCase());

  const m = (error.message ?? "").toLowerCase();
  // 1. Propagation phrase overrides any wrapped status (403/404 propagation).
  if (hasPropagationPhrase(m)) return true;

  if (typeof error.status === "number") {
    const status = error.status;
    // 2a. Throttling / server errors are transient → retry.
    if (status === 429 || status >= 500) return true;
    // 2b. Client errors (bad request / unauthorized / not-found / conflict) are
    //     permanent → fail fast; the phrase override above already rescued a
    //     genuine propagation case wrapped in a 403/404.
    if (status === 400 || status === 403 || status === 404 || status === 409) return false;
    // Any other explicit status with no phrase → fail fast.
    return false;
  }

  // 3. Statusless (raw network error) → fall back to the transient-infra allowlist.
  return isTransientInfraError(m);
}
