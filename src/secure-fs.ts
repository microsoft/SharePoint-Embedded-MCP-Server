// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Restrictive filesystem helpers for credential / state material (SEC-003).
 *
 * The token cache (MSAL refresh tokens) and provisioning state live under
 * `~/.spe-mcp/`. On POSIX, default umask yields world-readable `0644` files in
 * a `0755` directory — so on a shared host another local user could read the
 * refresh token. We therefore create the directory `0o700` and write files
 * `0o600`, and best-effort `chmod` any pre-existing files/dir to repair perms
 * created before this hardening landed.
 *
 * On Windows the POSIX mode bits are largely ignored by the FS; protection
 * comes from the per-user profile ACL on `%USERPROFILE%\.spe-mcp`. The chmod
 * calls are wrapped so they never throw on platforms that don't support them.
 */

import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";

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

/** Create a directory (recursively) with owner-only permissions. */
export function ensureSecureDir(dir: string): void {
  if (!existsSync(dir)) {
    // `mode` is honored on POSIX at creation time; ignored (harmless) on Windows.
    mkdirSync(dir, { recursive: true, mode: OWNER_RWX });
    return;
  }
  if (!IS_POSIX) return; // Windows: ACL governs; nothing to repair.
  // POSIX: repair perms on a dir that may predate this hardening (best-effort).
  try {
    chmodSync(dir, OWNER_RWX);
  } catch {
    /* best-effort repair (e.g. not the owner) — leave existing perms as-is */
  }
}

/**
 * Write a file with owner-only (0o600) permissions. `mode` on writeFileSync is
 * only honored when the file is *created* (and only on POSIX), so on POSIX we
 * also chmod to repair an existing file that may have been written
 * world-readable previously. On Windows the chmod is skipped and the profile
 * ACL provides the protection.
 */
export function writeSecureFile(path: string, data: string): void {
  writeFileSync(path, data, { encoding: "utf-8", mode: OWNER_RW });
  if (!IS_POSIX) return; // Windows: ACL governs; chmod would be a no-op.
  try {
    chmodSync(path, OWNER_RW);
  } catch {
    /* best-effort repair (e.g. not the owner) — leave existing perms as-is */
  }
}
