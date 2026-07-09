// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Restrictive filesystem helpers for credential / state material (SEC-003).
 *
 * The token cache (MSAL refresh tokens) and provisioning state live under the
 * resolved data directory (default `~/.spe-mcp/`, or a `--data-dir` /
 * `SPE_DATA_DIR` override). On POSIX, default umask yields world-readable
 * `0644` files in a `0755` directory — so on a shared host another local user
 * could read the refresh token. We therefore create the directory `0o700` and
 * write files `0o600`.
 *
 * Historically the data directory was ALWAYS the user-owned `~/.spe-mcp`, so a
 * fail-open, symlink-following implementation was safe. Now that the directory
 * is caller-supplied (potentially from untrusted workspace config), that path
 * crosses a trust boundary and these helpers are hardened to FAIL CLOSED:
 *  - `ensureSecureDir` refuses a directory that is a symlink, not owned by the
 *    current user, or accessible to group/other (POSIX). On Windows an override
 *    outside `%USERPROFILE%` gets an owner-only DACL applied via `icacls`, or is
 *    refused.
 *  - `writeSecureFile` / `readSecureFile` open the final component with
 *    `O_NOFOLLOW` and verify the resulting fd with `fstat` (regular file, owner)
 *    BEFORE writing/reading, and `chmod` the fd — never the path — to defeat
 *    symlink/TOCTOU swaps.
 * A refusal throws, so callers that persist secrets (the MSAL cache writer)
 * simply skip persistence and force a fresh interactive sign-in rather than
 * writing a refresh token to an insecure location.
 *
 * On Windows the POSIX mode bits are largely ignored by the FS; protection
 * comes from the profile ACL (default path) or the icacls-applied owner-only
 * DACL (off-profile override).
 */

import { execFileSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { resolve, sep } from "node:path";
import { AppError } from "./errors.js";

/**
 * POSIX permission modes as octal literals (the leading `0o` is octal in JS).
 * Each octal digit is a 3-bit rwx group for owner/group/other respectively:
 *   0o700 = rwx------  → owner read/write/execute(traverse), no group/other.
 *   0o600 = rw-------  → owner read/write, no group/other.
 * Directories need the execute bit (`x`) to be traversable, hence 0o700 for
 * dirs vs 0o600 for files.
 */
const OWNER_RWX = 0o700; // rwx------  (directories)
const OWNER_RW = 0o600; //  rw-------  (files)

/**
 * These POSIX mode bits are only meaningful on POSIX platforms. On Windows the
 * FS ignores them and `fs.chmod` is a near no-op (it can only toggle the
 * read-only attribute), so we gate the permission calls behind an explicit
 * platform check. On Windows protection instead comes from the per-user
 * profile ACL on `%USERPROFILE%\.spe-mcp`.
 */
const IS_POSIX = process.platform !== "win32";

/**
 * `O_NOFOLLOW` makes `open` fail with `ELOOP` if the final path component is a
 * symlink, instead of following it to an attacker-chosen target. It is a POSIX
 * flag; on Windows Node leaves it `undefined`, so we coalesce to `0` (no-op) and
 * rely on the directory ACL there instead.
 */
const O_NOFOLLOW = (fsConstants.O_NOFOLLOW as number | undefined) ?? 0;

/**
 * Per-process memo of directories already validated as secure. Avoids repeating
 * the stat / icacls work on the hot path (every state + cache write). The
 * per-write fd checks in {@link writeSecureFile} still run every time, so this
 * only caches the directory-level decision, not the file-level TOCTOU defense.
 */
const validatedDirs = new Set<string>();

function insecureDir(dir: string, reason: string): AppError {
  return new AppError("INSECURE_DATA_DIR", `Refusing to use data directory '${dir}': ${reason}.`, {
    safeMessage: `Refusing to use an insecure data directory: ${reason}.`,
    suggestion:
      "Point --data-dir / SPE_DATA_DIR at a directory you own with owner-only permissions (a fresh directory under your home directory is safest).",
  });
}

function insecureFile(path: string, reason: string): AppError {
  return new AppError("INSECURE_CACHE_FILE", `Refusing to use file '${path}': ${reason}.`, {
    safeMessage: `Refusing to use an insecure credential/state file: ${reason}.`,
  });
}

/** True when `dir` resolves to the home directory or something beneath it. */
function isUnderHome(dir: string): boolean {
  const home = resolve(homedir());
  const d = resolve(dir);
  return d === home || d.startsWith(home + sep);
}

/**
 * Windows: apply an owner-only DACL to an off-profile override directory, or
 * throw. `/inheritance:r` strips inherited ACEs; `/grant:r <user>:(OI)(CI)F`
 * replaces the user's ACE with full control inherited by files + subdirs.
 */
function secureWindowsDirAclOrThrow(dir: string): void {
  const user = process.env.USERDOMAIN
    ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}`
    : process.env.USERNAME;
  if (!user) {
    throw insecureDir(dir, "the current Windows user could not be determined to set an owner-only ACL");
  }
  try {
    execFileSync("icacls", [dir, "/inheritance:r", "/grant:r", `${user}:(OI)(CI)F`], {
      stdio: "ignore",
    });
  } catch {
    throw insecureDir(dir, "an owner-only ACL could not be applied to this off-profile path");
  }
}

/**
 * Create a directory (recursively) with owner-only permissions and FAIL CLOSED
 * if it cannot be verified as owner-only. Safe to call repeatedly (memoized).
 */
export function ensureSecureDir(dir: string): void {
  const key = resolve(dir);
  if (validatedDirs.has(key)) return;

  if (!existsSync(dir)) {
    // `mode` is honored on POSIX at creation time; ignored (harmless) on Windows.
    mkdirSync(dir, { recursive: true, mode: OWNER_RWX });
  }

  // Fail-closed validation. lstat ONLY the final component (not the whole
  // chain) so legitimately symlinked parents (e.g. macOS /var -> /private/var,
  // or a symlinked home) don't trip the check.
  const st = lstatSync(key);
  if (st.isSymbolicLink()) throw insecureDir(dir, "it is a symlink");
  if (!st.isDirectory()) throw insecureDir(dir, "it is not a directory");

  if (IS_POSIX) {
    // Repair perms that may predate this hardening, then re-verify. If we are
    // not the owner, chmod throws EPERM and the ownership check below rejects.
    try {
      chmodSync(key, OWNER_RWX);
    } catch {
      /* fall through to the ownership/mode check, which will reject */
    }
    const uid = process.getuid?.();
    if (uid !== undefined && st.uid !== uid) {
      throw insecureDir(dir, "it is owned by another user");
    }
    const mode = lstatSync(key).mode & 0o777;
    if (mode & 0o077) {
      throw insecureDir(dir, "it is accessible to group or other (expected 0o700)");
    }
  } else if (!isUnderHome(dir)) {
    // Windows override outside %USERPROFILE% has no inherited profile ACL.
    secureWindowsDirAclOrThrow(dir);
  }

  validatedDirs.add(key);
}

/**
 * Write a file with owner-only (0o600) permissions, opening with `O_NOFOLLOW`
 * and verifying the fd (regular file, owner) before writing. Repairs a
 * pre-existing world-readable file via `fchmod` on the fd (never the path).
 * Throws (fail-closed) if the target is a symlink or owned by another user.
 */
export function writeSecureFile(path: string, data: string): void {
  const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | O_NOFOLLOW;
  let fd: number;
  try {
    fd = openSync(path, flags, OWNER_RW);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ELOOP") {
      throw insecureFile(path, "it is a symlink");
    }
    throw err;
  }
  try {
    if (IS_POSIX) {
      const st = fstatSync(fd);
      if (!st.isFile()) throw insecureFile(path, "it is not a regular file");
      const uid = process.getuid?.();
      if (uid !== undefined && st.uid !== uid) {
        throw insecureFile(path, "it is owned by another user");
      }
      // chmod the fd (never the path) so a swap between check and change can't
      // redirect us. `mode` on open only applies when creating a NEW file, so
      // this also repairs a pre-existing world-readable file.
      fchmodSync(fd, OWNER_RW);
    }
    writeSync(fd, data, null, "utf-8");
  } finally {
    closeSync(fd);
  }
}

/**
 * Read a credential/state file, opening with `O_NOFOLLOW` and verifying the fd
 * (regular file, owner) before reading. Returns `null` when the file does not
 * exist; throws (fail-closed) if the final component is a symlink or is owned
 * by another user, so a planted symlink is never read through.
 */
export function readSecureFile(path: string): string | null {
  if (!existsSync(path)) return null;
  let fd: number;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | O_NOFOLLOW);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ELOOP") throw insecureFile(path, "it is a symlink");
    if (code === "ENOENT") return null;
    throw err;
  }
  try {
    if (IS_POSIX) {
      const st = fstatSync(fd);
      if (!st.isFile()) throw insecureFile(path, "it is not a regular file");
      const uid = process.getuid?.();
      if (uid !== undefined && st.uid !== uid) {
        throw insecureFile(path, "it is owned by another user");
      }
    }
    return readFileSync(fd, { encoding: "utf-8" });
  } finally {
    closeSync(fd);
  }
}
