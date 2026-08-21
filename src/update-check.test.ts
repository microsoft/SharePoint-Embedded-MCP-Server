// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Tests for the npm update-awareness check (SEC-008).
 *
 * The check is a best-effort courtesy: it must never throw, never block, never
 * authenticate, and never run when the user or the environment has opted out.
 * These tests therefore assert as much about what the feature *does not* do
 * (no network, no cache writes, no notices) as about what it does.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  COLLECTION_NOTICE,
  collectionNotice,
  DEFAULT_REGISTRY,
  CHECK_TTL_MS,
  FAILURE_BACKOFF_MS,
  MAX_RESPONSE_BYTES,
  REQUEST_TIMEOUT_MS,
  __testing,
  getUpdateStatus,
  removeUpdateCache,
  startUpdateCheck,
  takePendingUpdateNotice,
} from "./update-check.js";
import { parseSemver, releaseChannel } from "./semver.js";
import { PACKAGE_NAME, PACKAGE_VERSION } from "./version.js";
import {
  getUpdateCacheFile,
  setDataDirOverride,
  __testing as pathsTesting,
} from "./paths.js";

// ---------------------------------------------------------------------------
// Fixtures derived from the real package version so a future release bump
// (alpha -> beta -> stable) cannot silently invalidate these expectations.
// ---------------------------------------------------------------------------

const CURRENT = parseSemver(PACKAGE_VERSION);
if (!CURRENT) throw new Error(`package.json version is not valid SemVer: ${PACKAGE_VERSION}`);

const CHANNEL = releaseChannel(CURRENT);
const NEWER_STABLE = `${CURRENT.major + 1}.0.0`;
const NEWER_CHANNEL = CHANNEL ? `${CURRENT.major + 1}.0.0-${CHANNEL}.1` : null;
/** What the check should settle on: the user's own channel, else stable. */
const EXPECTED_LATEST = NEWER_CHANNEL ?? NEWER_STABLE;

/** A registry payload offering a newer build on both `latest` and the channel. */
function tagsFixture(): Record<string, string> {
  const tags: Record<string, string> = { latest: NEWER_STABLE };
  if (CHANNEL && NEWER_CHANNEL) tags[CHANNEL] = NEWER_CHANNEL;
  return tags;
}

function packument(tags: Record<string, unknown>): string {
  return JSON.stringify({ name: PACKAGE_NAME, "dist-tags": tags });
}

/** Every environment variable this module reads. */
const ENV_KEYS = [
  "SPE_MCP_UPDATE_CHECK",
  "SPE_NO_UPDATE_CHECK",
  "SPE_MCP_COLLECT_TELEMETRY",
  "NO_UPDATE_NOTIFIER",
  "CI",
  "CONTINUOUS_INTEGRATION",
  "GITHUB_ACTIONS",
  "TF_BUILD",
  "BUILD_BUILDID",
  "SPE_NPM_REGISTRY",
  "SPE_DATA_DIR",
] as const;

let savedEnv: Record<string, string | undefined> = {};
let dataDir: string;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }

  dataDir = mkdtempSync(join(tmpdir(), "spe-mcp-update-"));
  setDataDirOverride(dataDir);

  __testing.reset();
  // Default posture for flow tests: behave like a real npm install.
  __testing.setInstalled(true);

  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  __testing.reset();
  pathsTesting.reset();
  rmSync(dataDir, { recursive: true, force: true });
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

/** Respond with a real `Response` so the streaming/cap path is exercised. */
function respondWith(body: string, init?: ResponseInit): void {
  fetchMock.mockResolvedValue(new Response(body, { status: 200, ...init }));
}

function cacheExists(): boolean {
  return existsSync(getUpdateCacheFile());
}

function readCacheFile(): Record<string, unknown> {
  return JSON.parse(readFileSync(getUpdateCacheFile(), "utf8")) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Skip reasons
// ---------------------------------------------------------------------------

describe("resolveSkipReason", () => {
  it("allows the check when nothing opts out and the build is installed", () => {
    expect(__testing.resolveSkipReason({})).toBeNull();
  });

  it("reports the CLI flag when enabled is false", () => {
    expect(__testing.resolveSkipReason({ enabled: false })).toBe("cli-flag");
  });

  it("treats an omitted enabled option as opt-in", () => {
    expect(__testing.resolveSkipReason({ enabled: undefined })).toBeNull();
  });

  it("honors SPE_NO_UPDATE_CHECK", () => {
    process.env.SPE_NO_UPDATE_CHECK = "1";
    expect(__testing.resolveSkipReason({})).toBe("env-spe-no-update-check");
  });

  it("honors NO_UPDATE_NOTIFIER (the community convention)", () => {
    process.env.NO_UPDATE_NOTIFIER = "true";
    expect(__testing.resolveSkipReason({})).toBe("env-no-update-notifier");
  });

  it.each([
    ["CI"],
    ["CONTINUOUS_INTEGRATION"],
    ["GITHUB_ACTIONS"],
    ["TF_BUILD"],
    ["BUILD_BUILDID"],
  ])("detects CI via %s", (name) => {
    process.env[name] = "1";
    expect(__testing.resolveSkipReason({})).toBe("ci");
  });

  it("skips source checkouts so contributors are never told to npm install", () => {
    __testing.setInstalled(false);
    expect(__testing.resolveSkipReason({})).toBe("source-install");
  });

  it.each([["0"], ["false"], ["no"], ["off"], [""], ["  "], ["FALSE"], ["Off"]])(
    "treats %s as not opting out",
    (value) => {
      process.env.SPE_NO_UPDATE_CHECK = value;
      expect(__testing.resolveSkipReason({})).toBeNull();
    },
  );

  it.each([["1"], ["true"], ["yes"], ["anything"]])("treats %s as opting out", (value) => {
    process.env.SPE_NO_UPDATE_CHECK = value;
    expect(__testing.resolveSkipReason({})).toBe("env-spe-no-update-check");
  });

  it("prefers the most specific reason when several apply", () => {
    process.env.SPE_NO_UPDATE_CHECK = "1";
    process.env.NO_UPDATE_NOTIFIER = "1";
    process.env.CI = "1";
    __testing.setInstalled(false);
    expect(__testing.resolveSkipReason({ enabled: false })).toBe("cli-flag");
    expect(__testing.resolveSkipReason({})).toBe("env-spe-no-update-check");
  });
});

// ---------------------------------------------------------------------------
// Registry resolution
// ---------------------------------------------------------------------------

describe("resolveRegistry", () => {
  it("defaults to the public npm registry", () => {
    expect(__testing.resolveRegistry()).toBe(DEFAULT_REGISTRY);
    expect(DEFAULT_REGISTRY.startsWith("https://")).toBe(true);
  });

  it("accepts an HTTPS override", () => {
    process.env.SPE_NPM_REGISTRY = "https://registry.contoso.example";
    expect(__testing.resolveRegistry()).toBe("https://registry.contoso.example");
  });

  it("strips trailing slashes so the URL join stays canonical", () => {
    process.env.SPE_NPM_REGISTRY = "https://registry.contoso.example/npm///";
    expect(__testing.resolveRegistry()).toBe("https://registry.contoso.example/npm");
  });

  it("falls back to the default when the override is blank", () => {
    process.env.SPE_NPM_REGISTRY = "   ";
    expect(__testing.resolveRegistry()).toBe(DEFAULT_REGISTRY);
  });

  it.each([
    ["plain HTTP", "http://registry.npmjs.org"],
    ["a non-web scheme", "file:///etc/passwd"],
    ["embedded credentials", "https://user:pass@registry.contoso.example"],
    ["a username only", "https://user@registry.contoso.example"],
    ["a query string", "https://registry.contoso.example?token=abc"],
    ["a fragment", "https://registry.contoso.example#token"],
    ["a non-URL", "not a url"],
    ["a bare host", "registry.contoso.example"],
  ])("rejects %s", (_label, value) => {
    process.env.SPE_NPM_REGISTRY = value;
    expect(__testing.resolveRegistry()).toBeNull();
  });

  it("rejects an absurdly long override", () => {
    process.env.SPE_NPM_REGISTRY = `https://example.com/${"a".repeat(600)}`;
    expect(__testing.resolveRegistry()).toBeNull();
  });
});

describe("buildPackumentUrl", () => {
  it("escapes the scope separator the way npm does", () => {
    const url = __testing.buildPackumentUrl(DEFAULT_REGISTRY);
    expect(url).toBe(`${DEFAULT_REGISTRY}/${PACKAGE_NAME.replace("/", "%2f")}`);
    expect(url).not.toContain("@microsoft/spe-mcp");
  });

  it("produces a URL the platform can parse", () => {
    const url = __testing.buildPackumentUrl(DEFAULT_REGISTRY);
    expect(url).not.toBeNull();
    expect(() => new URL(url as string)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Hostile payload handling
// ---------------------------------------------------------------------------

describe("extractDistTags", () => {
  it("keeps well-formed tags", () => {
    expect(__testing.extractDistTags(packument({ latest: "1.2.3", next: "2.0.0-rc.1" }))).toEqual({
      latest: "1.2.3",
      next: "2.0.0-rc.1",
    });
  });

  it.each([
    ["malformed JSON", "{not json"],
    ["a JSON array", "[]"],
    ["a JSON string", '"hello"'],
    ["JSON null", "null"],
    ["a number", "42"],
    ["an object with no dist-tags", '{"name":"x"}'],
    ["dist-tags as an array", '{"dist-tags":[]}'],
    ["dist-tags as null", '{"dist-tags":null}'],
    ["dist-tags as a string", '{"dist-tags":"latest"}'],
  ])("returns no tags for %s", (_label, raw) => {
    expect(__testing.extractDistTags(raw)).toEqual({});
  });

  it("drops prototype-pollution keys", () => {
    const raw = '{"dist-tags":{"__proto__":"9.9.9","constructor":"9.9.9","prototype":"9.9.9","latest":"1.0.0"}}';
    const tags = __testing.extractDistTags(raw);
    expect(tags).toEqual({ latest: "1.0.0" });
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
    expect(Object.getPrototypeOf(tags)).toBeNull();
  });

  it("drops non-string and non-SemVer values", () => {
    const raw = JSON.stringify({
      "dist-tags": {
        latest: "1.0.0",
        numeric: 3,
        nested: { version: "2.0.0" },
        listy: ["2.0.0"],
        nully: null,
        loose: "v2.0.0",
        ranged: "^2.0.0",
        partial: "2.0",
        empty: "",
      },
    });
    expect(__testing.extractDistTags(raw)).toEqual({ latest: "1.0.0" });
  });

  it("drops over-long tag names and values", () => {
    const raw = JSON.stringify({
      "dist-tags": {
        latest: "1.0.0",
        ["t".repeat(65)]: "1.0.0",
        long: `1.0.0-${"a".repeat(300)}`,
      },
    });
    expect(__testing.extractDistTags(raw)).toEqual({ latest: "1.0.0" });
  });

  it("drops an empty tag name", () => {
    expect(__testing.extractDistTags('{"dist-tags":{"":"1.0.0","latest":"1.0.0"}}')).toEqual({
      latest: "1.0.0",
    });
  });
});

// ---------------------------------------------------------------------------
// Response size cap
// ---------------------------------------------------------------------------

describe("readCappedText", () => {
  it("reads a small body", async () => {
    const response = new Response("hello");
    await expect(__testing.readCappedText(response, MAX_RESPONSE_BYTES)).resolves.toBe("hello");
  });

  it("rejects a body whose declared content-length exceeds the cap", async () => {
    const response = new Response("{}", {
      headers: { "content-length": String(MAX_RESPONSE_BYTES + 1) },
    });
    await expect(__testing.readCappedText(response, MAX_RESPONSE_BYTES)).resolves.toBeNull();
  });

  it("rejects a streamed body that exceeds the cap despite a truthful-looking header", async () => {
    const response = new Response("x".repeat(MAX_RESPONSE_BYTES + 1_024));
    await expect(__testing.readCappedText(response, MAX_RESPONSE_BYTES)).resolves.toBeNull();
  });

  it("accepts a body exactly at the cap", async () => {
    const body = "y".repeat(MAX_RESPONSE_BYTES);
    const text = await __testing.readCappedText(new Response(body), MAX_RESPONSE_BYTES);
    expect(text).toHaveLength(MAX_RESPONSE_BYTES);
  });

  it("falls back to text() when the response exposes no readable stream", async () => {
    const fake = {
      headers: new Headers(),
      body: null,
      text: async () => "fallback",
    } as unknown as Response;
    await expect(__testing.readCappedText(fake, MAX_RESPONSE_BYTES)).resolves.toBe("fallback");
  });

  it("rejects an oversize body on the text() fallback path", async () => {
    const fake = {
      headers: new Headers(),
      body: null,
      text: async () => "z".repeat(MAX_RESPONSE_BYTES + 1),
    } as unknown as Response;
    await expect(__testing.readCappedText(fake, MAX_RESPONSE_BYTES)).resolves.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Cache freshness
// ---------------------------------------------------------------------------

describe("cache", () => {
  const base = {
    version: 1 as const,
    checkedAt: 1_000_000,
    currentVersion: PACKAGE_VERSION,
    registry: DEFAULT_REGISTRY,
    outcome: "success" as const,
    notifiedFor: [] as string[],
  };

  it("round-trips through secure-fs", () => {
    __testing.writeCache({ ...base, latest: "9.9.9", notifiedFor: ["9.9.9"] });
    expect(cacheExists()).toBe(true);
    const read = __testing.readCache();
    expect(read?.latest).toBe("9.9.9");
    expect(read?.notifiedFor).toEqual(["9.9.9"]);
  });

  it("returns null when no cache file exists", () => {
    expect(__testing.readCache()).toBeNull();
  });

  it.each([
    ["malformed JSON", "{oops"],
    ["an array", "[]"],
    ["a wrong schema version", '{"version":2}'],
    ["a missing timestamp", '{"version":1,"currentVersion":"1.0.0","registry":"r","outcome":"success"}'],
    ["a bogus outcome", '{"version":1,"checkedAt":1,"currentVersion":"1.0.0","registry":"r","outcome":"maybe"}'],
  ])("ignores a cache with %s", (_label, raw) => {
    writeFileSync(getUpdateCacheFile(), raw, "utf8");
    expect(__testing.readCache()).toBeNull();
  });

  it("discards non-string notifiedFor entries", () => {
    writeFileSync(
      getUpdateCacheFile(),
      JSON.stringify({ ...base, notifiedFor: ["1.0.0", 5, null, { a: 1 }] }),
      "utf8",
    );
    expect(__testing.readCache()?.notifiedFor).toEqual(["1.0.0"]);
  });

  it("treats a recent success as fresh", () => {
    expect(__testing.isCacheFresh(base, DEFAULT_REGISTRY, base.checkedAt + 1_000)).toBe(true);
  });

  it("expires a success at the TTL boundary", () => {
    expect(__testing.isCacheFresh(base, DEFAULT_REGISTRY, base.checkedAt + CHECK_TTL_MS)).toBe(false);
    expect(__testing.isCacheFresh(base, DEFAULT_REGISTRY, base.checkedAt + CHECK_TTL_MS - 1)).toBe(true);
  });

  it("expires a failure at the same 24h boundary as a success", () => {
    const failure = { ...base, outcome: "failure" as const };
    // The failure backoff MUST equal the TTL: every doc promises "at most one
    // request per day", which a shorter backoff would silently break.
    expect(FAILURE_BACKOFF_MS).toBe(CHECK_TTL_MS);
    expect(FAILURE_BACKOFF_MS).toBe(24 * 60 * 60 * 1000);
    expect(__testing.isCacheFresh(failure, DEFAULT_REGISTRY, base.checkedAt + FAILURE_BACKOFF_MS)).toBe(false);
    expect(__testing.isCacheFresh(failure, DEFAULT_REGISTRY, base.checkedAt + FAILURE_BACKOFF_MS - 1)).toBe(true);
  });

  it("suppresses a repeat network probe for a whole day after a failure", async () => {
    const failure = { ...base, outcome: "failure" as const, checkedAt: Date.now() - 23 * 60 * 60 * 1000 };
    writeFileSync(getUpdateCacheFile(), JSON.stringify(failure), "utf8");
    await __testing.runUpdateCheck({});
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a cache written by a different build", () => {
    expect(
      __testing.isCacheFresh({ ...base, currentVersion: "0.0.1" }, DEFAULT_REGISTRY, base.checkedAt),
    ).toBe(false);
  });

  it("rejects a cache written against a different registry", () => {
    expect(__testing.isCacheFresh(base, "https://other.example", base.checkedAt)).toBe(false);
  });

  it("rejects a cache from the future (clock skew or tampering)", () => {
    expect(__testing.isCacheFresh(base, DEFAULT_REGISTRY, base.checkedAt - 1)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Notice rendering
// ---------------------------------------------------------------------------

describe("renderNotice", () => {
  it("names the channel and the package spec to move to", () => {
    const text = __testing.renderNotice({
      package: PACKAGE_NAME,
      current: "1.0.0-alpha.1",
      latest: "1.0.0-alpha.2",
      channel: "alpha",
      packageSpec: `${PACKAGE_NAME}@alpha`,
    });
    expect(text).toContain("1.0.0-alpha.1 -> 1.0.0-alpha.2");
    expect(text).toContain("(alpha channel)");
    expect(text).toContain(`${PACKAGE_NAME}@alpha`);
    expect(text).toContain("--no-update-check");
    expect(text).not.toContain("Latest stable release");
  });

  // B1: the server is usually launched by an MCP client through an unpinned
  // `npx -y @microsoft/spe-mcp`. Guidance that names ONLY a global install would
  // tell the user to update something the client never runs.
  it("gives execution-mode neutral remediation, not a bare global install", () => {
    const text = __testing.renderNotice({
      package: PACKAGE_NAME,
      current: "1.0.0-alpha.1",
      latest: "1.0.0-alpha.2",
      channel: "alpha",
      packageSpec: `${PACKAGE_NAME}@alpha`,
    });
    // Points at the client configuration first...
    expect(text).toContain("MCP client");
    expect(text).toMatch(/package spec/i);
    // ...warns about the unpinned npx caching trap...
    expect(text).toMatch(/npx/i);
    expect(text).toMatch(/cached build/i);
    // ...and names the installation modes without dictating a shell command.
    expect(text).toMatch(/global or project-local installation/i);
    expect(text).toMatch(/reinstalled/i);
    // Still explicitly notify-only.
    expect(text).toContain("Nothing was downloaded, installed, or executed");
  });

  // CELA R2: the notice rides a tool result an agent may act on, so it must read
  // as information, never as a command an autonomous client should execute.
  it("frames remediation as informational and human-driven, not an executable command", () => {
    const text = __testing.renderNotice({
      package: PACKAGE_NAME,
      current: "1.0.0-alpha.1",
      latest: "1.0.0-alpha.2",
      channel: "alpha",
      packageSpec: `${PACKAGE_NAME}@alpha`,
    });
    expect(text).toMatch(/informational only/i);
    expect(text).toMatch(/no command should be run in response/i);
    expect(text).toMatch(/not an instruction to run any command/i);
    // Updating is a person changing config, not the server acting.
    expect(text).toMatch(/requires a person/i);
    // No copy-pasteable install command anywhere in the notice.
    expect(text).not.toMatch(/npm install/i);
    expect(text).not.toMatch(/npm i\b/i);
  });

  it("calls out a separate stable target when one exists", () => {
    const text = __testing.renderNotice({
      package: PACKAGE_NAME,
      current: "1.0.0-alpha.1",
      latest: "1.0.0-alpha.2",
      channel: "alpha",
      stable: "2.0.0",
      packageSpec: `${PACKAGE_NAME}@alpha`,
      stablePackageSpec: `${PACKAGE_NAME}@latest`,
    });
    expect(text).toContain("Latest stable release: 2.0.0");
    expect(text).toContain(`spec ${PACKAGE_NAME}@latest`);
  });

  it("omits the channel clause for a stable build", () => {
    const text = __testing.renderNotice({
      package: PACKAGE_NAME,
      current: "1.0.0",
      latest: "1.1.0",
      channel: null,
      packageSpec: `${PACKAGE_NAME}@latest`,
    });
    expect(text).not.toContain("channel)");
    expect(text).toContain(`${PACKAGE_NAME}@latest`);
  });
});

// ---------------------------------------------------------------------------
// End-to-end flow
// ---------------------------------------------------------------------------

describe("runUpdateCheck", () => {
  it("surfaces a newer release exactly once and records it", async () => {
    respondWith(packument(tagsFixture()));

    await __testing.runUpdateCheck({});

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const status = getUpdateStatus();
    expect(status.state).toBe("update-available");
    expect(status.latestVersion).toBe(EXPECTED_LATEST);
    expect(status.currentVersion).toBe(PACKAGE_VERSION);
    expect(status.updateAvailable?.packageSpec).toBe(`${PACKAGE_NAME}@alpha`);

    const notice = takePendingUpdateNotice();
    expect(notice?.text).toContain(EXPECTED_LATEST);
    expect(notice?.updateAvailable.latest).toBe(EXPECTED_LATEST);
    // Take-and-clear: a second consumer must not see it again.
    expect(takePendingUpdateNotice()).toBeNull();

    expect(readCacheFile()["notifiedFor"]).toEqual([EXPECTED_LATEST]);
  });

  it("requests the abbreviated packument with the product user agent and no credentials", async () => {
    respondWith(packument(tagsFixture()));
    await __testing.runUpdateCheck({});

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url.startsWith(`${DEFAULT_REGISTRY}/`)).toBe(true);
    expect(init.method).toBe("GET");
    expect(init.redirect).toBe("error");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const headers = init.headers as Record<string, string>;
    expect(headers["accept"]).toBe("application/vnd.npm.install-v1+json");
    expect(Object.keys(headers).map((k) => k.toLowerCase())).not.toContain("authorization");
    expect(Object.keys(headers).map((k) => k.toLowerCase())).not.toContain("cookie");
    expect(REQUEST_TIMEOUT_MS).toBe(2_000);
  });

  it("does not notify twice for the same target across restarts", async () => {
    respondWith(packument(tagsFixture()));
    await __testing.runUpdateCheck({});
    expect(takePendingUpdateNotice()).not.toBeNull();

    // Simulate a restart a week later: state is reset, cache survives.
    __testing.reset();
    __testing.setInstalled(true);
    const stale = readCacheFile();
    writeFileSync(
      getUpdateCacheFile(),
      JSON.stringify({ ...stale, checkedAt: Date.now() - CHECK_TTL_MS * 7 }),
      "utf8",
    );
    respondWith(packument(tagsFixture()));

    await __testing.runUpdateCheck({});
    expect(getUpdateStatus().state).toBe("update-available");
    expect(takePendingUpdateNotice()).toBeNull();
  });

  it("reports up-to-date when the registry offers nothing newer", async () => {
    respondWith(packument({ latest: PACKAGE_VERSION, ...(CHANNEL ? { [CHANNEL]: PACKAGE_VERSION } : {}) }));

    await __testing.runUpdateCheck({});

    expect(getUpdateStatus().state).toBe("up-to-date");
    expect(takePendingUpdateNotice()).toBeNull();
    expect(readCacheFile()["outcome"]).toBe("success");
  });

  it("ignores older published versions", async () => {
    respondWith(packument({ latest: "0.0.1" }));
    await __testing.runUpdateCheck({});
    expect(getUpdateStatus().state).toBe("up-to-date");
    expect(takePendingUpdateNotice()).toBeNull();
  });

  it("reuses a fresh success cache without touching the network", async () => {
    respondWith(packument(tagsFixture()));
    await __testing.runUpdateCheck({});
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(takePendingUpdateNotice()).not.toBeNull();

    __testing.reset();
    __testing.setInstalled(true);
    await __testing.runUpdateCheck({});

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getUpdateStatus().state).toBe("update-available");
    // Already delivered before the restart, so it is not repeated.
    expect(takePendingUpdateNotice()).toBeNull();
  });

  it("backs off after a failure instead of retrying every start", async () => {
    fetchMock.mockRejectedValue(new Error("offline"));
    await __testing.runUpdateCheck({});
    expect(getUpdateStatus().state).toBe("unavailable");
    expect(readCacheFile()["outcome"]).toBe("failure");

    __testing.reset();
    __testing.setInstalled(true);
    await __testing.runUpdateCheck({});

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getUpdateStatus().state).toBe("unavailable");
  });

  it.each([
    [
      "a network error",
      () => {
        fetchMock.mockRejectedValue(new Error("getaddrinfo ENOTFOUND"));
      },
    ],
    [
      "a timeout",
      () => {
        fetchMock.mockRejectedValue(
          Object.assign(new Error("The operation was aborted"), { name: "TimeoutError" }),
        );
      },
    ],
    [
      "a 500 response",
      () => {
        fetchMock.mockResolvedValue(new Response("boom", { status: 500 }));
      },
    ],
    [
      "a 404 response",
      () => {
        fetchMock.mockResolvedValue(new Response("{}", { status: 404 }));
      },
    ],
    [
      "an oversize body",
      () => {
        fetchMock.mockResolvedValue(new Response("x".repeat(MAX_RESPONSE_BYTES + 512)));
      },
    ],
    [
      "a body that lies about its length",
      () => {
        fetchMock.mockResolvedValue(
          new Response("{}", { headers: { "content-length": String(MAX_RESPONSE_BYTES * 4) } }),
        );
      },
    ],
  ])("degrades silently on %s", async (_label, arrange) => {
    arrange();
    await expect(__testing.runUpdateCheck({})).resolves.toBeUndefined();
    expect(getUpdateStatus().state).toBe("unavailable");
    expect(takePendingUpdateNotice()).toBeNull();
    expect(readCacheFile()["outcome"]).toBe("failure");
  });

  it.each([
    ["garbage that is not JSON", "<html>404</html>"],
    ["JSON with no dist-tags", '{"name":"x"}'],
    ["dist-tags full of junk", '{"dist-tags":{"latest":"not-a-version","next":{"a":1}}}'],
    ["prototype pollution attempts", '{"dist-tags":{"__proto__":"999.0.0"}}'],
  ])("treats %s as no update rather than an error", async (_label, body) => {
    respondWith(body);
    await __testing.runUpdateCheck({});
    expect(getUpdateStatus().state).toBe("up-to-date");
    expect(takePendingUpdateNotice()).toBeNull();
  });

  it.each([
    ["the CLI flag", () => ({ enabled: false }) as const, "cli-flag"],
    [
      "SPE_NO_UPDATE_CHECK",
      () => {
        process.env.SPE_NO_UPDATE_CHECK = "1";
        return {};
      },
      "env-spe-no-update-check",
    ],
    [
      "NO_UPDATE_NOTIFIER",
      () => {
        process.env.NO_UPDATE_NOTIFIER = "1";
        return {};
      },
      "env-no-update-notifier",
    ],
    [
      "CI detection",
      () => {
        process.env.GITHUB_ACTIONS = "true";
        return {};
      },
      "ci",
    ],
    [
      "a source checkout",
      () => {
        __testing.setInstalled(false);
        return {};
      },
      "source-install",
    ],
  ])("makes no network call and writes no cache when disabled by %s", async (_label, arrange, reason) => {
    const options = arrange();

    await __testing.runUpdateCheck(options);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(cacheExists()).toBe(false);
    expect(takePendingUpdateNotice()).toBeNull();
    const status = getUpdateStatus();
    expect(status.enabled).toBe(false);
    expect(status.state).toBe("disabled");
    expect(status.skipReason).toBe(reason);
  });

  it("refuses a non-HTTPS registry override without calling out", async () => {
    process.env.SPE_NPM_REGISTRY = "http://registry.npmjs.org";

    await __testing.runUpdateCheck({});

    expect(fetchMock).not.toHaveBeenCalled();
    expect(cacheExists()).toBe(false);
    expect(getUpdateStatus().skipReason).toBe("invalid-registry");
  });

  it("honors a valid HTTPS registry override", async () => {
    process.env.SPE_NPM_REGISTRY = "https://registry.contoso.example/npm/";
    respondWith(packument(tagsFixture()));

    await __testing.runUpdateCheck({});

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url.startsWith("https://registry.contoso.example/npm/")).toBe(true);
    expect(readCacheFile()["registry"]).toBe("https://registry.contoso.example/npm");
  });

  it("re-probes when the registry changes even inside the TTL", async () => {
    respondWith(packument(tagsFixture()));
    await __testing.runUpdateCheck({});
    expect(fetchMock).toHaveBeenCalledTimes(1);

    __testing.reset();
    __testing.setInstalled(true);
    process.env.SPE_NPM_REGISTRY = "https://registry.contoso.example";
    respondWith(packument(tagsFixture()));
    await __testing.runUpdateCheck({});

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("never throws even when the cache directory is unusable", async () => {
    respondWith(packument(tagsFixture()));
    // Point the data dir at a path whose parent is a file: every write fails.
    const blocker = join(dataDir, "blocker");
    writeFileSync(blocker, "not a directory", "utf8");
    setDataDirOverride(join(blocker, "nested"));

    await expect(__testing.runUpdateCheck({})).resolves.toBeUndefined();
    expect(getUpdateStatus().state).toBe("update-available");
  });
});

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

describe("startUpdateCheck", () => {
  it("returns immediately and completes in the background", async () => {
    respondWith(packument(tagsFixture()));

    const returned = startUpdateCheck({ enabled: true });
    expect(returned).toBeUndefined();
    // Not yet observable: the caller was never blocked.
    expect(getUpdateStatus().state).toBe("pending");

    await __testing.settle();
    expect(getUpdateStatus().state).toBe("update-available");
  });

  it("defaults to enabled when no options are passed", async () => {
    respondWith(packument(tagsFixture()));
    startUpdateCheck();
    await __testing.settle();
    expect(getUpdateStatus().enabled).toBe(true);
  });

  it("swallows a synchronous fetch explosion", async () => {
    fetchMock.mockImplementation(() => {
      throw new Error("boom");
    });
    startUpdateCheck({ enabled: true });
    await expect(__testing.settle()).resolves.toBeUndefined();
    expect(getUpdateStatus().state).toBe("unavailable");
  });

  it("reports a disabled check without ever reaching the network", async () => {
    startUpdateCheck({ enabled: false });
    await __testing.settle();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(getUpdateStatus()).toMatchObject({
      enabled: false,
      state: "disabled",
      skipReason: "cli-flag",
      currentVersion: PACKAGE_VERSION,
    });
  });
});

describe("getUpdateStatus", () => {
  it("starts pending with the running version and no leaked internals", () => {
    const status = getUpdateStatus();
    expect(status).toMatchObject({ enabled: true, state: "pending", currentVersion: PACKAGE_VERSION });
    expect(status.latestVersion).toBeUndefined();
    expect(status.updateAvailable).toBeUndefined();
  });

  it("exposes an ISO timestamp once a check completes", async () => {
    respondWith(packument(tagsFixture()));
    await __testing.runUpdateCheck({});
    const status = getUpdateStatus();
    expect(status.lastCheckedAt).toBeDefined();
    expect(new Date(status.lastCheckedAt as string).toISOString()).toBe(status.lastCheckedAt);
  });
});

// ---------------------------------------------------------------------------
// Privacy review deltas
//
// The privacy pre-review for this feature is NOT signed off. These tests pin
// the commitments the implementation makes so a later change cannot quietly
// widen what is disclosed to the third-party npm registry.
// ---------------------------------------------------------------------------

/** The `init` object handed to `fetch` on the single request. */
function requestInit(): RequestInit {
  expect(fetchMock).toHaveBeenCalledTimes(1);
  return fetchMock.mock.calls[0]![1] as RequestInit;
}

/** The request headers, lower-cased, as a plain object. */
function requestHeaders(): Record<string, string> {
  const raw = (requestInit().headers ?? {}) as Record<string, string>;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) out[key.toLowerCase()] = value;
  return out;
}

describe("privacy: request shape", () => {
  it("issues exactly one GET to the exact package path with no query or fragment", async () => {
    respondWith(packument(tagsFixture()));
    await __testing.runUpdateCheck({});

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toBe(`${DEFAULT_REGISTRY}/${PACKAGE_NAME.replace("/", "%2f")}`);
    expect(url).toBe("https://registry.npmjs.org/@microsoft%2fspe-mcp");

    const parsed = new URL(url);
    expect(parsed.protocol).toBe("https:");
    expect(parsed.search).toBe("");
    expect(parsed.hash).toBe("");
    expect(parsed.username).toBe("");
    expect(parsed.password).toBe("");
    expect(requestInit().method).toBe("GET");
  });

  it("sends only accept and the static product User-Agent", async () => {
    respondWith(packument(tagsFixture()));
    await __testing.runUpdateCheck({});

    const headers = requestHeaders();
    expect(Object.keys(headers).sort()).toEqual(["accept", "user-agent"]);
    expect(headers.accept).toBe("application/vnd.npm.install-v1+json");
    expect(headers["user-agent"]).toBe(`spe-mcp-server/${PACKAGE_VERSION}`);
  });

  it("sends no credential, cookie, or identifying header", async () => {
    respondWith(packument(tagsFixture()));
    await __testing.runUpdateCheck({});

    const headers = requestHeaders();
    for (const banned of [
      "authorization",
      "cookie",
      "proxy-authorization",
      "x-api-key",
      "x-ms-client-request-id",
      "x-correlation-id",
      "client-request-id",
      "x-anchormailbox",
    ]) {
      expect(headers[banned]).toBeUndefined();
    }
    expect(requestInit().credentials).toBe("omit");
    expect(requestInit().body).toBeUndefined();
  });

  it("carries no account, tenant, machine, session, or install identifier anywhere", async () => {
    respondWith(packument(tagsFixture()));
    await __testing.runUpdateCheck({});

    const serialized = JSON.stringify({
      url: fetchMock.mock.calls[0]![0],
      init: requestInit(),
      headers: requestHeaders(),
      cache: readCacheFile(),
    });
    // No GUID-shaped value may appear in anything we send or persist.
    expect(serialized).not.toMatch(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
    );
    for (const banned of [
      "tenant",
      "objectId",
      "upn",
      "userId",
      "machineId",
      "installId",
      "sessionId",
      "deviceId",
      "hostname",
      "correlation",
    ]) {
      expect(serialized.toLowerCase()).not.toContain(banned.toLowerCase());
    }
  });

  it("refuses to follow redirects", async () => {
    respondWith(packument(tagsFixture()));
    await __testing.runUpdateCheck({});
    expect(requestInit().redirect).toBe("error");
  });

  it("rejects a response that was redirected or served by another host", async () => {
    // A runtime that followed a hop anyway must still be rejected.
    const redirected = new Response(packument(tagsFixture()), { status: 200 });
    Object.defineProperty(redirected, "redirected", { value: true });
    fetchMock.mockResolvedValue(redirected);
    await __testing.runUpdateCheck({});
    expect(getUpdateStatus().state).toBe("unavailable");

    // A same-status response served from a foreign origin must be rejected too.
    __testing.reset();
    __testing.setInstalled(true);
    rmSync(getUpdateCacheFile(), { force: true });
    const foreign = new Response(packument(tagsFixture()), { status: 200 });
    Object.defineProperty(foreign, "url", { value: "https://evil.example/@microsoft%2fspe-mcp" });
    fetchMock.mockResolvedValue(foreign);
    await __testing.runUpdateCheck({});
    expect(getUpdateStatus().state).toBe("unavailable");
  });
});

describe("privacy: zero-network opt-outs", () => {
  it.each([
    ["SPE_MCP_UPDATE_CHECK", "false", "env-spe-mcp-update-check"],
    ["SPE_MCP_UPDATE_CHECK", "0", "env-spe-mcp-update-check"],
    ["SPE_MCP_UPDATE_CHECK", "off", "env-spe-mcp-update-check"],
    ["SPE_NO_UPDATE_CHECK", "1", "env-spe-no-update-check"],
    ["NO_UPDATE_NOTIFIER", "1", "env-no-update-notifier"],
    ["SPE_MCP_COLLECT_TELEMETRY", "false", "env-telemetry-disabled"],
    ["SPE_MCP_COLLECT_TELEMETRY", "0", "env-telemetry-disabled"],
    ["CI", "1", "ci"],
  ])("%s=%s suppresses the check entirely (%s)", async (name, value, reason) => {
    process.env[name] = value;
    expect(__testing.resolveSkipReason({})).toBe(reason);

    await __testing.runUpdateCheck({});
    expect(fetchMock).not.toHaveBeenCalled();
    expect(cacheExists()).toBe(false);
    expect(takePendingUpdateNotice()).toBeNull();
    expect(__testing.collectionNoticeEmitted()).toBe(false);
    expect(getUpdateStatus()).toMatchObject({ enabled: false, state: "disabled", skipReason: reason });
  });

  it("treats SPE_MCP_UPDATE_CHECK=true as leaving the check enabled", () => {
    process.env.SPE_MCP_UPDATE_CHECK = "true";
    expect(__testing.resolveSkipReason({})).toBeNull();
  });

  it("prefers the CLI flag over every environment control", () => {
    process.env.SPE_MCP_UPDATE_CHECK = "false";
    process.env.SPE_MCP_COLLECT_TELEMETRY = "false";
    expect(__testing.resolveSkipReason({ enabled: false })).toBe("cli-flag");
  });

  it("ranks the preferred public control above the back-compat alias", () => {
    process.env.SPE_MCP_UPDATE_CHECK = "false";
    process.env.SPE_NO_UPDATE_CHECK = "1";
    expect(__testing.resolveSkipReason({})).toBe("env-spe-mcp-update-check");
  });

  it.each([["1"], ["true"], ["yes"], [""], ["  "]])(
    "does not treat SPE_MCP_UPDATE_CHECK=%s as an opt-out",
    (value) => {
      process.env.SPE_MCP_UPDATE_CHECK = value;
      expect(__testing.envFlagDisabled("SPE_MCP_UPDATE_CHECK")).toBe(false);
    },
  );
});

describe("privacy: first-run collection notice", () => {
  let stderr: ReturnType<typeof vi.spyOn>;
  let events: string[];

  beforeEach(() => {
    events = [];
    stderr = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      if (String(args[0]).includes(COLLECTION_NOTICE)) events.push("notice");
    });
    fetchMock.mockImplementation(() => {
      events.push("fetch");
      return Promise.resolve(new Response(packument(tagsFixture()), { status: 200 }));
    });
  });

  afterEach(() => {
    stderr.mockRestore();
  });

  it("names the endpoint, the boundary, the retention, and the opt-out", () => {
    expect(COLLECTION_NOTICE).toContain("npm registry");
    expect(COLLECTION_NOTICE).toContain("OUTSIDE the Microsoft 365 / Azure");
    expect(COLLECTION_NOTICE).toContain("IP address");
    expect(COLLECTION_NOTICE).toContain("User-Agent");
    expect(COLLECTION_NOTICE).toContain("cached locally until you delete it");
    expect(COLLECTION_NOTICE).toContain("Nothing is downloaded, installed, or updated automatically");
    expect(COLLECTION_NOTICE).toContain("--no-update-check");
    expect(COLLECTION_NOTICE).toContain("SPE_MCP_UPDATE_CHECK=false");
  });

  it("emits on stderr strictly before the first request", async () => {
    await __testing.runUpdateCheck({});
    expect(events).toEqual(["notice", "fetch"]);
    expect(__testing.collectionNoticeEmitted()).toBe(true);
  });

  it("emits at most once per process", async () => {
    await __testing.runUpdateCheck({});
    rmSync(getUpdateCacheFile(), { force: true });
    await __testing.runUpdateCheck({});
    expect(events.filter((e) => e === "notice")).toHaveLength(1);
    expect(events.filter((e) => e === "fetch")).toHaveLength(2);
  });

  it("never emits when the check is opted out", async () => {
    process.env.SPE_MCP_UPDATE_CHECK = "false";
    await __testing.runUpdateCheck({});
    expect(events).toEqual([]);
    expect(__testing.collectionNoticeEmitted()).toBe(false);
  });

  it("never emits when a fresh cache answers without a request", async () => {
    __testing.writeCache({
      version: 1,
      checkedAt: Date.now(),
      currentVersion: PACKAGE_VERSION,
      registry: DEFAULT_REGISTRY,
      outcome: "success",
      notifiedFor: [],
    });
    await __testing.runUpdateCheck({});
    expect(events).toEqual([]);
    expect(__testing.collectionNoticeEmitted()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// B4: the disclosure must name the registry that is actually contacted.
// ---------------------------------------------------------------------------

describe("privacy: collection notice names the configured registry", () => {
  let stderr: ReturnType<typeof vi.spyOn>;
  let lines: string[];

  beforeEach(() => {
    lines = [];
    stderr = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    });
    respondWith(packument(tagsFixture()));
  });

  afterEach(() => {
    stderr.mockRestore();
  });

  it("names the default public registry when no override is set", async () => {
    await __testing.runUpdateCheck({});
    const notice = lines.find((l) => l.includes("OUTSIDE the Microsoft 365 / Azure"));
    expect(notice).toBeDefined();
    expect(notice).toContain(DEFAULT_REGISTRY);
  });

  it("names the override host, not the default, when SPE_NPM_REGISTRY is set", async () => {
    process.env.SPE_NPM_REGISTRY = "https://npm.contoso.example";
    await __testing.runUpdateCheck({});
    const notice = lines.find((l) => l.includes("OUTSIDE the Microsoft 365 / Azure"));
    expect(notice).toBeDefined();
    expect(notice).toContain("https://npm.contoso.example");
    // Telling the user we contacted npmjs.org when we did not would be a
    // false disclosure.
    expect(notice).not.toContain(DEFAULT_REGISTRY);
  });

  it("only ever renders a registry that already passed validation", () => {
    // collectionNotice() prints its argument verbatim, so the sanitisation
    // guarantee lives in resolveRegistry(): anything it accepts is an https
    // origin with no credentials, query, or fragment.
    for (const hostile of [
      "http://npm.example",
      "https://user:pw@npm.example",
      "https://npm.example/?x=1",
      "https://npm.example/#f",
      `https://npm.example/${"a".repeat(600)}`,
    ]) {
      process.env.SPE_NPM_REGISTRY = hostile;
      expect(__testing.resolveRegistry()).toBeNull();
    }
  });

  it("keeps the exported default disclosure in sync with the builder", () => {
    expect(COLLECTION_NOTICE).toBe(collectionNotice(DEFAULT_REGISTRY));
    expect(COLLECTION_NOTICE).toContain(DEFAULT_REGISTRY);
  });

  it("states the request is unauthenticated and carries no user identifier", () => {
    // B4: "anonymous" overstates the guarantee — an IP address is still
    // observable. Say precisely what is and is not sent.
    expect(COLLECTION_NOTICE).toContain("unauthenticated");
    expect(COLLECTION_NOTICE).toContain("no user");
    expect(COLLECTION_NOTICE).not.toContain("anonymous");
  });
});

describe("privacy: cache retention and deletion", () => {
  it("removes the cache file, mirroring logout", async () => {
    respondWith(packument(tagsFixture()));
    await __testing.runUpdateCheck({});
    expect(cacheExists()).toBe(true);

    removeUpdateCache();
    expect(cacheExists()).toBe(false);
  });

  it("is a safe no-op when no cache exists and never throws", () => {
    expect(cacheExists()).toBe(false);
    expect(() => {
      removeUpdateCache();
      removeUpdateCache();
    }).not.toThrow();
  });

  // Deleting the cache is a privacy promise: after logout there must be no
  // residue, and delivering a notice that was already in flight must not quietly
  // recreate the file the user just asked to be removed.
  it("does not recreate the cache when a pending notice is delivered after deletion", async () => {
    respondWith(packument(tagsFixture()));
    await __testing.runUpdateCheck({});
    expect(cacheExists()).toBe(true);

    removeUpdateCache();
    expect(cacheExists()).toBe(false);

    const notice = takePendingUpdateNotice();
    expect(notice, "a notice was pending before the deletion").not.toBeNull();
    expect(cacheExists(), "delivery must not resurrect a deleted cache").toBe(false);
  });

  // The CLI is where the deletion is actually triggered. Spawning `logout` would
  // touch real credential state, so assert the wiring statically instead: both
  // credential-clearing paths must call the cache removal.
  it("is wired into both CLI credential-clearing paths", () => {
    const cli = readFileSync(new URL("./cli.ts", import.meta.url), "utf8");
    const calls = cli.match(/removeUpdateCache\(\)/g) ?? [];
    expect(calls.length, "logout and auth --reset must both clear the cache").toBeGreaterThanOrEqual(
      2,
    );
    expect(cli).toMatch(/removeUpdateCache/);
  });

  it("persists no identifier and only the fields the feature needs", async () => {
    respondWith(packument(tagsFixture()));
    await __testing.runUpdateCheck({});

    expect(Object.keys(readCacheFile()).sort()).toEqual(
      expect.arrayContaining(["checkedAt", "currentVersion", "outcome", "registry", "version"]),
    );
    for (const key of Object.keys(readCacheFile())) {
      expect(key.toLowerCase()).not.toContain("id");
      expect(key.toLowerCase()).not.toContain("user");
      expect(key.toLowerCase()).not.toContain("tenant");
    }
  });
});

describe("privacy: status_get reporting is offline", () => {
  it("reports the cache location and opt-out without any network call", () => {
    const status = getUpdateStatus();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(status.cacheFile).toBe(getUpdateCacheFile());
    expect(status.registry).toBe(DEFAULT_REGISTRY);
    expect(status.currentVersion).toBe(PACKAGE_VERSION);
  });

  it("surfaces the locally cached result in a fresh process", async () => {
    respondWith(packument(tagsFixture()));
    await __testing.runUpdateCheck({});
    __testing.reset(); // simulate a restart: in-memory state gone, cache on disk

    const status = getUpdateStatus();
    expect(fetchMock).toHaveBeenCalledTimes(1); // still only the original check
    expect(status.latestVersion).toBe(EXPECTED_LATEST);
    expect(status.lastCheckedAt).toBeDefined();
    expect(status.cacheFile).toBe(getUpdateCacheFile());
  });

  it("still reports when opted out, without reading the network", () => {
    process.env.SPE_MCP_UPDATE_CHECK = "false";
    startUpdateCheck({});
    const status = getUpdateStatus();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(status).toMatchObject({ enabled: false, state: "disabled" });
    expect(status.cacheFile).toBe(getUpdateCacheFile());
  });

  it("tolerates a missing or corrupt cache file", () => {
    writeFileSync(getUpdateCacheFile(), "{not json", "utf8");
    expect(() => getUpdateStatus()).not.toThrow();
    expect(getUpdateStatus().latestVersion).toBeUndefined();

    rmSync(getUpdateCacheFile(), { force: true });
    expect(getUpdateStatus().cacheFile).toBe(getUpdateCacheFile());
  });
});

// ---------------------------------------------------------------------------
// Code review follow-ups: the notice is only "spent" once a caller has actually
// received it, one probe per process, and hostile cache content stays inert.
// ---------------------------------------------------------------------------

describe("notice delivery is what marks a version as notified", () => {
  it("does not record the target while the notice is still pending", async () => {
    respondWith(packument(tagsFixture()));
    await __testing.runUpdateCheck({});

    // The probe found something, but nobody has been told yet.
    expect(getUpdateStatus().state).toBe("update-available");
    expect(readCacheFile()["notifiedFor"]).toEqual([]);
  });

  it("records the target only when the notice is handed to a caller", async () => {
    respondWith(packument(tagsFixture()));
    await __testing.runUpdateCheck({});
    expect(readCacheFile()["notifiedFor"]).toEqual([]);

    expect(takePendingUpdateNotice()).not.toBeNull();
    expect(readCacheFile()["notifiedFor"]).toEqual([EXPECTED_LATEST]);
  });

  it("survives a process exit before the notice was delivered", async () => {
    respondWith(packument(tagsFixture()));
    await __testing.runUpdateCheck({});
    // Server exits here: no tool call ever consumed the notice.

    __testing.reset();
    __testing.setInstalled(true);
    await __testing.runUpdateCheck({}); // fresh cache, no network

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const notice = takePendingUpdateNotice();
    expect(notice?.updateAvailable.latest).toBe(EXPECTED_LATEST);
    expect(readCacheFile()["notifiedFor"]).toEqual([EXPECTED_LATEST]);
  });

  it("keeps replaying the notice until one restart actually delivers it", async () => {
    respondWith(packument(tagsFixture()));
    for (let attempt = 0; attempt < 3; attempt += 1) {
      __testing.reset();
      __testing.setInstalled(true);
      await __testing.runUpdateCheck({});
      expect(readCacheFile()["notifiedFor"]).toEqual([]);
    }

    expect(takePendingUpdateNotice()).not.toBeNull();
    expect(readCacheFile()["notifiedFor"]).toEqual([EXPECTED_LATEST]);
  });

  it("merges with the cache written by another process before delivery", async () => {
    respondWith(packument(tagsFixture()));
    await __testing.runUpdateCheck({});

    // Another server instance notified about a different build meanwhile.
    const concurrent = { ...readCacheFile(), notifiedFor: ["7.7.7"] };
    writeFileSync(getUpdateCacheFile(), JSON.stringify(concurrent), "utf8");

    expect(takePendingUpdateNotice()).not.toBeNull();
    expect(readCacheFile()["notifiedFor"]).toEqual(["7.7.7", EXPECTED_LATEST]);
  });

  it("does not recreate a cache that logout deleted", async () => {
    respondWith(packument(tagsFixture()));
    await __testing.runUpdateCheck({});

    removeUpdateCache();
    expect(cacheExists()).toBe(false);

    // The pending notice is still delivered, but no file comes back.
    expect(takePendingUpdateNotice()).not.toBeNull();
    expect(cacheExists()).toBe(false);
  });

  it("never writes on delivery when there is nothing to deliver", async () => {
    respondWith(packument({ latest: PACKAGE_VERSION, ...(CHANNEL ? { [CHANNEL]: PACKAGE_VERSION } : {}) }));
    await __testing.runUpdateCheck({});

    const before = readFileSync(getUpdateCacheFile(), "utf8");
    expect(takePendingUpdateNotice()).toBeNull();
    expect(readFileSync(getUpdateCacheFile(), "utf8")).toBe(before);
  });
});

describe("startUpdateCheck runs at most one probe per process", () => {
  it("ignores a second call while the first is still in flight", async () => {
    respondWith(packument(tagsFixture()));

    startUpdateCheck({});
    startUpdateCheck({});
    startUpdateCheck({});
    await __testing.settle();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("ignores a second call after the first has completed", async () => {
    respondWith(packument(tagsFixture()));
    startUpdateCheck({});
    await __testing.settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    startUpdateCheck({});
    await __testing.settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("hostile cache content stays inert", () => {
  const hostile = {
    version: 1,
    checkedAt: Date.now(),
    currentVersion: PACKAGE_VERSION,
    registry: DEFAULT_REGISTRY,
    outcome: "success" as const,
    latest: NEWER_STABLE,
    channelVersion: NEWER_CHANNEL ?? NEWER_STABLE,
    notifiedFor: [] as string[],
  };

  it("ignores a prototype-polluting channel tag from the cache file", async () => {
    writeFileSync(
      getUpdateCacheFile(),
      JSON.stringify({ ...hostile, channelTag: "__proto__" }),
      "utf8",
    );

    await __testing.runUpdateCheck({});

    expect(fetchMock).not.toHaveBeenCalled();
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
    expect(Object.prototype).not.toHaveProperty("latest");
    // Falls back to the stable tag rather than trusting the hostile name.
    expect(getUpdateStatus().latestVersion).toBe(NEWER_STABLE);
  });

  it("ignores an over-long or non-string channel tag from the cache file", async () => {
    writeFileSync(
      getUpdateCacheFile(),
      JSON.stringify({ ...hostile, channelTag: "a".repeat(500) }),
      "utf8",
    );
    await __testing.runUpdateCheck({});
    expect(getUpdateStatus().latestVersion).toBe(NEWER_STABLE);

    __testing.reset();
    __testing.setInstalled(true);
    writeFileSync(getUpdateCacheFile(), JSON.stringify({ ...hostile, channelTag: 42 }), "utf8");
    await __testing.runUpdateCheck({});
    expect(getUpdateStatus().latestVersion).toBe(NEWER_STABLE);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("getUpdateStatus stays cheap and quiet", () => {
  it("omits the registry and any cached version when disabled", async () => {
    process.env.SPE_MCP_UPDATE_CHECK = "false";
    writeFileSync(
      getUpdateCacheFile(),
      JSON.stringify({
        version: 1,
        checkedAt: Date.now(),
        currentVersion: PACKAGE_VERSION,
        registry: DEFAULT_REGISTRY,
        outcome: "success",
        latest: NEWER_STABLE,
        notifiedFor: [],
      }),
      "utf8",
    );
    await __testing.runUpdateCheck({});

    const status = getUpdateStatus();

    expect(status.enabled).toBe(false);
    expect(status.state).toBe("disabled");
    expect(status.registry).toBeUndefined();
    expect(status.latestVersion).toBeUndefined();
    expect(status.lastCheckedAt).toBeUndefined();
    expect(status.cacheFile).toBe(getUpdateCacheFile());
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("serves an in-memory result without re-reading the cache file", async () => {
    respondWith(packument(tagsFixture()));
    await __testing.runUpdateCheck({});

    // Corrupting the file must not disturb an already-resolved status.
    writeFileSync(getUpdateCacheFile(), "{not json", "utf8");

    const status = getUpdateStatus();
    expect(status.state).toBe("update-available");
    expect(status.latestVersion).toBe(EXPECTED_LATEST);
    expect(status.registry).toBe(DEFAULT_REGISTRY);
  });
});
