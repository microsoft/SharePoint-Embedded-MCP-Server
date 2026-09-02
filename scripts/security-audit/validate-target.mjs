#!/usr/bin/env node
/**
 * Validates and normalizes the audit target before any privileged step runs.
 *
 * Guarantees enforced here:
 *  - `ref` is a full 40-character hex commit SHA (no branch names, no tags, no
 *    abbreviated SHAs) and is an ancestor of `origin/main`. This prevents the
 *    audit from being pointed at arbitrary unreviewed code via a
 *    `repository_dispatch` payload.
 *  - An omitted/empty `ref` (the `schedule` event supplies no inputs, and the
 *    dispatch payload may omit the field) resolves to the current
 *    `origin/main` tip. The resolved value is then subjected to the *same*
 *    full-SHA and reachability checks as an operator-supplied value — it is a
 *    default, never a bypass.
 *  - `model` and `scope` are members of a fixed allowlist.
 *  - `dry_run` is a strict boolean literal.
 *
 * Reachability is mandatory. There is no production flag to skip it; the only
 * escape hatch is the `SECURITY_AUDIT_TEST_MODE=1` environment variable, which
 * exists so unit tests can exercise argument validation inside a scratch
 * repository that has no `origin/main`. `tests/workflow-invariants.test.mjs`
 * asserts that no workflow ever sets that variable.
 *
 * Writes the normalized values to `$GITHUB_OUTPUT` when running in Actions.
 * Exits non-zero on any violation so that downstream jobs never start.
 *
 * Usage:
 *   node scripts/security-audit/validate-target.mjs \
 *     [--ref <sha>] --model <name> --scope <name> --dry-run <true|false>
 */

import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { ALLOWED_MODELS, DEFAULT_MODEL, DEFAULT_SCOPE, SCOPES } from './lib/constants.mjs';
import { gitExecutable } from './lib/git-executable.mjs';

const BASE_REF = 'refs/remotes/origin/main';
/** The only ref the audit ever targets. */
const TARGET_REF = 'refs/heads/main';
/**
 * The only ref the controller half of the run may be loaded from.
 *
 * The "controller" is the workflow definition plus every helper script under
 * `scripts/security-audit/`. It is trusted: it decides what is collected, what
 * is redacted, and what is published. The "target" is the (possibly historical)
 * commit whose contents are analysed, and is treated as untrusted input.
 */
const CONTROLLER_REF = 'refs/heads/main';
const FULL_SHA = /^[0-9a-f]{40}$/;

/** Test-only escape hatch; never set by any workflow. */
const TEST_MODE = process.env.SECURITY_AUDIT_TEST_MODE === '1';

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
 * @param {string} value
 * @param {string} name
 */
function parseBoolean(value, name) {
  if (value === undefined || value === '') return false;
  if (value === 'true') return true;
  if (value === 'false') return false;
  fail(`${name} must be exactly "true" or "false"; received ${JSON.stringify(value)}`);
  return false;
}

/** @param {string} sha */
function assertReachableFromMain(sha) {
  try {
    execFileSync(gitExecutable(), ['cat-file', '-e', `${sha}^{commit}`], { stdio: 'ignore' });
  } catch {
    fail(`ref ${sha} does not resolve to a commit in this repository`);
  }

  try {
    execFileSync(gitExecutable(), ['merge-base', '--is-ancestor', sha, BASE_REF], {
      stdio: 'ignore',
    });
  } catch {
    fail(
      `ref ${sha} is not an ancestor of ${BASE_REF}. ` +
        'Only commits already merged to main may be audited.',
    );
  }
}

/**
 * Resolves the current tip of `origin/main`, exiting when it cannot be
 * determined.
 *
 * The tip serves three purposes, all of which must agree:
 *
 * 1. The default audit target when no `ref` was supplied — the `schedule` event
 *    passes no payload, and a repository dispatch may omit the field. The
 *    returned SHA is *not* trusted implicitly: `main()`
 *    re-applies the full-SHA shape check and the reachability check to it (the
 *    tip is trivially its own ancestor, so the check is satisfied without being
 *    weakened).
 * 2. The `is_main_tip` output, which records whether the audited commit is the
 *    current tip or a historical ancestor.
 * 3. The `controller_sha` output that every downstream job pins its *controller*
 *    checkout to, so the helper scripts always come from protected main rather
 *    than from the audited target.
 *
 * Because (3) is a trust boundary, an unresolvable tip is fatal rather than
 * degraded: without it there is no verified commit to pin the controller to.
 *
 * @returns {string}
 */
function requireMainTip() {
  const tip = tryResolveMainTip();
  if (tip === '') {
    fail(
      `${BASE_REF} could not be resolved, so the trusted controller commit is unknown. ` +
        'Ensure the controller checkout fetched origin/main (fetch-depth: 0).',
    );
  }
  return tip;
}

/**
 * Resolves the current tip of `origin/main`, returning an empty string instead
 * of exiting when it cannot be determined.
 *
 * Used for the `is_main_tip` output, which records whether the audited commit
 * is the current tip. Nothing is published on the basis of that flag — findings
 * are delivered privately and name the audited commit explicitly — so an
 * unresolvable tip degrades to `false` rather than being fatal here. The fatal
 * case is handled by `requireMainTip()`, which needs the tip to pin the
 * controller checkout.
 *
 * @returns {string} 40-hex SHA, or `''` when unresolvable.
 */
function tryResolveMainTip() {
  try {
    return execFileSync(gitExecutable(), ['rev-parse', `${BASE_REF}^{commit}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

/**
 * Rejects any Actions run whose controller ref is not the protected default
 * branch.
 *
 * The supported `schedule` and `repository_dispatch` events both load the
 * protected default-branch workflow. Refusing any other Actions ref is defence
 * in depth around that platform guarantee. The substantive downstream control
 * remains the explicit checkout of the validated `controller_sha` before any
 * helper script runs.
 *
 * No-ops outside Actions (`GITHUB_EVENT_NAME` unset) so local runs and unit
 * tests are unaffected.
 */
function assertControllerRefIsMain() {
  const event = (process.env.GITHUB_EVENT_NAME ?? '').trim();
  if (event === '') {
    return;
  }

  const ref = (process.env.GITHUB_REF ?? '').trim();
  if (ref !== CONTROLLER_REF) {
    fail(
      `${event} is only accepted from ${CONTROLLER_REF}; this run was started from ` +
        `${JSON.stringify(ref || '(unset)')}. Re-run the workflow from the protected ` +
        `default branch.`,
    );
  }
}

function main() {
  // Runs before argument parsing: an unsupported Actions ref is rejected
  // regardless of what payload it supplied.
  assertControllerRefIsMain();

  const args = parseArgs(process.argv.slice(2));

  // Resolved exactly once so the default target, the `is_main_tip` gate and the
  // `controller_sha` pin can never describe three different commits.
  const mainTip = requireMainTip();

  // `schedule` supplies no payload and dispatch may omit ref, so an absent ref
  // means "audit the current main tip" rather than "invalid".
  const suppliedRef = (args.ref ?? '').trim();
  const ref = suppliedRef === '' ? mainTip : suppliedRef;
  const refSource = suppliedRef === '' ? `default (${BASE_REF})` : 'input';

  if (!FULL_SHA.test(ref)) {
    fail(
      `ref must be a full 40-character lowercase hex commit SHA; ` +
        `received ${JSON.stringify(ref)} from ${refSource}`,
    );
  }

  const model = (args.model ?? '').trim() || DEFAULT_MODEL;
  if (!ALLOWED_MODELS.includes(model)) {
    fail(`model ${JSON.stringify(model)} is not allowlisted. Allowed: ${ALLOWED_MODELS.join(', ')}`);
  }

  const scope = (args.scope ?? '').trim() || DEFAULT_SCOPE;
  if (!Object.hasOwn(SCOPES, scope)) {
    fail(
      `scope ${JSON.stringify(scope)} is not allowlisted. Allowed: ${Object.keys(SCOPES).join(', ')}`,
    );
  }

  const dryRun = parseBoolean(args['dry-run'], 'dry_run');

  // Mandatory in every non-test invocation. There is deliberately no CLI flag
  // that disables this; see the module docblock.
  if (!TEST_MODE) {
    assertReachableFromMain(ref);
  }

  const outputs = {
    target_sha: ref,
    // The audit only ever targets commits reachable from main, so the ref is a
    // constant; exporting it keeps the workflow free of hard-coded branch names.
    target_ref: TARGET_REF,
    // True only when the target *is* the current main tip. Nothing is published
    // publicly on the basis of this flag; it exists so callers can tell a
    // scheduled tip audit apart from an operator-requested historical audit.
    is_main_tip: String(ref !== '' && ref === mainTip),
    // The commit the *trusted controller* checkout must pin to. Every job that
    // runs audit helpers checks this commit out at the repository root so the
    // scripts always come from protected main, never from the event-selected
    // branch and never from the (possibly historical) target commit.
    controller_sha: mainTip,
    model,
    scope,
    dry_run: String(dryRun),
  };

  for (const [key, value] of Object.entries(outputs)) {
    process.stdout.write(`${key}=${value}\n`);
  }

  if (process.env.GITHUB_OUTPUT) {
    const payload = Object.entries(outputs)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n');
    appendFileSync(process.env.GITHUB_OUTPUT, `${payload}\n`, 'utf8');
  }
}

export { CONTROLLER_REF, FULL_SHA, TARGET_REF, requireMainTip, tryResolveMainTip };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
