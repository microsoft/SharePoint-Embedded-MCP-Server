// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Per-instance data-directory resolution — the SINGLE source of truth for where
 * the SPE MCP Server keeps its provisioning state (`state.json`) and MSAL token
 * cache (`token-cache.*.json`).
 *
 * Historically both `state.ts` and `auth.ts` hard-coded `~/.spe-mcp` in a
 * module-level `const` evaluated at import time. That froze the location before
 * any CLI flag / env var could be parsed, and it meant two MCP server instances
 * sharing a home directory would clobber each other's single, unpartitioned
 * `state.json`. This module replaces those consts with a lazy, memoized resolver
 * so a caller can select the directory per-instance via `--data-dir` /
 * `SPE_DATA_DIR`.
 *
 * Precedence (highest first): explicit override (`setDataDirOverride`, set by the
 * CLI from `--data-dir` or `SPE_DATA_DIR`) > `SPE_DATA_DIR` env > default
 * `~/.spe-mcp`. The default is byte-for-byte identical to the previous behavior.
 *
 * IMPORTANT — import-order safety: nothing here captures the resolved path in a
 * module-load-time constant. Resolution happens lazily on the first getter call
 * (or when the CLI calls `setDataDirOverride`), so the flag/env parsed in the CLI
 * action always wins even though `state.ts`/`auth.ts` are imported first.
 *
 * Cross-platform: every path is built with `node:path` + `os.homedir()`, so it
 * resolves correctly on Windows (`%USERPROFILE%\.spe-mcp`) and POSIX
 * (`~/.spe-mcp`) alike. The override is treated as UNTRUSTED input: it must be
 * absolute after explicit `~` expansion, it is normalized, and a CWD-relative
 * path is rejected outright (we never resolve against `process.cwd()`).
 */

import { homedir } from "node:os";
import { isAbsolute, join, normalize, sep } from "node:path";
import { AppError } from "./errors.js";

/** Directory name kept under the home directory by default. */
const DEFAULT_DIR_NAME = ".spe-mcp";

/**
 * The default data directory: `~/.spe-mcp`. Computed via a function (not a
 * module-level const) so tests can exercise a changed `homedir()` and so nothing
 * is frozen at import time.
 */
function defaultDataDir(): string {
  return join(homedir(), DEFAULT_DIR_NAME);
}

/**
 * Memoized resolved data directory. `null` means "not yet resolved" — the next
 * `getDataDir()` will resolve it (from an override set via `setDataDirOverride`,
 * else `SPE_DATA_DIR`, else the default). `setDataDirOverride` overwrites it so
 * a later override re-resolves lazily on demand.
 */
let memoizedDataDir: string | null = null;

/**
 * Expand a leading `~` against the HOME directory only. `~` alone → home;
 * `~/foo` or `~\foo` → `<home>/foo`. A `~user` form is intentionally NOT
 * expanded (we don't resolve other users' homes) and will fall through to the
 * absolute-path check, which rejects it.
 */
function expandTilde(input: string): string {
  if (input === "~") return homedir();
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return join(homedir(), input.slice(2));
  }
  return input;
}

/** Strip a single trailing path separator so the default compares byte-identically. */
function stripTrailingSep(p: string): string {
  if (p.length > 1 && p.endsWith(sep)) return p.slice(0, -1);
  return p;
}

/**
 * Resolve a raw data-directory value (from a flag, env var, or nothing) to an
 * absolute, normalized path.
 *
 * - Empty / whitespace / undefined → the default `~/.spe-mcp`.
 * - A leading `~` is expanded against `homedir()`.
 * - The result MUST be absolute. A CWD-relative path (e.g. `foo`, `./foo`,
 *   `../foo`) is REJECTED — we never resolve against `process.cwd()`, because an
 *   attacker-influenced working directory must not be able to redirect where
 *   refresh tokens are written.
 *
 * Exported for unit testing and reuse by the CLI.
 */
export function resolveDataDir(input?: string): string {
  const raw = (input ?? "").trim();
  if (raw === "") {
    return stripTrailingSep(normalize(defaultDataDir()));
  }
  const expanded = expandTilde(raw);
  if (!isAbsolute(expanded)) {
    throw new AppError(
      "INVALID_DATA_DIR",
      `Data directory must be an absolute path (got '${raw}'). Use an absolute path or a '~/...'-relative path; CWD-relative paths are rejected so the token store cannot be redirected by the working directory.`,
      {
        safeMessage:
          "Data directory must be an absolute path (or '~/...'); CWD-relative paths are rejected.",
      },
    );
  }
  return stripTrailingSep(normalize(expanded));
}

/**
 * Record an explicit data-directory override (highest precedence). The CLI calls
 * this once per invocation from `--data-dir` (falling back to `SPE_DATA_DIR`)
 * BEFORE `state.ts`/`auth.ts` first read the directory through the seam. Returns
 * the resolved absolute path so the caller can also propagate it (e.g. by
 * setting `process.env.SPE_DATA_DIR`) and log it.
 *
 * This overwrites the memoized value, so a subsequent `getDataDir()` re-resolves
 * to the new location (lazy re-resolution).
 */
export function setDataDirOverride(input?: string): string {
  memoizedDataDir = resolveDataDir(input);
  return memoizedDataDir;
}

/**
 * The resolved, absolute data directory for this process. Lazily resolved and
 * memoized on first use: an override set via `setDataDirOverride` wins; otherwise
 * `SPE_DATA_DIR` is honored; otherwise the default `~/.spe-mcp` is used.
 */
export function getDataDir(): string {
  if (memoizedDataDir === null) {
    memoizedDataDir = resolveDataDir(process.env.SPE_DATA_DIR);
  }
  return memoizedDataDir;
}

/** Absolute path to the provisioning state file (`<dataDir>/state.json`). */
export function getStateFile(): string {
  return join(getDataDir(), "state.json");
}

/**
 * The token-cache directory. This is the SAME directory as the data dir — the
 * cache and state co-locate under `~/.spe-mcp` — but it is exposed under its own
 * name so `auth.ts` reads intent-revealing code.
 */
export function getCacheDir(): string {
  return getDataDir();
}

/** Make a value safe to embed in a filename (GUIDs are already safe; be defensive). */
export function sanitizeForFilename(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}

/**
 * Token-cache file path partitioned by tenant + client:
 * `<dataDir>/token-cache.<tenant>.<client>.json`. Partitioning guarantees
 * accounts from different tenants (or client apps) never co-mingle.
 */
export function getCacheFile(tenant: string, client: string): string {
  return join(
    getDataDir(),
    `token-cache.${sanitizeForFilename(tenant)}.${sanitizeForFilename(client)}.json`,
  );
}

/**
 * Legacy single-file token cache (`<dataDir>/token-cache.json`) used before
 * per-tenant partitioning. Kept only so logout can clean it up; never read on the
 * hot path.
 */
export function getLegacyCacheFile(): string {
  return join(getDataDir(), "token-cache.json");
}

/**
 * Test-only hooks. Not part of the public API. Used to reset the memoized state
 * between unit tests so env-var precedence and lazy re-resolution can be asserted
 * deterministically.
 */
export const __testing = {
  /** Clear the memoized data dir so the next getter re-resolves from env/default. */
  reset(): void {
    memoizedDataDir = null;
  },
  /** The default data directory (`~/.spe-mcp`), for golden-path assertions. */
  defaultDataDir,
};
