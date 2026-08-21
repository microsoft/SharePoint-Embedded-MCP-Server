#!/usr/bin/env node
/**
 * Renders the audit run summary and decides the overall exit status.
 *
 * Disclosure policy: the rendered summary is written to the job summary and to
 * the console, both of which are world-readable on a public repository. It is
 * therefore deliberately reduced to one of exactly two literals — no scanner
 * identity, no file path, no rule identifier, no count, no advisory URL, no
 * commit and no scope. A failing run says only that it failed; the detail lives
 * in the private vulnerability report submitted to maintainers, or (for the
 * deterministic checks) in a maintainer's local reproduction. See
 * docs/SECURITY-AUDIT.md.
 *
 * `Security audit: PASS` states that the deterministic checks succeeded. It
 * makes no claim about model-detectable issues: the model layer ships disabled,
 * and when it does not run no inference is attempted at all.
 *
 * Usage:
 *   node scripts/security-audit/summarize.mjs \
 *     --dependency-audit success --secret-scan success \
 *     --action-pins success --model skipped [--dry-run true] [--out <file>]
 */

import { appendFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { PUBLIC_SUMMARY_FAIL, PUBLIC_SUMMARY_PASS, STATUS } from './lib/constants.mjs';

/**
 * Deterministic jobs whose failure fails the run. Keys only: the human-readable
 * scanner names used to live here and were rendered into the public summary,
 * which told a reader which control had found something.
 */
const REQUIRED_JOBS = Object.freeze(['dependency-audit', 'secret-scan', 'action-pins']);

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

/**
 * Maps a GitHub Actions job result onto the status literal reported for the
 * model layer.
 *
 * @param {string} result
 * @param {boolean} dryRun
 */
export function modelStatus(result, dryRun) {
  if (dryRun) return STATUS.dryRun;
  switch (result) {
    case 'success':
      return STATUS.completed;
    case 'skipped':
    case '':
    case undefined:
      return STATUS.notConfigured;
    default:
      return STATUS.failed;
  }
}

/**
 * Builds the public summary.
 *
 * `status` is returned for the caller's own control flow only. It is not
 * rendered into `markdown`, because the markdown is published verbatim to a
 * world-readable job summary.
 *
 * @param {Record<string, string>} args
 * @returns {{ markdown: string, failed: boolean, status: string }}
 */
export function buildSummary(args) {
  const dryRun = args['dry-run'] === 'true';
  const status = modelStatus(args.model ?? 'skipped', dryRun);
  const failed = REQUIRED_JOBS.some((key) => (args[key] ?? 'skipped') !== 'success');
  const markdown = `${failed ? PUBLIC_SUMMARY_FAIL : PUBLIC_SUMMARY_PASS}\n`;

  return { markdown, failed, status };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const { markdown, failed } = buildSummary(args);

  if (args.out) writeFileSync(args.out, markdown, 'utf8');
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown, 'utf8');
  }
  process.stdout.write(markdown);

  // No detail on either stream: which control failed is itself a signal on a
  // public repository, and the model status is not published at all.
  if (failed) process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
