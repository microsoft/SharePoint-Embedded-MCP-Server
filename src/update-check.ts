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
 * - The result is surfaced by appending one short notice to exactly ONE
 *   subsequent successful tool result (plus `structuredContent.updateAvailable`),
 *   and by `status_get`. It is never printed to stdout — stdout is the JSON-RPC
 *   channel and writing to it corrupts the protocol.
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
 *   symlink traversal), with a 24h TTL applied to successes *and* failures so
 *   the "at most one request per day" promise holds even offline.
 *
 * KNOWN LIMITATION (accepted tradeoff, not a sign-off)
 * - Node's built-in `fetch` does not honour `HTTP_PROXY` / `HTTPS_PROXY` /
 *   `NO_PROXY`. Adding proxy support would require a new runtime dependency,
 *   which this package deliberately does not take. On a proxy-only network the
 *   probe simply fails closed (silent no-op) rather than bypassing the proxy.
 *   Operators who must not egress at all should turn the check off outright.
 * - Cache writes are last-writer-wins. `secure-fs` has no compare-and-swap, and
 *   this change deliberately does not alter that shared primitive. Two servers
 *   delivering a notice at the same instant can therefore drop one suppression
 *   entry, costing at most one extra notice; tracked as follow-up work.
 *
 * ZERO-NETWORK OPT-OUTS — each skips the check entirely (no request, no notice,
 * no cache read, no cache write): `--no-update-check`, `SPE_MCP_UPDATE_CHECK=false`,
 * `SPE_NO_UPDATE_CHECK=1` (back-compatible alias), `NO_UPDATE_NOTIFIER=1`,
 * `SPE_MCP_COLLECT_TELEMETRY=false`, any CI marker, and source checkouts.
 */

import { existsSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createLogger } from "./logger.js";
import { getDataDir, getUpdateCacheFile } from "./paths.js";
import { ensureSecureDir, readSecureFile, writeSecureFile } from "./secure-fs.js";
import { isNewer, parseSemver, releaseChannel, type SemVer } from "./semver.js";
import { applyProductUserAgent } from "./user-agent.js";
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
 * Deliberately identical to {@link CHECK_TTL_MS}: the documented promise is "at
 * most one request per day", and a shorter failure backoff would quietly make
 * that promise false for anyone who is offline (a failing probe would be retried
 * several times a day). Success and failure are both remembered for 24h.
 */
export const FAILURE_BACKOFF_MS = CHECK_TTL_MS;

/** Cap on remembered "already told the user about this version" entries. */
const MAX_NOTIFIED_ENTRIES = 10;

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
 * It must name the endpoint actually contacted, say plainly that the endpoint
 * sits outside the Microsoft 365 / Azure compliance boundary, say what the
 * connection discloses, say that nothing is installed, and name the opt-out.
 *
 * @param registry - The resolved registry origin. Always a value that already
 *   passed {@link resolveRegistry} (HTTPS, no credentials, no query/fragment,
 *   length-capped), so it is safe to print verbatim.
 */
export function collectionNotice(registry: string): string {
  return [
    `Update check: contacting the npm registry at ${registry} to see whether a`,
    `newer version of ${PACKAGE_NAME} has been published.`,
    "The npm registry is a third-party service OUTSIDE the Microsoft 365 / Azure",
    "compliance boundary. The request is unauthenticated and carries no user",
    "identifier and no account, tenant, machine, session, or content data — but",
    "the connection itself discloses your IP address, the package name, and the",
    "product User-Agent to that third party. The result is cached locally until",
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

// ---------------------------------------------------------------------------
// Process-local state
// ---------------------------------------------------------------------------

let pendingNotice: UpdateNotice | null = null;
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
 * valid SemVer string is dropped silently.
 */
function extractDistTags(raw: string): Record<string, string> {
  const result = emptyTagMap();

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return result;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return result;

  const tags = (parsed as Record<string, unknown>)["dist-tags"];
  if (typeof tags !== "object" || tags === null || Array.isArray(tags)) return result;

  for (const [name, value] of Object.entries(tags as Record<string, unknown>)) {
    if (!isSafeTagName(name)) continue;
    if (typeof value !== "string" || value.length > MAX_TAG_VALUE_LENGTH) continue;
    if (parseSemver(value) === null) continue;
    result[name] = value;
  }

  return result;
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
    const response = await fetch(url, {
      method: "GET",
      redirect: "error",
      credentials: "omit",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: applyProductUserAgent({
        // The abbreviated packument is orders of magnitude smaller than the full one.
        accept: "application/vnd.npm.install-v1+json",
      }),
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

/** Read the cache, tolerating absence, corruption, and secure-fs rejections. */
function readCache(): UpdateCache | null {
  let raw: string | null;
  try {
    raw = readSecureFile(getUpdateCacheFile());
  } catch {
    return null;
  }
  if (raw === null) return null;

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
      notifiedFor: notified.slice(-MAX_NOTIFIED_ENTRIES),
    };
  } catch {
    return null;
  }
}

/** Persist the cache with owner-only permissions. Failures are non-fatal. */
function writeCache(cache: UpdateCache): void {
  try {
    ensureSecureDir(getDataDir());
    writeSecureFile(
      getUpdateCacheFile(),
      JSON.stringify({ ...cache, notifiedFor: cache.notifiedFor.slice(-MAX_NOTIFIED_ENTRIES) }, null, 2),
    );
  } catch {
    // Best-effort: an unwritable cache only costs an extra probe next time.
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
 * Wired into `spe-mcp logout` (and `auth --reset`) so signing out clears every
 * file this server wrote under the data directory, not just the token cache.
 * Best-effort and never throws: a missing or unremovable file is not an error.
 */
export function removeUpdateCache(): void {
  try {
    const file = getUpdateCacheFile();
    if (!existsSync(file)) return;
    unlinkSync(file);
    logger.debug("Removed update-check cache.");
  } catch {
    // Best-effort: leaving the file behind is not a failure worth surfacing.
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
 * Reconstruct the version a cached result would have pointed at, using exactly
 * the same channel-first rule as a live check. Purely local: this reads the
 * cache file only and never touches the network.
 */
function cachedTargetVersion(cache: UpdateCache): string | undefined {
  const tags = buildTagsFromCache(cache);
  const current = parseSemver(PACKAGE_VERSION);
  if (current) {
    const channel = releaseChannel(current);
    const target =
      newerTagVersion(tags, channel, current) ?? newerTagVersion(tags, "latest", current);
    if (target) return target;
  }
  // Nothing newer is known: still report the newest version we saw, so the
  // status table can show what the cache actually holds.
  return cache.channelVersion ?? cache.latest;
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
 * 2. It is **execution-mode neutral**. This server is commonly launched by an MCP
 *    client through an unpinned `npx -y @microsoft/spe-mcp`, in which case updating a
 *    global installation would update something the client never runs. We therefore
 *    name the package *spec* to move to and let a person apply it to whichever launch
 *    mechanism they actually configured.
 */
function renderNotice(update: UpdateAvailable): string {
  const lines = [
    `Update available: ${update.package} ${update.current} -> ${update.latest}` +
      `${update.channel ? ` (${update.channel} channel)` : ""}.`,
    `This notice is informational only — nothing is installed or changed ` +
      `automatically, and no command should be run in response to it. Updating ` +
      `requires a person to change the MCP client configuration or the installed ` +
      `package: point the client at ${update.packageSpec} by updating or pinning the ` +
      `package spec in the client config (for example the npx args), or have the copy ` +
      `that is actually launched (a global or project-local installation, for ` +
      `instance) reinstalled at that same spec. An unpinned npx launch may keep ` +
      `starting a cached build.`,
  ];
  if (update.stable && update.stablePackageSpec) {
    lines.push(`Latest stable release: ${update.stable} (spec ${update.stablePackageSpec}).`);
  }
  lines.push(
    "Nothing was downloaded, installed, or executed; this is a notification only, " +
      "not an instruction to run any command. Disable this check with " +
      "--no-update-check or SPE_MCP_UPDATE_CHECK=false.",
  );
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
    const cached = readCache();
    const fresh = cached && isCacheFresh(cached, registry, now) ? cached : null;

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
      tags = await fetchDistTags(url, registry);
      if (tags === null) {
        writeCache({
          version: 1,
          checkedAt: now,
          currentVersion: PACKAGE_VERSION,
          registry,
          outcome: "failure",
          notifiedFor,
        });
        status = {
          enabled: true,
          state: "unavailable",
          currentVersion: PACKAGE_VERSION,
          lastCheckedAt: new Date(now).toISOString(),
        };
        return;
      }
    }

    const channel = releaseChannel(current);
    const channelVersion = newerTagVersion(tags ?? {}, channel, current);
    const stableVersion = newerTagVersion(tags ?? {}, "latest", current);

    // Prefer the user's own channel; fall back to stable (the only target when
    // the running build is itself a stable release).
    const latest = channelVersion ?? stableVersion;
    const lastCheckedAt = new Date(checkedAt).toISOString();

    if (!fresh) {
      writeCache({
        version: 1,
        checkedAt,
        currentVersion: PACKAGE_VERSION,
        registry,
        outcome: "success",
        latest: tags?.["latest"],
        channelTag: channel ?? undefined,
        channelVersion: channel ? tags?.[channel] : undefined,
        notifiedFor,
      });
    }

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

    const update: UpdateAvailable = {
      package: PACKAGE_NAME,
      current: PACKAGE_VERSION,
      latest,
      channel,
      // Only call out stable separately when it is a different, additional target.
      ...(stableVersion && stableVersion !== latest
        ? { stable: stableVersion, stablePackageSpec: `${PACKAGE_NAME}@latest` }
        : {}),
      packageSpec: `${PACKAGE_NAME}@${channelVersion && channel ? channel : "latest"}`,
    };

    status = {
      enabled: true,
      state: "update-available",
      currentVersion: PACKAGE_VERSION,
      latestVersion: latest,
      channel: channel ?? undefined,
      lastCheckedAt,
      updateAvailable: update,
    };

    // Per-target suppression: each newer version is announced exactly once, even
    // across restarts. The suppression entry is persisted by
    // `takePendingUpdateNotice()` at *delivery* time, not here: a process that
    // probes and then exits before any tool call would otherwise burn the only
    // announcement without the user ever seeing it.
    if (notifiedFor.includes(latest)) return;

    pendingNotice = { text: renderNotice(update), updateAvailable: update };
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
 * Take the pending notice, clearing it.
 *
 * Returning-and-clearing is what makes the notice appear on exactly one tool
 * result: whichever call happens to run after the probe resolves gets it, and
 * every later call sees `null`.
 *
 * Cross-process suppression is persisted *here*, at delivery, rather than when
 * the probe found the update: a process that exits before any tool call leaves
 * the cache untouched, so the next process still announces the version. The
 * cache is re-read immediately before writing so a concurrent process's entries
 * are merged rather than clobbered. Known residual risk: two processes that
 * deliver at the same instant can still interleave (last writer wins) and one
 * suppression entry may be lost, costing at most one extra notice; fixing that
 * needs compare-and-swap support in `secure-fs`, tracked as follow-up work.
 *
 * An absent cache file is never re-created here: `spe-mcp logout` deletes it,
 * and delivery must not resurrect state the user just erased.
 */
export function takePendingUpdateNotice(): UpdateNotice | null {
  const notice = pendingNotice;
  pendingNotice = null;
  if (notice) persistNotified(notice.updateAvailable.latest);
  return notice;
}

/** Record `version` as announced, merging into whatever is on disk right now. */
function persistNotified(version: string): void {
  try {
    const cache = readCache();
    // No cache (never written, or deleted by logout) => nothing to update.
    if (!cache) return;
    if (cache.notifiedFor.includes(version)) return;
    writeCache({ ...cache, notifiedFor: [...cache.notifiedFor, version] });
  } catch {
    // Best-effort: at worst the notice is shown once more next run.
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
  isCacheFresh,
  renderNotice,
  removeUpdateCache,
  envFlagDisabled,
  /** Whether the one-time collection notice has already been emitted. */
  collectionNoticeEmitted(): boolean {
    return collectionNoticeEmitted;
  },
};
