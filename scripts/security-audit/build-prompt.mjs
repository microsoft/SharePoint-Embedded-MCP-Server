#!/usr/bin/env node
/**
 * Render the model prompt from the corpus manifest.
 *
 * Why this exists
 * ---------------
 * `actions/ai-inference` concatenates its system prompt and user prompt into a
 * single Copilot CLI invocation. There is no separate privileged system role
 * that untrusted content cannot reach, so instructions placed only *before* the
 * corpus can be attacked with "ignore your earlier instructions" framing.
 *
 * This script therefore produces two artefacts:
 *
 *   system.txt  = rendered `prompt.md`         (preamble, before the corpus)
 *   prompt.txt  = corpus + rendered `prompt-suffix.md` (trusted suffix, last word)
 *
 * The effective concatenation is `[preamble][corpus][suffix]`, so the immutable
 * output contract is asserted both before and after untrusted content.
 *
 * It also resolves the per-run delimiter nonce into both templates, so the model
 * is told the exact fence it must trust, and injects the finding vocabulary
 * straight from `lib/constants.mjs` so the prompt cannot drift away from
 * `validate-response.mjs`.
 *
 * Neither the preamble nor the suffix is a security control. The enforceable
 * boundary is `scripts/security-audit/validate-response.mjs`.
 *
 * Usage:
 *   node scripts/security-audit/build-prompt.mjs --corpus <dir> --out <dir>
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  CATEGORIES,
  CONFIDENCES,
  MAX_FIELD_CHARS,
  MAX_FINDINGS,
  SEVERITIES,
  corpusDelimiters,
} from './lib/constants.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PREAMBLE_TEMPLATE = path.join(HERE, 'prompt.md');
const SUFFIX_TEMPLATE = path.join(HERE, 'prompt-suffix.md');

/** Matches an HTML comment block, used to strip template documentation. */
const HTML_COMMENT_RE = /<!--[\s\S]*?-->\n?/g;

/** Matches any unresolved `{{TOKEN}}` placeholder. */
const PLACEHOLDER_RE = /\{\{[A-Z_]+\}\}/g;

function parseArgs(argv) {
  const args = { corpus: '', out: '' };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === '--corpus') {
      args.corpus = value ?? '';
      i += 1;
    } else if (key === '--out') {
      args.out = value ?? '';
      i += 1;
    }
  }
  return args;
}

function fail(message) {
  process.stderr.write(`build-prompt: ${message}\n`);
  process.exit(2);
}

/**
 * Substitute template placeholders and strip template documentation comments.
 *
 * @param {string} template Raw template text.
 * @param {Record<string, string>} values Placeholder values, keyed without braces.
 * @returns {string}
 */
export function renderTemplate(template, values) {
  const stripped = String(template).replace(HTML_COMMENT_RE, '');
  const rendered = stripped.replace(/\{\{([A-Z_]+)\}\}/g, (match, token) => {
    if (!Object.hasOwn(values, token)) {
      throw new Error(`unknown template placeholder: ${match}`);
    }
    return values[token];
  });
  const leftover = rendered.match(PLACEHOLDER_RE);
  if (leftover) {
    throw new Error(`unresolved template placeholders: ${leftover.join(', ')}`);
  }
  return rendered.trimStart();
}

/**
 * Build placeholder values for a run.
 *
 * @param {string} nonce Hex nonce recorded in the corpus manifest.
 * @returns {Record<string, string>}
 */
export function templateValues(nonce) {
  const delimiters = corpusDelimiters(nonce);
  return {
    CORPUS_NONCE: delimiters.nonce,
    FENCE_BEGIN: delimiters.begin,
    FENCE_END: delimiters.end,
    CATEGORIES: CATEGORIES.map((entry) => `\`${entry}\``).join(', '),
    SEVERITIES: SEVERITIES.map((entry) => `\`${entry}\``).join(', '),
    CONFIDENCES: CONFIDENCES.map((entry) => `\`${entry}\``).join(', '),
    MAX_FINDINGS: String(MAX_FINDINGS),
    MAX_FIELD_CHARS: String(MAX_FIELD_CHARS),
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.corpus) {
    fail('--corpus <dir> is required');
  }
  if (!args.out) {
    fail('--out <dir> is required');
  }

  const manifestPath = path.join(args.corpus, 'corpus-manifest.json');
  const corpusPath = path.join(args.corpus, 'corpus.txt');

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    fail(`unable to read corpus manifest: ${error.message}`);
  }

  const nonce = manifest?.nonce;
  if (typeof nonce !== 'string' || !/^[0-9a-f]{16,}$/.test(nonce)) {
    fail('corpus manifest does not contain a usable delimiter nonce');
  }

  let corpus;
  try {
    corpus = readFileSync(corpusPath, 'utf8');
  } catch (error) {
    fail(`unable to read corpus: ${error.message}`);
  }

  const delimiters = corpusDelimiters(nonce);
  const expected = Number(manifest.fileCount ?? 0);
  const beginCount = corpus.split(delimiters.begin).length - 1;
  const endCount = corpus.split(delimiters.end).length - 1;
  if (beginCount !== expected || endCount !== expected) {
    fail(
      `corpus fence integrity check failed: expected ${expected} begin/end pairs, ` +
        `found ${beginCount}/${endCount}`,
    );
  }

  let system;
  let suffix;
  try {
    const values = templateValues(nonce);
    system = renderTemplate(readFileSync(PREAMBLE_TEMPLATE, 'utf8'), values);
    suffix = renderTemplate(readFileSync(SUFFIX_TEMPLATE, 'utf8'), values);
  } catch (error) {
    fail(error.message);
  }

  mkdirSync(args.out, { recursive: true });
  const systemPath = path.join(args.out, 'system.txt');
  const promptPath = path.join(args.out, 'prompt.txt');

  writeFileSync(systemPath, system, 'utf8');
  writeFileSync(promptPath, `${corpus.replace(/\s*$/, '')}\n\n${suffix}`, 'utf8');

  process.stdout.write(
    `build-prompt: system=${systemPath} prompt=${promptPath} files=${expected} ` +
      `systemBytes=${Buffer.byteLength(system)} promptBytes=${Buffer.byteLength(
        readFileSync(promptPath, 'utf8'),
      )}\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
