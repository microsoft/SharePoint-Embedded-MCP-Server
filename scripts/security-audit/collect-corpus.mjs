#!/usr/bin/env node
/**
 * Collects the bounded, allowlisted corpus that is sent to the model.
 *
 * Security properties:
 *  - Only files under the scope's directory prefixes are considered.
 *  - Only allowlisted extensions are read; deny patterns remove tests, build
 *    output and vendored code.
 *  - Hard caps on file count, per-file bytes and total bytes. Any eligible file
 *    that cannot be collected in full aborts the run, so a successful audit can
 *    never represent a partial eligible corpus.
 *  - Every file body is fenced with a PER-RUN CRYPTOGRAPHIC NONCE. A static fence
 *    is forgeable — this repository's own `lib/constants.mjs` contains the fence
 *    sentinel — so the nonce is generated fresh for every run and cannot appear
 *    in repository content. Any sentinel literal found inside a collected body is
 *    neutralized before emission, and a body that somehow contains the run nonce
 *    aborts the collection outright.
 *  - File discovery uses `git ls-files`, so untracked and ignored files (which
 *    may contain local secrets) are never collected.
 *  - `--repo-root` points at the *audited* checkout, which is separate from the
 *    trusted controller checkout this script is executed from. The controller
 *    never runs code from, and never sources helper scripts out of, the audited
 *    tree — so auditing a historical commit cannot change audit behaviour.
 *
 * Emits:
 *  - `<out>/corpus.txt`          delimiter-fenced file bodies
 *  - `<out>/corpus-manifest.json` nonce + path -> { bytes, lines } used to
 *                                 validate that model findings reference real
 *                                 files and lines, and to render the prompt with
 *                                 the exact fence in use
 *
 * Usage:
 *   node scripts/security-audit/collect-corpus.mjs --scope <name> --out <dir> [--repo-root <dir>]
 */

import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  ALLOWED_EXTENSIONS,
  corpusDelimiters,
  CORPUS_DENY_PATTERNS,
  CORPUS_LIMITS,
  DEFAULT_SCOPE,
  generateCorpusNonce,
  neutralizeDelimiters,
  SCOPES,
} from './lib/constants.mjs';
import { gitExecutable } from './lib/git-executable.mjs';

/**
 * @param {string[]} argv
 * @returns {Record<string, string>}
 */
function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      args[key] = 'true';
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

/** @param {string} message */
function fail(message) {
  process.stderr.write(`security-audit: ${message}\n`);
  process.exit(1);
}

/**
 * Git records symbolic links as blobs with this file mode. A tracked symlink is
 * the classic way to smuggle out-of-tree content into a bounded corpus: the
 * blob holds a path such as `../../secrets.env`, and any collector that reads
 * through the link exfiltrates a file the allowlist never approved. The mode is
 * therefore checked at enumeration time, before the filesystem is touched.
 */
const GIT_SYMLINK_MODE = '120000';

/**
 * @param {string} repoRoot Directory of the checkout to enumerate.
 * @returns {{ file: string, mode: string }[]} Repository-relative, POSIX-separated
 *   tracked paths paired with their git file mode.
 */
function listTrackedFiles(repoRoot) {
  // `-s` prepends "<mode> <object> <stage>\t" to every record so symlink blobs
  // (mode 120000) can be rejected without following them.
  const stdout = execFileSync(gitExecutable(), ['ls-files', '-s', '-z'], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });

  const entries = [];
  for (const record of stdout.split('\0')) {
    if (!record) continue;
    const tab = record.indexOf('\t');
    if (tab === -1) {
      fail(`unparsable git ls-files record: ${JSON.stringify(record)}`);
    }
    const mode = record.slice(0, record.indexOf(' '));
    entries.push({ file: record.slice(tab + 1), mode });
  }
  return entries;
}

/**
 * Fail closed unless `absolute` resolves inside `rootReal` once every symbolic
 * link on the path has been expanded. This catches the case the per-file
 * `lstat` cannot see: a symlinked *parent directory* that redirects an
 * otherwise innocent-looking relative path outside the audited checkout.
 *
 * @param {string} rootReal Canonical path of the audited checkout.
 * @param {string} absolute Path to validate.
 * @param {string} file Repository-relative path, used for the error message.
 */
function assertWithinRoot(rootReal, absolute, file) {
  let resolved;
  try {
    resolved = realpathSync.native(absolute);
  } catch {
    fail(`refusing to collect ${file}: path could not be resolved`);
    return;
  }
  const relative = path.relative(rootReal, resolved);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    fail(`refusing to collect ${file}: resolved path escapes the audited checkout`);
  }
}

/**
 * @param {string} file
 * @param {string[]} prefixes
 */
function isEligible(file, prefixes) {
  if (!prefixes.some((prefix) => file.startsWith(prefix))) return false;
  if (!ALLOWED_EXTENSIONS.includes(path.extname(file))) return false;
  if (CORPUS_DENY_PATTERNS.some((pattern) => pattern.test(file))) return false;
  return true;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const scope = (args.scope ?? '').trim() || DEFAULT_SCOPE;
  const outDir = (args.out ?? '').trim() || 'security-audit-out';
  // The audited content lives in a *separate* checkout from the trusted
  // controller scripts, so the corpus root is explicit. Manifest keys stay
  // repository-relative so findings reference real repository paths rather
  // than the controller's `target/` staging directory.
  const repoRoot = (args['repo-root'] ?? '').trim() || '.';

  const prefixes = SCOPES[scope];
  if (!prefixes) {
    fail(`scope ${JSON.stringify(scope)} is not allowlisted`);
  }

  const candidates = listTrackedFiles(repoRoot)
    .filter((entry) => isEligible(entry.file, prefixes))
    .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));

  // Index-level symlink rejection. A tracked symlink whose blob points outside
  // the checkout would otherwise be read through, so collection aborts rather
  // than silently skipping: a corpus that quietly drops files is harder to
  // reason about than one that refuses to build.
  const trackedSymlinks = candidates
    .filter((entry) => entry.mode === GIT_SYMLINK_MODE)
    .map((entry) => entry.file);
  if (trackedSymlinks.length > 0) {
    fail(`refusing to collect tracked symlink(s): ${trackedSymlinks.join(', ')}`);
  }

  // Canonical root for containment checks. Resolved once so a symlinked
  // checkout directory (common on macOS, where /tmp is a link) does not make
  // every subsequent comparison fail.
  let rootReal;
  try {
    rootReal = realpathSync.native(path.resolve(repoRoot));
  } catch {
    fail(`repository root ${JSON.stringify(repoRoot)} could not be resolved`);
  }

  /** @type {Record<string, { bytes: number, lines: number }>} */
  const manifest = {};
  const chunks = [];
  let totalBytes = 0;
  let fileCount = 0;
  let neutralizedTotal = 0;

  // Fresh, unguessable fence for this run only. Repository content cannot
  // contain it, so no collected file can close its own fence.
  const nonce = generateCorpusNonce();
  const delimiters = corpusDelimiters(nonce);

  if (candidates.length > CORPUS_LIMITS.maxFiles) {
    fail(
      `scope ${scope} exceeds the ${CORPUS_LIMITS.maxFiles}-file corpus limit`,
    );
  }

  /** @type {Array<{ file: string, absolute: string, size: number }>} */
  const prepared = [];
  for (const { file } of candidates) {
    const absolute = path.join(repoRoot, file);

    // lstat, never stat: stat follows links and would report the *target*, so a
    // symlink would be read as an ordinary file.
    let stats;
    try {
      stats = lstatSync(absolute);
    } catch {
      fail(`refusing to collect ${file}: tracked file is unreadable`);
    }

    // Fail closed rather than skip. Reaching here means git reported a
    // non-symlink mode while the filesystem disagrees, which is exactly the
    // inconsistency an attacker would engineer.
    if (stats.isSymbolicLink()) {
      fail(`refusing to read symlink ${file}`);
    }
    if (!stats.isFile()) {
      fail(`refusing to collect ${file}: tracked path is not a regular file`);
    }

    // Catches a symlinked *parent* directory, which the index mode check above
    // cannot see: the file entry is a regular blob, but its path traverses a
    // link that may escape the checkout.
    assertWithinRoot(rootReal, absolute, file);

    const size = stats.size;

    if (size > CORPUS_LIMITS.maxFileBytes) {
      fail(
        `refusing to collect ${file}: file exceeds the ${CORPUS_LIMITS.maxFileBytes}-byte limit`,
      );
    }
    if (totalBytes + size > CORPUS_LIMITS.maxTotalBytes) {
      fail(
        `scope ${scope} exceeds the ${CORPUS_LIMITS.maxTotalBytes}-byte corpus limit`,
      );
    }
    totalBytes += size;
    prepared.push({ file, absolute, size });
  }

  for (const { file, absolute, size } of prepared) {
    let rawBody;
    try {
      rawBody = readFileSync(absolute, 'utf8');
    } catch {
      fail(`refusing to collect ${file}: tracked file could not be read`);
    }
    if (Buffer.byteLength(rawBody, 'utf8') !== size) {
      fail(`refusing to collect ${file}: tracked file changed during collection`);
    }

    // Defence in depth: a body must never be able to emit anything that looks
    // like a fence. The nonce makes forgery infeasible; neutralization makes it
    // impossible even to write the sentinel token into the corpus.
    if (rawBody.includes(nonce)) {
      fail(`file ${file} contains the run nonce; aborting corpus collection`);
    }
    const { value: body, neutralized } = neutralizeDelimiters(rawBody);
    neutralizedTotal += neutralized;
    const lines = body.split('\n').length;

    manifest[file] = { bytes: size, lines };
    fileCount += 1;

    chunks.push(
      [
        `${delimiters.begin} path=${file} lines=${lines}`,
        body.replace(/\s+$/, ''),
        delimiters.end,
        '',
      ].join('\n'),
    );
  }

  if (fileCount === 0) {
    fail(`scope ${scope} produced an empty corpus; nothing to audit`);
  }

  const corpus = chunks.join('\n');

  // Final assertion: exactly one begin and one end fence per collected file.
  const beginCount = corpus.split(delimiters.begin).length - 1;
  const endCount = corpus.split(delimiters.end).length - 1;
  if (beginCount !== fileCount || endCount !== fileCount) {
    fail(
      `corpus fence integrity check failed: expected ${fileCount} pairs, found begin=${beginCount} end=${endCount}`,
    );
  }

  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, 'corpus.txt'), corpus, 'utf8');
  writeFileSync(
    path.join(outDir, 'corpus-manifest.json'),
    `${JSON.stringify(
      {
        scope,
        nonce,
        delimiters: { begin: delimiters.begin, end: delimiters.end },
        fileCount,
        totalBytes,
        neutralized: neutralizedTotal,
        files: manifest,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  if (process.env.GITHUB_ACTIONS !== 'true') {
    process.stdout.write(
      `security-audit: corpus scope=${scope} files=${fileCount} bytes=${totalBytes} neutralized=${neutralizedTotal}\n`,
    );
  }

  if (process.env.GITHUB_OUTPUT) {
    // The nonce is deliberately NOT exported as a step output: it is carried in
    // the manifest and consumed only by `build-prompt.mjs` inside the same job.
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `corpus_files=${fileCount}\ncorpus_bytes=${totalBytes}\ncorpus_neutralized=${neutralizedTotal}\n`,
      'utf8',
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
