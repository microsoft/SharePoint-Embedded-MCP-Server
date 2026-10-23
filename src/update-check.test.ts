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
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  COLLECTION_NOTICE,
  collectionNotice,
  DEFAULT_REGISTRY,
  CHECK_TTL_MS,
  FAILURE_BACKOFF_MS,
  MAX_RESPONSE_BYTES,
  REFRESH_LOCK_STALE_MS,
  REQUEST_TIMEOUT_MS,
  __testing,
  getUpdateStatus,
  removeUpdateCache,
  startUpdateCheck,
  takePendingUpdateNotice,
} from "./update-check.js";
import { parseSemver, releaseChannel } from "./semver.js";
import {
  USER_AGENT,
  resolveInstallAttribution,
  setAgentHostAttribution,
  setInstallAttribution,
  __testing as userAgentTesting,
} from "./user-agent.js";
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
const EXPECTED_NOTIFICATION_KEYS = [
  ...(CHANNEL && NEWER_CHANNEL ? [`channel:${CHANNEL}:${NEWER_CHANNEL}`] : []),
  `stable:${NEWER_STABLE}`,
];

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
  userAgentTesting.reset();
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

function mockExitedProcess(pid: number): void {
  vi.spyOn(process, "kill").mockImplementation(
    ((candidate: number) => {
      if (candidate === pid) {
        throw Object.assign(new Error("no such process"), { code: "ESRCH" });
      }
      return true;
    }) as typeof process.kill,
  );
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
    ["empty dist-tags", '{"dist-tags":{}}'],
    ["prototype-only dist-tags", '{"dist-tags":{"__proto__":"9.9.9"}}'],
    ["entirely invalid dist-tags", '{"dist-tags":{"latest":"not-semver","next":42}}'],
  ])("rejects %s", (_label, raw) => {
    expect(__testing.extractDistTags(raw)).toBeNull();
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

  it("retains the complete suppression history for the cache lifetime", () => {
    const notifiedFor = Array.from({ length: 20 }, (_, index) => `stable:${index + 1}.0.0`);
    expect(__testing.writeCache({ ...base, notifiedFor })).toBe(true);

    expect(__testing.readCache()?.notifiedFor).toEqual(notifiedFor);
    expect(readCacheFile()["notifiedFor"]).toEqual(notifiedFor);
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
  it("renders the concise notice with versions, channel, manual action, and opt-out", () => {
    const text = __testing.renderNotice({
      package: PACKAGE_NAME,
      current: "1.0.0-alpha.1",
      latest: "1.0.0-alpha.2",
      target: "channel",
      channel: "alpha",
      packageSpec: `${PACKAGE_NAME}@alpha`,
    });
    expect(text).toBe(
      `Update available: ${PACKAGE_NAME} 1.0.0-alpha.1 -> 1.0.0-alpha.2 (alpha channel).\n` +
        "Note: This is just a notice. If you choose to update, update the MCP server manually. " +
        "No command should run automatically.\n" +
        "Silence with --no-update-check.",
    );
    expect(text).not.toContain(`${PACKAGE_NAME}@alpha`);
    expect(text).not.toContain("Stable release also available");
  });

  it("remains agent-safe without installation or environment-specific commands", () => {
    const text = __testing.renderNotice({
      package: PACKAGE_NAME,
      current: "1.0.0-alpha.1",
      latest: "1.0.0-alpha.2",
      target: "channel",
      channel: "alpha",
      packageSpec: `${PACKAGE_NAME}@alpha`,
    });
    expect(text).toContain("just a notice");
    expect(text).toContain("update the MCP server manually");
    expect(text).toContain("No command should run automatically");
    expect(text).not.toMatch(/\b(?:npm|npx|pnpm|yarn)\b/i);
    expect(text).not.toMatch(/\b(?:install|reinstall)\b/i);
  });

  it("calls out a separate stable target when one exists", () => {
    const text = __testing.renderNotice({
      package: PACKAGE_NAME,
      current: "1.0.0-alpha.1",
      latest: "1.0.0-alpha.2",
      target: "channel",
      channel: "alpha",
      stable: "2.0.0",
      packageSpec: `${PACKAGE_NAME}@alpha`,
      stablePackageSpec: `${PACKAGE_NAME}@latest`,
    });
    expect(text).toContain(`Stable release also available: ${PACKAGE_NAME} 2.0.0.`);
    expect(text).not.toContain(`${PACKAGE_NAME}@latest`);
  });

  it("labels a stable target and omits the optional stable-release line", () => {
    const text = __testing.renderNotice({
      package: PACKAGE_NAME,
      current: "1.0.0",
      latest: "1.1.0",
      target: "stable",
      channel: null,
      packageSpec: `${PACKAGE_NAME}@latest`,
    });
    expect(text).toContain(`Update available: ${PACKAGE_NAME} 1.0.0 -> 1.1.0.`);
    expect(text).not.toContain("(stable channel)");
    expect(text).not.toContain("Stable release also available");
    expect(text).not.toContain(`${PACKAGE_NAME}@latest`);
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

    expect(readCacheFile()["notifiedFor"]).toEqual([
      ...EXPECTED_NOTIFICATION_KEYS,
    ]);
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

  it("does not send install-source or agent-host attribution to the npm registry", async () => {
    setInstallAttribution(
      resolveInstallAttribution({
        source: "github-readme",
        content: "readme-install",
        campaign: "docs-install-buttons",
      }),
    );
    setAgentHostAttribution("vscode");
    respondWith(packument(tagsFixture()));

    await __testing.runUpdateCheck({});

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["User-Agent"]).toBe(USER_AGENT);
    expect(headers["User-Agent"]).not.toContain("spe-install-");
    expect(headers["User-Agent"]).not.toContain("spe-agent-host/");
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

  it.runIf(CHANNEL === "alpha")(
    "announces GA when alpha is unchanged after an earlier alpha notice",
    async () => {
      const newerAlpha = NEWER_CHANNEL!;
      const ga = NEWER_STABLE;

      respondWith(packument({ alpha: newerAlpha }));
      await __testing.runUpdateCheck({});
      const alphaNotice = takePendingUpdateNotice();
      expect(alphaNotice?.updateAvailable).toMatchObject({
        latest: newerAlpha,
        target: "channel",
        channel: "alpha",
      });
      expect(readCacheFile()["notifiedFor"]).toEqual([`channel:alpha:${newerAlpha}`]);

      // Restart after the TTL. The alpha target is unchanged, but `latest` has
      // advanced to GA. Stable suppression must be independent from alpha.
      __testing.reset();
      __testing.setInstalled(true);
      const stale = readCacheFile();
      writeFileSync(
        getUpdateCacheFile(),
        JSON.stringify({ ...stale, checkedAt: Date.now() - CHECK_TTL_MS }),
        "utf8",
      );
      respondWith(packument({ alpha: newerAlpha, latest: ga }));

      await __testing.runUpdateCheck({});
      const gaNotice = takePendingUpdateNotice();
      expect(gaNotice?.updateAvailable).toMatchObject({
        latest: ga,
        target: "stable",
        channel: "alpha",
      });
      expect(gaNotice?.updateAvailable.stable).toBeUndefined();
      expect(gaNotice?.text).toContain(`${PACKAGE_VERSION} -> ${ga}`);
      expect(gaNotice?.text).not.toContain(newerAlpha);
      expect(gaNotice?.text).not.toContain("(alpha channel)");
      expect(readCacheFile()["notifiedFor"]).toEqual([
        `channel:alpha:${newerAlpha}`,
        `stable:${ga}`,
      ]);
    },
  );

  it.runIf(CHANNEL === "alpha")(
    "coalesces equal alpha and latest GA targets in favor of stable",
    async () => {
      const ga = `${CURRENT.major + 1}.0.0`;
      respondWith(packument({ alpha: ga, latest: ga }));

      await __testing.runUpdateCheck({});

      expect(getUpdateStatus().updateAvailable).toMatchObject({
        latest: ga,
        target: "stable",
        channel: "alpha",
        packageSpec: `${PACKAGE_NAME}@latest`,
      });
      expect(getUpdateStatus().updateAvailable?.stable).toBeUndefined();

      const notice = takePendingUpdateNotice();
      expect(notice?.updateAvailable).toMatchObject({
        latest: ga,
        target: "stable",
        packageSpec: `${PACKAGE_NAME}@latest`,
      });
      expect(notice?.text).not.toContain("(alpha channel)");
      expect(notice?.text).toContain(
        `Update available: ${PACKAGE_NAME} ${PACKAGE_VERSION} -> ${ga}.`,
      );
      expect(notice?.text).not.toContain("(stable channel)");
      expect(notice?.text).not.toContain(`${PACKAGE_NAME}@latest`);
      expect(readCacheFile()["notifiedFor"]).toEqual([`stable:${ga}`]);
    },
  );

  it("never labels a prerelease value from the latest tag as stable", async () => {
    const prereleaseLatest = `${CURRENT.major + 2}.0.0-rc.1`;
    respondWith(
      packument({
        latest: prereleaseLatest,
        ...(CHANNEL && NEWER_CHANNEL ? { [CHANNEL]: NEWER_CHANNEL } : {}),
      }),
    );

    await __testing.runUpdateCheck({});

    const status = getUpdateStatus();
    expect(status.updateAvailable?.stable).toBeUndefined();
    expect(status.updateAvailable?.stablePackageSpec).toBeUndefined();
    expect(takePendingUpdateNotice()?.text).not.toContain("Latest stable release");
    if (!CHANNEL) expect(status.state).toBe("up-to-date");
  });

  it("does not expose a cached prerelease latest tag as a stable fallback", () => {
    writeFileSync(
      getUpdateCacheFile(),
      JSON.stringify({
        version: 1,
        checkedAt: Date.now(),
        currentVersion: PACKAGE_VERSION,
        registry: DEFAULT_REGISTRY,
        outcome: "success",
        latest: `${CURRENT.major + 2}.0.0-rc.1`,
        notifiedFor: [],
      }),
      "utf8",
    );

    expect(getUpdateStatus().latestVersion).toBeUndefined();
  });

  it("reports up-to-date when the registry offers nothing newer", async () => {
    respondWith(packument({ latest: PACKAGE_VERSION, ...(CHANNEL ? { [CHANNEL]: PACKAGE_VERSION } : {}) }));

    await __testing.runUpdateCheck({});

    expect(getUpdateStatus().state).toBe("up-to-date");
    expect(takePendingUpdateNotice()).toBeNull();
    expect(readCacheFile()["outcome"]).toBe("success");
  });

  it("accepts mixed valid and invalid tags after filtering", async () => {
    respondWith(
      JSON.stringify({
        "dist-tags": {
          latest: PACKAGE_VERSION,
          malformed: "not-a-version",
          nested: { version: "9.9.9" },
          __proto__: "9.9.9",
        },
      }),
    );

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

  it("reserves the 24-hour request window before egress and blocks a concurrent process", async () => {
    let finishFetch: ((response: Response) => void) | undefined;
    fetchMock.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          finishFetch = resolve;
        }),
    );

    const first = __testing.runUpdateCheck({});
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    // The failure reservation exists before fetch resolves. A second module
    // instance/process sharing this data directory sees it as fresh and does
    // not issue another request.
    expect(readCacheFile()).toMatchObject({
      outcome: "failure",
      currentVersion: PACKAGE_VERSION,
      registry: DEFAULT_REGISTRY,
    });
    await __testing.runUpdateCheck({});
    expect(fetchMock).toHaveBeenCalledTimes(1);

    finishFetch?.(new Response(packument(tagsFixture()), { status: 200 }));
    await first;
    expect(readCacheFile()["outcome"]).toBe("success");
    expect(__testing.listRefreshLocks()).toEqual([]);
  });

  it("fails closed without egress while another process holds an active refresh lock", async () => {
    const lock = `${__testing.getRefreshLockPrefix()}active`;
    writeFileSync(
      lock,
      JSON.stringify({
        pid: process.pid,
        createdAt: Date.now(),
        id: "active",
        state: "ready",
        ticket: 1,
      }),
      "utf8",
    );
    respondWith(packument(tagsFixture()));

    await __testing.runUpdateCheck({});

    expect(fetchMock).not.toHaveBeenCalled();
    expect(cacheExists()).toBe(false);
    expect(getUpdateStatus().state).toBe("unavailable");
    expect(existsSync(lock)).toBe(true);
  });

  it("reclaims an abandoned stale refresh lock and completes one request", async () => {
    const lock = `${__testing.getRefreshLockPrefix()}stale`;
    const createdAt = Date.now() - REFRESH_LOCK_STALE_MS - 1_000;
    const deadPid = 999_999_991;
    mockExitedProcess(deadPid);
    writeFileSync(
      lock,
      JSON.stringify({
        pid: deadPid,
        createdAt,
        id: "stale",
        state: "ready",
        ticket: 1,
      }),
      "utf8",
    );
    const staleTime = new Date(createdAt);
    utimesSync(lock, staleTime, staleTime);
    respondWith(packument(tagsFixture()));

    await __testing.runUpdateCheck({});

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(readCacheFile()["outcome"]).toBe("success");
    expect(existsSync(lock)).toBe(false);
  });

  it("fails closed on stale malformed lock metadata", async () => {
    const lock = `${__testing.getRefreshLockPrefix()}malformed`;
    writeFileSync(lock, "partially-written", "utf8");
    const staleTime = new Date(Date.now() - REFRESH_LOCK_STALE_MS - 1_000);
    utimesSync(lock, staleTime, staleTime);
    respondWith(packument(tagsFixture()));

    await __testing.runUpdateCheck({});

    expect(fetchMock).not.toHaveBeenCalled();
    expect(getUpdateStatus().state).toBe("unavailable");
    expect(existsSync(lock)).toBe(true);
  });

  it("never replaces an old lock while its recorded process is still alive", async () => {
    const lock = `${__testing.getRefreshLockPrefix()}alive`;
    writeFileSync(
      lock,
      JSON.stringify({
        pid: process.pid,
        createdAt: Date.now() - REFRESH_LOCK_STALE_MS - 1_000,
        id: "alive",
        state: "ready",
        ticket: 1,
      }),
      "utf8",
    );
    const staleTime = new Date(Date.now() - REFRESH_LOCK_STALE_MS - 1_000);
    utimesSync(lock, staleTime, staleTime);
    respondWith(packument(tagsFixture()));

    await __testing.runUpdateCheck({});

    expect(fetchMock).not.toHaveBeenCalled();
    expect(getUpdateStatus().state).toBe("unavailable");
    expect(existsSync(lock)).toBe(true);
  });

  it("does not remove or bypass a non-file refresh lock entry", async () => {
    const lock = `${__testing.getRefreshLockPrefix()}directory`;
    mkdirSync(lock);
    respondWith(packument(tagsFixture()));

    await __testing.runUpdateCheck({});

    expect(fetchMock).not.toHaveBeenCalled();
    expect(getUpdateStatus().state).toBe("unavailable");
    expect(existsSync(lock)).toBe(true);
  });

  it("does not acquire or egress while another contender is choosing", async () => {
    const choosing = `${__testing.getRefreshLockPrefix()}choosing`;
    writeFileSync(
      choosing,
      JSON.stringify({
        pid: process.pid,
        createdAt: Date.now(),
        id: "choosing",
        state: "choosing",
      }),
      "utf8",
    );
    respondWith(packument(tagsFixture()));

    await __testing.runUpdateCheck({});

    expect(fetchMock).not.toHaveBeenCalled();
    expect(getUpdateStatus().state).toBe("unavailable");
    expect(existsSync(choosing)).toBe(true);
  });

  it("reclaims an abandoned unique contender before acquiring the refresh lock", () => {
    const abandoned = `${__testing.getRefreshLockPrefix()}abandoned`;
    const createdAt = Date.now() - REFRESH_LOCK_STALE_MS - 1_000;
    const deadPid = 999_999_992;
    mockExitedProcess(deadPid);
    writeFileSync(
      abandoned,
      JSON.stringify({
        pid: deadPid,
        createdAt,
        id: "abandoned",
        state: "ready",
        ticket: 1,
      }),
      "utf8",
    );
    const staleTime = new Date(createdAt);
    utimesSync(abandoned, staleTime, staleTime);

    const token = __testing.acquireRefreshLock(Date.now());

    expect(token).not.toBeNull();
    expect(existsSync(abandoned)).toBe(false);
    expect(__testing.listRefreshLocks()).toEqual([token]);
    __testing.releaseRefreshLock(token as string);
    expect(__testing.listRefreshLocks()).toEqual([]);
  });

  it("cleans an abandoned atomic-publication temp lock on the next acquisition", () => {
    const createdAt = Date.now() - REFRESH_LOCK_STALE_MS - 1_000;
    const deadPid = 999_999_993;
    mockExitedProcess(deadPid);
    const tempLock = `${__testing.getRefreshLockPrefix()}abandoned.tmp-fixture`;
    writeFileSync(tempLock, JSON.stringify({ pid: deadPid, createdAt }), "utf8");
    const staleTime = new Date(createdAt);
    utimesSync(tempLock, staleTime, staleTime);

    const token = __testing.acquireRefreshLock(Date.now());

    expect(token).not.toBeNull();
    expect(existsSync(tempLock)).toBe(false);
    __testing.releaseRefreshLock(token as string);
  });

  it("cleans an abandoned atomic cache temp on the next acquisition", () => {
    const tempCache = `${getUpdateCacheFile()}.tmp-abandoned`;
    writeFileSync(tempCache, '{"partial":true}', "utf8");
    const staleTime = new Date(Date.now() - REFRESH_LOCK_STALE_MS - 1_000);
    utimesSync(tempCache, staleTime, staleTime);

    const token = __testing.acquireRefreshLock(Date.now());

    expect(token).not.toBeNull();
    expect(existsSync(tempCache)).toBe(false);
    __testing.releaseRefreshLock(token as string);
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
    ["empty dist-tags", '{"dist-tags":{}}'],
    ["dist-tags full of junk", '{"dist-tags":{"latest":"not-a-version","next":{"a":1}}}'],
    ["prototype pollution attempts", '{"dist-tags":{"__proto__":"999.0.0"}}'],
  ])("treats %s as an unavailable registry response", async (_label, body) => {
    respondWith(body);
    await __testing.runUpdateCheck({});
    expect(getUpdateStatus().state).toBe("unavailable");
    expect(takePendingUpdateNotice()).toBeNull();
    expect(readCacheFile()["outcome"]).toBe("failure");
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

  it("fails closed without egress when the cache directory is unusable", async () => {
    respondWith(packument(tagsFixture()));
    // Point the data dir at a path whose parent is a file: every write fails.
    const blocker = join(dataDir, "blocker");
    writeFileSync(blocker, "not a directory", "utf8");
    setDataDirOverride(join(blocker, "nested"));

    await expect(__testing.runUpdateCheck({})).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(getUpdateStatus().state).toBe("unavailable");
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
    expect(COLLECTION_NOTICE).toContain("public npm registry");
    expect(COLLECTION_NOTICE).toContain("npm, Inc. / GitHub");
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

  it("describes an override neutrally without assigning its operator or boundary", async () => {
    process.env.SPE_NPM_REGISTRY = "https://npm.contoso.example";
    await __testing.runUpdateCheck({});
    const notice = lines.find((l) => l.includes("https://npm.contoso.example"));
    expect(notice).toBeDefined();
    expect(notice).toContain("https://npm.contoso.example");
    expect(notice).toContain("supplied through SPE_NPM_REGISTRY");
    expect(notice).toContain("operator and compliance boundary depend on your configuration");
    expect(notice).toContain("IP address");
    expect(notice).toContain("cached locally until you delete it");
    expect(notice).toContain("Nothing is downloaded, installed, or updated automatically");
    expect(notice).toContain("--no-update-check");
    // Telling the user we contacted npmjs.org when we did not would be a
    // false disclosure.
    expect(notice).not.toContain(DEFAULT_REGISTRY);
    expect(notice).not.toContain("npm, Inc.");
    expect(notice).not.toContain("third-party service");
    expect(notice).not.toContain("OUTSIDE the Microsoft 365 / Azure");
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

    await removeUpdateCache();
    expect(cacheExists()).toBe(false);
  });

  it("is a safe no-op when no cache exists and never throws", async () => {
    expect(cacheExists()).toBe(false);
    await expect(removeUpdateCache()).resolves.toBeUndefined();
    await expect(removeUpdateCache()).resolves.toBeUndefined();
  });

  it("writes a unique deletion generation for every cache removal", async () => {
    await removeUpdateCache();
    const first = readFileSync(__testing.getDeletionGenerationFile(), "utf8");

    await removeUpdateCache();
    const second = readFileSync(__testing.getDeletionGenerationFile(), "utf8");

    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(second).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(second).not.toBe(first);
  });

  it("blocks cache writers while a deletion marker is active", async () => {
    respondWith(packument(tagsFixture()));
    await __testing.runUpdateCheck({});
    const cache = __testing.readCache();
    expect(cache).not.toBeNull();

    const generation = __testing.readDeletionGeneration();
    const marker = `${__testing.getDeletionMarkerPrefix()}test`;
    writeFileSync(marker, "active", "utf8");
    rmSync(getUpdateCacheFile(), { force: true });

    expect(__testing.hasDeletionMarker()).toBe(true);
    expect(__testing.writeCacheForGeneration(cache!, generation)).toBe(false);
    expect(cacheExists()).toBe(false);
  });

  // Deleting the cached registry result is a privacy promise. A small local
  // deletion-generation tombstone may remain to prevent in-flight writers from
  // quietly recreating the result the user asked to remove.
  it("does not return or recreate a pending notice after cache deletion", async () => {
    respondWith(packument(tagsFixture()));
    await __testing.runUpdateCheck({});
    expect(cacheExists()).toBe(true);

    await removeUpdateCache();
    expect(cacheExists()).toBe(false);

    const notice = takePendingUpdateNotice();
    expect(notice, "an unclaimable notice must be dropped").toBeNull();
    expect(cacheExists(), "claiming must not resurrect a deleted cache").toBe(false);
  });

  it("does not recreate the cache when logout races an in-flight registry request", async () => {
    let finishFetch: ((response: Response) => void) | undefined;
    fetchMock.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          finishFetch = resolve;
        }),
    );

    const check = __testing.runUpdateCheck({});
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(cacheExists(), "pre-egress reservation should exist").toBe(true);

    const removal = removeUpdateCache();
    expect(cacheExists()).toBe(false);
    expect(existsSync(__testing.getDeletionGenerationFile())).toBe(true);

    finishFetch?.(new Response(packument(tagsFixture()), { status: 200 }));
    await Promise.all([check, removal]);

    expect(cacheExists(), "post-fetch write must not undo logout").toBe(false);
    expect(takePendingUpdateNotice()).toBeNull();
    expect(getUpdateStatus().state).toBe("unavailable");
  });

  it("does not adopt a logout generation that advances before lock acquisition", async () => {
    respondWith(packument({ latest: PACKAGE_VERSION }));
    await __testing.runUpdateCheck({});
    const stale = readCacheFile();
    writeFileSync(
      getUpdateCacheFile(),
      JSON.stringify({ ...stale, checkedAt: Date.now() - CHECK_TTL_MS }),
      "utf8",
    );
    __testing.reset();
    __testing.setInstalled(true);
    fetchMock.mockClear();

    // Force lock acquisition to observe a proven-dead contender. The liveness
    // probe runs after runUpdateCheck's initial cache read but before it owns
    // the refresh lock, giving logout a deterministic point to advance the
    // deletion generation and remove the cache.
    const deadPid = 999_999_990;
    const lock = `${__testing.getRefreshLockPrefix()}logout-race`;
    const createdAt = Date.now() - REFRESH_LOCK_STALE_MS - 1_000;
    writeFileSync(
      lock,
      JSON.stringify({
        pid: deadPid,
        createdAt,
        id: "logout-race",
        state: "ready",
        ticket: 1,
      }),
      "utf8",
    );
    const staleTime = new Date(createdAt);
    utimesSync(lock, staleTime, staleTime);
    let removal: Promise<void> | undefined;
    let logoutStarted = false;
    vi.spyOn(process, "kill").mockImplementation(
      ((candidate: number) => {
        if (candidate === deadPid) {
          if (!logoutStarted) {
            logoutStarted = true;
            removal = removeUpdateCache();
          }
          throw Object.assign(new Error("no such process"), { code: "ESRCH" });
        }
        return true;
      }) as typeof process.kill,
    );

    await __testing.runUpdateCheck({});
    await removal;

    expect(fetchMock).not.toHaveBeenCalled();
    expect(cacheExists(), "pre-lock logout must remain authoritative").toBe(false);
    expect(takePendingUpdateNotice()).toBeNull();
    expect(getUpdateStatus().state).toBe("unavailable");
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
// received it, refreshes are serialized across processes, and hostile cache
// content stays inert.
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
    expect(readCacheFile()["notifiedFor"]).toEqual(EXPECTED_NOTIFICATION_KEYS);
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
    expect(readCacheFile()["notifiedFor"]).toEqual(EXPECTED_NOTIFICATION_KEYS);
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
    expect(readCacheFile()["notifiedFor"]).toEqual(EXPECTED_NOTIFICATION_KEYS);
  });

  it("merges with the cache written by another process before delivery", async () => {
    respondWith(packument(tagsFixture()));
    await __testing.runUpdateCheck({});

    // Another server instance notified about a different build meanwhile.
    const concurrent = { ...readCacheFile(), notifiedFor: ["7.7.7"] };
    writeFileSync(getUpdateCacheFile(), JSON.stringify(concurrent), "utf8");

    expect(takePendingUpdateNotice()).not.toBeNull();
    expect(readCacheFile()["notifiedFor"]).toEqual(["7.7.7", ...EXPECTED_NOTIFICATION_KEYS]);
  });

  it("does not return or recreate a notice that logout made unclaimable", async () => {
    respondWith(packument(tagsFixture()));
    await __testing.runUpdateCheck({});

    await removeUpdateCache();
    expect(cacheExists()).toBe(false);

    // Returning it without a durable claim could duplicate it in another
    // process. Logout wins, so the pending notice is dropped.
    expect(takePendingUpdateNotice()).toBeNull();
    expect(cacheExists()).toBe(false);
  });

  it("retries a pending notice after a transient cache-read failure", async () => {
    respondWith(packument(tagsFixture()));
    await __testing.runUpdateCheck({});
    const saved = readCacheFile();

    rmSync(getUpdateCacheFile(), { force: true });
    mkdirSync(getUpdateCacheFile());
    expect(takePendingUpdateNotice()).toBeNull();

    rmSync(getUpdateCacheFile(), { recursive: true, force: true });
    expect(__testing.writeCache(saved as Parameters<typeof __testing.writeCache>[0])).toBe(true);
    expect(takePendingUpdateNotice()).not.toBeNull();
    expect(readCacheFile()["notifiedFor"]).toEqual(EXPECTED_NOTIFICATION_KEYS);
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
