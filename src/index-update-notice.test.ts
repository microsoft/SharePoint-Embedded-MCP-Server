// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Tests for how a pending update notice is attached to a tool result (SEC-008).
 *
 * The notice must ride along on exactly one successful result without ever
 * blocking on the network, and the machine-readable twin must survive even when
 * the tool itself produced no structured content — a client that only reads
 * `structuredContent` would otherwise never learn about the update.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { __testing as serverTesting } from "./index.js";
import { __testing as updateTesting } from "./update-check.js";
import { setDataDirOverride, __testing as pathsTesting } from "./paths.js";
import { PACKAGE_NAME, PACKAGE_VERSION } from "./version.js";

const LATEST = "99.0.0";

function packument(): string {
  return JSON.stringify({ name: PACKAGE_NAME, "dist-tags": { latest: LATEST } });
}

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

/** Arrange a resolved "update available" state without touching the network. */
async function primeNotice(): Promise<void> {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(new Response(packument(), { status: 200 })),
  );
  await updateTesting.runUpdateCheck({});
}

const TEXT = [{ type: "text" as const, text: "tool output" }];

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  dataDir = mkdtempSync(join(tmpdir(), "spe-mcp-notice-"));
  setDataDirOverride(dataDir);
  updateTesting.reset();
  updateTesting.setInstalled(true);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  updateTesting.reset();
  pathsTesting.reset();
  rmSync(dataDir, { recursive: true, force: true });
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("withUpdateNotice", () => {
  it("creates a structured twin when the tool returned none", async () => {
    await primeNotice();

    const result = serverTesting.withUpdateNotice(TEXT, undefined);

    expect(result.content).toHaveLength(2);
    expect(result.content[1]?.text).toContain(LATEST);
    expect(result.structuredContent).toMatchObject({
      updateAvailable: { latest: LATEST, current: PACKAGE_VERSION },
    });
  });

  it("creates a structured twin when the tool returned a non-object", async () => {
    await primeNotice();

    const result = serverTesting.withUpdateNotice(TEXT, [1, 2, 3]);

    expect(result.structuredContent).toMatchObject({ updateAvailable: { latest: LATEST } });
  });

  it("merges into structured content the tool already produced", async () => {
    await primeNotice();

    const result = serverTesting.withUpdateNotice(TEXT, { data: { ok: true }, durationMs: 5 });

    expect(result.structuredContent).toMatchObject({
      data: { ok: true },
      durationMs: 5,
      updateAvailable: { latest: LATEST },
    });
  });

  it("passes the result through untouched when nothing is pending", () => {
    const structured = { data: { ok: true } };

    const result = serverTesting.withUpdateNotice(TEXT, structured);

    expect(result.content).toEqual(TEXT);
    expect(result.structuredContent).toBe(structured);
  });

  it("appends the notice to only one result", async () => {
    await primeNotice();

    const first = serverTesting.withUpdateNotice(TEXT, undefined);
    const second = serverTesting.withUpdateNotice(TEXT, undefined);

    expect(first.content).toHaveLength(2);
    expect(second.content).toEqual(TEXT);
    expect(second.structuredContent).toBeUndefined();
  });
});
