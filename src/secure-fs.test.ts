// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { execFileSync } from "node:child_process";
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
import { homedir, tmpdir, platform } from "node:os";
import { join, resolve } from "node:path";
import { ensureSecureDir, writeSecureFile, readSecureFile } from "./secure-fs.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) };
});

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: vi.fn(actual.homedir) };
});

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

const CALLER_SID = "S-1-5-21-100-200-300-1001";
const OTHER_SID = "S-1-5-21-100-200-300-1002";

function windowsAcl(
  overrides: Partial<{
    callerSid: string;
    ownerSid: string;
    protected: boolean;
    rules: Array<{
      sid: string;
      type: "Allow" | "Deny";
      inherited: boolean;
      fullControl: boolean;
      containerInherit: boolean;
      objectInherit: boolean;
      propagation: string;
    }>;
  }> = {},
): string {
  return JSON.stringify({
    callerSid: CALLER_SID,
    ownerSid: CALLER_SID,
    protected: false,
    rules: [],
    ...overrides,
  });
}

function ownerFullControlRule() {
  return {
    sid: CALLER_SID,
    type: "Allow" as const,
    inherited: false,
    fullControl: true,
    containerInherit: true,
    objectInherit: true,
    propagation: "None",
  };
}

describe("secure-fs — Windows off-profile ACL refusal policy", () => {
  const mockedExecFileSync = vi.mocked(execFileSync);
  const mockedHomedir = vi.mocked(homedir);
  const defaultHomedir = homedir();
  let scope: string;
  let dir: string;
  let platformSpy: { mockRestore(): void };

  beforeEach(() => {
    scope = mkdtempSync(join(tmpdir(), "spe-mcp-securefs-win-unit-"));
    mockedHomedir.mockReturnValue(join(scope, "profile"));
    dir = join(scope, "off-profile");
    mkdirSync(dir);
    platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    mockedExecFileSync.mockReset();
    vi.resetModules();
  });

  afterEach(() => {
    platformSpy.mockRestore();
    mockedHomedir.mockReset();
    mockedHomedir.mockReturnValue(defaultHomedir);
    rmSync(scope, { recursive: true, force: true });
  });

  it("uses the caller SID, removes inheritance, and verifies the resulting owner-only ACL", async () => {
    mockedExecFileSync
      .mockImplementationOnce(() => windowsAcl())
      .mockImplementationOnce(() => Buffer.from(""))
      .mockImplementationOnce(() =>
        windowsAcl({ protected: true, rules: [ownerFullControlRule()] }),
      );
    const { ensureSecureDir: ensureWindowsSecureDir } = await import("./secure-fs.js");

    expect(() => ensureWindowsSecureDir(dir)).not.toThrow();
    expect(mockedExecFileSync).toHaveBeenCalledTimes(3);
    const inspectionArgs = mockedExecFileSync.mock.calls[0]?.[1];
    const encodedPath = Buffer.from(resolve(dir), "utf8").toString("base64");
    expect(inspectionArgs).toHaveLength(5);
    expect(inspectionArgs?.[3]).toBe("-Command");
    expect(inspectionArgs?.[4]).toContain(`FromBase64String('${encodedPath}')`);
    expect(inspectionArgs?.[4]).not.toContain(resolve(dir));
    expect(inspectionArgs?.[4]).not.toContain("$args[0]");
    expect(mockedExecFileSync.mock.calls[1]?.[1]).toEqual([
      resolve(dir),
      "/inheritance:r",
      "/grant:r",
      `*${CALLER_SID}:(OI)(CI)F`,
    ]);
  });

  it("refuses a foreign owner without changing the ACL", async () => {
    mockedExecFileSync.mockImplementationOnce(() => windowsAcl({ ownerSid: OTHER_SID }));
    const { ensureSecureDir: ensureWindowsSecureDir } = await import("./secure-fs.js");

    expect(() => ensureWindowsSecureDir(dir)).toThrow(/owned by another Windows principal/);
    expect(mockedExecFileSync).toHaveBeenCalledTimes(1);
  });

  it("refuses an explicit allow ACE for another principal without changing the ACL", async () => {
    mockedExecFileSync.mockImplementationOnce(() =>
      windowsAcl({
        rules: [{ ...ownerFullControlRule(), sid: OTHER_SID }],
      }),
    );
    const { ensureSecureDir: ensureWindowsSecureDir } = await import("./secure-fs.js");

    expect(() => ensureWindowsSecureDir(dir)).toThrow(
      /grants explicit access to another Windows principal/,
    );
    expect(mockedExecFileSync).toHaveBeenCalledTimes(1);
  });

  it("removes inherited access entries before verifying the owner-only ACL", async () => {
    mockedExecFileSync
      .mockImplementationOnce(() =>
        windowsAcl({
          rules: [{ ...ownerFullControlRule(), sid: OTHER_SID, inherited: true }],
        }),
      )
      .mockImplementationOnce(() => Buffer.from(""))
      .mockImplementationOnce(() =>
        windowsAcl({ protected: true, rules: [ownerFullControlRule()] }),
      );
    const { ensureSecureDir: ensureWindowsSecureDir } = await import("./secure-fs.js");

    expect(() => ensureWindowsSecureDir(dir)).not.toThrow();
    expect(mockedExecFileSync).toHaveBeenCalledTimes(3);
  });

  it("fails closed when post-validation is unsafe", async () => {
    mockedExecFileSync
      .mockImplementationOnce(() => windowsAcl())
      .mockImplementationOnce(() => Buffer.from(""))
      .mockImplementationOnce(() =>
        windowsAcl({
          protected: true,
          rules: [ownerFullControlRule(), { ...ownerFullControlRule(), sid: OTHER_SID }],
        }),
      );
    const { ensureSecureDir: ensureWindowsSecureDir } = await import("./secure-fs.js");

    expect(() => ensureWindowsSecureDir(dir)).toThrow(
      /resulting Windows ACL was not owner-only/,
    );
  });

  it("fails closed without changing permissions when ACL inspection is unavailable", async () => {
    mockedExecFileSync.mockImplementationOnce(() => {
      throw new Error("inspection unavailable");
    });
    const { ensureSecureDir: ensureWindowsSecureDir } = await import("./secure-fs.js");

    expect(() => ensureWindowsSecureDir(dir)).toThrow(
      /Windows owner and access rules could not be inspected/,
    );
    expect(mockedExecFileSync).toHaveBeenCalledTimes(1);
  });

  it("fails closed without changing permissions when ACL inspection is malformed", async () => {
    mockedExecFileSync.mockImplementationOnce(() =>
      JSON.stringify({
        callerSid: "not-a-sid",
        ownerSid: CALLER_SID,
        protected: false,
        rules: [],
      }),
    );
    const { ensureSecureDir: ensureWindowsSecureDir } = await import("./secure-fs.js");

    expect(() => ensureWindowsSecureDir(dir)).toThrow(
      /Windows owner and access rules were malformed/,
    );
    expect(mockedExecFileSync).toHaveBeenCalledTimes(1);
  });

  it("preserves profile-directory compatibility without ACL inspection", async () => {
    const profileDir = join(scope, "profile", "data");
    mkdirSync(profileDir, { recursive: true });
    const { ensureSecureDir: ensureWindowsSecureDir } = await import("./secure-fs.js");

    expect(() => ensureWindowsSecureDir(profileDir)).not.toThrow();
    expect(mockedExecFileSync).not.toHaveBeenCalled();
  });
});

describe.runIf(platform() === "win32")("secure-fs — Windows ACL integration", () => {
  const mockedExecFileSync = vi.mocked(execFileSync);
  let dir: string;

  function establishCallerOwnership(disposableDir: string): void {
    const powershell = `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
    const encodedPath = Buffer.from(resolve(disposableDir), "utf8").toString("base64");
    const script = [
      "$ErrorActionPreference = 'Stop'",
      `$path = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedPath}'))`,
      "$sidType = [Security.Principal.SecurityIdentifier]",
      "$callerSid = [Security.Principal.WindowsIdentity]::GetCurrent().User",
      "$acl = Get-Acl -LiteralPath $path",
      "$acl.SetOwner($callerSid)",
      "Set-Acl -LiteralPath $path -AclObject $acl",
      "$verifiedAcl = Get-Acl -LiteralPath $path",
      "$ownerSid = $verifiedAcl.GetOwner($sidType)",
      "if ($ownerSid.Value -ne $callerSid.Value) { throw 'Caller ownership was not established' }",
      "[ordered]@{ callerSid = $callerSid.Value; ownerSid = $ownerSid.Value } | ConvertTo-Json -Compress",
    ].join("\n");
    const output = execFileSync(
      powershell,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
      { encoding: "utf8", windowsHide: true },
    );
    const inspection: unknown = JSON.parse(output);
    if (
      typeof inspection !== "object" ||
      inspection === null ||
      !("callerSid" in inspection) ||
      !("ownerSid" in inspection) ||
      typeof inspection.callerSid !== "string" ||
      typeof inspection.ownerSid !== "string" ||
      !/^S-\d(?:-\d+)+$/i.test(inspection.callerSid) ||
      inspection.ownerSid.toUpperCase() !== inspection.callerSid.toUpperCase()
    ) {
      throw new Error("Disposable Windows directory ownership verification failed");
    }
  }

  beforeEach(async () => {
    const actual = await vi.importActual<typeof import("node:child_process")>(
      "node:child_process",
    );
    mockedExecFileSync.mockReset();
    mockedExecFileSync.mockImplementation(actual.execFileSync);
    const offProfileRoot = process.env.ProgramData ?? "C:\\ProgramData";
    dir = mkdtempSync(join(offProfileRoot, "spe-mcp-securefs-win-integration-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("hardens a disposable caller-owned off-profile directory", () => {
    const owned = join(dir, "owned");
    mkdirSync(owned);
    establishCallerOwnership(owned);
    expect(() => ensureSecureDir(owned)).not.toThrow();
  });

  it("refuses a disposable caller-owned directory with an explicit Everyone grant", () => {
    const unsafe = join(dir, "unsafe");
    mkdirSync(unsafe);
    establishCallerOwnership(unsafe);
    const icacls = `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\icacls.exe`;
    execFileSync(icacls, [unsafe, "/grant", "*S-1-1-0:(OI)(CI)R"], { stdio: "ignore" });
    try {
      expect(() => ensureSecureDir(unsafe)).toThrow(
        /grants explicit access to another Windows principal/,
      );
    } finally {
      execFileSync(icacls, [unsafe, "/remove:g", "*S-1-1-0"], { stdio: "ignore" });
    }
  });
});
