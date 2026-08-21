#!/usr/bin/env node
/**
 * Offline dry run for the SPE MCP security audit model pipeline.
 *
 * This script exercises the *entire* untrusted-output path -- corpus
 * collection, nonce fence integrity, prompt assembly, response schema
 * validation and redaction -- without invoking any model, without any
 * credential and without any network access. It exists so the fail-closed
 * behaviour of the pipeline can be tested locally and in CI while the AI layer
 * is still NOT_CONFIGURED.
 *
 * The synthetic response is generated at run time from
 * `fixtures/dry-run-findings.json` by binding each finding body to a real file
 * and line taken from the freshly collected corpus manifest. That keeps the
 * fixture honest: the validator still enforces "file must be in the corpus"
 * and "line must be within range" rather than being handed a pre-baked answer.
 *
 * Disclosure policy: the dry run validates the schema *privately*. Stage output
 * is captured rather than inherited and is echoed only when a stage fails, and
 * the success path prints a single generic line with no file paths, rule names,
 * finding counts or redaction counts. Even though the dry-run corpus is
 * synthetic, the same code path runs in CI against the audited tree, so it must
 * never be capable of printing finding-shaped detail to a public log.
 *
 * `--repo-root` selects the tree that is *audited*. It defaults to `.` for local
 * use, and the workflow passes `target` so the dry run reads the separately
 * checked out audited tree while still executing the trusted controller scripts
 * from the protected branch.
 *
 * Usage:
 *   node scripts/security-audit/dry-run.mjs [--scope <name>] [--out <dir>] [--repo-root <dir>]
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { corpusDelimiters, DEFAULT_SCOPE, SCOPES } from './lib/constants.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..', '..');

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
 * Runs one pipeline stage in a child Node process.
 *
 * Stage output is captured, not inherited. It is written to this process's
 * streams only when the stage fails, so a successful run cannot leak stage
 * detail (paths, counts, rule names) into a public log.
 *
 * @param {string} label
 * @param {string} script
 * @param {string[]} scriptArgs
 * @param {number[]} [allowedExitCodes]
 * @returns {number}
 */
function runStage(label, script, scriptArgs, allowedExitCodes = [0]) {
  const result = spawnSync(process.execPath, [join(SCRIPT_DIR, script), ...scriptArgs], {
    cwd: REPO_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    env: { ...process.env, GITHUB_OUTPUT: '' },
  });

  if (result.error) {
    throw new Error(`${label} failed to start: ${result.error.message}`);
  }
  const code = result.status ?? 1;
  if (!allowedExitCodes.includes(code)) {
    // Failure path only: surface the captured stage output so a maintainer
    // running this locally can diagnose it. CI treats a dry-run failure as a
    // configuration failure, not as a published finding.
    process.stderr.write(result.stdout ?? '');
    process.stderr.write(result.stderr ?? '');
    throw new Error(`${label} exited with ${code} (expected one of ${allowedExitCodes.join(', ')})`);
  }
  return code;
}

/**
 * Binds fixture finding bodies to real corpus files and lines.
 *
 * @param {{ files: Record<string, { lines: number }> }} manifest
 * @param {Array<Record<string, unknown>>} bodies
 * @returns {string}
 */
export function buildSyntheticResponse(manifest, bodies) {
  const files = Object.keys(manifest.files ?? {});
  if (files.length === 0) {
    throw new Error('corpus manifest contains no files; cannot build a synthetic response');
  }

  const findings = bodies.map((body, index) => {
    const file = files[index % files.length];
    const maxLine = Math.max(1, Number(manifest.files[file]?.lines ?? 1));
    return {
      file,
      line: Math.min(maxLine, index + 1),
      ...body,
    };
  });

  return [
    'SYNTHETIC DRY RUN -- no model was invoked and no credential was used.',
    'The findings below are fixture data bound to the collected corpus so that the',
    'schema validator and the redaction pass both execute.',
    '',
    '```json',
    JSON.stringify({ findings }, null, 2),
    '```',
    '',
  ].join('\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const scope = args.scope ?? DEFAULT_SCOPE;
  if (!Object.prototype.hasOwnProperty.call(SCOPES, scope)) {
    process.stderr.write(
      `dry-run: scope "${scope}" is not allowlisted (expected one of ${Object.keys(SCOPES).join(', ')})\n`,
    );
    process.exit(1);
  }

  const outDir = resolve(REPO_ROOT, args.out ?? join('.security-audit', 'dry-run'));
  mkdirSync(outDir, { recursive: true });

  // The audited tree. Defaults to this repository so the dry run is usable
  // locally; the workflow passes `target`, the separate audited checkout.
  const repoRoot = (args['repo-root'] ?? '').trim() || '.';

  runStage('collect corpus', 'collect-corpus.mjs', [
    '--scope',
    scope,
    '--out',
    outDir,
    '--repo-root',
    repoRoot,
  ]);

  const manifestPath = join(outDir, 'corpus-manifest.json');
  const corpusPath = join(outDir, 'corpus.txt');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

  const corpus = readFileSync(corpusPath, 'utf8');

  // Fence integrity: the delimiters are derived from the per-run nonce recorded
  // in the manifest, so a corpus file cannot forge or close a fence. Assert the
  // begin/end counts match the manifest file count exactly.
  const delimiters = corpusDelimiters(manifest.nonce);
  const beginCount = corpus.split(delimiters.begin).length - 1;
  const endCount = corpus.split(delimiters.end).length - 1;
  if (beginCount !== manifest.fileCount || endCount !== manifest.fileCount) {
    throw new Error(
      `corpus fence integrity check failed: expected ${manifest.fileCount} begin/end markers, saw ${beginCount}/${endCount}`,
    );
  }

  // Assemble the trusted preamble and the corpus + trusted suffix exactly as the
  // workflow does, so the dry run also covers prompt construction.
  runStage('build prompt', 'build-prompt.mjs', ['--corpus', outDir, '--out', outDir]);

  const systemPrompt = readFileSync(join(outDir, 'system.txt'), 'utf8');
  const modelPrompt = readFileSync(join(outDir, 'prompt.txt'), 'utf8');

  // `prompt.txt` is corpus + trusted suffix. The corpus is untrusted repository
  // content and legitimately contains `{{` (GitHub Actions expressions are in
  // the `workflows` scope), so the unresolved-placeholder assertion may only be
  // applied to the trusted, template-rendered regions: `system.txt` in full and
  // the suffix that follows the final corpus fence.
  const lastFence = modelPrompt.lastIndexOf(delimiters.end);
  if (lastFence === -1) {
    throw new Error('prompt.txt does not contain the per-run corpus fence');
  }
  const trustedSuffix = modelPrompt.slice(lastFence + delimiters.end.length);

  for (const [label, text] of [
    ['system.txt', systemPrompt],
    ['prompt.txt', modelPrompt],
  ]) {
    if (!text.includes(manifest.nonce)) {
      throw new Error(`${label} does not carry the per-run corpus nonce`);
    }
  }
  for (const [label, text] of [
    ['system.txt', systemPrompt],
    ['prompt.txt trusted suffix', trustedSuffix],
  ]) {
    if (text.includes('{{')) {
      throw new Error(`${label} contains an unresolved template placeholder`);
    }
  }
  if (!modelPrompt.endsWith('\n') || !modelPrompt.includes('END OF UNTRUSTED CORPUS')) {
    throw new Error('prompt.txt is missing the trusted suffix that reasserts the output contract');
  }

  const fixture = JSON.parse(
    readFileSync(join(SCRIPT_DIR, 'fixtures', 'dry-run-findings.json'), 'utf8'),
  );
  const responsePath = join(outDir, 'model-response.txt');
  writeFileSync(responsePath, buildSyntheticResponse(manifest, fixture.findings), 'utf8');

  const reportPath = join(outDir, 'model-report.json');
  runStage('validate response', 'validate-response.mjs', [
    '--response',
    responsePath,
    '--manifest',
    manifestPath,
    '--out',
    reportPath,
  ]);

  // The validated report stays on disk for local inspection only. It is never
  // printed, never summarised and never uploaded: the workflow publishes no
  // dry-run artifact, so nothing finding-shaped can reach a public surface.
  // Read it back so a malformed report still fails the dry run.
  const report = JSON.parse(readFileSync(reportPath, 'utf8'));
  if (!Array.isArray(report.findings) || report.schemaVersion !== 1) {
    throw new Error('validated report did not match the expected schema');
  }

  process.stdout.write(
    'security-audit: dry run passed. AI status: DRY_RUN (synthetic response; no model, no credential, no network).\n',
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`dry-run: ${error.message}\n`);
    process.exit(1);
  }
}
