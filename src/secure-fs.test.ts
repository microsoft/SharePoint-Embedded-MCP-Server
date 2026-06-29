// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, statSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir, platform } from "node:os";
import { join } from "node:path";
import { ensureSecureDir, writeSecureFile } from "./secure-fs.js";

const isPosix = platform() !== "win32";

describe("secure-fs (SEC-003)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "spe-mcp-securefs-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates a directory and writes a file (cross-platform)", () => {
    const sub = join(dir, "nested", "cache");
    ensureSecureDir(sub);
    expect(existsSync(sub)).toBe(true);

    const file = join(sub, "token-cache.json");
    writeSecureFile(file, '{"secret":"x"}');
    expect(existsSync(file)).toBe(true);
  });

  it.runIf(isPosix)("writes the file with owner-only (0o600) permissions", () => {
    const file = join(dir, "token-cache.json");
    writeSecureFile(file, "data");
    const mode = statSync(file).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it.runIf(isPosix)("creates the directory with owner-only (0o700) permissions", () => {
    const sub = join(dir, "secure-dir");
    ensureSecureDir(sub);
    const mode = statSync(sub).mode & 0o777;
    expect(mode).toBe(0o700);
  });

  it.runIf(isPosix)("repairs permissions on a pre-existing world-readable file", () => {
    const file = join(dir, "legacy-cache.json");
    writeFileSync(file, "old", { mode: 0o644 });
    expect((statSync(file).mode & 0o777)).toBe(0o644);

    writeSecureFile(file, "new");
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });
});
