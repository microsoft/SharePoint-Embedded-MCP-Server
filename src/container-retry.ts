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
 * ── Classification (body-phrase priority, then explicit transient allowlist) ─
 *   1. An explicit propagation/replication PHRASE ("not registered", "not yet",
 *      "propagat", "replicat", "try again", "temporarily", "timeout") ALWAYS
 *      means transient — regardless of the 403/404 status it is wrapped in. This
 *      keeps a genuine, correctly-registered grant retrying through replication.
 *   2. A genuinely-transient INFRASTRUCTURE signal (5xx / 429 throttling /
 *      timeout / network blip) is on an explicit allowlist → transient (retry).
 *   3. Everything else — a bare authorization 403 ("access denied" /
 *      "unauthorized"), a 404 / "not found" / "itemnotfound", a 400 / "bad
 *      request", or any unrecognized failure — is PERMANENT → fail fast
 *     . A wrong containerTypeId or an unauthorized caller can never
 *      be fixed by waiting, so we surface it on the FIRST attempt instead of
 *      hanging. Retry is gated behind the explicit transient checks above and a
 *      bare 403 now defaults to permanent.
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
 * True for conditions that should be retried through the registration-
 * propagation window. See the file-level comment for the full classification
 * and the deliberate body-phrase-over-status ordering.
 */
export function isContainerPropagationError(message: string): boolean {
  const m = message.toLowerCase();
  // 1. Explicit propagation phrase wins over any wrapped HTTP status.
  if (hasPropagationPhrase(m)) return true;
  // 2. Genuinely-transient infrastructure signal (5xx / 429 / network) → retry.
  if (isTransientInfraError(m)) return true;
  // 3. Permanent shape — bare 403/access-denied, 404/not-found, 400/bad-request
  //    → fail fast on the first attempt.
  if (isDefinitelyPermanent(m)) return false;
  // 4. Unknown / unrecognized failure → fail fast.
  return false;
}
