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

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/** Create a directory (recursively) with owner-only permissions. */
export function ensureSecureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: DIR_MODE });
    return;
  }
  // Repair perms on a dir that may predate this hardening.
  try {
    chmodSync(dir, DIR_MODE);
  } catch {
    /* not supported on this platform (e.g. Windows) — ACL governs instead */
  }
}

/**
 * Write a file with owner-only (0o600) permissions. `mode` on writeFileSync is
 * only honored when the file is *created*, so we also chmod to repair an
 * existing file that may have been written world-readable previously.
 */
export function writeSecureFile(path: string, data: string): void {
  writeFileSync(path, data, { encoding: "utf-8", mode: FILE_MODE });
  try {
    chmodSync(path, FILE_MODE);
  } catch {
    /* not supported on this platform (e.g. Windows) — ACL governs instead */
  }
}
