// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Spawned JSON-RPC regression for update-notice *delivery* (AB#3219517, SEC-008).
 *
 * The in-process suites prove the notice logic; this suite proves the property
 * that only a real process boundary can show: the single announcement of a newer
 * version survives a server that probes and then exits before any tool call.
 *
 * Shape of the run (three sequential servers, one shared data directory):
 *   1. connect, then close without calling a tool  => nothing is burned
 *   2. restart, call a tool                        => exactly one notice
 *   3. restart, call a tool                        => silence forever after
 *
 * Hermetic by construction:
 *  - the update cache is pre-seeded as a *fresh success*, so the server reuses it
 *    and performs no network request at all (registry.npmjs.org is never touched);
 *  - `SPE_DATA_DIR`, `HOME`, and `USERPROFILE` point at throwaway directories;
 *  - every CI marker and every opt-out variable is stripped from the child env, so
 *    the check actually runs (in CI it would otherwise be skipped);
 *  - only `content_access_grant` is called: a read-only, no-network, side-effect
 *    free tool whose unconfirmed result is a plain success.
 *
 * The server is spawned from a copy of `dist/` placed *under* `node_modules/`,
 * because the check deliberately runs only for registry installs
 * (`isInstalledFromRegistry()`); a checkout is skipped as `source-install`. The
 * copy carries a sibling `package.json` so the runtime version lookup resolves.
 */

import { execSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { parseSemver, releaseChannel } from "./semver.js";
import { ensureSecureDir, writeSecureFile } from "./secure-fs.js";
import { DEFAULT_REGISTRY } from "./update-check.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const CLI_ENTRY = join(REPO_ROOT, "dist", "cli.js");

/** Copy of the built server placed under `node_modules/` so it looks installed. */
const FIXTURE_DIR = join(REPO_ROOT, "node_modules", ".spe-update-e2e-fixture");
const FIXTURE_CLI = join(FIXTURE_DIR, "dist", "cli.js");

const CALL_TIMEOUT_MS = 8000;

/** Every marker the check treats as "running in CI" — all must be absent. */
const CI_ENV_VARS = ["CI", "CONTINUOUS_INTEGRATION", "GITHUB_ACTIONS", "TF_BUILD", "BUILD_BUILDID"];

/** Every documented kill switch — all must be absent for the check to run. */
const OPT_OUT_ENV_VARS = [
  "SPE_MCP_UPDATE_CHECK",
  "SPE_NO_UPDATE_CHECK",
  "NO_UPDATE_NOTIFIER",
  "SPE_MCP_COLLECT_TELEMETRY",
  "SPE_NPM_REGISTRY",
];

const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
  name: string;
  version: string;
};

// Derive the seed from the *actual* running version so the suite keeps working
// across releases (stable builds have no channel tag; prereleases do).
const parsedCurrent = parseSemver(pkg.version);
const CHANNEL_TAG = parsedCurrent ? releaseChannel(parsedCurrent) : null;
const SEED_LATEST = "999.0.0";
const SEED_CHANNEL_VERSION = CHANNEL_TAG ? `999.0.0-${CHANNEL_TAG}.1` : undefined;
/** Channel-first, exactly as a live check would resolve it. */
const EXPECTED_LATEST = SEED_CHANNEL_VERSION ?? SEED_LATEST;

let isolatedHome = "";
let dataDir = "";

function cacheFile(): string {
  return join(dataDir, "update-check.json");
}

/** Write a fresh, successful cache entry => the server reuses it, no network. */
function seedCache(notifiedFor: string[] = []): void {
  ensureSecureDir(dataDir);
  writeSecureFile(
    cacheFile(),
    JSON.stringify(
      {
        version: 1,
        checkedAt: Date.now(),
        currentVersion: pkg.version,
        registry: DEFAULT_REGISTRY,
        outcome: "success",
        latest: SEED_LATEST,
        ...(CHANNEL_TAG ? { channelTag: CHANNEL_TAG, channelVersion: SEED_CHANNEL_VERSION } : {}),
        notifiedFor,
      },
      null,
      2,
    ),
  );
}

function readCacheFile(): { notifiedFor?: unknown } | null {
  if (!existsSync(cacheFile())) return null;
  return JSON.parse(readFileSync(cacheFile(), "utf8")) as { notifiedFor?: unknown };
}

function childEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string") env[k] = v;
  }
  for (const key of [
    ...CI_ENV_VARS,
    ...OPT_OUT_ENV_VARS,
    "SPE_CLIENT_ID",
    "SPE_TENANT_ID",
    "SPE_READ_ONLY",
    "SPE_TOOLS",
  ]) {
    delete env[key];
  }
  env.HOME = isolatedHome;
  env.USERPROFILE = isolatedHome;
  env.SPE_DATA_DIR = dataDir;
  return env;
}

async function startServer(): Promise<{ client: Client; transport: StdioClientTransport }> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [FIXTURE_CLI, "start"],
    env: childEnv(),
    cwd: REPO_ROOT,
    stderr: "ignore",
  });
  const client = new Client({ name: "spe-mcp-update-e2e", version: "0.0.0" }, {});
  await client.connect(transport);
  // The check is fire-and-forget; give the detached promise a moment to settle
  // so the first tool call is guaranteed to see the pending notice.
  await new Promise((r) => setTimeout(r, 400));
  return { client, transport };
}

async function stopServer(client?: Client, transport?: StdioClientTransport): Promise<void> {
  try {
    await client?.close();
  } catch {
    /* ignore */
  }
  try {
    await transport?.close();
  } catch {
    /* ignore */
  }
}

/** Call the safe, no-network tool and return its text + structured payload. */
async function callSafeTool(
  client: Client,
): Promise<{ text: string; structured: Record<string, unknown> | undefined }> {
  const res = await client.callTool({ name: "content_access_grant", arguments: {} }, undefined, {
    timeout: CALL_TIMEOUT_MS,
  });
  expect(res.isError, "content_access_grant should return a plain success").not.toBe(true);
  const text = (res.content as Array<{ type: string; text: string }>).map((c) => c.text).join("\n");
  return { text, structured: res.structuredContent as Record<string, unknown> | undefined };
}

describe("update notice delivery over spawned JSON-RPC (AB#3219517)", () => {
  beforeAll(() => {
    if (!existsSync(CLI_ENTRY)) {
      execSync("npm run build", { cwd: REPO_ROOT, stdio: "ignore" });
    }

    // A copy under node_modules/ makes `isInstalledFromRegistry()` true without
    // any production-code test hook. The sibling package.json is what the runtime
    // version lookup reads.
    rmSync(FIXTURE_DIR, { recursive: true, force: true });
    cpSync(join(REPO_ROOT, "dist"), join(FIXTURE_DIR, "dist"), { recursive: true });
    cpSync(join(REPO_ROOT, "package.json"), join(FIXTURE_DIR, "package.json"));

    isolatedHome = mkdtempSync(join(tmpdir(), "spe-mcp-update-home-"));
    dataDir = mkdtempSync(join(tmpdir(), "spe-mcp-update-data-"));
  }, 120000);

  afterAll(() => {
    for (const dir of [FIXTURE_DIR, isolatedHome, dataDir]) {
      try {
        if (dir) rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  // (1) F1 regression: probing is not delivering. A server that exits before any
  //     tool call must not record the target as announced, or the user would
  //     never see the only notice they were ever going to get.
  it("does not burn the notice when the server exits before any tool call", async () => {
    seedCache([]);

    const { client, transport } = await startServer();
    await stopServer(client, transport);

    const cache = readCacheFile();
    expect(cache, "cache should survive the run").not.toBeNull();
    expect(cache?.notifiedFor, "probe-time persistence would have written the target here").toEqual(
      [],
    );
  }, 60000);

  // (2) The restarted server still owes the user a notice, and pays it exactly
  //     once — on the first *successful* tool result.
  it("delivers exactly one notice on the first successful tool result after a restart", async () => {
    const { client, transport } = await startServer();
    try {
      const first = await callSafeTool(client);
      expect(first.text, "first successful result should carry the notice").toMatch(
        /Update available:/i,
      );
      expect(first.text).toContain(EXPECTED_LATEST);
      expect(first.text).toContain(pkg.version);
      // F8: the structured twin is created even though this tool returns none.
      const update = first.structured?.["updateAvailable"] as Record<string, unknown> | undefined;
      expect(update, "structuredContent.updateAvailable should be created").toBeDefined();
      expect(update?.["latest"]).toBe(EXPECTED_LATEST);
      expect(update?.["current"]).toBe(pkg.version);

      const second = await callSafeTool(client);
      expect(second.text, "the notice must not repeat within a session").not.toMatch(
        /Update available:/i,
      );
      expect(second.structured?.["updateAvailable"]).toBeUndefined();
    } finally {
      await stopServer(client, transport);
    }

    const cache = readCacheFile();
    expect(
      cache?.notifiedFor,
      "delivery should persist the announced target for future processes",
    ).toEqual([EXPECTED_LATEST]);
  }, 60000);

  // (3) Cross-process suppression: once delivered, never again for that target.
  it("does not repeat the notice after a subsequent restart", async () => {
    const { client, transport } = await startServer();
    try {
      const result = await callSafeTool(client);
      expect(result.text, "a delivered target must stay suppressed across restarts").not.toMatch(
        /Update available:/i,
      );
      expect(result.structured?.["updateAvailable"]).toBeUndefined();
    } finally {
      await stopServer(client, transport);
    }

    expect(readCacheFile()?.notifiedFor, "suppression list should not grow").toEqual([
      EXPECTED_LATEST,
    ]);
  }, 60000);
});
