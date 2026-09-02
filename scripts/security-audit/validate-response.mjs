#!/usr/bin/env node
/**
 * Validates, redacts and normalizes a model response into a sanitized report.
 *
 * This is the trust boundary between untrusted model output and the only
 * consumer that follows it: the private advisory report submitted to
 * maintainers via `submit-report.mjs`. Nothing downstream reads the raw
 * response, and nothing derived from it reaches a public surface.
 *
 * Enforced:
 *  - Response parses as a JSON object with a `findings` array (code fences and
 *    surrounding prose are tolerated and stripped).
 *  - At most `MAX_FINDINGS` findings; each free-text field at most
 *    `MAX_FIELD_CHARS`.
 *  - Every required field is present and well-typed.
 *  - `category`, `severity`, `confidence` are members of fixed allowlists.
 *  - `control` matches a code documented in `docs/SECURITY-CONTROLS.md`, or the
 *    literal `UNMAPPED`.
 *  - `file` exists in the corpus manifest and `line` is within that file, which
 *    rejects findings invented about files the model never saw.
 *  - No field matches a REJECT pattern (credentials, GUIDs, absolute paths,
 *    weaponized payloads). A single match discards the finding and the process
 *    exits 3 so the workflow fails closed.
 *  - Remaining fields are passed through REDACT rules.
 *
 * Exit codes: 0 clean, 1 usage/parse failure, 3 content rejected (fail closed).
 *
 * Usage:
 *   node scripts/security-audit/validate-response.mjs \
 *     --response <file> --manifest <file> --out <file> [--status-out <file>]
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  CATEGORIES,
  CONFIDENCES,
  MAX_FIELD_CHARS,
  MAX_FINDINGS,
  SEVERITIES,
} from './lib/constants.mjs';
import { loadControlCodes } from './lib/controls.mjs';
import { findRejectReasons, redact } from './lib/redaction.mjs';

const REQUIRED_TEXT_FIELDS = ['title', 'detail', 'remediation', 'test'];
const IN_GITHUB_ACTIONS = process.env.GITHUB_ACTIONS === 'true';

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
  if (!IN_GITHUB_ACTIONS) {
    process.stderr.write(`security-audit: ${message}\n`);
  }
  process.exit(1);
}

/**
 * Extracts a JSON object from a response that may be wrapped in a fenced code
 * block or accompanied by prose.
 *
 * @param {string} raw
 * @returns {unknown}
 */
export function extractJson(raw) {
  const text = String(raw ?? '').trim();
  if (text === '') throw new Error('response is empty');

  const fenced = text.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  const candidates = [];
  if (fenced) candidates.push(fenced[1]);
  candidates.push(text);

  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    candidates.push(text.slice(firstBrace, lastBrace + 1));
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {
      // Try the next candidate.
    }
  }
  throw new Error('response did not contain a parseable JSON object');
}

/**
 * @param {unknown} parsed
 * @param {{ files: Record<string, { lines: number }> }} manifest
 * @param {Set<string>} controlCodes
 */
export function validateFindings(parsed, manifest, controlCodes) {
  const accepted = [];
  /** @type {{ index: number, reasons: string[] }[]} */
  const rejected = [];
  const redactions = [];

  const rawFindings = parsed?.findings;
  if (!Array.isArray(rawFindings)) {
    throw new Error('response object must contain a "findings" array');
  }
  if (rawFindings.length > MAX_FINDINGS) {
    throw new Error(`response contains ${rawFindings.length} findings; the cap is ${MAX_FINDINGS}`);
  }

  rawFindings.forEach((finding, index) => {
    /** @type {string[]} */
    const reasons = [];

    if (!finding || typeof finding !== 'object' || Array.isArray(finding)) {
      rejected.push({ index, reasons: ['not-an-object'] });
      return;
    }

    const file = typeof finding.file === 'string' ? finding.file.trim() : '';
    const files =
      manifest &&
      typeof manifest === 'object' &&
      manifest.files &&
      typeof manifest.files === 'object' &&
      !Array.isArray(manifest.files)
        ? manifest.files
        : null;
    const candidate =
      files && Object.prototype.hasOwnProperty.call(files, file) ? files[file] : null;
    const entry =
      candidate &&
      typeof candidate === 'object' &&
      !Array.isArray(candidate) &&
      Number.isInteger(candidate.lines) &&
      candidate.lines >= 1
        ? candidate
        : null;
    if (!entry) reasons.push('file-not-in-corpus');

    const line = finding.line;
    if (typeof line !== 'number' || !Number.isInteger(line) || line < 1) {
      reasons.push('line-not-a-positive-integer');
    } else if (entry && line > entry.lines) {
      reasons.push('line-out-of-range');
    }

    if (!CATEGORIES.includes(finding.category)) reasons.push('category-not-allowlisted');
    if (!SEVERITIES.includes(finding.severity)) reasons.push('severity-not-allowlisted');
    if (!CONFIDENCES.includes(finding.confidence)) reasons.push('confidence-not-allowlisted');
    if (!controlCodes.has(finding.control)) reasons.push('control-not-in-legend');

    /** @type {Record<string, string>} */
    const text = {};
    for (const field of REQUIRED_TEXT_FIELDS) {
      const value = finding[field];
      if (typeof value !== 'string' || value.trim() === '') {
        reasons.push(`${field}-missing`);
        continue;
      }
      if (value.length > MAX_FIELD_CHARS) {
        reasons.push(`${field}-too-long`);
        continue;
      }
      text[field] = value.trim();
    }

    // Reject patterns are evaluated across every string the model produced,
    // including fields that already failed other checks.
    const scanTarget = [file, ...REQUIRED_TEXT_FIELDS.map((f) => finding[f])]
      .filter((v) => typeof v === 'string')
      .join('\n');
    for (const reason of findRejectReasons(scanTarget)) {
      reasons.push(`unsafe-content:${reason}`);
    }

    if (reasons.length > 0) {
      rejected.push({ index, reasons });
      return;
    }

    /** @type {Record<string, string>} */
    const safeText = {};
    for (const field of REQUIRED_TEXT_FIELDS) {
      const result = redact(text[field]);
      safeText[field] = result.value;
      redactions.push(...result.redactions);
    }

    accepted.push({
      file,
      line,
      category: finding.category,
      severity: finding.severity,
      confidence: finding.confidence,
      control: finding.control,
      ...safeText,
    });
  });

  return { accepted, rejected, redactions };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const responsePath = args.response;
  const manifestPath = args.manifest;
  const outPath = args.out;

  if (!responsePath || !manifestPath || !outPath) {
    fail('usage: validate-response.mjs --response <file> --manifest <file> --out <file>');
  }

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    fail(`unable to read corpus manifest: ${error.message}`);
  }

  const controlCodes = loadControlCodes();

  let raw;
  try {
    raw = readFileSync(responsePath, 'utf8');
  } catch (error) {
    fail(`unable to read model response: ${error.message}`);
  }

  let result;
  try {
    result = validateFindings(extractJson(raw), manifest, controlCodes);
  } catch (error) {
    fail(error.message);
  }

  const failClosed = result.rejected.length > 0;
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    scope: manifest.scope ?? null,
    rejected: result.rejected,
    findings: result.accepted,
  };

  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  if (!IN_GITHUB_ACTIONS) {
    process.stdout.write(
      `security-audit: accepted=${result.accepted.length} rejected=${result.rejected.length} redactions=${result.redactions.length}\n`,
    );
  }

  if (failClosed) {
    // The report is intentionally written before this failure so that any
    // accepted findings can still take the sole permitted egress path. Counts
    // and rejection/redaction status are not printed in Actions; local runs
    // retain their diagnostics.
    if (!IN_GITHUB_ACTIONS) {
      process.stderr.write(
        'security-audit: rejected findings detected; failing closed. ' +
          'The sanitized report was still written and contains only reason codes for the rejected entries.\n',
      );
    }
    process.exit(3);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
