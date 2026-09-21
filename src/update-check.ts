// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * SEC-008 — npm update awareness.
 *
 * Tells the user, once, when a newer build of this server has been published to
 * the public npm registry. It NEVER updates anything: there is no auto-update,
 * no install, no child process, and no write outside the server's own data dir.
 *
 * SHAPE OF THE FEATURE
 * - After the MCP transport is connected, a fire-and-forget probe reads the
 *   package's `dist-tags` from the registry. Nothing awaits it; if it is slow,
 *   fails, or never finishes, the server behaves exactly as it does today.
 * - When the installed build is a prerelease (e.g. `0.2.0-alpha.1`) the matching
 *   channel dist-tag (`alpha`) is the primary target, and a newer STABLE release
 *   is reported separately so prerelease users learn when GA lands.
 * - The result is surfaced by appending one short notice to at most one
 *   subsequent successful tool result across processes that share the data
 *   directory (plus `structuredContent.updateAvailable`), and by `status_get`.
 *   It is never printed to stdout — stdout is the JSON-RPC channel and writing
 *   to it corrupts the protocol.
 *
 * WHERE THE DATA GOES (disclosure)
 * - The only endpoint contacted is the public npm registry, by default
 *   `https://registry.npmjs.org`. That is a THIRD-PARTY service operated by npm,
 *   Inc. / GitHub. It is **not a Microsoft 365 or Azure Online Service**, so it
 *   is outside the Microsoft Product Terms, the Microsoft Products and Services
 *   Data Protection Addendum (DPA), and the EU Data Boundary — none of the M365
 *   data-residency, EUDB, or tenant-data commitments apply to it.
 * - Making the connection at all inherently discloses to that third party the
 *   **client IP address**, standard TLS/HTTP connection metadata (TLS handshake
 *   and SNI, the `Host` and `Accept` headers, request time and timing), the
 *   requested **package name** (in the URL path), and the static product
 *   **`User-Agent`** string. Nothing else is sent.
 * - Opting out of telemetry (`SPE_MCP_COLLECT_TELEMETRY=false`) suppresses the
 *   registry request **entirely** — it is a skip reason, so there is no
 *   connection and therefore nothing to disclose. (The shared user-agent helper
 *   also omits the product `User-Agent` when telemetry is off; for this endpoint
 *   that is defense in depth only, because no request is made at all.)
 * - No account, tenant, subscription, container, machine, install, session, or
 *   content data is sent. There is no install GUID and no correlation identifier
 *   of any kind, in the request or in the cache.
 * - Before the FIRST network request of a process, a one-time collection notice
 *   ({@link collectionNotice}) is written to stderr naming the endpoint actually
 *   contacted (including a `SPE_NPM_REGISTRY` override), its boundary status, and
 *   the opt-out. Skipped/cached runs make no request and so emit no notice.
 * - The result is cached on the local disk only. It is **retained until deleted**
 *   — by `spe-mcp logout`, by removing the data dir, or by deleting the file
 *   reported by `status_get`. There is no server-side record and no retention
 *   schedule to expire it for you.
 *
 * SECURITY CONTROLS
 * - Unauthenticated GET only. No credential, cookie, `.npmrc`, or auth header is
 *   read or sent, and no npm CLI or other child process is spawned.
 * - Exact package path only: no query string and no fragment, on the request or
 *   on an `SPE_NPM_REGISTRY` override.
 * - Registry origin is pinned to `https://registry.npmjs.org` unless overridden
 *   by `SPE_NPM_REGISTRY`, which MUST be `https:` and MUST NOT embed credentials.
 * - `redirect: "error"` plus an explicit post-response host check, so the pinned
 *   origin cannot be bounced to another host.
 * - Hard {@link REQUEST_TIMEOUT_MS} timeout and a streamed
 *   {@link MAX_RESPONSE_BYTES} cap, so a hostile or hung registry cannot stall
 *   or exhaust the process.
 * - The response is parsed defensively: prototype-polluting keys are dropped,
 *   over-long keys/values are dropped, and every version is validated by the
 *   strict SemVer parser before it is compared or shown.
 * - Results are cached under the server data dir with the same owner-only
 *   secure-fs primitives as the token cache (SEC-003: 0700 dir / 0600 file, no
 *   symlink traversal), with a 24h TTL applied to successes *and* failures.
 * - A cross-process exclusive lock serializes stale-cache refreshes. The process
 *   that owns it writes a 24h failure reservation BEFORE egress, then replaces
 *   that reservation with success data after a valid response. For the same
 *   running package version and registry, concurrent processes, crashes after
 *   egress, lock errors, and stale-lock recovery therefore cannot cause a
 *   second request inside the reservation window while the cache is retained.
 *
 * PROXY ROUTING
 * - Routing follows the running Node.js configuration. Releases that support
 *   Node's environment-proxy mode (including current Node 24/26 releases) can
 *   use `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` when it is enabled with
 *   `NODE_USE_ENV_PROXY=1` or `--use-env-proxy`; Node 22 may ignore those
 *   variables and attempt a direct connection. Operators who require enforced
 *   proxy routing must configure it at the runtime/network layer or disable
 *   this check outright.
 *
 * ZERO-NETWORK OPT-OUTS — each skips the check entirely (no request, no notice,
 * no cache read, no cache write): `--no-update-check`, `SPE_MCP_UPDATE_CHECK=false`,
 * `SPE_NO_UPDATE_CHECK=1` (back-compatible alias), `NO_UPDATE_NOTIFIER=1`,
 * `SPE_MCP_COLLECT_TELEMETRY=false`, any CI marker, and source checkouts.
 */

import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readdirSync,
  unlinkSync,
} from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createLogger } from "./logger.js";
import { getDataDir, getUpdateCacheFile } from "./paths.js";
import {
  ensureSecureDir,
  readSecureFile,
  tryCreateSecureFileExclusive,
  writeSecureFileAtomic,
} from "./secure-fs.js";
import { isNewer, parseSemver, releaseChannel, type SemVer } from "./semver.js";
import { productUserAgent } from "./user-agent.js";
import { PACKAGE_NAME, PACKAGE_VERSION } from "./version.js";

/** Default public registry. Overridable only by an explicit HTTPS URL. */
export const DEFAULT_REGISTRY = "https://registry.npmjs.org";

/** Hard ceiling on the probe. Deliberately short: this is best-effort garnish. */
export const REQUEST_TIMEOUT_MS = 2_000;

/** Streamed response cap. The abbreviated packument is a few KB at most. */
export const MAX_RESPONSE_BYTES = 64 * 1024;

/** How long a successful probe is reused before re-checking. */
export const CHECK_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * How long a failed probe is remembered before retrying.
 *
 * Deliberately identical to {@link CHECK_TTL_MS}: for the same package version
 * and registry, a shorter failure backoff would quietly retry several times a
 * day while offline. Success and failure are both remembered for 24h.
 */
export const FAILURE_BACKOFF_MS = CHECK_TTL_MS;

/**
 * Age after which an abandoned refresh lock can be reclaimed.
 *
 * A normal request is hard-capped at two seconds. Thirty seconds leaves ample
 * room for scheduling and cache I/O without allowing a crashed process to block
 * refreshes forever. The pre-request cache reservation below remains the
 * authoritative 24-hour request gate even when a stale lock is reclaimed.
 */
export const REFRESH_LOCK_STALE_MS = 30_000;

/** Cap on a dist-tag name we are willing to look at. */
const MAX_TAG_NAME_LENGTH = 64;

/** Cap on a dist-tag value we are willing to look at. */
const MAX_TAG_VALUE_LENGTH = 256;

/** Cap on an accepted `SPE_NPM_REGISTRY` value. */
const MAX_REGISTRY_LENGTH = 512;

/** Keys that must never be copied out of untrusted JSON. */
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** npm package-name grammar, used to prove the name is URL-path safe. */
const PACKAGE_NAME_PATTERN = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;

/** Values that mean "off" for any of the opt-out / CI environment variables. */
const FALSY_ENV_VALUES = new Set(["0", "false", "no", "off"]);

/** Environment variables whose presence means "this is automation, stay quiet". */
const CI_ENV_VARS = [
  "CI",
  "CONTINUOUS_INTEGRATION",
  "GITHUB_ACTIONS",
  "TF_BUILD",
  "BUILD_BUILDID",
] as const;

const logger = createLogger("Update");

/**
 * Build the one-time stderr disclosure emitted immediately BEFORE the first
 * network request of a process.
 *
 * It must name the endpoint actually contacted. The default public npm
 * registry gets its explicit operator/compliance-boundary disclosure; an
 * operator-supplied override is described neutrally because this process
 * cannot know who operates it or which boundary contains it. Both variants say
 * what the connection discloses, say that nothing is installed, and name the
 * opt-out.
 *
 * @param registry - The resolved registry origin. Always a value that already
 *   passed {@link resolveRegistry} (HTTPS, no credentials, no query/fragment,
 *   length-capped), so it is safe to print verbatim.
 */
export function collectionNotice(registry: string): string {
  const destination =
    registry === DEFAULT_REGISTRY
      ? [
          "The public npm registry is a third-party service operated by npm, Inc. /",
          "GitHub OUTSIDE the Microsoft 365 / Azure compliance boundary.",
        ]
      : [
          "This endpoint was supplied through SPE_NPM_REGISTRY; its operator and",
          "compliance boundary depend on your configuration.",
        ];

  return [
    `Update check: contacting the registry at ${registry} to see whether a`,
    `newer version of ${PACKAGE_NAME} has been published.`,
    ...destination,
    "The request is unauthenticated and carries no user",
    "identifier and no account, tenant, machine, session, or content data — but",
    "the connection itself discloses your IP address, the package name, and the",
    "product User-Agent to the registry operator. The result is cached locally until",
    "you delete it. Nothing is downloaded, installed, or updated automatically.",
    "Turn this off with --no-update-check or SPE_MCP_UPDATE_CHECK=false.",
  ].join(" ");
}

/**
 * The disclosure for the default public registry. Exported so docs and tests
 * assert the exact wording; a `SPE_NPM_REGISTRY` override names that host
 * instead (see {@link collectionNotice}).
 */
export const COLLECTION_NOTICE = collectionNotice(DEFAULT_REGISTRY);

/** Why the check did not run. */
export type UpdateSkipReason =
  | "cli-flag"
  | "env-spe-mcp-update-check"
  | "env-spe-no-update-check"
  | "env-no-update-notifier"
  | "env-telemetry-disabled"
  | "ci"
  | "source-install"
  | "invalid-registry"
  | "invalid-package";

/** Machine-readable description of an available update. */
export interface UpdateAvailable {
  /** npm package name this build was published as. */
  readonly package: string;
  /** The version currently running. */
  readonly current: string;
  /** The newest version on the user's own channel (or stable, when on stable). */
  readonly latest: string;
  /** Whether {@link latest} is the running prerelease channel or stable target. */
  readonly target: "channel" | "stable";
  /** Release channel of the running build (`alpha`, `beta`, …), or `null`. */
  readonly channel: string | null;
  /** Newest STABLE release, when it is also newer than the running build. */
  readonly stable?: string;
  /**
   * The package spec to move to, e.g. `@microsoft/spe-mcp@alpha`. Deliberately
   * NOT an install command: the server may be launched by `npx`, by a global
   * install, or from a pinned spec in an MCP client config, and only the user
   * knows which. Informational only — nothing is installed automatically.
   */
  readonly packageSpec: string;
  /** Package spec for the newest stable release, when {@link stable} is set. */
  readonly stablePackageSpec?: string;
}

/** A ready-to-append notice plus its structured twin. */
export interface UpdateNotice {
  readonly text: string;
  readonly updateAvailable: UpdateAvailable;
}

/** Lifecycle of the check, as reported by `status_get`. */
export type UpdateCheckState =
  | "disabled"
  | "pending"
  | "up-to-date"
  | "update-available"
  | "unavailable";

/** Snapshot of the check for diagnostics surfaces. Never triggers a network call. */
export interface UpdateCheckStatus {
  readonly enabled: boolean;
  readonly state: UpdateCheckState;
  readonly currentVersion: string;
  readonly skipReason?: UpdateSkipReason;
  readonly latestVersion?: string;
  readonly channel?: string;
  readonly lastCheckedAt?: string;
  readonly updateAvailable?: UpdateAvailable;
  /** Absolute path of the local cache file, so a user can inspect or delete it. */
  readonly cacheFile?: string;
  /** Registry origin that would be (or was) contacted. */
  readonly registry?: string;
}

/** Options accepted by {@link startUpdateCheck}. */
export interface StartUpdateCheckOptions {
  /** `false` when the user passed `--no-update-check`. Defaults to enabled. */
  readonly enabled?: boolean;
}

/** On-disk cache shape. `version` guards against future format changes. */
interface UpdateCache {
  version: 1;
  checkedAt: number;
  currentVersion: string;
  registry: string;
  outcome: "success" | "failure";
  latest?: string;
  channelTag?: string;
  channelVersion?: string;
  notifiedFor: string[];
}

type NoticeTarget =
  | { readonly kind: "channel"; readonly channel: string; readonly version: string }
  | { readonly kind: "stable"; readonly version: string };

interface PendingUpdateNotice {
  readonly channel: string | null;
  readonly targets: readonly NoticeTarget[];
}

// ---------------------------------------------------------------------------
// Process-local state
// ---------------------------------------------------------------------------

let pendingNotice: PendingUpdateNotice | null = null;
let status: UpdateCheckStatus = { enabled: true, state: "pending", currentVersion: PACKAGE_VERSION };
let inFlight: Promise<void> | null = null;
/** Test-only override for "am I running from an installed package?". */
let installedOverride: boolean | null = null;
/** Guards the one-time pre-network collection notice for this process. */
let collectionNoticeEmitted = false;

// ---------------------------------------------------------------------------
// Environment / eligibility
// ---------------------------------------------------------------------------

/**
 * Whether an environment variable is set to something meaning "yes".
 *
 * Unset, empty, `0`, `false`, `no`, and `off` all mean "no"; anything else means
 * "yes". Shared by the opt-outs and the CI detectors so they behave identically.
 */
function envFlagEnabled(name: string): boolean {
  const raw = process.env[name];
  if (raw === undefined) return false;
  const value = raw.trim().toLowerCase();
  if (value === "") return false;
  return !FALSY_ENV_VALUES.has(value);
}

/**
 * Whether an environment variable is explicitly set to something meaning "no".
 *
 * Distinct from `!envFlagEnabled(name)`: an unset variable is NOT a "no" here,
 * so `SPE_MCP_UPDATE_CHECK` and `SPE_MCP_COLLECT_TELEMETRY` only suppress the
 * check when the operator deliberately turned them off.
 */
function envFlagDisabled(name: string): boolean {
  const raw = process.env[name];
  if (raw === undefined) return false;
  const value = raw.trim().toLowerCase();
  if (value === "") return false;
  return FALSY_ENV_VALUES.has(value);
}

/**
 * Whether this process is running from an installed npm package rather than a
 * source checkout. Contributors running the server out of the repo should never
 * be told to `npm install` over their working tree.
 */
function isInstalledFromRegistry(): boolean {
  if (installedOverride !== null) return installedOverride;
  try {
    return fileURLToPath(import.meta.url).split(/[\\/]+/).includes("node_modules");
  } catch {
    return false;
  }
}

/**
 * The reason the check must not run, or `null` when it may proceed.
 *
 * Every reason here is a ZERO-NETWORK suppression: no request is made, the
 * collection notice is not emitted, and the cache is neither read nor written.
 *
 * Order matters: explicit user intent (flag, then the preferred env control,
 * then its back-compatible aliases, then the telemetry master switch) beats
 * environment inference (CI, source checkout), so the reported reason is the
 * most specific one.
 */
function resolveSkipReason(options: StartUpdateCheckOptions): UpdateSkipReason | null {
  if (options.enabled === false) return "cli-flag";
  // Preferred public control: SPE_MCP_UPDATE_CHECK=false.
  if (envFlagDisabled("SPE_MCP_UPDATE_CHECK")) return "env-spe-mcp-update-check";
  // Back-compatible alias kept so existing deployments keep working.
  if (envFlagEnabled("SPE_NO_UPDATE_CHECK")) return "env-spe-no-update-check";
  // Community convention shared with update-notifier and friends.
  if (envFlagEnabled("NO_UPDATE_NOTIFIER")) return "env-no-update-notifier";
  // Telemetry master switch: opting out of telemetry opts out of egress here too.
  if (envFlagDisabled("SPE_MCP_COLLECT_TELEMETRY")) return "env-telemetry-disabled";
  if (CI_ENV_VARS.some((name) => envFlagEnabled(name))) return "ci";
  if (!isInstalledFromRegistry()) return "source-install";
  return null;
}

/**
 * The registry origin (plus optional base path) to query, or `null` when the
 * configured override is not something we are willing to talk to.
 *
 * Only `https:` is accepted, embedded credentials are rejected outright (this
 * request must never carry authentication), and query/fragment are rejected so
 * the override cannot smuggle parameters onto the lookup.
 */
function resolveRegistry(): string | null {
  const raw = process.env.SPE_NPM_REGISTRY?.trim();
  if (!raw) return DEFAULT_REGISTRY;
  if (raw.length > MAX_REGISTRY_LENGTH) return null;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }

  if (url.protocol !== "https:") return null;
  if (url.username !== "" || url.password !== "") return null;
  if (url.search !== "" || url.hash !== "") return null;

  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

/**
 * The packument URL for this package on `registry`, or `null` when the package
 * name is not the plain npm grammar (belt-and-braces: the name comes from our
 * own package.json, but it is interpolated into a URL path).
 */
function buildPackumentUrl(registry: string): string | null {
  if (!PACKAGE_NAME_PATTERN.test(PACKAGE_NAME)) return null;
  // npm's canonical scoped form keeps the leading `@` and escapes only the `/`.
  return `${registry}/${PACKAGE_NAME.replace(/\//g, "%2f")}`;
}

// ---------------------------------------------------------------------------
// Registry access
// ---------------------------------------------------------------------------

/**
 * Read at most `cap` bytes of `response`, returning `null` when the body is
 * larger. The declared `content-length` is checked first as a cheap reject; the
 * stream is then read incrementally so a lying header cannot get past the cap.
 */
async function readCappedText(response: Response, cap: number): Promise<string | null> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > cap) return null;

  const body = response.body;
  if (!body || typeof body.getReader !== "function") {
    const text = await response.text();
    return Buffer.byteLength(text, "utf8") > cap ? null : text;
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Whether a value is a tag name we are willing to use as a map key.
 *
 * Rejects non-strings, empty/oversized names, and prototype-pollution keys such
 * as `__proto__`. Applied to both freshly fetched packument keys and to tag
 * names read back from the on-disk cache, which is treated as untrusted input.
 */
function isSafeTagName(name: unknown): name is string {
  if (typeof name !== "string") return false;
  if (name.length === 0 || name.length > MAX_TAG_NAME_LENGTH) return false;
  return !FORBIDDEN_KEYS.has(name);
}

/** A fresh `name -> version` map that cannot inherit anything from `Object`. */
function emptyTagMap(): Record<string, string> {
  return Object.create(null) as Record<string, string>;
}

/**
 * Extract a trustworthy `name -> version` map from a raw packument body.
 *
 * Everything here treats the input as hostile: the JSON may be any shape, keys
 * may be prototype pollution attempts, and values may be enormous or not
 * versions at all. Anything that is not a short tag name mapped to a strictly
 * valid SemVer string is dropped. A packument with no usable tags is rejected
 * as unavailable rather than being mistaken for a successful current result.
 */
function extractDistTags(raw: string): Record<string, string> | null {
  const result = emptyTagMap();

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;

  const tags = (parsed as Record<string, unknown>)["dist-tags"];
  if (typeof tags !== "object" || tags === null || Array.isArray(tags)) return null;

  for (const [name, value] of Object.entries(tags as Record<string, unknown>)) {
    if (!isSafeTagName(name)) continue;
    if (typeof value !== "string" || value.length > MAX_TAG_VALUE_LENGTH) continue;
    if (parseSemver(value) === null) continue;
    result[name] = value;
  }

  return Object.keys(result).length > 0 ? result : null;
}

/**
 * Emit the collection disclosure to stderr, at most once per process.
 *
 * Called immediately before the first network request, so a run that is opted
 * out, skipped, or served from cache never makes a request AND never emits the
 * notice. stderr only — stdout is the JSON-RPC channel.
 *
 * @param registry - The registry actually about to be contacted, so a
 *   `SPE_NPM_REGISTRY` override is disclosed truthfully rather than the default
 *   public host. Already validated by {@link resolveRegistry}.
 */
function emitCollectionNotice(registry: string): void {
  if (collectionNoticeEmitted) return;
  collectionNoticeEmitted = true;
  logger.log(collectionNotice(registry));
}

/**
 * Fetch the package's dist-tags. Returns `null` on any failure — offline,
 * timeout, redirect, non-2xx, oversize body, or unparseable payload — so every
 * failure mode collapses to the same silent no-op.
 *
 * Privacy/security shape of the request, asserted by tests:
 * - exactly one GET, to the exact package path, with no query and no fragment;
 * - no `authorization`, no `cookie`, and no identifier of any kind;
 * - `credentials: "omit"` and `redirect: "error"`, plus an explicit check that
 *   the response did not come from a different host than the one we dialled;
 * - the only headers are `accept` and the static product `User-Agent`. (When
 *   telemetry is opted out the check never reaches this function at all — the
 *   whole request is skipped — so there is no "request without a User-Agent"
 *   case for this endpoint.)
 */
async function fetchDistTags(
  url: string,
  registry: string,
): Promise<Record<string, string> | null> {
  let expectedHost: string;
  try {
    expectedHost = new URL(url).host;
  } catch {
    return null;
  }

  // Last thing before any egress: tell the user what is about to happen.
  emitCollectionNotice(registry);

  try {
    const userAgent = productUserAgent();
    const response = await fetch(url, {
      method: "GET",
      redirect: "error",
      credentials: "omit",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        // The abbreviated packument is orders of magnitude smaller than the full one.
        accept: "application/vnd.npm.install-v1+json",
        ...(userAgent ? { "User-Agent": userAgent } : {}),
      },
    });
    if (!response.ok) return null;

    // Defence in depth behind `redirect: "error"`: if anything (a proxy, a
    // future runtime change) still followed a hop, refuse a foreign host.
    if (response.redirected) return null;
    if (typeof response.url === "string" && response.url !== "") {
      try {
        if (new URL(response.url).host !== expectedHost) return null;
      } catch {
        return null;
      }
    }

    const body = await readCappedText(response, MAX_RESPONSE_BYTES);
    if (body === null) return null;

    return extractDistTags(body);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

/** Parse the owner-only cache after secure-fs has read it. */
function parseCache(raw: string): UpdateCache | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const candidate = parsed as Partial<UpdateCache>;
    if (candidate.version !== 1) return null;
    if (typeof candidate.checkedAt !== "number" || !Number.isFinite(candidate.checkedAt)) return null;
    if (typeof candidate.currentVersion !== "string") return null;
    if (typeof candidate.registry !== "string") return null;
    if (candidate.outcome !== "success" && candidate.outcome !== "failure") return null;

    const notified = Array.isArray(candidate.notifiedFor)
      ? candidate.notifiedFor.filter((entry): entry is string => typeof entry === "string")
      : [];

    return {
      version: 1,
      checkedAt: candidate.checkedAt,
      currentVersion: candidate.currentVersion,
      registry: candidate.registry,
      outcome: candidate.outcome,
      latest: typeof candidate.latest === "string" ? candidate.latest : undefined,
      // The cache file is untrusted input: a tampered `channelTag` is used as a
      // map key later, so it goes through the same guard as packument keys.
      channelTag: isSafeTagName(candidate.channelTag) ? candidate.channelTag : undefined,
      channelVersion:
        typeof candidate.channelVersion === "string" ? candidate.channelVersion : undefined,
      // Never evict a delivered target while this cache is retained. Otherwise
      // a dist-tag rollback could make an old target appear unannounced again.
      notifiedFor: [...new Set(notified)],
    };
  } catch {
    return null;
  }
}

type CacheReadResult =
  | { readonly state: "value"; readonly cache: UpdateCache }
  | { readonly state: "missing" | "invalid" | "unreadable" };

/** Read the cache while preserving the distinction needed by notice claims. */
function readCacheResult(): CacheReadResult {
  let raw: string | null;
  try {
    raw = readSecureFile(getUpdateCacheFile());
  } catch {
    return { state: "unreadable" };
  }
  if (raw === null) return { state: "missing" };
  const cache = parseCache(raw);
  return cache ? { state: "value", cache } : { state: "invalid" };
}

/** Read the cache, tolerating absence, corruption, and secure-fs rejections. */
function readCache(): UpdateCache | null {
  const result = readCacheResult();
  return result.state === "value" ? result.cache : null;
}

/** Persist the cache with owner-only permissions. Returns false on any refusal. */
function writeCache(cache: UpdateCache): boolean {
  try {
    ensureSecureDir(getDataDir());
    writeSecureFileAtomic(
      getUpdateCacheFile(),
      JSON.stringify({ ...cache, notifiedFor: [...new Set(cache.notifiedFor)] }, null, 2),
    );
    return true;
  } catch {
    return false;
  }
}

/** Persistent local generation used to cancel writes that raced cache deletion. */
function getDeletionGenerationFile(): string {
  return `${getUpdateCacheFile()}.deleted`;
}

/** Read the current deletion generation. Corruption fails closed as a new value. */
function readDeletionGeneration(): string | null {
  try {
    return readSecureFile(getDeletionGenerationFile());
  } catch {
    return "unreadable";
  }
}

/**
 * Advance the deletion generation before removing the cache.
 *
 * A refresh captures the prior value under its lock and verifies it both before
 * and after each atomic cache replacement. A logout that races the replacement
 * therefore wins: the refresh removes its own write and never resurrects data.
 */
function advanceDeletionGeneration(): boolean {
  try {
    ensureSecureDir(getDataDir());
    // Every deletion gets an independently generated value. A read/increment/write
    // counter can lose an update when separate logout processes race.
    writeSecureFileAtomic(getDeletionGenerationFile(), randomUUID());
    return true;
  } catch {
    return false;
  }
}

/** Prefix for unique markers that block cache writes while deletion is active. */
function getDeletionMarkerPrefix(): string {
  return `${getUpdateCacheFile()}.deleting-`;
}

function createDeletionMarker(): string | null {
  const id = randomUUID();
  const file = `${getDeletionMarkerPrefix()}${id}`;
  const marker = JSON.stringify({ pid: process.pid, createdAt: Date.now(), id });
  try {
    ensureSecureDir(getDataDir());
    return tryCreateSecureFileExclusive(file, marker) ? file : null;
  } catch {
    return null;
  }
}

function hasDeletionMarker(): boolean {
  const prefix = basename(getDeletionMarkerPrefix());
  try {
    return readdirSync(getDataDir()).some(
      (name) => name.startsWith(prefix) && !name.includes(".tmp-"),
    );
  } catch {
    return true;
  }
}

function releaseDeletionMarker(file: string): void {
  try {
    unlinkSync(file);
  } catch {
    // A surviving marker fails closed by continuing to block cache writes.
  }
}

function removeCacheFileOnly(): void {
  try {
    unlinkSync(getUpdateCacheFile());
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
  }
}

/**
 * Atomically persist only while logout's deletion generation is unchanged.
 * Called under the refresh lock, so deleting our mismatched write cannot remove
 * a successor refresh's cache.
 */
function writeCacheForGeneration(
  cache: UpdateCache,
  deletionGeneration: string | null,
): boolean {
  if (hasDeletionMarker() || readDeletionGeneration() !== deletionGeneration) return false;
  if (!writeCache(cache)) return false;
  if (!hasDeletionMarker() && readDeletionGeneration() === deletionGeneration) return true;
  try {
    removeCacheFileOnly();
  } catch {
    // The deletion generation still prevents this process from writing again.
  }
  return false;
}

/** Prefix for unique owner-only lock contenders beside the update cache. */
function getRefreshLockPrefix(): string {
  return `${getUpdateCacheFile()}.lock-`;
}

/** Parsed ownership data for one of this module's transient lock files. */
function lockOwner(raw: string): { pid: number; createdAt: number } | null {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !Number.isSafeInteger(parsed["pid"]) ||
      (parsed["pid"] as number) <= 0 ||
      typeof parsed["createdAt"] !== "number" ||
      !Number.isFinite(parsed["createdAt"])
    ) {
      return null;
    }
    return { pid: parsed["pid"] as number, createdAt: parsed["createdAt"] };
  } catch {
    return null;
  }
}

/**
 * Whether the local process recorded in a lock may still be alive.
 *
 * Anything except an explicit ESRCH/"no such process" result is treated as
 * alive. In particular, EPERM means the OS knows the process but will not let
 * us signal it. This conservative check prevents a paused stale owner from
 * resuming and deleting a replacement lock.
 */
function lockOwnerMayBeAlive(raw: string): boolean {
  const owner = lockOwner(raw);
  // Malformed metadata can be a partially migrated/corrupt/hostile file. There
  // is no proof its creator is gone, so fail closed rather than reclaim it.
  if (!owner) return true;
  if (owner.pid === process.pid) return true;
  try {
    process.kill(owner.pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code !== "ESRCH";
  }
}

interface RefreshLockRecord {
  readonly pid: number;
  readonly createdAt: number;
  readonly id: string;
  readonly state: "choosing" | "ready";
  readonly ticket?: number;
}

/** Parse one unique bakery-lock contender. Invalid metadata fails closed. */
function refreshLockRecord(raw: string): RefreshLockRecord | null {
  const owner = lockOwner(raw);
  if (!owner) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (
      typeof parsed["id"] !== "string" ||
      parsed["id"].length === 0 ||
      parsed["id"].length > 64 ||
      (parsed["state"] !== "choosing" && parsed["state"] !== "ready")
    ) {
      return null;
    }
    if (
      parsed["state"] === "ready" &&
      (!Number.isSafeInteger(parsed["ticket"]) || (parsed["ticket"] as number) <= 0)
    ) {
      return null;
    }
    return {
      ...owner,
      id: parsed["id"],
      state: parsed["state"],
      ticket: parsed["state"] === "ready" ? (parsed["ticket"] as number) : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Remove abandoned temp inodes left if a process exited while atomically
 * publishing a lock. These names are never synchronization points, so deleting
 * an old malformed temp is fail-closed: at worst its still-live creator's
 * publication fails and no request occurs.
 */
function cleanupAbandonedUpdateTemps(now: number): void {
  const dir = getDataDir();
  const cacheTempPrefix = `${basename(getUpdateCacheFile())}.tmp-`;
  const lockPrefix = basename(getRefreshLockPrefix());
  try {
    for (const name of readdirSync(dir)) {
      const isCacheTemp = name.startsWith(cacheTempPrefix);
      const isLockTemp = name.startsWith(lockPrefix) && name.includes(".tmp-");
      if (!isCacheTemp && !isLockTemp) {
        continue;
      }
      const file = join(dir, name);
      try {
        const stat = lstatSync(file);
        if (stat.isSymbolicLink() || !stat.isFile()) continue;
        const age = now - stat.mtimeMs;
        if (!Number.isFinite(age) || age < REFRESH_LOCK_STALE_MS) continue;

        const raw = readSecureFile(file);
        if (raw === null) continue;
        const owner = lockOwner(raw);
        if (owner && lockOwnerMayBeAlive(raw)) continue;
        unlinkSync(file);
      } catch {
        // Best-effort local hygiene; temp cleanup must never enable egress.
      }
    }
  } catch {
    // Missing/unreadable directory: acquisition below fails closed as usual.
  }
}

/**
 * Return the exact contents of a regular-file lock only when it is old enough
 * and its recorded local process has exited. Malformed, live, symlink, and
 * unreadable entries fail closed.
 */
function abandonedLockContents(file: string, now: number): string | null {
  try {
    const raw = readSecureFile(file);
    if (raw === null) return null;
    const stat = lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile()) return null;
    const age = now - stat.mtimeMs;
    if (!Number.isFinite(age) || age < REFRESH_LOCK_STALE_MS) return null;
    return lockOwnerMayBeAlive(raw) ? null : raw;
  } catch {
    return null;
  }
}

/** List fully published, unique bakery-lock contenders. */
function listRefreshLocks(): string[] {
  const prefix = basename(getRefreshLockPrefix());
  try {
    return readdirSync(getDataDir())
      .filter((name) => name.startsWith(prefix) && !name.includes(".tmp-"))
      .map((name) => join(getDataDir(), name));
  } catch {
    // An unreadable directory must block acquisition, not enable it.
    return [getRefreshLockPrefix()];
  }
}

/**
 * Remove abandoned unique lock contenders.
 *
 * Contender names are UUID-based and never reused. Deleting a proven-dead
 * contender therefore cannot remove a successor synchronization object.
 */
function cleanupAbandonedRefreshLocks(now: number): void {
  for (const marker of listRefreshLocks()) {
    if (!abandonedLockContents(marker, now)) continue;
    try {
      unlinkSync(marker);
    } catch {
      // Another cleanup observer may already have removed the unique contender.
    }
  }
}

type RefreshLockRead =
  | { readonly state: "missing" }
  | { readonly state: "invalid" }
  | { readonly state: "present"; readonly record: RefreshLockRecord };

/** Read one contender while distinguishing disappearance from invalid state. */
function readRefreshLock(file: string): RefreshLockRead {
  try {
    const raw = readSecureFile(file);
    if (raw === null) {
      return existsSync(file) ? { state: "invalid" } : { state: "missing" };
    }
    const record = refreshLockRecord(raw);
    return record ? { state: "present", record } : { state: "invalid" };
  } catch {
    return { state: "invalid" };
  }
}

/**
 * Atomically acquire the cross-process refresh lock.
 *
 * This is a fail-fast Lamport bakery protocol over owner-only files:
 * 1. publish a never-reused UUID contender in `choosing` state;
 * 2. choose one more than the largest published ticket;
 * 3. atomically publish that ticket; and
 * 4. enter only when no contender is still choosing and no ready contender has
 *    the lower `(ticket, UUID)` tuple.
 *
 * A contender that starts after step 4 observes this process's ready ticket and
 * loses. Concurrent choosers either observe one another or cause one/both calls
 * to fail closed. Crashed contenders are reclaimed only through their unique
 * paths after the owner is proven dead, so no observer ever unlinks or renames a
 * shared pathname that a successor could have replaced.
 */
function acquireRefreshLock(now: number): string | null {
  const id = randomUUID();
  const file = `${getRefreshLockPrefix()}${id}`;
  const choosing = JSON.stringify({
    pid: process.pid,
    createdAt: now,
    id,
    state: "choosing",
  });
  let acquired = false;
  try {
    ensureSecureDir(getDataDir());
    cleanupAbandonedUpdateTemps(now);
    cleanupAbandonedRefreshLocks(now);
    if (!tryCreateSecureFileExclusive(file, choosing)) return null;

    let maxTicket = 0;
    for (const contender of listRefreshLocks()) {
      if (contender === file) continue;
      const read = readRefreshLock(contender);
      if (read.state === "missing") continue;
      if (read.state === "invalid") return null;
      if (read.record.state === "ready") {
        maxTicket = Math.max(maxTicket, read.record.ticket ?? 0);
      }
    }
    if (!Number.isSafeInteger(maxTicket) || maxTicket >= Number.MAX_SAFE_INTEGER) return null;

    const ticket = maxTicket + 1;
    writeSecureFileAtomic(
      file,
      JSON.stringify({
        pid: process.pid,
        createdAt: now,
        id,
        state: "ready",
        ticket,
      }),
    );

    for (const contender of listRefreshLocks()) {
      if (contender === file) continue;
      const read = readRefreshLock(contender);
      if (read.state === "missing") continue;
      if (read.state === "invalid" || read.record.state === "choosing") return null;
      const otherTicket = read.record.ticket;
      if (
        otherTicket === undefined ||
        otherTicket < ticket ||
        (otherTicket === ticket && read.record.id < id)
      ) {
        return null;
      }
    }

    acquired = true;
    return file;
  } catch {
    return null;
  } finally {
    if (!acquired) releaseRefreshLock(file);
  }
}

/**
 * Release this caller's never-reused contender path.
 *
 * No token reread is needed: the protocol never creates a successor at this
 * UUID pathname, which removes the read-then-unlink pathname race entirely.
 */
function releaseRefreshLock(file: string): void {
  try {
    unlinkSync(file);
  } catch {
    // Best-effort. A surviving contender is reclaimed after the owner exits.
  }
}

/** Whether a cache entry is still authoritative for `registry` and this build. */
function isCacheFresh(cache: UpdateCache, registry: string, now: number): boolean {
  if (cache.currentVersion !== PACKAGE_VERSION) return false;
  if (cache.registry !== registry) return false;
  const age = now - cache.checkedAt;
  if (age < 0) return false;
  return age < (cache.outcome === "success" ? CHECK_TTL_MS : FAILURE_BACKOFF_MS);
}

/**
 * Delete the local update-check cache.
 *
 * Wired into `spe-mcp logout` (and `auth --reset`) so signing out clears the
 * cached registry result and cancels in-flight cache writers. Best-effort and
 * never throws: a missing or unremovable file is not an error.
 */
export async function removeUpdateCache(): Promise<void> {
  let deletionMarker: string | null = null;
  let refreshLock: string | null = null;
  let deletionCompleted = false;
  try {
    const file = getUpdateCacheFile();
    // Do not create a data directory solely for an empty tombstone. If the data
    // directory already exists, always advance the generation: a refresh may be
    // between writing its fully formed temp lock and atomically publishing it,
    // during which neither the final lock nor cache exists yet.
    if (!existsSync(getDataDir())) return;
    deletionMarker = createDeletionMarker();
    if (!deletionMarker) return;
    advanceDeletionGeneration();
    removeCacheFileOnly();

    const deadline = Date.now() + REFRESH_LOCK_STALE_MS + REQUEST_TIMEOUT_MS;
    while (!refreshLock && Date.now() < deadline) {
      refreshLock = acquireRefreshLock(Date.now());
      if (!refreshLock) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    if (!refreshLock) return;

    // A writer may have completed after the first removal but before observing
    // the marker. Repeating the removal under the shared lock closes that gap.
    removeCacheFileOnly();

    // Cache replacement temps are never synchronization points. Removing one
    // that belongs to an in-flight writer makes its atomic rename fail closed.
    const prefix = `${basename(file)}.tmp-`;
    for (const name of readdirSync(getDataDir())) {
      if (!name.startsWith(prefix)) continue;
      const candidate = join(getDataDir(), name);
      const stat = lstatSync(candidate);
      if (stat.isFile() && !stat.isSymbolicLink()) unlinkSync(candidate);
    }
    deletionCompleted = true;
    logger.debug("Removed update-check cache.");
  } catch {
    // Best-effort: leaving the file behind is not a failure worth surfacing.
  } finally {
    if (deletionCompleted && deletionMarker) releaseDeletionMarker(deletionMarker);
    if (refreshLock) releaseRefreshLock(refreshLock);
  }
}

// ---------------------------------------------------------------------------
// Notice construction
// ---------------------------------------------------------------------------

/** Pick the newest version carried by `tag`, when it beats `current`. */
function newerTagVersion(
  tags: Record<string, string>,
  tag: string | null,
  current: SemVer,
): string | undefined {
  if (!tag) return undefined;
  const raw = Object.prototype.hasOwnProperty.call(tags, tag) ? tags[tag] : undefined;
  if (raw === undefined) return undefined;
  const parsed = parseSemver(raw);
  if (!parsed) return undefined;
  return isNewer(parsed, current) ? parsed.raw : undefined;
}

/**
 * Pick a newer stable target from npm's `latest` tag.
 *
 * npm permits any SemVer string in a dist-tag, including prereleases. The name
 * `latest` alone is therefore not evidence of GA: only a value with no
 * prerelease identifiers is exposed as the stable target.
 */
function newerStableVersion(
  tags: Record<string, string>,
  current: SemVer,
): string | undefined {
  const raw = Object.prototype.hasOwnProperty.call(tags, "latest")
    ? tags["latest"]
    : undefined;
  if (raw === undefined) return undefined;
  const parsed = parseSemver(raw);
  if (!parsed || parsed.prerelease.length > 0) return undefined;
  return isNewer(parsed, current) ? parsed.raw : undefined;
}

/**
 * Reconstruct the version a cached result would have pointed at, using exactly
 * the same channel-first rule as a live check. Purely local: this reads the
 * cache file only and never touches the network.
 */
function cachedTargetVersion(cache: UpdateCache): string | undefined {
  const tags = buildTagsFromCache(cache);
  const current = parseSemver(PACKAGE_VERSION);
  if (current) {
    const channel = releaseChannel(current);
    const target = newerTagVersion(tags, channel, current) ?? newerStableVersion(tags, current);
    if (target) return target;
  }
  // Nothing newer on the running channel or on a non-prerelease `latest` tag is
  // a target for this build. Do not surface an arbitrary cached prerelease as a
  // stable fallback.
  return undefined;
}

/**
 * Build the public update model from independently selected channel/stable
 * targets. The channel wins when both are present; stable is then carried as a
 * separate target rather than inferred from the `latest` tag name.
 */
function buildUpdateAvailable(
  channel: string | null,
  channelTarget: Extract<NoticeTarget, { kind: "channel" }> | undefined,
  stableTarget: Extract<NoticeTarget, { kind: "stable" }> | undefined,
): UpdateAvailable | null {
  const primary = channelTarget ?? stableTarget;
  if (!primary) return null;

  return {
    package: PACKAGE_NAME,
    current: PACKAGE_VERSION,
    latest: primary.version,
    target: primary.kind,
    channel,
    ...(channelTarget && stableTarget && stableTarget.version !== primary.version
      ? {
          stable: stableTarget.version,
          stablePackageSpec: `${PACKAGE_NAME}@latest`,
        }
      : {}),
    packageSpec:
      primary.kind === "channel"
        ? `${PACKAGE_NAME}@${primary.channel}`
        : `${PACKAGE_NAME}@latest`,
  };
}

/**
 * Render the single notice appended to a tool result.
 *
 * Two constraints shape this wording:
 *
 * 1. It is **informational**, never an instruction to run a command. The notice is
 *    read by agents as well as humans, so it must not look like a shell command to
 *    execute. Updating is a human decision that changes MCP client configuration or
 *    a package installation; this server never performs it.
 * 2. It is **execution-mode neutral**. The structured result carries the package
 *    specs for clients that can present installation-specific guidance safely; the
 *    human-readable notice does not guess how this server was launched.
 */
function renderNotice(update: UpdateAvailable): string {
  const channel =
    update.target === "channel" && update.channel ? ` (${update.channel} channel)` : "";
  const lines = [
    `Update available: ${update.package} ${update.current} -> ${update.latest}${channel}.`,
    "Note: This is just a notice. If you choose to update, update the MCP server manually. " +
      "No command should run automatically.",
  ];
  if (update.stable && update.stablePackageSpec) {
    lines.push(`Stable release also available: ${update.package} ${update.stable}.`);
  }
  lines.push("Silence with --no-update-check.");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/**
 * The whole check. Never throws: every failure path leaves the server exactly as
 * it would have been had the feature not existed.
 */
async function runUpdateCheck(options: StartUpdateCheckOptions): Promise<void> {
  try {
    const skipReason = resolveSkipReason(options);
    if (skipReason) {
      status = {
        enabled: false,
        state: "disabled",
        currentVersion: PACKAGE_VERSION,
        skipReason,
      };
      logger.debug(`Update check skipped (${skipReason})`);
      return;
    }

    const current = parseSemver(PACKAGE_VERSION);
    if (!current) {
      status = {
        enabled: false,
        state: "disabled",
        currentVersion: PACKAGE_VERSION,
        skipReason: "invalid-package",
      };
      return;
    }

    const registry = resolveRegistry();
    if (!registry) {
      status = {
        enabled: false,
        state: "disabled",
        currentVersion: PACKAGE_VERSION,
        skipReason: "invalid-registry",
      };
      logger.debug("Update check skipped (SPE_NPM_REGISTRY is not a credential-free HTTPS URL)");
      return;
    }

    const url = buildPackumentUrl(registry);
    if (!url) {
      status = {
        enabled: false,
        state: "disabled",
        currentVersion: PACKAGE_VERSION,
        skipReason: "invalid-package",
      };
      return;
    }

    const now = Date.now();
    // Capture logout/reset's generation before the first cache read. If it
    // advances anywhere before the under-lock reread, this run started on a
    // superseded view and must not adopt the new generation or recreate state.
    const deletionGenerationAtStart = readDeletionGeneration();
    let cached = readCache();
    let fresh = cached && isCacheFresh(cached, registry, now) ? cached : null;
    let refreshLock: string | null = null;
    let deletionGeneration: string | null = null;

    if (!fresh) {
      refreshLock = acquireRefreshLock(now);
      if (refreshLock) {
        // Another process may have completed between our first cache read and
        // lock acquisition. Re-check under the lock before reserving a request.
        const afterLock = readCache();
        // Even when this entry is stale, its suppression history is now the
        // authoritative one. A notice claim may have landed after `cached` was
        // read but before this lock was acquired; carrying the initial history
        // forward would erase that claim and permit a duplicate notice.
        cached = afterLock;
        if (readDeletionGeneration() !== deletionGenerationAtStart) {
          releaseRefreshLock(refreshLock);
          refreshLock = null;
          status = {
            enabled: true,
            state: "unavailable",
            currentVersion: PACKAGE_VERSION,
          };
          return;
        }
        fresh = afterLock && isCacheFresh(afterLock, registry, now) ? afterLock : null;
      } else {
        // The lock owner may have completed between contention and this read.
        // If not, fail closed rather than issuing a concurrent request.
        const afterContention = readCache();
        fresh =
          afterContention && isCacheFresh(afterContention, registry, now)
            ? afterContention
            : null;
        if (!fresh) {
          status = {
            enabled: true,
            state: "unavailable",
            currentVersion: PACKAGE_VERSION,
          };
          return;
        }
      }
    }
    if (fresh && refreshLock) {
      releaseRefreshLock(refreshLock);
      refreshLock = null;
    }
    if (!fresh) deletionGeneration = deletionGenerationAtStart;

    let tags: Record<string, string> | null;
    let checkedAt: number;
    let notifiedFor: string[];

    if (fresh) {
      // Within TTL/backoff: reuse the prior outcome, no network at all.
      checkedAt = fresh.checkedAt;
      notifiedFor = [...fresh.notifiedFor];
      tags =
        fresh.outcome === "success"
          ? buildTagsFromCache(fresh)
          : null;
      if (fresh.outcome === "failure") {
        status = {
          enabled: true,
          state: "unavailable",
          currentVersion: PACKAGE_VERSION,
          lastCheckedAt: new Date(checkedAt).toISOString(),
        };
        return;
      }
    } else {
      notifiedFor = cached ? [...cached.notifiedFor] : [];
      checkedAt = now;

      try {
        // Reserve this 24-hour attempt BEFORE egress. If the process exits after
        // the request starts but before it can record the response, the failure
        // reservation still prevents another process from issuing a duplicate.
        const reserved = writeCacheForGeneration({
          version: 1,
          checkedAt: now,
          currentVersion: PACKAGE_VERSION,
          registry,
          outcome: "failure",
          notifiedFor,
        }, deletionGeneration);
        if (!reserved) {
          status = {
            enabled: true,
            state: "unavailable",
            currentVersion: PACKAGE_VERSION,
          };
          return;
        }

        tags = await fetchDistTags(url, registry);
        if (tags === null) {
          status = {
            enabled: true,
            state: "unavailable",
            currentVersion: PACKAGE_VERSION,
            lastCheckedAt: new Date(now).toISOString(),
          };
          return;
        }

        const channel = releaseChannel(current);
        const persisted = writeCacheForGeneration({
          version: 1,
          checkedAt,
          currentVersion: PACKAGE_VERSION,
          registry,
          outcome: "success",
          latest: tags["latest"],
          channelTag: channel ?? undefined,
          channelVersion: channel ? tags[channel] : undefined,
          notifiedFor,
        }, deletionGeneration);
        if (!persisted) {
          status = {
            enabled: true,
            state: "unavailable",
            currentVersion: PACKAGE_VERSION,
            lastCheckedAt: new Date(now).toISOString(),
          };
          return;
        }
      } finally {
        if (refreshLock) releaseRefreshLock(refreshLock);
      }
    }

    const channel = releaseChannel(current);
    const channelVersion = newerTagVersion(tags ?? {}, channel, current);
    const stableVersion = newerStableVersion(tags ?? {}, current);
    const rawChannelTarget =
      channel && channelVersion
        ? ({ kind: "channel", channel, version: channelVersion } as const)
        : undefined;
    const stableTarget = stableVersion
      ? ({ kind: "stable", version: stableVersion } as const)
      : undefined;
    // A channel dist-tag is allowed to point at a GA. When it converges with
    // `latest`, represent the target once as stable so the notice names
    // `@latest` and only the stable suppression key is consumed.
    const channelTarget =
      rawChannelTarget?.version === stableTarget?.version
        ? undefined
        : rawChannelTarget;
    const targets: NoticeTarget[] = [
      ...(channelTarget ? [channelTarget] : []),
      ...(stableTarget ? [stableTarget] : []),
    ];

    // Prefer the user's own channel; fall back to stable (the only target when
    // the running build is itself a stable release).
    const latest = channelTarget?.version ?? stableTarget?.version;
    const lastCheckedAt = new Date(checkedAt).toISOString();

    if (!latest) {
      status = {
        enabled: true,
        state: "up-to-date",
        currentVersion: PACKAGE_VERSION,
        channel: channel ?? undefined,
        lastCheckedAt,
      };
      return;
    }

    const update = buildUpdateAvailable(channel, channelTarget, stableTarget);
    if (!update) return;

    status = {
      enabled: true,
      state: "update-available",
      currentVersion: PACKAGE_VERSION,
      latestVersion: latest,
      channel: channel ?? undefined,
      lastCheckedAt,
      updateAvailable: update,
    };

    // Per-target suppression is claimed atomically by
    // `takePendingUpdateNotice()`, not here: a process that probes and then exits
    // before any tool call leaves the announcement available to another process.
    const unnotifiedTargets = targets.filter(
      (target) => !isTargetNotified(notifiedFor, target),
    );
    if (unnotifiedTargets.length === 0) return;

    const noticeChannelTarget = unnotifiedTargets.find(
      (target): target is Extract<NoticeTarget, { kind: "channel" }> =>
        target.kind === "channel",
    );
    const noticeStableTarget = unnotifiedTargets.find(
      (target): target is Extract<NoticeTarget, { kind: "stable" }> =>
        target.kind === "stable",
    );
    const noticeUpdate = buildUpdateAvailable(
      channel,
      noticeChannelTarget,
      noticeStableTarget,
    );
    if (!noticeUpdate) return;

    pendingNotice = {
      channel,
      targets: unnotifiedTargets,
    };
    logger.debug(`Update available: ${PACKAGE_VERSION} -> ${latest}`);
  } catch {
    // A best-effort courtesy must never affect the server.
  }
}

/** Rebuild the tag map from a fresh success cache entry (no network). */
function buildTagsFromCache(cache: UpdateCache): Record<string, string> {
  const tags = emptyTagMap();
  if (cache.latest) tags["latest"] = cache.latest;
  if (isSafeTagName(cache.channelTag) && cache.channelVersion) {
    tags[cache.channelTag] = cache.channelVersion;
  }
  return tags;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Kick off the update check. Returns immediately and is never awaited by the
 * server; the work happens on a detached promise that swallows all errors.
 *
 * Re-entrant calls are ignored while a probe is still in flight, so a caller
 * that wires this up more than once can never produce a duplicate request.
 */
export function startUpdateCheck(options: StartUpdateCheckOptions = {}): void {
  if (inFlight) return;
  try {
    inFlight = runUpdateCheck(options).catch(() => undefined);
  } catch {
    // Unreachable in practice; belt-and-braces so start-up can never fail here.
  }
}

/**
 * Atomically claim and take the pending notice.
 *
 * The claim is durably written before a notice is returned, so simultaneous
 * processes sharing a data directory cannot both return the same target. If a
 * process exits after that durable claim but before its MCP response reaches the
 * client, the notice can be missed rather than duplicated; filesystem state
 * alone cannot make response delivery transactional.
 *
 * A transient lock/security failure keeps the process-local notice pending for a
 * later tool call. An absent cache (for example after logout) drops the notice
 * rather than returning something that cannot be claimed cross-process.
 *
 * An absent cache file is never re-created here: `spe-mcp logout` deletes it,
 * and delivery must not resurrect state the user just erased.
 */
export function takePendingUpdateNotice(): UpdateNotice | null {
  const pending = pendingNotice;
  pendingNotice = null;
  if (!pending) return null;

  const claim = claimNoticeTargets(pending.targets);
  if (claim.state === "retry") {
    pendingNotice ??= pending;
    return null;
  }
  if (claim.state !== "claimed") return null;

  const channelTarget = claim.targets.find(
    (target): target is Extract<NoticeTarget, { kind: "channel" }> =>
      target.kind === "channel",
  );
  const stableTarget = claim.targets.find(
    (target): target is Extract<NoticeTarget, { kind: "stable" }> =>
      target.kind === "stable",
  );
  const updateAvailable = buildUpdateAvailable(
    pending.channel,
    channelTarget,
    stableTarget,
  );
  if (!updateAvailable) return null;
  return { text: renderNotice(updateAvailable), updateAvailable };
}

/** Namespaced suppression key so channel and stable targets advance independently. */
function targetSuppressionKey(target: NoticeTarget): string {
  return target.kind === "stable"
    ? `stable:${target.version}`
    : `channel:${target.channel}:${target.version}`;
}

/**
 * Backward-compatible suppression check.
 *
 * Version-only entries came from cache version 1 before target namespacing. A
 * matching historical version still counts as delivered; new writes always use
 * namespaced keys so a channel update cannot suppress a later stable target.
 */
function isTargetNotified(notifiedFor: readonly string[], target: NoticeTarget): boolean {
  return (
    notifiedFor.includes(targetSuppressionKey(target)) ||
    notifiedFor.includes(target.version)
  );
}

type NoticeClaimResult =
  | { readonly state: "claimed"; readonly targets: readonly NoticeTarget[] }
  | { readonly state: "already-claimed" }
  | { readonly state: "retry" };

/**
 * Claim only the targets still unannounced in the authoritative cache.
 *
 * The read, comparison, and write all happen under the refresh lock. Returning
 * the represented targets only after the atomic write is what prevents two
 * processes from both returning the same notice.
 */
function claimNoticeTargets(targets: readonly NoticeTarget[]): NoticeClaimResult {
  let lock: string | null = null;
  try {
    const beforeLock = readCacheResult();
    if (beforeLock.state === "unreadable") return { state: "retry" };
    if (beforeLock.state !== "value") return { state: "already-claimed" };
    lock = acquireRefreshLock(Date.now());
    if (!lock) return { state: "retry" };
    const deletionGeneration = readDeletionGeneration();

    const afterLock = readCacheResult();
    if (afterLock.state === "unreadable") return { state: "retry" };
    if (afterLock.state !== "value") return { state: "already-claimed" };
    const cache = afterLock.cache;
    const unclaimed = targets.filter(
      (target) => !isTargetNotified(cache.notifiedFor, target),
    );
    if (unclaimed.length === 0) return { state: "already-claimed" };
    const suppressionKeys = unclaimed.map(targetSuppressionKey);
    const persisted = writeCacheForGeneration(
      { ...cache, notifiedFor: [...cache.notifiedFor, ...suppressionKeys] },
      deletionGeneration,
    );
    return persisted
      ? { state: "claimed", targets: unclaimed }
      : { state: "retry" };
  } catch {
    return { state: "retry" };
  } finally {
    if (lock) releaseRefreshLock(lock);
  }
}

/**
 * Current check state, for `status_get` and diagnostics.
 *
 * Read-only and strictly local: this never makes a network request. When the
 * live status has nothing to say (a fresh process that has not probed yet) the
 * locally cached result is surfaced instead, so a user can always see what is
 * stored, when it was stored, and where the file lives.
 */
export function getUpdateStatus(): UpdateCheckStatus {
  const cacheFile = getUpdateCacheFile();

  // Opted out: report the local file location only. No disk read, and no
  // registry is named — nothing would ever be contacted. `startUpdateCheck`
  // resolves a skip synchronously before its first `await`, so this is already
  // accurate by the time any tool can call in.
  if (!status.enabled) return { ...status, cacheFile };

  // This process already has a result, so the in-memory status is at least as
  // current as the file: skip the disk read entirely.
  if (status.lastCheckedAt) {
    return { ...status, cacheFile, registry: resolveRegistry() ?? DEFAULT_REGISTRY };
  }

  const cache = readCache();
  return {
    ...status,
    cacheFile,
    registry: cache?.registry ?? resolveRegistry() ?? DEFAULT_REGISTRY,
    latestVersion: cache ? cachedTargetVersion(cache) : undefined,
    lastCheckedAt: cache ? new Date(cache.checkedAt).toISOString() : undefined,
  };
}

/**
 * Test-only hooks. Not part of the public API.
 */
export const __testing = {
  /** Reset all process-local state between tests. */
  reset(): void {
    pendingNotice = null;
    inFlight = null;
    installedOverride = null;
    collectionNoticeEmitted = false;
    status = { enabled: true, state: "pending", currentVersion: PACKAGE_VERSION };
  },
  /** Pretend the process is (or is not) running from an installed package. */
  setInstalled(value: boolean | null): void {
    installedOverride = value;
  },
  /** Await the in-flight check so assertions are deterministic. */
  async settle(): Promise<void> {
    await inFlight;
  },
  /** Run the check and await it directly. */
  runUpdateCheck,
  resolveSkipReason,
  resolveRegistry,
  buildPackumentUrl,
  extractDistTags,
  readCappedText,
  readCache,
  writeCache,
  readDeletionGeneration,
  writeCacheForGeneration,
  getDeletionMarkerPrefix,
  hasDeletionMarker,
  getRefreshLockPrefix,
  listRefreshLocks,
  getDeletionGenerationFile,
  acquireRefreshLock,
  releaseRefreshLock,
  isCacheFresh,
  newerStableVersion,
  targetSuppressionKey,
  isTargetNotified,
  lockOwner,
  lockOwnerMayBeAlive,
  cleanupAbandonedUpdateTemps,
  renderNotice,
  removeUpdateCache,
  envFlagDisabled,
  /** Whether the one-time collection notice has already been emitted. */
  collectionNoticeEmitted(): boolean {
    return collectionNoticeEmitted;
  },
};
