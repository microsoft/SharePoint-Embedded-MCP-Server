#!/usr/bin/env node
/**
 * Submits a validated model report to GitHub Private Vulnerability Reporting.
 *
 * Rationale
 *
 * Automated security findings must never reach a public surface. On a public
 * repository, Actions logs, job summaries, artifacts, code scanning alerts, PR
 * annotations and issues are all world-readable, so none of them can carry a
 * finding. GitHub Private Vulnerability Reporting is the only channel this
 * repository has that is visible to maintainers and to nobody else, so it is
 * the only channel used. There is no fallback: if the report cannot be
 * submitted privately, the job fails and the finding stays in the runner, which
 * is destroyed when the job ends.
 *
 * One aggregate report is submitted per audited commit rather than one per
 * finding. The title is `<prefix><first 12 hex of the audited commit>`, which
 * makes it a stable dedup key: a re-run of the same commit finds the existing
 * report by exact title match and submits nothing. Triage and draft states are
 * both searched, and both are paginated, because a maintainer may have already
 * promoted a report to a draft advisory.
 *
 * This process prints exactly one line — `report: <result>` — where result is
 * one of submitted, existing, none or failed. Response bodies, GHSA
 * identifiers, advisory URLs and HTTP status codes are never printed: a status
 * code alone discloses whether a finding exists, and an advisory URL discloses
 * where it lives.
 *
 * Transient 5xx responses are retried at most twice with a fixed delay. Every
 * other error — auth, permission, validation, network, malformed payload — is
 * terminal and fails closed.
 *
 * Usage:
 *   node scripts/security-audit/submit-report.mjs \
 *     --report <file> --sha <40-hex> --repo <owner/repo>
 *
 * Environment:
 *   SECURITY_ADVISORY_TOKEN   required; a credential carrying
 *                             `Repository security advisories: write` on this
 *                             repository and nothing else.
 *   SECURITY_AUDIT_API_BASE   optional; honoured only when it is an http
 *                             loopback URL, so tests can point the submitter at
 *                             a local server while a workflow cannot redirect
 *                             it to a third-party host.
 */

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  GITHUB_API_BASE_URL,
  REPORT_DESCRIPTION_MAX_CHARS,
  REPORT_RESULTS,
  REPORT_RETRY_DELAY_MS,
  REPORT_RETRY_LIMIT,
  REPORT_SUMMARY_MAX_CHARS,
  REPORT_SUMMARY_PREFIX,
  SEVERITIES,
} from './lib/constants.mjs';

/** Advisory states that can already hold a report for this commit. */
const DEDUP_STATES = ['triage', 'draft'];

/** Page size for the dedup scan. */
const PAGE_SIZE = 100;

/** Hard stop for the dedup scan, so a pathological response cannot loop. */
const MAX_PAGES = 50;

/** Loopback hosts a test server may bind to. */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

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
 * Resolves the API base URL.
 *
 * The override exists so tests can run against a local server. It is accepted
 * only for an http loopback origin, so a workflow that sets the variable cannot
 * redirect submissions to a host that is not GitHub; the worst it can do is
 * point the submitter at the runner itself, which fails closed.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {string}
 */
export function resolveApiBase(env) {
  const override = env.SECURITY_AUDIT_API_BASE;
  if (override === undefined || override === '') return GITHUB_API_BASE_URL;

  let parsed;
  try {
    parsed = new URL(override);
  } catch {
    throw new Error('api base override is not a valid URL');
  }
  if (parsed.protocol !== 'http:' || !LOOPBACK_HOSTS.has(parsed.hostname)) {
    throw new Error('api base override is not an http loopback origin');
  }
  return override.replace(/\/+$/, '');
}

/**
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeRepo(value) {
  const repo = typeof value === 'string' ? value.trim() : '';
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repo)) {
    throw new Error('repository must be given as owner/repo');
  }
  return repo;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeSha(value) {
  const sha = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    throw new Error('commit must be a 40-character hex sha');
  }
  return sha;
}

/**
 * The dedup key. Short enough to stay well inside the summary cap, long enough
 * that a collision across this repository's history is not a practical concern.
 *
 * @param {string} sha
 * @returns {string}
 */
export function buildSummary(sha) {
  const summary = `${REPORT_SUMMARY_PREFIX}${normalizeSha(sha).slice(0, 12)}`;
  return summary.slice(0, REPORT_SUMMARY_MAX_CHARS);
}

/**
 * Highest severity present, using the fixed order in `SEVERITIES`.
 *
 * @param {{ severity: string }[]} findings
 * @returns {string}
 */
export function maxSeverity(findings) {
  let best = SEVERITIES.length - 1;
  for (const finding of findings) {
    const index = SEVERITIES.indexOf(finding.severity);
    if (index >= 0 && index < best) best = index;
  }
  return SEVERITIES[best];
}

/**
 * Renders the report body.
 *
 * Every value here has already passed `validate-response.mjs`, so it is
 * allowlisted, length-capped and redacted. Truncation is a deterministic tail
 * cut with an explicit marker, so the same report always produces the same
 * body.
 *
 * @param {{ sha: string, scope: unknown, findings: Record<string, unknown>[] }} input
 * @returns {string}
 */
export function buildDescription({ sha, scope, findings }) {
  const lines = [
    'Automated security audit of this repository.',
    '',
    `- Commit: \`${normalizeSha(sha)}\``,
    `- Scope: \`${typeof scope === 'string' && scope ? scope : 'unknown'}\``,
    `- Findings: ${findings.length}`,
    '',
    'Findings are model-generated and unconfirmed. Each one has been validated',
    'against the audited source tree and redacted, but none has been triaged by',
    'a human. Treat this report as a review queue, not as a set of confirmed',
    'vulnerabilities.',
    '',
  ];

  findings.forEach((finding, index) => {
    lines.push(
      `## ${index + 1}. ${finding.title}`,
      '',
      `- Location: \`${finding.file}\`:${finding.line}`,
      `- Category: ${finding.category}`,
      `- Severity: ${finding.severity}`,
      `- Confidence: ${finding.confidence}`,
      `- Control: ${finding.control}`,
      '',
      `**Detail.** ${finding.detail}`,
      '',
      `**Remediation.** ${finding.remediation}`,
      '',
      `**Suggested test.** ${finding.test}`,
      '',
    );
  });

  const body = lines.join('\n');
  if (body.length <= REPORT_DESCRIPTION_MAX_CHARS) return body;

  const marker = '\n\n_Truncated._\n';
  return `${body.slice(0, REPORT_DESCRIPTION_MAX_CHARS - marker.length)}${marker}`;
}

/**
 * @param {{ summary: string, description: string, severity: string }} input
 * @returns {Record<string, unknown>}
 */
export function buildReportBody({ summary, description, severity }) {
  // `vulnerabilities` describes affected *published packages*. These findings
  // are about source in this repository, not about a released package version,
  // so the field is omitted rather than populated with a guess.
  return {
    summary,
    description,
    severity,
    start_private_fork: false,
  };
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Single request with a bounded retry for transient 5xx responses.
 *
 * Errors are deliberately opaque: the message never carries the status code,
 * the response body or the URL, because this process runs in a public log.
 *
 * @param {{ url: string, method: string, token: string, body?: unknown, fetchImpl?: typeof fetch, sleepImpl?: (ms: number) => Promise<void> }} options
 * @returns {Promise<{ ok: boolean, status: number, data: unknown }>}
 */
export async function request({
  url,
  method,
  token,
  body,
  fetchImpl = fetch,
  sleepImpl = sleep,
}) {
  const init = {
    method,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'x-github-api-version': '2022-11-28',
      'user-agent': 'spe-mcp-security-audit',
    },
  };
  if (body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }

  for (let attempt = 0; ; attempt += 1) {
    let response;
    try {
      response = await fetchImpl(url, init);
    } catch {
      throw new Error('request failed');
    }

    if (response.status >= 500 && attempt < REPORT_RETRY_LIMIT) {
      await sleepImpl(REPORT_RETRY_DELAY_MS);
      continue;
    }

    let data = null;
    const text = await response.text().catch(() => '');
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
      }
    }

    return { ok: response.ok, status: response.status, data };
  }
}

/**
 * True when a report with exactly this summary already exists in triage or
 * draft state. Both states are scanned page by page; an exact string match is
 * used so a maintainer-edited title never suppresses a new submission by
 * accident.
 *
 * @param {{ apiBase: string, repo: string, token: string, summary: string, fetchImpl?: typeof fetch, sleepImpl?: (ms: number) => Promise<void> }} options
 * @returns {Promise<boolean>}
 */
export async function reportExists({
  apiBase,
  repo,
  token,
  summary,
  fetchImpl = fetch,
  sleepImpl = sleep,
}) {
  for (const state of DEDUP_STATES) {
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const url =
        `${apiBase}/repos/${repo}/security-advisories` +
        `?state=${state}&per_page=${PAGE_SIZE}&page=${page}`;
      const result = await request({ url, method: 'GET', token, fetchImpl, sleepImpl });
      if (!result.ok) throw new Error('unable to list existing reports');
      if (!Array.isArray(result.data)) throw new Error('unexpected list response');

      for (const advisory of result.data) {
        if (advisory && advisory.summary === summary) return true;
      }
      if (result.data.length < PAGE_SIZE) break;
    }
  }
  return false;
}

/**
 * @param {{ report: Record<string, unknown>, sha: string, repo: string, token: string, apiBase: string, fetchImpl?: typeof fetch, sleepImpl?: (ms: number) => Promise<void> }} options
 * @returns {Promise<string>} one of `REPORT_RESULTS`
 */
export async function submitReport({
  report,
  sha,
  repo,
  token,
  apiBase,
  fetchImpl = fetch,
  sleepImpl = sleep,
}) {
  const findings = Array.isArray(report?.findings) ? report.findings : [];
  if (findings.length === 0) return REPORT_RESULTS.none;

  const summary = buildSummary(sha);

  if (await reportExists({ apiBase, repo, token, summary, fetchImpl, sleepImpl })) {
    return REPORT_RESULTS.existing;
  }

  const body = buildReportBody({
    summary,
    description: buildDescription({ sha, scope: report?.scope, findings }),
    severity: maxSeverity(findings),
  });

  const result = await request({
    url: `${apiBase}/repos/${repo}/security-advisories/reports`,
    method: 'POST',
    token,
    body,
    fetchImpl,
    sleepImpl,
  });
  if (!result.ok) throw new Error('report submission was rejected');

  return REPORT_RESULTS.submitted;
}

/**
 * @param {string} result
 */
function emit(result) {
  process.stdout.write(`report: ${result}\n`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  try {
    const reportPath = args.report;
    const sha = normalizeSha(args.sha);
    const repo = normalizeRepo(args.repo ?? process.env.GITHUB_REPOSITORY);
    const apiBase = resolveApiBase(process.env);

    const token = process.env.SECURITY_ADVISORY_TOKEN;
    if (!token) throw new Error('advisory credential is not available');
    if (!reportPath) throw new Error('usage: submit-report.mjs --report <file> --sha <sha>');

    const report = JSON.parse(readFileSync(reportPath, 'utf8'));

    const result = await submitReport({ report, sha, repo, token, apiBase });
    emit(result);
  } catch (error) {
    // The message is generated in this file and never contains response data,
    // but it is still kept off stdout so the only machine-readable line stays
    // the result token.
    emit(REPORT_RESULTS.failed);
    process.stderr.write(`security-audit: private report not submitted (${error.message})\n`);
    // Set the code rather than calling process.exit(). Tearing the process down
    // abruptly while the HTTP client is still closing its handles aborts the
    // runtime on some platforms, which replaces the deliberate exit code with a
    // crash code and prints runtime noise. Letting the loop drain keeps the
    // failure deterministic: this step fails closed with status 1.
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
