// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, normalize } from "node:path";
import { readState, writeState, clearState } from "./state.js";
import { setDataDirOverride, getStateFile, __testing } from "./paths.js";

describe("state — per-instance isolation via the data-dir seam", () => {
  const savedEnv = process.env.SPE_DATA_DIR;
  let dirA: string;
  let dirB: string;

  beforeEach(() => {
    __testing.reset();
    delete process.env.SPE_DATA_DIR;
    dirA = mkdtempSync(join(tmpdir(), "spe-mcp-state-A-"));
    dirB = mkdtempSync(join(tmpdir(), "spe-mcp-state-B-"));
  });

  afterEach(() => {
    __testing.reset();
    if (savedEnv === undefined) delete process.env.SPE_DATA_DIR;
    else process.env.SPE_DATA_DIR = savedEnv;
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  });

  it("writes state under the resolved data dir, not ~/.spe-mcp", () => {
    setDataDirOverride(dirA);
    writeState({ tenantId: "tenant-A" });
    expect(getStateFile()).toBe(join(normalize(dirA), "state.json"));
    expect(readState().tenantId).toBe("tenant-A");
  });

  it("keeps two instances isolated: writing dir B leaves dir A byte-identical", () => {
    // Instance A writes its state.
    setDataDirOverride(dirA);
    writeState({ tenantId: "tenant-A", appId: "app-A" });
    const stateFileA = getStateFile();
    const bytesA = readFileSync(stateFileA);

    // Instance B (different data dir) writes DIFFERENT state.
    __testing.reset();
    setDataDirOverride(dirB);
    writeState({ tenantId: "tenant-B", appId: "app-B" });

    // A's file is unchanged — no cross-instance clobber.
    const bytesA2 = readFileSync(stateFileA);
    expect(bytesA2.equals(bytesA)).toBe(true);

    // And each dir reflects only its own writes.
    __testing.reset();
    setDataDirOverride(dirA);
    expect(readState().tenantId).toBe("tenant-A");
    __testing.reset();
    setDataDirOverride(dirB);
    expect(readState().tenantId).toBe("tenant-B");
  });

  it("clearState removes only the resolving instance's state file", () => {
    setDataDirOverride(dirA);
    writeState({ tenantId: "tenant-A" });
    __testing.reset();
    setDataDirOverride(dirB);
    writeState({ tenantId: "tenant-B" });

    // Clear A; B must survive.
    __testing.reset();
    setDataDirOverride(dirA);
    clearState();
    expect(readState()).toEqual({});

    __testing.reset();
    setDataDirOverride(dirB);
    expect(readState().tenantId).toBe("tenant-B");
  });

  it("golden default: with no override, state resolves to ~/.spe-mcp/state.json", () => {
    // No setDataDirOverride, no env — the default path is byte-identical to the
    // pre-feature hardcoded location.
    expect(getStateFile()).toBe(join(normalize(join(homedir(), ".spe-mcp")), "state.json"));
  });
});
