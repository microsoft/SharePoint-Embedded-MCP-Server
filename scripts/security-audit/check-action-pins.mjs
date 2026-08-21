#!/usr/bin/env node
/**
 * Verifies that every `uses:` reference in `.github/workflows` is pinned to a
 * full 40-character commit SHA and carries a human-readable version comment.
 *
 * A floating tag (`@v4`) is mutable: whoever controls the tag controls what runs
 * inside the workflow, including in the job that holds the advisory credential
 * used to file a private vulnerability report.
 * Local (`./…`) and Docker (`docker://…`) references are out of scope.
 *
 * The check is line-based rather than YAML-based so that it still fires on files
 * this repository's YAML subset parser cannot represent.
 *
 * Both surfaces are scanned:
 *   - every `*.yml` / `*.yaml` under the workflow directory, recursively; and
 *   - every composite/local action (`action.yml` / `action.yaml`) anywhere under
 *     the repository root. A composite action runs with the calling workflow's
 *     permissions, so an unpinned `uses:` inside one is just as dangerous while
 *     being invisible to a workflow-directory-only scan.
 *
 * Usage:
 *   node scripts/security-audit/check-action-pins.mjs [--dir .github/workflows] [--root .]
 */

import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

const USES_RE = /^\s*(?:-\s+)?uses:\s*(\S+)\s*(.*)$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const VERSION_COMMENT_RE = /#\s*\S+/;
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage', '.security-audit']);
const COMPOSITE_NAMES = new Set(['action.yml', 'action.yaml']);

/**
 * @param {string} text
 * @param {string} file
 * @returns {Array<{ file: string, line: number, uses: string, reason: string }>}
 */
export function checkWorkflowSource(text, file) {
  /** @type {Array<{ file: string, line: number, uses: string, reason: string }>} */
  const violations = [];
  const lines = text.split(/\r?\n/);

  lines.forEach((line, index) => {
    const match = USES_RE.exec(line);
    if (!match) return;

    const [, reference, trailing] = match;
    if (reference.startsWith('./') || reference.startsWith('docker://')) return;

    const at = reference.lastIndexOf('@');
    const record = { file, line: index + 1, uses: reference };

    if (at === -1) {
      violations.push({ ...record, reason: 'missing-ref' });
      return;
    }

    const ref = reference.slice(at + 1);
    if (!SHA_RE.test(ref)) {
      violations.push({ ...record, reason: 'not-sha-pinned' });
      return;
    }

    if (!VERSION_COMMENT_RE.test(trailing)) {
      violations.push({ ...record, reason: 'missing-version-comment' });
    }
  });

  return violations;
}

/**
 * Resolves `absolute` and asserts the real path stays inside `rootReal`.
 *
 * The walk refuses to follow symlinks, but a caller can still point `--root` or
 * `--dir` at a path whose *ancestors* are links. Re-checking containment on every
 * visited entry keeps the scan confined to a single real directory tree even when
 * the entry point itself was reached through a link.
 *
 * @param {string} rootReal Canonical (already realpath-resolved) scan root.
 * @param {string} absolute Path to verify.
 * @returns {string} The canonical path of `absolute`.
 */
function assertWithinRoot(rootReal, absolute) {
  let real;
  try {
    real = realpathSync.native(absolute);
  } catch (error) {
    throw new Error(
      `security-audit: cannot resolve ${absolute}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const rel = relative(rootReal, real);
  if (rel !== '' && (rel.startsWith('..') || isAbsolute(rel))) {
    throw new Error(`security-audit: path escapes the scan root: ${absolute} -> ${real}`);
  }
  return real;
}

/**
 * Recursively lists files under `dir` that satisfy `predicate`.
 *
 * Symlinks are rejected outright — both symlinked files and symlinked directories
 * cause a fail-closed throw rather than a skip. A repository that ships a link
 * into `/etc`, into another checkout, or back into itself would otherwise let the
 * pin scanner read (or loop over) content outside the audited tree, and a link
 * that shadows a composite action could hide an unpinned `uses:` from this check.
 * Refusing to follow links also makes filesystem cycles unreachable; the `seen`
 * set below is belt-and-braces for hard-linked or bind-mounted directories.
 *
 * @param {string} dir
 * @param {(name: string) => boolean} predicate
 * @returns {string[]} POSIX-style paths, sorted for deterministic output.
 * @throws {Error} When a symlink, an escaping path, or a directory cycle is found.
 */
export function collectFiles(dir, predicate) {
  /** @type {string[]} */
  const found = [];

  let rootReal;
  try {
    rootReal = realpathSync.native(dir);
  } catch (error) {
    throw new Error(
      `security-audit: cannot resolve the scan root ${dir}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  /** @type {Set<string>} */
  const seen = new Set([rootReal]);

  /** @param {string} current */
  function walk(current) {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const full = join(current, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`security-audit: refusing to follow symlink: ${full}`);
      }
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') && entry.name !== '.github') continue;
        if (SKIP_DIRS.has(entry.name)) continue;
        const real = assertWithinRoot(rootReal, full);
        if (seen.has(real)) {
          throw new Error(`security-audit: directory cycle detected at ${full}`);
        }
        seen.add(real);
        walk(full);
        continue;
      }
      // Sockets, FIFOs and device nodes are never audit inputs.
      if (!entry.isFile()) continue;
      if (predicate(entry.name)) {
        assertWithinRoot(rootReal, full);
        found.push(full.split('\\').join('/'));
      }
    }
  }

  walk(dir);
  return found.sort();
}

/**
 * Scans every YAML file under `dir`, recursively.
 *
 * @param {string} dir
 */
export function checkWorkflowDirectory(dir) {
  const files = collectFiles(dir, (name) => name.endsWith('.yml') || name.endsWith('.yaml'));

  return files.flatMap((file) => checkWorkflowSource(readFileSync(file, 'utf8'), file));
}

/**
 * Scans composite/local actions (`action.yml` / `action.yaml`) anywhere under
 * `root`. Composite actions run with the calling workflow's permissions, so an
 * unpinned `uses:` inside one is exactly as dangerous as an unpinned `uses:` in
 * the workflow itself, yet it is invisible to a workflow-directory-only scan.
 *
 * @param {string} root
 */
export function checkCompositeActions(root) {
  const files = collectFiles(root, (name) => COMPOSITE_NAMES.has(name));

  return files.flatMap((file) => checkWorkflowSource(readFileSync(file, 'utf8'), file));
}

function main() {
  const argv = process.argv.slice(2);
  const dirIndex = argv.indexOf('--dir');
  const dir = dirIndex === -1 ? '.github/workflows' : argv[dirIndex + 1];
  const rootIndex = argv.indexOf('--root');
  const root = rootIndex === -1 ? '.' : argv[rootIndex + 1];

  let violations;
  let scanned;
  try {
    const workflowFiles = collectFiles(
      dir,
      (name) => name.endsWith('.yml') || name.endsWith('.yaml'),
    );
    const compositeFiles = checkCompositeActionPaths(root, workflowFiles);
    scanned = workflowFiles.length + compositeFiles.length;
    violations = [
      ...workflowFiles.flatMap((file) => checkWorkflowSource(readFileSync(file, 'utf8'), file)),
      ...compositeFiles.flatMap((file) => checkWorkflowSource(readFileSync(file, 'utf8'), file)),
    ];
  } catch (error) {
    process.stderr.write(`security-audit: unable to read ${dir}: ${error.message}\n`);
    process.exit(1);
    return;
  }

  if (violations.length === 0) {
    process.stdout.write(
      `security-audit: all actions are SHA-pinned across ${scanned} workflow/composite file(s)\n`,
    );
    return;
  }

  for (const violation of violations) {
    process.stderr.write(
      `${violation.file}:${violation.line}: ${violation.reason}: ${violation.uses}\n`,
    );
  }
  process.stderr.write(
    `security-audit: ${violations.length} unpinned or undocumented action reference(s)\n`,
  );
  process.exit(1);
}

/**
 * @param {string} root
 * @param {string[]} alreadyScanned
 */
function checkCompositeActionPaths(root, alreadyScanned) {
  const seen = new Set(alreadyScanned);
  return collectFiles(root, (name) => COMPOSITE_NAMES.has(name)).filter((file) => !seen.has(file));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
