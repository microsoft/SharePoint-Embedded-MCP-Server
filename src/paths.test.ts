// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, normalize } from "node:path";
import {
  resolveDataDir,
  setDataDirOverride,
  getDataDir,
  getStateFile,
  getCacheDir,
  getCacheFile,
  getLegacyCacheFile,
  sanitizeForFilename,
  __testing,
} from "./paths.js";

const DEFAULT = normalize(join(homedir(), ".spe-mcp"));

describe("paths — data directory resolution", () => {
  const savedEnv = process.env.SPE_DATA_DIR;

  beforeEach(() => {
    // Each test starts from a clean slate: no memoized dir, no env override.
    __testing.reset();
    delete process.env.SPE_DATA_DIR;
  });

  afterEach(() => {
    __testing.reset();
    if (savedEnv === undefined) delete process.env.SPE_DATA_DIR;
    else process.env.SPE_DATA_DIR = savedEnv;
  });

  it("defaults to ~/.spe-mcp (byte-identical to the legacy hardcoded path)", () => {
    expect(getDataDir()).toBe(DEFAULT);
    expect(getStateFile()).toBe(join(DEFAULT, "state.json"));
    expect(getCacheDir()).toBe(DEFAULT);
  });

  it("resolveDataDir(undefined/empty/whitespace) returns the default", () => {
    expect(resolveDataDir()).toBe(DEFAULT);
    expect(resolveDataDir("")).toBe(DEFAULT);
    expect(resolveDataDir("   ")).toBe(DEFAULT);
  });

  it("honors an explicit override (flag) via setDataDirOverride", () => {
    const dir = mkdtempSync(join(tmpdir(), "spe-mcp-paths-A-"));
    try {
      const resolved = setDataDirOverride(dir);
      expect(resolved).toBe(normalize(dir));
      expect(getDataDir()).toBe(normalize(dir));
      expect(getStateFile()).toBe(join(normalize(dir), "state.json"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("honors SPE_DATA_DIR env when no explicit override is set", () => {
    const dir = mkdtempSync(join(tmpdir(), "spe-mcp-paths-E-"));
    try {
      process.env.SPE_DATA_DIR = dir;
      expect(getDataDir()).toBe(normalize(dir));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("gives the explicit override precedence over the env var (flag > env)", () => {
    const envDir = mkdtempSync(join(tmpdir(), "spe-mcp-paths-env-"));
    const flagDir = mkdtempSync(join(tmpdir(), "spe-mcp-paths-flag-"));
    try {
      process.env.SPE_DATA_DIR = envDir;
      // Mirror the CLI's `options.dataDir || process.env.SPE_DATA_DIR`.
      setDataDirOverride(flagDir || process.env.SPE_DATA_DIR);
      expect(getDataDir()).toBe(normalize(flagDir));
    } finally {
      rmSync(envDir, { recursive: true, force: true });
      rmSync(flagDir, { recursive: true, force: true });
    }
  });

  it("expands a leading ~ against the home directory", () => {
    expect(resolveDataDir("~")).toBe(normalize(homedir()));
    expect(resolveDataDir("~/spe-alt")).toBe(normalize(join(homedir(), "spe-alt")));
  });

  it("rejects a CWD-relative path so secrets never land in the working directory", () => {
    expect(() => resolveDataDir("relative/dir")).toThrow(/absolute/i);
    expect(() => resolveDataDir("./foo")).toThrow(/absolute/i);
    expect(() => resolveDataDir("../foo")).toThrow(/absolute/i);
  });

  it("re-resolves lazily after a later override (no import-time freeze)", () => {
    const a = mkdtempSync(join(tmpdir(), "spe-mcp-paths-lazy-a-"));
    const b = mkdtempSync(join(tmpdir(), "spe-mcp-paths-lazy-b-"));
    try {
      setDataDirOverride(a);
      expect(getDataDir()).toBe(normalize(a));
      // A subsequent override wins and getters re-resolve to it.
      setDataDirOverride(b);
      expect(getDataDir()).toBe(normalize(b));
    } finally {
      rmSync(a, { recursive: true, force: true });
      rmSync(b, { recursive: true, force: true });
    }
  });

  it("partitions the token cache by tenant and client within the data dir", () => {
    const dir = mkdtempSync(join(tmpdir(), "spe-mcp-paths-cache-"));
    try {
      setDataDirOverride(dir);
      const a = getCacheFile("tenant-A", "client-1");
      const b = getCacheFile("tenant-B", "client-1");
      const c = getCacheFile("tenant-A", "client-2");
      expect(a).not.toBe(b);
      expect(a).not.toBe(c);
      expect(a).toContain("tenant-A");
      expect(a.startsWith(normalize(dir))).toBe(true);
      expect(getLegacyCacheFile()).toBe(join(normalize(dir), "token-cache.json"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sanitizeForFilename replaces path-unsafe characters (keeps [A-Za-z0-9._-])", () => {
    expect(sanitizeForFilename("abc-123_DEF.xyz")).toBe("abc-123_DEF.xyz");
    expect(sanitizeForFilename("a/b\\c:d*e")).toBe("a_b_c_d_e");
    // A traversal-looking value cannot introduce separators into the filename.
    expect(sanitizeForFilename("../../etc/passwd")).toBe(".._.._etc_passwd");
  });
});
