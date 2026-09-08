/**
 * Behavioural tests for the private vulnerability report submitter.
 *
 * `submit-report.mjs` is the only component in the audit pipeline that is
 * allowed to carry model findings anywhere, and the only place it may carry
 * them is GitHub Private Vulnerability Reporting. These tests pin that
 * contract from both directions: the request it makes (one aggregate report
 * per audited commit, deduplicated, with no `vulnerabilities` block) and the
 * output it produces (a single result token, never a status code, response
 * body, advisory identifier or URL).
 *
 * Nothing here touches the network. Unit-level cases inject `fetchImpl` and
 * `sleepImpl`; end-to-end cases run the CLI against an `http` server bound to
 * 127.0.0.1 and reached through the loopback-only `SECURITY_AUDIT_API_BASE`
 * override.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  GITHUB_API_BASE_URL,
  REPORT_DESCRIPTION_MAX_CHARS,
  REPORT_RESULTS,
  REPORT_RETRY_DELAY_MS,
  REPORT_RETRY_LIMIT,
  REPORT_SUMMARY_PREFIX,
  SEVERITIES,
} from '../lib/constants.mjs';
import {
  buildDescription,
  buildReportBody,
  buildSummary,
  maxSeverity,
  normalizeRepo,
  normalizeSha,
  reportExists,
  request,
  resolveApiBase,
  submitReport,
} from '../submit-report.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const SUBMIT_SCRIPT = path.join(REPO_ROOT, 'scripts', 'security-audit', 'submit-report.mjs');

const SHA = 'a'.repeat(39) + '9';
const REPO = 'microsoft/SharePoint-Embedded-MCP-Server';
const TOKEN = 'test-credential';
const API_BASE = 'http://127.0.0.1:1';
const DEDUP_STATES = ['triage', 'draft', 'published', 'closed'];
const PAGE_SIZE = 100;
const MAX_PAGES = 50;

/** The single line the submitter is permitted to print. */
const STDOUT_CONTRACT = /^report: (submitted|existing|none|failed)\n$/;

/**
 * A finding in the shape `validate-response.mjs` emits.
 *
 * @param {Record<string, unknown>} [overrides]
 */
function finding(overrides = {}) {
  return {
    file: 'src/index.ts',
    line: 42,
    category: 'injection',
    severity: 'high',
    confidence: 'medium',
    control: 'SC-1',
    title: 'Unvalidated path segment',
    detail: 'The handler forwards a caller-supplied segment without checking it.',
    remediation: 'Validate the segment against an allowlist before use.',
    test: 'Add a case asserting a traversal segment is rejected.',
    ...overrides,
  };
}

/** Write a validated report to a scratch file and return its path. */
function writeReport(findings, scope = 'src') {
  const dir = mkdtempSync(path.join(tmpdir(), 'spe-submit-report-'));
  const file = path.join(dir, 'report.json');
  writeFileSync(file, JSON.stringify({ schemaVersion: 1, scope, findings }), 'utf8');
  return file;
}

/**
 * Minimal stand-in for a `fetch` Response, carrying only what `request` reads.
 *
 * @param {{ status?: number, body?: unknown, headers?: Record<string, string> }} [spec]
 */
function fakeResponse({ status = 200, body = null, headers = {} } = {}) {
  const normalizedHeaders = new Map(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]),
  );
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (body === null ? '' : JSON.stringify(body)),
    headers: {
      get: (name) => normalizedHeaders.get(name.toLowerCase()) ?? null,
    },
  };
}

/**
 * `fetch` stub that records every call.
 *
 * The handler receives the call index so a test can describe a sequence
 * (for example: fail twice, then succeed) without bookkeeping of its own.
 * Returning an `Error` makes the call reject, modelling a network failure.
 *
 * @param {(url: string, init: Record<string, unknown>, index: number) => unknown} handler
 */
function stubFetch(handler) {
  const calls = [];
  const impl = async (url, init) => {
    const index = calls.length;
    calls.push({ url, method: init.method, headers: init.headers, body: init.body });
    const outcome = handler(url, init, index);
    if (outcome instanceof Error) throw outcome;
    return fakeResponse(outcome);
  };
  impl.calls = calls;
  return impl;
}

/** `sleep` stub that records the delays asked for instead of waiting. */
function stubSleep() {
  const delays = [];
  const impl = async (ms) => {
    delays.push(ms);
  };
  impl.delays = delays;
  return impl;
}

/** A same-origin, same-endpoint cursor Link for a dedup state. */
function nextLink(state, cursor, overrides = {}) {
  const base = overrides.base ?? API_BASE;
  const repo = overrides.repo ?? REPO;
  const query = overrides.query ?? `state=${state}&per_page=100&after=${cursor}`;
  return `<${base}/repos/${repo}/security-advisories?${query}>; rel="next"`;
}

/** Requests the submitter made, split by method. */
function methods(calls) {
  return calls.map((call) => call.method);
}

/**
 * Build the child environment explicitly.
 *
 * Every variable the submitter reads is cleared first, so a developer
 * workstation that happens to export one cannot change the outcome.
 *
 * @param {Record<string, string | undefined>} extra
 */
function childEnv(extra) {
  const env = { ...process.env };
  for (const key of ['SECURITY_ADVISORY_TOKEN', 'SECURITY_AUDIT_API_BASE', 'GITHUB_REPOSITORY']) {
    delete env[key];
  }
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

/**
 * Run the submitter as a child process.
 *
 * `spawn` rather than `spawnSync` because the loopback server that answers the
 * child runs on this process's event loop.
 *
 * @param {string[]} argv
 * @param {Record<string, string | undefined>} env
 * @returns {Promise<{ status: number, stdout: string, stderr: string }>}
 */
function runSubmit(argv, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SUBMIT_SCRIPT, ...argv], {
      cwd: REPO_ROOT,
      env: childEnv(env),
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

/**
 * Serve `handler` on a loopback port for the duration of `run`.
 *
 * @param {(record: { method: string, url: string, body: string }, res: import('node:http').ServerResponse) => void} handler
 * @param {(base: string, requests: { method: string, url: string, body: string }[]) => Promise<void>} run
 */
async function withServer(handler, run) {
  const requests = [];
  const server = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      const record = { method: req.method, url: req.url, body };
      requests.push(record);
      handler(record, res);
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    return await run(`http://127.0.0.1:${port}`, requests);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

/** Answer every dedup GET with an empty list and every POST with `status`. */
function listThen(status, body = { html_url: 'https://example.invalid/GHSA-xxxx-xxxx-xxxx' }) {
  return (record, res) => {
    if (record.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('[]');
      return;
    }
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
}

// Input normalisation. Everything reaching the API is derived from values that
// were checked here first, so a malformed workflow input cannot become a URL.

test('the repository argument must be owner/repo', () => {
  assert.equal(normalizeRepo(` ${REPO} `), REPO);
  for (const bad of ['', 'owner', 'owner/repo/extra', 'owner repo', '../../etc', undefined, 7]) {
    assert.throws(() => normalizeRepo(bad), /owner\/repo/);
  }
});

test('the commit argument must be a full hex sha', () => {
  assert.equal(normalizeSha(SHA.toUpperCase()), SHA);
  for (const bad of ['', 'main', SHA.slice(0, 39), `${SHA}0`, 'z'.repeat(40), undefined]) {
    assert.throws(() => normalizeSha(bad), /40-character hex sha/);
  }
});

// The API base. The override exists only so these tests can run offline; it
// must not be usable to redirect a real submission away from GitHub.

test('the API base defaults to GitHub when no override is set', () => {
  assert.equal(resolveApiBase({}), GITHUB_API_BASE_URL);
  assert.equal(resolveApiBase({ SECURITY_AUDIT_API_BASE: '' }), GITHUB_API_BASE_URL);
  assert.match(GITHUB_API_BASE_URL, /^https:\/\/api\.github\.com$/);
});

test('the API base override accepts only an http loopback origin', () => {
  assert.equal(
    resolveApiBase({ SECURITY_AUDIT_API_BASE: 'http://127.0.0.1:8080///' }),
    'http://127.0.0.1:8080',
  );
  assert.equal(resolveApiBase({ SECURITY_AUDIT_API_BASE: 'http://localhost:1' }), 'http://localhost:1');

  for (const bad of [
    'https://api.github.com',
    'https://127.0.0.1',
    'http://attacker.example.com',
    'http://127.0.0.1.attacker.example.com',
    'http://169.254.169.254',
    'file:///etc/passwd',
  ]) {
    assert.throws(
      () => resolveApiBase({ SECURITY_AUDIT_API_BASE: bad }),
      /http loopback origin/,
      `expected ${bad} to be rejected`,
    );
  }

  assert.throws(() => resolveApiBase({ SECURITY_AUDIT_API_BASE: 'not a url' }), /valid URL/);
});

// The report body.

test('the summary is the fixed prefix plus the short audited sha', () => {
  const summary = buildSummary(SHA);
  assert.equal(summary, `${REPORT_SUMMARY_PREFIX}${SHA.slice(0, 12)}`);
  assert.match(summary, /^SPE automated security audit — [0-9a-f]{12}$/u);
  assert.ok(summary.length <= 1024);
});

test('the report severity is the highest severity present', () => {
  assert.equal(maxSeverity([finding({ severity: 'low' }), finding({ severity: 'critical' })]), 'critical');
  assert.equal(maxSeverity([finding({ severity: 'medium' }), finding({ severity: 'high' })]), 'high');
  assert.equal(maxSeverity([finding({ severity: 'low' })]), 'low');
  // An unknown label never raises the reported severity.
  assert.equal(maxSeverity([finding({ severity: 'not-a-severity' })]), SEVERITIES.at(-1));
});

test('the description carries the findings and is capped deterministically', () => {
  const body = buildDescription({ sha: SHA, scope: 'src', findings: [finding()] });
  assert.match(body, /- Commit: `a{39}9`/);
  assert.match(body, /## 1\. Unvalidated path segment/);
  assert.match(body, /- Location: `src\/index\.ts`:42/);
  assert.match(body, /\*\*Remediation\.\*\* Validate the segment/);

  const huge = buildDescription({
    sha: SHA,
    scope: 'src',
    findings: [finding({ detail: 'x'.repeat(REPORT_DESCRIPTION_MAX_CHARS + 1000) })],
  });
  assert.equal(huge.length, REPORT_DESCRIPTION_MAX_CHARS);
  assert.ok(huge.endsWith('\n\n_Truncated._\n'));
  assert.equal(
    huge,
    buildDescription({
      sha: SHA,
      scope: 'src',
      findings: [finding({ detail: 'x'.repeat(REPORT_DESCRIPTION_MAX_CHARS + 1000) })],
    }),
  );
});

test('the report body omits vulnerabilities and never opens a private fork', () => {
  const body = buildReportBody({ summary: 's', description: 'd', severity: 'high' });
  assert.deepEqual(Object.keys(body).sort(), ['description', 'severity', 'start_private_fork', 'summary']);
  assert.equal(body.start_private_fork, false);
  assert.ok(!('vulnerabilities' in body));
  assert.ok(!('cve_id' in body));
});

// Transport. Retries are bounded and every failure is opaque.

test('a transient 5xx is retried at most twice with the fixed delay', async () => {
  const fetchImpl = stubFetch((_url, _init, index) => (index < 2 ? { status: 503 } : { status: 200, body: [] }));
  const sleepImpl = stubSleep();

  const result = await request({ url: 'http://127.0.0.1:1/x', method: 'GET', token: TOKEN, fetchImpl, sleepImpl });

  assert.equal(result.ok, true);
  assert.equal(fetchImpl.calls.length, 3);
  assert.deepEqual(sleepImpl.delays, [REPORT_RETRY_DELAY_MS, REPORT_RETRY_DELAY_MS]);
  assert.equal(REPORT_RETRY_LIMIT, 2);
  assert.equal(REPORT_RETRY_DELAY_MS, 5000);
});

test('a persistent 5xx gives up after the retry budget', async () => {
  const fetchImpl = stubFetch(() => ({ status: 500 }));
  const sleepImpl = stubSleep();

  const result = await request({ url: 'http://127.0.0.1:1/x', method: 'GET', token: TOKEN, fetchImpl, sleepImpl });

  assert.equal(result.ok, false);
  assert.equal(fetchImpl.calls.length, REPORT_RETRY_LIMIT + 1);
});

test('a non-idempotent POST is never retried after an ambiguous 5xx', async () => {
  const fetchImpl = stubFetch(() => ({ status: 503 }));
  const sleepImpl = stubSleep();

  const result = await request({
    url: `${API_BASE}/repos/${REPO}/security-advisories/reports`,
    method: 'POST',
    token: TOKEN,
    body: { summary: 'opaque' },
    fetchImpl,
    sleepImpl,
  });

  assert.equal(result.ok, false);
  assert.equal(fetchImpl.calls.length, 1);
  assert.deepEqual(sleepImpl.delays, []);
});

test('a client error is never retried', async () => {
  for (const status of [403, 404, 422]) {
    const fetchImpl = stubFetch(() => ({ status }));
    const sleepImpl = stubSleep();
    const result = await request({ url: 'http://127.0.0.1:1/x', method: 'GET', token: TOKEN, fetchImpl, sleepImpl });
    assert.equal(result.ok, false);
    assert.equal(fetchImpl.calls.length, 1);
    assert.deepEqual(sleepImpl.delays, []);
  }
});

test('a network failure surfaces as an opaque error', async () => {
  const fetchImpl = stubFetch(() => new Error('getaddrinfo ENOTFOUND api.github.com'));
  await assert.rejects(
    () => request({ url: 'http://127.0.0.1:1/secret-path', method: 'GET', token: TOKEN, fetchImpl }),
    (error) => {
      assert.equal(error.message, 'request failed');
      assert.ok(!/secret-path|ENOTFOUND|127\.0\.0\.1/.test(error.message));
      return true;
    },
  );
});

test('every request is sent as an authorised, versioned GitHub API call', async () => {
  const fetchImpl = stubFetch(() => ({ status: 200, body: [] }));
  await request({ url: 'http://127.0.0.1:1/x', method: 'GET', token: TOKEN, fetchImpl });

  const [call] = fetchImpl.calls;
  assert.equal(call.headers.accept, 'application/vnd.github+json');
  assert.ok(call.headers.authorization.startsWith('Bearer '));
  assert.equal(call.headers['x-github-api-version'], '2022-11-28');
  // A GET carries no body and therefore no JSON content type.
  assert.equal(call.body, undefined);
  assert.equal(call.headers['content-type'], undefined);
});

// Deduplication. One report per audited commit, across every state a report can
// be sitting in. Cursor URLs come only from validated GitHub Link headers.

test('the dedup scan follows a validated cursor before scanning every state', async () => {
  const fetchImpl = stubFetch((_url, _init, index) => {
    if (index === 0) {
      return {
        status: 200,
        body: [{ summary: 'unrelated' }],
        headers: {
          link:
            `${nextLink('triage', 'cursor-2')}, ` +
            `<${API_BASE}/repos/${REPO}/security-advisories?state=triage&per_page=100&after=last>; rel="last"`,
        },
      };
    }
    return { status: 200, body: [] };
  });

  const exists = await reportExists({
    apiBase: API_BASE,
    repo: REPO,
    token: TOKEN,
    summary: buildSummary(SHA),
    fetchImpl,
    sleepImpl: stubSleep(),
  });

  assert.equal(exists, false);
  assert.equal(fetchImpl.calls.length, 5);
  assert.match(fetchImpl.calls[0].url, /state=triage&per_page=100$/);
  assert.match(fetchImpl.calls[1].url, /state=triage&per_page=100&after=cursor-2$/);
  assert.match(fetchImpl.calls[2].url, /state=draft&per_page=100$/);
  assert.match(fetchImpl.calls[3].url, /state=published&per_page=100$/);
  assert.match(fetchImpl.calls[4].url, /state=closed&per_page=100$/);
  assert.equal(fetchImpl.calls.some((call) => /[?&]page=/.test(call.url)), false);
});

test('a matching summary on a later page counts as an existing report', async () => {
  const summary = buildSummary(SHA);
  const fetchImpl = stubFetch((_url, _init, index) => {
    if (index === 0) {
      return {
        status: 200,
        body: [],
        headers: { link: nextLink('triage', 'later') },
      };
    }
    return { status: 200, body: [{ summary }] };
  });

  assert.equal(
    await reportExists({
      apiBase: API_BASE,
      repo: REPO,
      token: TOKEN,
      summary,
      fetchImpl,
      sleepImpl: stubSleep(),
    }),
    true,
  );
  assert.equal(fetchImpl.calls.length, 2);
});

test('reports in every relevant state suppress duplicate submission', async () => {
  const summary = buildSummary(SHA);
  for (const [stateIndex, state] of DEDUP_STATES.entries()) {
    const fetchImpl = stubFetch((url) => ({
      status: 200,
      body: url.includes(`state=${state}`) ? [{ summary }] : [],
    }));

    assert.equal(
      await reportExists({
        apiBase: API_BASE,
        repo: REPO,
        token: TOKEN,
        summary,
        fetchImpl,
        sleepImpl: stubSleep(),
      }),
      true,
      `${state} must be searched`,
    );
    assert.equal(fetchImpl.calls.length, stateIndex + 1);
  }
});

test('dedup matches the summary exactly, so a retitled report does not mask a new commit', async () => {
  const summary = buildSummary(SHA);
  const fetchImpl = stubFetch(() => ({
    status: 200,
    body: [{ summary: `${summary} (triaged)` }, { summary: summary.toUpperCase() }, { summary: null }, null],
  }));

  assert.equal(
    await reportExists({
      apiBase: API_BASE,
      repo: REPO,
      token: TOKEN,
      summary,
      fetchImpl,
      sleepImpl: stubSleep(),
    }),
    false,
  );
  assert.equal(fetchImpl.calls.length, DEDUP_STATES.length);
});

test('unsafe or non-cursor advisory continuation links fail closed', async () => {
  const cases = [
    nextLink('triage', 'x', { base: 'http://attacker.example.com' }),
    nextLink('triage', 'x', { repo: 'other/repository' }),
    `<${API_BASE}/repos/${REPO}/security-advisories/reports?state=triage&after=x>; rel="next"`,
    nextLink('draft', 'x'),
    nextLink('triage', 'x', { query: 'state=triage&per_page=100&page=2' }),
  ];

  for (const link of cases) {
    const fetchImpl = stubFetch(() => ({
      status: 200,
      body: [],
      headers: { link },
    }));
    await assert.rejects(
      () =>
        reportExists({
          apiBase: API_BASE,
          repo: REPO,
          token: TOKEN,
          summary: buildSummary(SHA),
          fetchImpl,
          sleepImpl: stubSleep(),
        }),
      /advisory pagination/,
    );
    assert.equal(fetchImpl.calls.length, 1);
  }
});

test('the dedup scan fails closed when the cursor limit still has a next page', async () => {
  const fetchImpl = stubFetch((_url, _init, index) => ({
    status: 200,
    body: [],
    headers: { link: nextLink('triage', `cursor-${index + 1}`) },
  }));

  await assert.rejects(
    () =>
      reportExists({
        apiBase: API_BASE,
        repo: REPO,
        token: TOKEN,
        summary: buildSummary(SHA),
        fetchImpl,
        sleepImpl: stubSleep(),
      }),
    /pagination limit reached/,
  );
  assert.equal(fetchImpl.calls.length, MAX_PAGES);
});

test('a full capped page without a continuation is still deduplication uncertainty', async () => {
  const fetchImpl = stubFetch((_url, _init, index) => {
    if (index < MAX_PAGES - 1) {
      return {
        status: 200,
        body: [],
        headers: { link: nextLink('triage', `cursor-${index + 1}`) },
      };
    }
    return {
      status: 200,
      body: Array.from({ length: PAGE_SIZE }, (_, item) => ({ summary: `unrelated ${item}` })),
    };
  });

  await assert.rejects(
    () =>
      reportExists({
        apiBase: API_BASE,
        repo: REPO,
        token: TOKEN,
        summary: buildSummary(SHA),
        fetchImpl,
        sleepImpl: stubSleep(),
      }),
    /pagination limit reached/,
  );
  assert.equal(fetchImpl.calls.length, MAX_PAGES);
});

test('a partial capped page without a continuation proves that state is exhausted', async () => {
  const fetchImpl = stubFetch((_url, _init, index) => {
    if (index < MAX_PAGES - 1) {
      return {
        status: 200,
        body: [],
        headers: { link: nextLink('triage', `cursor-${index + 1}`) },
      };
    }
    return { status: 200, body: [{ summary: 'unrelated' }] };
  });

  assert.equal(
    await reportExists({
      apiBase: API_BASE,
      repo: REPO,
      token: TOKEN,
      summary: buildSummary(SHA),
      fetchImpl,
      sleepImpl: stubSleep(),
    }),
    false,
  );
  assert.equal(fetchImpl.calls.length, MAX_PAGES + DEDUP_STATES.length - 1);
});

test('pagination uncertainty prevents the report POST entirely', async () => {
  const fetchImpl = stubFetch((_url, init, index) => {
    assert.equal(init.method, 'GET', 'uncertainty must prevent every POST');
    if (index < MAX_PAGES - 1) {
      return {
        status: 200,
        body: [],
        headers: { link: nextLink('triage', `cursor-${index + 1}`) },
      };
    }
    return {
      status: 200,
      body: Array.from({ length: PAGE_SIZE }, (_, item) => ({ summary: `unrelated ${item}` })),
    };
  });

  await assert.rejects(
    () =>
      submitReport({
        report: { scope: 'src', findings: [finding()] },
        sha: SHA,
        repo: REPO,
        token: TOKEN,
        apiBase: API_BASE,
        fetchImpl,
        sleepImpl: stubSleep(),
      }),
    /pagination limit reached/,
  );
  assert.equal(fetchImpl.calls.length, MAX_PAGES);
  assert.equal(methods(fetchImpl.calls).includes('POST'), false);
});

test('an unreadable advisory list fails closed', async () => {
  for (const spec of [{ status: 403 }, { status: 404 }, { status: 200, body: { message: 'nope' } }]) {
    await assert.rejects(
      () =>
        reportExists({
          apiBase: API_BASE,
          repo: REPO,
          token: TOKEN,
          summary: buildSummary(SHA),
          fetchImpl: stubFetch(() => spec),
          sleepImpl: stubSleep(),
        }),
      /unable to list existing reports|unexpected list response/,
    );
  }
});

// End-to-end submission decisions.

test('an empty finding list submits nothing at all', async () => {
  for (const report of [{ findings: [] }, {}, { findings: null }]) {
    const fetchImpl = stubFetch(() => ({ status: 200, body: [] }));
    const result = await submitReport({
      report,
      sha: SHA,
      repo: REPO,
      token: TOKEN,
      apiBase: 'http://127.0.0.1:1',
      fetchImpl,
      sleepImpl: stubSleep(),
    });
    assert.equal(result, REPORT_RESULTS.none);
    assert.equal(fetchImpl.calls.length, 0);
  }
});

test('findings are submitted as one aggregate report for the audited commit', async () => {
  const fetchImpl = stubFetch((_url, init) =>
    init.method === 'POST' ? { status: 201, body: { ghsa_id: 'GHSA-aaaa-bbbb-cccc' } } : { status: 200, body: [] },
  );

  const result = await submitReport({
    report: { scope: 'src', findings: [finding({ severity: 'low' }), finding({ severity: 'critical' })] },
    sha: SHA,
    repo: REPO,
    token: TOKEN,
    apiBase: 'http://127.0.0.1:1',
    fetchImpl,
    sleepImpl: stubSleep(),
  });

  assert.equal(result, REPORT_RESULTS.submitted);
  assert.deepEqual(methods(fetchImpl.calls), ['GET', 'GET', 'GET', 'GET', 'POST']);

  const post = fetchImpl.calls.at(-1);
  assert.equal(post.url, `http://127.0.0.1:1/repos/${REPO}/security-advisories/reports`);
  assert.equal(post.headers['content-type'], 'application/json');

  const body = JSON.parse(post.body);
  assert.deepEqual(Object.keys(body).sort(), ['description', 'severity', 'start_private_fork', 'summary']);
  assert.equal(body.summary, buildSummary(SHA));
  assert.equal(body.severity, 'critical');
  assert.equal(body.start_private_fork, false);
  assert.match(body.description, /## 2\. Unvalidated path segment/);
});

test('an existing report for the same commit is not submitted twice', async () => {
  const fetchImpl = stubFetch(() => ({ status: 200, body: [{ summary: buildSummary(SHA) }] }));

  const result = await submitReport({
    report: { scope: 'src', findings: [finding()] },
    sha: SHA,
    repo: REPO,
    token: TOKEN,
    apiBase: 'http://127.0.0.1:1',
    fetchImpl,
    sleepImpl: stubSleep(),
  });

  assert.equal(result, REPORT_RESULTS.existing);
  assert.deepEqual(methods(fetchImpl.calls), ['GET']);
});

test('a rejected submission fails closed with no fallback publication', async () => {
  for (const status of [403, 404, 422]) {
    const fetchImpl = stubFetch((_url, init) =>
      init.method === 'POST' ? { status } : { status: 200, body: [] },
    );
    await assert.rejects(
      () =>
        submitReport({
          report: { scope: 'src', findings: [finding()] },
          sha: SHA,
          repo: REPO,
          token: TOKEN,
          apiBase: 'http://127.0.0.1:1',
          fetchImpl,
          sleepImpl: stubSleep(),
        }),
      /report submission was rejected/,
    );
    // One POST, no second attempt down any other route.
    assert.deepEqual(methods(fetchImpl.calls), ['GET', 'GET', 'GET', 'GET', 'POST']);
  }
});

test('an ambiguous 5xx submission is not retried or published elsewhere', async () => {
  const fetchImpl = stubFetch((_url, init) =>
    init.method === 'POST' ? { status: 503 } : { status: 200, body: [] },
  );
  const sleepImpl = stubSleep();

  await assert.rejects(
    () =>
      submitReport({
        report: { scope: 'src', findings: [finding()] },
        sha: SHA,
        repo: REPO,
        token: TOKEN,
        apiBase: API_BASE,
        fetchImpl,
        sleepImpl,
      }),
    /report submission was rejected/,
  );
  assert.deepEqual(methods(fetchImpl.calls), ['GET', 'GET', 'GET', 'GET', 'POST']);
  assert.deepEqual(sleepImpl.delays, []);
});

test('a capability failure during dedup never reaches the POST', async () => {
  const fetchImpl = stubFetch(() => ({ status: 403 }));

  await assert.rejects(
    () =>
      submitReport({
        report: { scope: 'src', findings: [finding()] },
        sha: SHA,
        repo: REPO,
        token: TOKEN,
        apiBase: 'http://127.0.0.1:1',
        fetchImpl,
        sleepImpl: stubSleep(),
      }),
    /unable to list existing reports/,
  );
  assert.deepEqual(methods(fetchImpl.calls), ['GET']);
});

// The CLI surface. Everything below runs the real script against a loopback
// server, so the printed output is exactly what a workflow log would show.

test('a successful submission prints only the result token', async () => {
  await withServer(listThen(201), async (base, requests) => {
    const report = writeReport([finding()]);
    const run = await runSubmit(['--report', report, '--sha', SHA, '--repo', REPO], {
      SECURITY_ADVISORY_TOKEN: TOKEN,
      SECURITY_AUDIT_API_BASE: base,
    });

    assert.equal(run.status, 0);
    assert.equal(run.stdout, `report: ${REPORT_RESULTS.submitted}\n`);
    assert.match(run.stdout, STDOUT_CONTRACT);
    assert.equal(run.stderr, '');
    assert.deepEqual(methods(requests), ['GET', 'GET', 'GET', 'GET', 'POST']);
  });
});

test('the repository may come from the runner environment', async () => {
  await withServer(listThen(201), async (base, requests) => {
    const report = writeReport([finding()]);
    const run = await runSubmit(['--report', report, '--sha', SHA], {
      SECURITY_ADVISORY_TOKEN: TOKEN,
      SECURITY_AUDIT_API_BASE: base,
      GITHUB_REPOSITORY: REPO,
    });

    assert.equal(run.status, 0);
    assert.equal(run.stdout, `report: ${REPORT_RESULTS.submitted}\n`);
    assert.ok(requests.at(-1).url.includes(`/repos/${REPO}/security-advisories/reports`));
  });
});

test('a duplicate run prints existing and posts nothing', async () => {
  const handler = (record, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(record.url.includes('state=triage') ? [{ summary: buildSummary(SHA) }] : []));
  };

  await withServer(handler, async (base, requests) => {
    const report = writeReport([finding()]);
    const run = await runSubmit(['--report', report, '--sha', SHA, '--repo', REPO], {
      SECURITY_ADVISORY_TOKEN: TOKEN,
      SECURITY_AUDIT_API_BASE: base,
    });

    assert.equal(run.status, 0);
    assert.equal(run.stdout, `report: ${REPORT_RESULTS.existing}\n`);
    assert.deepEqual(methods(requests), ['GET']);
  });
});

test('a clean audit prints none without contacting the API', async () => {
  await withServer(listThen(201), async (base, requests) => {
    const report = writeReport([]);
    const run = await runSubmit(['--report', report, '--sha', SHA, '--repo', REPO], {
      SECURITY_ADVISORY_TOKEN: TOKEN,
      SECURITY_AUDIT_API_BASE: base,
    });

    assert.equal(run.status, 0);
    assert.equal(run.stdout, `report: ${REPORT_RESULTS.none}\n`);
    assert.deepEqual(requests, []);
  });
});

test('a rejected submission fails the job and discloses nothing', async () => {
  for (const status of [403, 404, 422]) {
    await withServer(listThen(status, { message: 'Forbidden', documentation_url: 'https://docs.github.com/x' }), async (base) => {
      const report = writeReport([finding()]);
      const run = await runSubmit(['--report', report, '--sha', SHA, '--repo', REPO], {
        SECURITY_ADVISORY_TOKEN: TOKEN,
        SECURITY_AUDIT_API_BASE: base,
      });

      assert.equal(run.status, 1, `status ${status} must fail the step`);
      assert.equal(run.stdout, `report: ${REPORT_RESULTS.failed}\n`);
      assert.match(run.stdout, STDOUT_CONTRACT);

      const output = `${run.stdout}${run.stderr}`;
      assert.ok(!output.includes(String(status)), 'the status code must not be printed');
      assert.ok(!/GHSA-|CVE-|https?:\/\//.test(output), 'no advisory id or URL may be printed');
      assert.ok(!/Forbidden|documentation_url/.test(output), 'no response body may be printed');
    });
  }
});

test('a missing advisory credential fails before any request is made', async () => {
  await withServer(listThen(201), async (base, requests) => {
    const report = writeReport([finding()]);
    const run = await runSubmit(['--report', report, '--sha', SHA, '--repo', REPO], {
      SECURITY_AUDIT_API_BASE: base,
    });

    assert.equal(run.status, 1);
    assert.equal(run.stdout, `report: ${REPORT_RESULTS.failed}\n`);
    assert.match(run.stderr, /advisory credential is not available/);
    assert.deepEqual(requests, []);
  });
});

test('a missing report file fails closed', async () => {
  await withServer(listThen(201), async (base, requests) => {
    const run = await runSubmit(['--sha', SHA, '--repo', REPO], {
      SECURITY_ADVISORY_TOKEN: TOKEN,
      SECURITY_AUDIT_API_BASE: base,
    });

    assert.equal(run.status, 1);
    assert.equal(run.stdout, `report: ${REPORT_RESULTS.failed}\n`);
    assert.deepEqual(requests, []);
  });
});

test('an API base outside loopback is refused before any request is made', async () => {
  const report = writeReport([finding()]);
  const run = await runSubmit(['--report', report, '--sha', SHA, '--repo', REPO], {
    SECURITY_ADVISORY_TOKEN: TOKEN,
    SECURITY_AUDIT_API_BASE: 'https://attacker.example.com',
  });

  assert.equal(run.status, 1);
  assert.equal(run.stdout, `report: ${REPORT_RESULTS.failed}\n`);
  assert.match(run.stderr, /http loopback origin/);
  assert.ok(!run.stderr.includes('attacker.example.com'));
});

test('a malformed commit argument fails closed', async () => {
  const report = writeReport([finding()]);
  const run = await runSubmit(['--report', report, '--sha', 'main', '--repo', REPO], {
    SECURITY_ADVISORY_TOKEN: TOKEN,
  });

  assert.equal(run.status, 1);
  assert.equal(run.stdout, `report: ${REPORT_RESULTS.failed}\n`);
});

test('no failure path suggests a public fallback channel', async () => {
  const report = writeReport([finding()]);
  const run = await runSubmit(['--report', report, '--sha', SHA, '--repo', REPO], {
    SECURITY_ADVISORY_TOKEN: TOKEN,
    SECURITY_AUDIT_API_BASE: 'https://attacker.example.com',
  });

  const output = `${run.stdout}${run.stderr}`;
  assert.ok(
    !/\b(issue|issues|pull request|azure devops|icm|sarif|code scanning|artifact)\b/i.test(output),
    'the submitter must never point at another publication route',
  );
});

// A guard on the tests themselves: none of them may reach the real API.

test('no test in this file contacts GitHub', () => {
  const source = readFileSync(new URL(import.meta.url), 'utf8');

  // Any address on the loopback interface is safe whatever the scheme: nothing
  // addressed there can leave the machine. Tests bind a real server on
  // 127.0.0.1, and a few loopback URLs appear only as inputs the submitter is
  // asserted to reject.
  const isLoopback = (url) => /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])([:/]|$)/.test(url);

  // Deliberately bogus hosts. These appear only as overrides the submitter must
  // refuse, or as strings planted inside a stub response body to prove they are
  // never echoed. No test ever sends a request to one.
  const unroutableFixtures = [
    'attacker.example.com',
    '127.0.0.1.attacker.example.com',
    '169.254.169.254',
    'example.invalid',
  ];
  const isUnroutableFixture = (url) =>
    unroutableFixtures.some((host) => new RegExp(`^https?://${host.replaceAll('.', '\\.')}([:/]|$)`).test(url));

  // Real GitHub hosts are named only to assert the default base and to prove
  // advisory links are not reproduced. The assertion below pins that they are
  // never wired up as a request base.
  const isNamedOnly = (url) => /^https:\/\/(api|docs)\.github\.com([:/]|$)/.test(url);

  for (const url of source.match(/https?:\/\/[A-Za-z0-9.[\]:-]+/g) ?? []) {
    assert.ok(
      isLoopback(url) || isUnroutableFixture(url) || isNamedOnly(url),
      `unexpected host in test source: ${url}`,
    );
  }

  assert.ok(
    !/SECURITY_AUDIT_API_BASE: '?https:\/\/api\.github\.com/.test(source),
    'no test may point the submitter at the real GitHub API',
  );
});
