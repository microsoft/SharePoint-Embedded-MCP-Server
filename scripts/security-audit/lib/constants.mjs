/**
 * Shared, immutable configuration for the weekly repository security audit.
 *
 * Everything in this module is intentionally declarative so that the security
 * boundaries of the audit (what may be read, how much may be read, which models
 * may be used) are auditable in one place and assertable from tests.
 *
 * No runtime dependencies: Node built-ins only.
 */

import { randomBytes } from 'node:crypto';

/** Repository-relative path of the control legend used to anchor findings. */
export const CONTROL_LEGEND_PATH = 'docs/SECURITY-CONTROLS.md';

/**
 * Corpus caps. These are hard limits: `collect-corpus.mjs` refuses to emit a
 * corpus that exceeds them rather than silently truncating the security-relevant
 * tail of a file.
 */
export const CORPUS_LIMITS = Object.freeze({
  /** Maximum number of files sent to the model. */
  maxFiles: 128,
  /** Maximum bytes for any single file. Larger files fail collection. */
  maxFileBytes: 96 * 1024,
  /** Maximum total bytes across the whole corpus. */
  maxTotalBytes: 1024 * 1024,
});

/**
 * Allowlisted audit scopes. A scope maps to a set of repository-relative
 * directory prefixes; nothing outside these prefixes is ever collected.
 */
export const SCOPES = Object.freeze({
  'server-core': ['src/'],
  tools: ['src/tools/', 'src/tooling/'],
  workflows: ['.github/workflows/', 'scripts/'],
  full: ['src/', 'scripts/', '.github/workflows/'],
});

/** Default scope when a schedule or repository-dispatch payload does not supply one. */
export const DEFAULT_SCOPE = 'server-core';

/**
 * File extensions eligible for collection. Binary and lockfile-shaped content is
 * never included.
 */
export const ALLOWED_EXTENSIONS = Object.freeze(['.ts', '.mts', '.mjs', '.js', '.yml', '.yaml']);

/**
 * Paths that are never collected even when they match a scope prefix.
 *
 * Two distinct reasons appear in this list:
 *
 * 1. Noise suppression — test files, build output and vendored code dominate the
 *    corpus by volume and dilute the audit signal.
 * 2. Prompt-injection containment — agent instruction surfaces are written to be
 *    obeyed by a model. Feeding them to the auditor as "untrusted file content"
 *    invites the model to follow them instead of auditing them. They are denied
 *    outright.
 *
 * The instruction-surface entries are deliberately matched on *path*, not on
 * file extension. `ALLOWED_EXTENSIONS` happens to exclude `.md` today, which
 * would mask most of these, but that is an incidental side effect of an
 * unrelated list. Encoding the denial here keeps the control intact if the
 * extension allowlist is ever widened.
 */
export const CORPUS_DENY_PATTERNS = Object.freeze([
  /(^|\/)node_modules\//,
  /(^|\/)dist\//,
  /(^|\/)coverage\//,
  /\.test\.(ts|mts|mjs|js)$/,
  /\.d\.ts$/,
  /(^|\/)__fixtures__\//,
  /(^|\/)security-audit\/fixtures\//,
  // Agent instruction surfaces — see docs/SECURITY-AUDIT.md "Prompt-injection
  // containment". Case-insensitive because these filenames are conventional
  // rather than enforced.
  /(^|\/)AGENTS\.[^/]+$/i,
  /(^|\/)CLAUDE\.[^/]+$/i,
  /(^|\/)SKILL\.[^/]+$/i,
  /(^|\/)copilot-instructions\.[^/]+$/i,
  /(^|\/)\.github\/(instructions|agents|prompts|chatmodes)\//i,
  /(^|\/)\.copilot\//i,
  /\.(instructions|agent|prompt|chatmode)\.md$/i,
]);

/**
 * Models the workflow is permitted to request. The repository-dispatch payload
 * is validated against this list; anything else aborts before any credential is
 * touched.
 *
 * The MVP allowlist deliberately holds exactly one entry. Each model family is
 * served by a different provider/subprocessor chain, and the privacy review
 * covers only the single chain named here. Widening this list changes where
 * repository source is processed, so a new entry requires its own CELA and
 * Privacy determination before it may be added — it is not a configuration
 * detail. Keep this list, the trusted operator documentation, and
 * `DEFAULT_MODEL` identical.
 */
export const ALLOWED_MODELS = Object.freeze(['claude-opus-5']);

/** Default model for the audit. */
export const DEFAULT_MODEL = 'claude-opus-5';

/** Public npm registry origin used by the dependency-audit workflows. */
export const NPM_AUDIT_REGISTRY = 'https://registry.npmjs.org/';

/** Allowed protocol for dependency-audit lockfile `resolved` URLs. */
export const NPM_AUDIT_ALLOWED_PROTOCOL = 'https:';

/** Allowed hostnames for dependency-audit lockfile `resolved` URLs. */
export const NPM_AUDIT_ALLOWED_HOSTS = Object.freeze(['registry.npmjs.org']);

/** Manifest/lockfile names copied into the isolated dependency-audit workspace. */
export const NPM_AUDIT_FILES = Object.freeze({
  manifest: 'package.json',
  lockfile: 'package-lock.json',
});

/** Dependency maps whose values may steer npm away from the public registry. */
export const NPM_AUDIT_DEPENDENCY_KEYS = Object.freeze([
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
]);

/** Rewrite maps that may also carry non-registry dependency sources. */
export const NPM_AUDIT_REWRITE_KEYS = Object.freeze(['overrides', 'resolutions']);

/** Target-controlled install topologies that the lockfile-only audit does not model. */
export const NPM_AUDIT_UNSUPPORTED_KEYS = Object.freeze(['workspaces', 'pnpm']);

/** Accepted finding severities, ordered from most to least severe. */
export const SEVERITIES = Object.freeze(['critical', 'high', 'medium', 'low']);

/** Accepted finding confidences. */
export const CONFIDENCES = Object.freeze(['high', 'medium', 'low']);

/** Accepted finding categories. */
export const CATEGORIES = Object.freeze([
  'injection',
  'prompt-injection',
  'authz',
  'authn',
  'secret-exposure',
  'path-traversal',
  'ssrf',
  'unsafe-deserialization',
  'error-leakage',
  'supply-chain',
  'crypto',
  'denial-of-service',
  'logic',
]);

/**
 * Literal used when a finding does not map to an existing control in
 * `docs/SECURITY-CONTROLS.md`. Anything else must match a documented code.
 */
export const UNMAPPED_CONTROL = 'UNMAPPED';

/** Maximum number of findings accepted from a single model response. */
export const MAX_FINDINGS = 50;

/** Maximum characters accepted for any single free-text finding field. */
export const MAX_FIELD_CHARS = 1200;

/**
 * Sentinel token embedded in every corpus fence.
 *
 * The token alone is NOT a security boundary: it is a fixed string that lives in
 * this file, which is itself inside the `workflows` and `full` scopes, so any
 * attacker (and this repository's own source) can reproduce it verbatim. The
 * boundary is the per-run nonce appended to it — see `generateCorpusNonce()`.
 */
export const DELIMITER_SENTINEL = 'SPE_AUDIT_UNTRUSTED_FILE';

/** Replacement written over any sentinel literal found inside collected content. */
export const DELIMITER_NEUTRALIZED = 'SPE_AUDIT_NEUTRALIZED_MARKER';

/** Number of random bytes backing a corpus nonce (48 hex characters). */
export const CORPUS_NONCE_BYTES = 24;

/**
 * Generate a fresh, unguessable delimiter nonce for a single audit run.
 *
 * Rationale: a static fence can be forged by any file that happens to contain
 * the literal — including this repository's own constants file. A per-run
 * nonce cannot be present in repository content, so a collected file is
 * incapable of closing the fence around itself or opening a new one.
 */
export function generateCorpusNonce() {
  return randomBytes(CORPUS_NONCE_BYTES).toString('hex');
}

/**
 * Build the begin/end fence for a given run nonce.
 *
 * @param {string} nonce Hex nonce from `generateCorpusNonce()`.
 * @returns {{ nonce: string, begin: string, end: string }}
 */
export function corpusDelimiters(nonce) {
  if (typeof nonce !== 'string' || !/^[0-9a-f]{16,}$/.test(nonce)) {
    throw new TypeError('corpusDelimiters requires a hex nonce of at least 16 characters');
  }
  return Object.freeze({
    nonce,
    begin: `<<<${DELIMITER_SENTINEL}_BEGIN:${nonce}>>>`,
    end: `<<<${DELIMITER_SENTINEL}_END:${nonce}>>>`,
  });
}

/**
 * Neutralize every sentinel literal inside untrusted content.
 *
 * Collected files may legitimately contain the sentinel (this file does). They
 * are escaped rather than rejected so that the `workflows` and `full` scopes
 * remain auditable, while the emitted corpus can never contain a string that
 * looks like a fence.
 *
 * @param {string} text Untrusted file content.
 * @returns {{ value: string, neutralized: number }}
 */
export function neutralizeDelimiters(text) {
  const pattern = new RegExp(DELIMITER_SENTINEL, 'g');
  const matches = String(text).match(pattern);
  if (!matches) {
    return { value: String(text), neutralized: 0 };
  }
  return {
    value: String(text).replace(pattern, DELIMITER_NEUTRALIZED),
    neutralized: matches.length,
  };
}

/**
 * Private reporting (GitHub Private Vulnerability Reporting).
 *
 * Validated model findings are submitted as a single aggregate repository
 * security advisory *report*, visible only to maintainers. Nothing about a
 * finding is ever written to a public surface: no SARIF, no code scanning, no
 * Actions artifact, no job summary, no issue, no external tracker.
 */

/** GitHub REST base URL. Overridable only by tests, never by workflow input. */
export const GITHUB_API_BASE_URL = 'https://api.github.com';

/**
 * Prefix of the advisory report title. The full summary is this prefix followed
 * by the first 12 hex characters of the audited commit, which makes the title a
 * stable dedup key: one aggregate report per audited commit, re-runs included.
 */
export const REPORT_SUMMARY_PREFIX = 'SPE automated security audit — ';

/** GitHub caps advisory report summaries at 1024 characters. */
export const REPORT_SUMMARY_MAX_CHARS = 1024;

/** GitHub caps advisory report descriptions at 65535 characters. */
export const REPORT_DESCRIPTION_MAX_CHARS = 65535;

/** The only tokens the submitter is permitted to print. */
export const REPORT_RESULTS = Object.freeze({
  submitted: 'submitted',
  existing: 'existing',
  none: 'none',
  failed: 'failed',
});

/** Idempotent GET retries attempted for transient 5xx responses. */
export const REPORT_RETRY_LIMIT = 2;

/** Fixed delay between retries; deliberately not randomised or exponential. */
export const REPORT_RETRY_DELAY_MS = 5000;
