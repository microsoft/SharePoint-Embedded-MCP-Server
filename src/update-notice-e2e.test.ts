// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Spawned JSON-RPC regression for update-notice *delivery* (AB#3219517, SEC-008).
 *
 * The in-process suites prove the notice logic; this suite proves the property
 * that only a real process boundary can show: the single announcement of a newer
 * version survives a server that probes and then exits before any tool call.
 *
 * Shape of the run (sequential and simultaneous servers, one shared data directory):
 *   1. connect, then close without calling a tool  => nothing is burned
 *   2. restart, call a tool                        => exactly one notice
 *   3. restart, call a tool                        => silence forever after
 *   4. two simultaneous first tool calls           => exactly one notice
 *   5. many stale-lock reclaimers                   => exactly one request
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

import { execSync, spawn } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { parseSemver, releaseChannel } from "./semver.js";
import { ensureSecureDir, writeSecureFile } from "./secure-fs.js";
import { DEFAULT_REGISTRY, REFRESH_LOCK_STALE_MS } from "./update-check.js";

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
const EXPECTED_NOTIFICATION_KEYS = [
  ...(CHANNEL_TAG && SEED_CHANNEL_VERSION
    ? [`channel:${CHANNEL_TAG}:${SEED_CHANNEL_VERSION}`]
    : []),
  `stable:${SEED_LATEST}`,
];

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

function readCacheFile(): { notifiedFor?: unknown; outcome?: unknown } | null {
  if (!existsSync(cacheFile())) return null;
  return JSON.parse(readFileSync(cacheFile(), "utf8")) as {
    notifiedFor?: unknown;
    outcome?: unknown;
  };
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

function runNodeChild(script: string): Promise<{ pid: number; stderr: string }> {
  return new Promise((resolveChild, rejectChild) => {
    const child = spawn(process.execPath, ["--input-type=module", "--eval", script], {
      cwd: REPO_ROOT,
      env: childEnv(),
      stdio: ["ignore", "ignore", "pipe"],
    });
    const pid = child.pid;
    if (pid === undefined) {
      rejectChild(new Error("spawned child did not receive a process ID"));
      return;
    }
    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", rejectChild);
    child.once("close", (code) => {
      if (code === 0) {
        resolveChild({ pid, stderr });
      } else {
        rejectChild(new Error(`spawned child ${pid} exited ${String(code)}: ${stderr}`));
      }
    });
  });
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
      if (CHANNEL_TAG) {
        expect(first.text).toContain(`(${CHANNEL_TAG} channel)`);
      } else {
        expect(first.text).not.toContain("(stable channel)");
      }
      expect(first.text).toContain("update the MCP server manually");
      expect(first.text).toContain("No command should run automatically");
      expect(first.text).toContain("Silence with --no-update-check.");
      expect(first.text).not.toMatch(/\b(?:npm|npx|pnpm|yarn)\b/i);
      // F8: the structured twin is created even though this tool returns none.
      const update = first.structured?.["updateAvailable"] as Record<string, unknown> | undefined;
      expect(update, "structuredContent.updateAvailable should be created").toBeDefined();
      expect(update?.["latest"]).toBe(EXPECTED_LATEST);
      expect(update?.["current"]).toBe(pkg.version);
      expect(update?.["target"]).toBe(CHANNEL_TAG ? "channel" : "stable");
      expect(update?.["packageSpec"]).toBe(
        `${pkg.name}@${CHANNEL_TAG ?? "latest"}`,
      );

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
    ).toEqual(EXPECTED_NOTIFICATION_KEYS);
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

    expect(readCacheFile()?.notifiedFor, "suppression list should not grow").toEqual(
      EXPECTED_NOTIFICATION_KEYS,
    );
  }, 60000);

  it("atomically delivers one notice across simultaneous server processes", async () => {
    seedCache([]);
    const servers = await Promise.all([startServer(), startServer()]);
    try {
      const results = await Promise.all(servers.map(({ client }) => callSafeTool(client)));
      expect(
        results.filter(({ text }) => /Update available:/i.test(text)),
        "only one process may claim and return the shared pending target",
      ).toHaveLength(1);
      expect(
        results.filter(({ structured }) => structured?.["updateAvailable"] !== undefined),
        "the structured notice must have the same single delivery",
      ).toHaveLength(1);
    } finally {
      await Promise.all(servers.map(({ client, transport }) => stopServer(client, transport)));
    }

    expect(readCacheFile()?.notifiedFor).toEqual(EXPECTED_NOTIFICATION_KEYS);
  }, 60000);

  it("allows only one request while processes race to recover a stale lock", async () => {
    rmSync(cacheFile(), { force: true });
    for (const name of readdirSync(dataDir)) {
      if (name.startsWith("request-")) rmSync(join(dataDir, name), { force: true });
    }

    // Use an actual exited child PID rather than guessing a nonexistent PID,
    // making the liveness proof portable across Windows, Linux, and macOS.
    const exited = await runNodeChild("");
    const staleCreatedAt = Date.now() - REFRESH_LOCK_STALE_MS - 1_000;
    const lockFile = `${cacheFile()}.lock-stale-fixture`;
    writeSecureFile(
      lockFile,
      JSON.stringify({
        pid: exited.pid,
        createdAt: staleCreatedAt,
        id: "stale-fixture",
        state: "ready",
        ticket: 1,
      }),
    );
    const staleDate = new Date(staleCreatedAt);
    utimesSync(lockFile, staleDate, staleDate);

    const moduleUrl = pathToFileURL(join(REPO_ROOT, "dist", "update-check.js")).href;
    const tags = {
      latest: SEED_LATEST,
      ...(CHANNEL_TAG && SEED_CHANNEL_VERSION
        ? { [CHANNEL_TAG]: SEED_CHANNEL_VERSION }
        : {}),
    };
    const worker = `
      const { existsSync, writeFileSync } = await import("node:fs");
      const { join } = await import("node:path");
      writeFileSync(join(process.env.SPE_DATA_DIR, \`ready-\${process.pid}\`), "1");
      while (!existsSync(join(process.env.SPE_DATA_DIR, "start-race"))) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      globalThis.fetch = async () => {
        writeFileSync(join(process.env.SPE_DATA_DIR, \`request-\${process.pid}\`), "1");
        await new Promise((resolve) => setTimeout(resolve, 350));
        return new Response(${JSON.stringify(JSON.stringify({ "dist-tags": tags }))}, {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      };
      const { __testing } = await import(${JSON.stringify(moduleUrl)});
      __testing.setInstalled(true);
      await __testing.runUpdateCheck({});
    `;

    const workers = Array.from({ length: 8 }, () => runNodeChild(worker));
    await vi.waitFor(
      () => {
        expect(
          readdirSync(dataDir).filter((name) => name.startsWith("ready-")),
          "every child must reach the barrier before stale recovery starts",
        ).toHaveLength(8);
      },
      { timeout: 10_000 },
    );
    writeSecureFile(join(dataDir, "start-race"), "go");
    await Promise.all(workers);

    expect(
      readdirSync(dataDir).filter((name) => name.startsWith("request-")),
      "stale recovery and the pre-egress reservation must admit one requester",
    ).toHaveLength(1);
    expect(readCacheFile(), "the winning process should publish a usable cache").toMatchObject({
      outcome: "success",
    });
    expect(
      readdirSync(dataDir).filter(
        (name) =>
          name.startsWith("update-check.json.lock-"),
      ),
      "no reclaimer may delete a successor lock or strand takeover artifacts",
    ).toEqual([]);
  }, 60000);
});
