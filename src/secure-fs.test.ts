// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  existsSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, platform } from "node:os";
import { join } from "node:path";
import { ensureSecureDir, writeSecureFile, readSecureFile } from "./secure-fs.js";

// POSIX permission bits under test, named for readability (see secure-fs.ts).
//   0o700 = rwx------ (owner-only, directories)   0o600 = rw------- (owner-only, files)
const OWNER_RWX = 0o700;
const OWNER_RW = 0o600;
// Mask that keeps only the 9 low permission bits (rwxrwxrwx), stripping the
// file-type / setuid bits from statSync().mode so we can compare perms directly.
const PERMISSION_MASK = 0o777;

// POSIX mode bits are only enforced off-Windows. On Windows these assertions
// are skipped (ACL governs instead); the cross-platform tests below still run.
const isPosix = platform() !== "win32";

describe("secure-fs (SEC-003 owner-only credential/state files)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "spe-mcp-securefs-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // Runs on every platform: verifies the happy path works and, importantly,
  // does not throw on Windows where chmod/POSIX modes are no-ops.
  it("creates a directory and writes a file without throwing (cross-platform)", () => {
    const sub = join(dir, "nested", "cache");
    expect(() => ensureSecureDir(sub)).not.toThrow();
    expect(existsSync(sub)).toBe(true);

    const file = join(sub, "token-cache.json");
    expect(() => writeSecureFile(file, '{"secret":"x"}')).not.toThrow();
    expect(existsSync(file)).toBe(true);
  });

  // Re-writing an existing file must also succeed on every platform (on POSIX
  // this exercises the chmod-repair branch; on Windows it must simply not throw).
  it("overwrites an existing file without throwing (cross-platform)", () => {
    const file = join(dir, "token-cache.json");
    writeSecureFile(file, "first");
    expect(() => writeSecureFile(file, "second")).not.toThrow();
    expect(existsSync(file)).toBe(true);
  });

  it.runIf(isPosix)("writes the file with owner-only (0o600) permissions", () => {
    const file = join(dir, "token-cache.json");
    writeSecureFile(file, "data");
    const mode = statSync(file).mode & PERMISSION_MASK;
    expect(mode).toBe(OWNER_RW);
  });

  it.runIf(isPosix)("creates the directory with owner-only (0o700) permissions", () => {
    const sub = join(dir, "secure-dir");
    ensureSecureDir(sub);
    const mode = statSync(sub).mode & PERMISSION_MASK;
    expect(mode).toBe(OWNER_RWX);
  });

  it.runIf(isPosix)("repairs permissions on a pre-existing world-readable file", () => {
    const file = join(dir, "legacy-cache.json");
    writeFileSync(file, "old", { mode: 0o644 }); // rw-r--r-- (world-readable)
    expect(statSync(file).mode & PERMISSION_MASK).toBe(0o644);

    writeSecureFile(file, "new");
    expect(statSync(file).mode & PERMISSION_MASK).toBe(OWNER_RW);
  });
});

describe("secure-fs — fail-closed hardening (symlink / TOCTOU / perms)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "spe-mcp-securefs-h-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("readSecureFile returns null for a missing file and round-trips content (cross-platform)", () => {
    const file = join(dir, "cache.json");
    expect(readSecureFile(file)).toBeNull();
    writeSecureFile(file, "hello");
    expect(readSecureFile(file)).toBe("hello");
  });

  it.runIf(isPosix)("writeSecureFile refuses to follow a symlinked target (O_NOFOLLOW)", () => {
    const real = join(dir, "outside.json");
    writeFileSync(real, "original", { mode: 0o600 });
    const link = join(dir, "link.json");
    symlinkSync(real, link);
    expect(() => writeSecureFile(link, "attacker")).toThrow();
    // The real file must NOT have been overwritten through the symlink.
    expect(readFileSync(real, "utf-8")).toBe("original");
  });

  it.runIf(isPosix)("readSecureFile refuses to follow a symlinked cache file", () => {
    const real = join(dir, "secret.json");
    writeFileSync(real, "secret", { mode: 0o600 });
    const link = join(dir, "cache-link.json");
    symlinkSync(real, link);
    expect(() => readSecureFile(link)).toThrow();
  });

  it.runIf(isPosix)("ensureSecureDir refuses a symlinked directory", () => {
    const realDir = join(dir, "real");
    mkdirSync(realDir, { mode: 0o700 });
    const linkDir = join(dir, "link");
    symlinkSync(realDir, linkDir);
    expect(() => ensureSecureDir(linkDir)).toThrow();
  });

  it.runIf(isPosix)("ensureSecureDir repairs a group/other-accessible directory to 0o700", () => {
    const sub = join(dir, "loose");
    mkdirSync(sub, { mode: 0o755 });
    ensureSecureDir(sub); // owner can repair -> must not throw
    expect(statSync(sub).mode & PERMISSION_MASK).toBe(0o700);
  });
});
