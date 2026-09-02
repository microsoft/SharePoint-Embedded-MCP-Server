// Structural invariants for the security-audit workflow.
//
// These assertions encode the threat model, not style preferences: each one
// corresponds to a way the workflow could be turned into an attack primitive if
// it were edited carelessly.
import { strict as assert } from 'node:assert';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { parseYaml } from '../lib/mini-yaml.mjs';
import { checkWorkflowSource } from '../check-action-pins.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const WORKFLOW_DIR = path.join(REPO_ROOT, '.github', 'workflows');
const SCRIPT_DIR = path.join(REPO_ROOT, 'scripts', 'security-audit');
const AUDIT_WORKFLOW = path.join(WORKFLOW_DIR, 'security-audit.yml');
const SECURITY_WORKFLOW = path.join(WORKFLOW_DIR, 'security.yml');
const CI_WORKFLOW = path.join(WORKFLOW_DIR, 'ci.yml');

// Comments are allowed to name a construct in order to explain why it is
// absent; only executable lines are checked for the dangerous constructs.
function stripComments(raw) {
  return raw
    .split(/\r?\n/)
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
}

function readWorkflow(file) {
  const raw = readFileSync(file, 'utf8');
  return { raw, code: stripComments(raw), doc: parseYaml(raw, path.basename(file)) };
}

const audit = readWorkflow(AUDIT_WORKFLOW);
const security = readWorkflow(SECURITY_WORKFLOW);

test('pull-request security gates load only from the protected base branch', () => {
  const triggers = Object.keys(security.doc.on);
  assert.equal(triggers.includes('pull_request'), false);
  assert.equal(triggers.includes('pull_request_target'), true);

  for (const [name, job] of Object.entries(security.doc.jobs)) {
    const checkouts = checkoutSteps(job);
    assert.equal(checkouts.length, 2, `${name}: controller and target checkouts are required`);
    const [controller, target] = checkouts;
    assert.equal(controller.with.ref, '${{ github.sha }}');
    assert.equal(controller.with.path, undefined);
    assert.equal(controller.with['persist-credentials'], 'false');
    assert.equal(target.with.path, 'target');
    assert.match(
      target.with.repository,
      /pull_request\.head\.repo\.full_name \|\| github\.repository/,
    );
    assert.match(target.with.ref, /github\.event\.pull_request\.head\.sha \|\| github\.sha/);
    assert.equal(target.with['persist-credentials'], 'false');
    assert.ok(job.steps.indexOf(controller) < job.steps.indexOf(target));
  }

  assert.equal(
    /(?:node|bash|sh)\s+target\//.test(security.code),
    false,
    'no executable may be loaded from the audited checkout',
  );
});

test('audit workflow has no pull request triggers', () => {
  const triggers = Object.keys(audit.doc.on);
  assert.deepEqual(triggers.sort(), ['repository_dispatch', 'schedule']);
  assert.equal(triggers.includes('pull_request'), false);
  assert.equal(triggers.includes('pull_request_target'), false);
  assert.equal(triggers.includes('issue_comment'), false);
  assert.equal(triggers.includes('fork'), false);
  assert.deepEqual(audit.doc.on.repository_dispatch.types, ['security-audit']);
});

test('audit workflow runs weekly on Monday', () => {
  const schedules = audit.doc.on.schedule;
  assert.equal(Array.isArray(schedules), true);
  assert.equal(schedules.length, 1);
  const cron = schedules[0].cron;
  const dayOfWeek = cron.trim().split(/\s+/)[4];
  assert.equal(dayOfWeek, '1');
});

test('audit workflow denies all permissions at workflow level', () => {
  assert.deepEqual(audit.doc.permissions, {});
});

test('audit workflow grants no write permission at all', () => {
  // Every job is read-only. `security-events: write` was removed along with the
  // SARIF path: model findings must never reach code scanning, and the private
  // vulnerability report is authenticated by a step-scoped secret rather than by
  // a `GITHUB_TOKEN` permission (GITHUB_TOKEN cannot request
  // `repository-advisories` in the first place).
  for (const [name, job] of Object.entries(audit.doc.jobs)) {
    assert.ok(job.permissions, `job ${name} must declare explicit permissions`);
    for (const [scope, level] of Object.entries(job.permissions)) {
      assert.notEqual(level, 'write', `job ${name} must not request ${scope}: write`);
    }
  }
});

test('no job requests the security-events scope at any level', () => {
  for (const [name, job] of Object.entries(audit.doc.jobs)) {
    for (const scope of Object.keys(job.permissions ?? {})) {
      assert.notEqual(
        scope,
        'security-events',
        `job ${name} must not request security-events`,
      );
    }
  }
});

test('audit workflow never requests issue or pull-request permissions', () => {
  for (const [name, job] of Object.entries(audit.doc.jobs)) {
    for (const scope of Object.keys(job.permissions ?? {})) {
      assert.notEqual(scope, 'issues', `job ${name} must not touch issues`);
      assert.notEqual(
        scope,
        'pull-requests',
        `job ${name} must not touch pull requests`,
      );
    }
  }
});

test('audit workflow creates no issues, comments or discussions', () => {
  const forbidden = [
    'issues.create',
    'createComment',
    'create-issue',
    'gh issue create',
    'gh pr comment',
    'gh api /repos/.*/issues',
    'peter-evans/create-issue',
  ];
  for (const needle of forbidden) {
    assert.equal(
      new RegExp(needle).test(audit.raw),
      false,
      `workflow must not contain ${needle}`,
    );
  }
});

test('every job declares a timeout and the workflow declares concurrency', () => {
  assert.ok(audit.doc.concurrency, 'workflow must declare concurrency');
  assert.equal(audit.doc.concurrency['cancel-in-progress'], 'false');
  for (const [name, job] of Object.entries(audit.doc.jobs)) {
    assert.ok(
      job['timeout-minutes'],
      `job ${name} must declare timeout-minutes`,
    );
  }
});

test('repository-dispatch payload values flow only through the validator', () => {
  const step = audit.doc.jobs['validate-inputs'].steps.find((entry) =>
    /validate-target\.mjs/.test(entry.run ?? ''),
  );
  assert.ok(step, 'validate-inputs must run validate-target.mjs');
  assert.match(step.env.INPUT_REF, /github\.event\.client_payload\.ref/);
  assert.match(step.env.INPUT_SCOPE, /github\.event\.client_payload\.scope/);
  assert.match(step.env.INPUT_MODEL, /github\.event\.client_payload\.model/);
  assert.match(step.env.INPUT_DRY_RUN, /github\.event\.client_payload\.dry_run/);
  assert.match(step.run, /--ref\s+"\$\{INPUT_REF:-\}"/);
  assert.match(step.run, /--scope\s+"\$\{INPUT_SCOPE:-server-core\}"/);
  assert.match(step.run, /--model\s+"\$\{INPUT_MODEL:-claude-opus-5\}"/);
  assert.match(step.run, /--dry-run\s+"\$\{INPUT_DRY_RUN:-false\}"/);
  assert.equal(/\$\{\{\s*inputs\./.test(audit.code), false);
});

test('all workflow actions are pinned to 40-hex commit SHAs', () => {
  const files = readdirSync(WORKFLOW_DIR).filter((f) => /\.ya?ml$/.test(f));
  assert.ok(files.length >= 3, 'expected the repo workflows to be present');
  for (const file of files) {
    const raw = readFileSync(path.join(WORKFLOW_DIR, file), 'utf8');
    assert.deepEqual(
      checkWorkflowSource(raw, file),
      [],
      `${file}: every action must satisfy the shared YAML-aware pin policy`,
    );
  }
});

test('normal CI runs audit contracts through a non-disclosing wrapper', () => {
  const ci = readWorkflow(CI_WORKFLOW);
  const steps = Object.values(ci.doc.jobs).flatMap((job) => job.steps ?? []);
  const contract = steps.find((step) => /security:audit:ci/.test(step.run ?? ''));
  assert.ok(contract, 'normal CI must run the security contract suite');
  assert.equal(contract.name, 'Validate repository contracts');
  assert.equal(
    /security:audit:(?:test|pins)|check-action-pins|workflow-invariants/.test(ci.code),
    false,
    'the workflow log command must not identify the underlying scanner or test',
  );

  const wrapper = readFileSync(path.join(SCRIPT_DIR, 'ci-contracts.mjs'), 'utf8');
  assert.match(wrapper, /stdio:\s*\['ignore', 'pipe', 'pipe'\]/);
  assert.match(wrapper, /Repository contract validation failed\./);
  assert.equal(/result\.(?:stdout|stderr)/.test(wrapper), false);
  assert.equal(/process\.stdout\.write/.test(wrapper), false);
});

test('model output is never interpolated into a shell command', () => {
  // `${{ }}` is substituted before bash sees the script, so referencing a model
  // response inside `run:` is remote code execution on the runner.
  assert.equal(
    /\$\{\{\s*steps\.[A-Za-z0-9_-]*\.outputs\.response\s*\}\}/.test(audit.raw),
    false,
    'model response must be passed by file path via env, never inlined',
  );
  assert.match(
    audit.raw,
    /RESPONSE_FILE:\s*\$\{\{\s*steps\.[A-Za-z0-9_-]+\.outputs\.response-file\s*\}\}/,
  );
});

test('the model job is gated, environment-protected and tool-less', () => {
  const job = audit.doc.jobs['model-audit'];
  assert.equal(
    job.if,
    '${{ false }}',
    'the unapproved model scaffold must be unconditionally disabled',
  );
  assert.equal(job.environment, 'security-audit-private-report');
  assert.equal(
    /copilot-allow-tools/.test(audit.code),
    false,
    'allowing tools would give the model shell access',
  );
  assert.equal(/--allow-all-tools/.test(audit.code), false);
});

test('the model job is read-only and cannot publish findings anywhere', () => {
  const job = audit.doc.jobs['model-audit'];
  assert.deepEqual(job.permissions, { contents: 'read' });
});

test('the dry-run job holds no secret and publishes nothing', () => {
  const job = audit.doc.jobs['model-audit-dry-run'];
  assert.deepEqual(job.permissions, { contents: 'read' });
  assert.equal(job.environment, undefined);
  const rendered = JSON.stringify(job);
  assert.equal(/COPILOT_PAT/.test(rendered), false);
  assert.equal(/SECURITY_ADVISORY_TOKEN/.test(rendered), false);
  assert.equal(/upload-sarif/.test(rendered), false);
  assert.equal(/upload-artifact/.test(rendered), false);
});

test('dependency install in the audit path never runs repository scripts', () => {
  for (const workflow of [audit, security]) {
    for (const [jobName, job] of Object.entries(workflow.doc.jobs ?? {})) {
      for (const step of job.steps ?? []) {
        const command = step.run ?? '';
        if (!/\bnpm (?:ci|install)\b/.test(command)) continue;
        if (command.includes('--global') || command.includes('-g ')) continue;
        assert.match(
          command,
          /--ignore-scripts/,
          `${jobName}/${step.name ?? '<unnamed>'}: install may execute lifecycle code`,
        );
      }
    }
  }
});

test('no workflow enables the reachability test-mode escape hatch', () => {
  // `SECURITY_AUDIT_TEST_MODE=1` skips the reachable-from-main check. It exists
  // solely for offline unit tests and must never appear in a workflow.
  const files = readdirSync(WORKFLOW_DIR).filter((f) => /\.ya?ml$/.test(f));
  for (const file of files) {
    const raw = readFileSync(path.join(WORKFLOW_DIR, file), 'utf8');
    assert.ok(
      !raw.includes('SECURITY_AUDIT_TEST_MODE'),
      `${file}: workflows must not disable the reachability gate`,
    );
  }
});

test('checkouts do not persist credentials', () => {
  const files = readdirSync(WORKFLOW_DIR).filter((f) => /\.ya?ml$/.test(f));
  for (const file of files) {
    const raw = readFileSync(path.join(WORKFLOW_DIR, file), 'utf8');
    const checkouts = (raw.match(/uses:\s*actions\/checkout@/g) ?? []).length;
    const disabled = (raw.match(/persist-credentials:\s*false/g) ?? []).length;
    assert.equal(
      disabled,
      checkouts,
      `${file}: every checkout must set persist-credentials: false`,
    );
  }
});

test('every continue-on-error step is re-raised by an explicit failure gate', () => {
  // continue-on-error is legitimate when a scanner's findings must be
  // sanitized before the job fails, but only if the outcome is re-raised.
  // Without that gate it is exactly the no-op pattern this change removes.
  const files = readdirSync(WORKFLOW_DIR).filter((f) => /\.ya?ml$/.test(f));
  for (const file of files) {
    const { raw, code, doc } = readWorkflow(path.join(WORKFLOW_DIR, file));
    for (const [jobName, job] of Object.entries(doc.jobs ?? {})) {
      for (const step of job.steps ?? []) {
        if (step['continue-on-error'] !== 'true') continue;
        assert.ok(
          step.id,
          `${file}/${jobName}: continue-on-error step needs an id`,
        );
        assert.match(
          raw,
          new RegExp(`steps\\.${step.id}\\.outcome == 'failure'`),
          `${file}/${jobName}: step ${step.id} tolerates failure but never re-raises it`,
        );
      }
    }
    assert.equal(
      /continue-on-error:\s*true[\s\S]*?\n\s*-\s+name:[\s\S]*$/.test(code) &&
        !/outcome == 'failure'/.test(code),
      false,
    );
  }
});

// ---------------------------------------------------------------------------
// Controller / target separation.
//
// The commit under audit is untrusted input. Helper scripts must always come
// from the protected default branch (the workflow's own event SHA), and the
// audited tree must always land in `target/`. Checking out the target over the
// workspace root would both execute attacker-controlled scripts and break for
// any historical commit that predates `scripts/security-audit/`.
// ---------------------------------------------------------------------------

// Jobs that execute a helper script from `scripts/security-audit/` and also
// need the audited tree present.
const CONTROLLER_JOBS = [
  'dependency-audit',
  'secret-scan',
  'action-pins',
  'model-audit',
  'model-audit-dry-run',
];

function checkoutSteps(job) {
  return (job.steps ?? []).filter((step) =>
    /^actions\/checkout@/.test(step.uses ?? ''),
  );
}

test('jobs that run helper scripts check out the controller before the target', () => {
  for (const name of CONTROLLER_JOBS) {
    const job = audit.doc.jobs[name];
    assert.ok(job, `job ${name} must exist`);
    const checkouts = checkoutSteps(job);
    assert.equal(
      checkouts.length,
      2,
      `job ${name} must check out the controller and the target separately`,
    );

    const [controller, target] = checkouts;
    assert.equal(
      controller.with.ref,
      '${{ needs.validate-inputs.outputs.controller_sha }}',
      `job ${name}: the controller checkout must be pinned to the validated main SHA, never the event-selected ref`,
    );
    assert.equal(
      controller.with.path,
      undefined,
      `job ${name}: the controller checkout must land at the workspace root`,
    );
    assert.equal(controller.with['persist-credentials'], 'false');

    assert.equal(
      target.with.path,
      'target',
      `job ${name}: the audited tree must be isolated in target/`,
    );
    assert.match(
      target.with.ref,
      /needs\.validate-inputs\.outputs\.target_sha/,
      `job ${name}: the target checkout must use the validated target SHA`,
    );
    assert.equal(target.with['persist-credentials'], 'false');

    assert.ok(
      (job.steps ?? []).indexOf(controller) < (job.steps ?? []).indexOf(target),
      `job ${name}: the controller checkout must run first — actions/checkout runs git clean -ffdx in its destination`,
    );
  }
});

test('every job in the workflow is a known controller job', () => {
  // The CodeQL job was removed rather than silently scan-and-discard: on a
  // public repository, code scanning alerts are world-readable, so uploading
  // SARIF publishes vulnerability locations. Any new job added here must be
  // reviewed against the same non-publication policy.
  const expected = [...CONTROLLER_JOBS, 'validate-inputs'].sort();
  assert.deepEqual(Object.keys(audit.doc.jobs).sort(), expected);
});

test('every public audit job is hard-disabled with an invariant display name', () => {
  assert.equal(audit.doc.name, 'Private security audit (inactive)');
  for (const [jobName, job] of Object.entries(audit.doc.jobs)) {
    assert.equal(
      job.if,
      '${{ false }}',
      `${jobName}: the activation gate must be exactly and unconditionally false`,
    );
    assert.equal(
      job.name,
      'Private audit inactive',
      `${jobName}: public job labels must not identify a scanner or outcome`,
    );
  }
});

test('no helper script is ever executed from the target checkout', () => {
  // Helper scripts are trusted controller code. Running `node target/...`
  // would execute code from the commit under audit.
  assert.equal(
    /node\s+target\//.test(audit.code),
    false,
    'helper scripts must be invoked from the controller checkout',
  );
  assert.equal(
    /working-directory:\s*target\/scripts/.test(audit.code),
    false,
    'helper scripts must not run with the audited tree as their working directory',
  );
  const invocations = audit.code.match(/node\s+\S*scripts\/security-audit\/\S+/g) ?? [];
  assert.ok(invocations.length > 0, 'expected helper script invocations');
  for (const invocation of invocations) {
    assert.match(
      invocation,
      /node\s+(?:"\$\{GITHUB_WORKSPACE\}\/)?scripts\/security-audit\//,
      `helper invocations must stay on the controller checkout: ${invocation}`,
    );
  }
});

test('dependency audit stays lockfile-only inside a runner-owned workspace', () => {
  for (const [label, workflow, jobName, packagePrefix] of [
    ['weekly audit', audit, 'dependency-audit', 'target/'],
    ['pull-request gate', security, 'audit', 'target/'],
  ]) {
    const job = workflow.doc.jobs[jobName];
    const prepare = (job.steps ?? []).find((step) =>
      /Prepare isolated dependency workspace/.test(step.name ?? ''),
    );
    assert.ok(prepare, `${label}: isolated workspace preparation is required`);
    assert.match(
      prepare.run,
      new RegExp(`cp ${packagePrefix}package\\.json ${packagePrefix}package-lock\\.json`),
    );
    assert.match(prepare.run, /: > "\$\{NPM_USER_CONFIG\}"/);
    assert.match(prepare.run, /: > "\$\{NPM_GLOBAL_CONFIG\}"/);

    const npmAudit = (job.steps ?? []).find((step) => /^\s*npm audit\b/m.test(step.run ?? ''));
    assert.ok(npmAudit, `${label}: expected an npm audit step`);
    assert.equal(
      npmAudit['working-directory'],
      '${{ runner.temp }}/security-audit-npm',
      `${label}/${npmAudit.name}: npm must not run in the checked-out project`,
    );
    assert.match(npmAudit.run, /validate-npm-audit-inputs\.mjs/);
    assert.match(npmAudit.run, /npm-audit-inputs\.log/);
    assert.match(npmAudit.run, /rm -f "[^"]*npm-audit-inputs\.log"/);
    assert.match(npmAudit.run, /--registry=https:\/\/registry\.npmjs\.org\//);
    assert.match(npmAudit.run, /--userconfig="\$\{NPM_USER_CONFIG\}"/);
    assert.match(npmAudit.run, /--globalconfig="\$\{NPM_GLOBAL_CONFIG\}"/);
    assert.equal(
      /\bnpm ci\b/.test(npmAudit.run),
      false,
      `${label}: dependency audit must not install target-controlled packages`,
    );
    assert.match(npmAudit.run, /--package-lock-only/);
    assert.match(npmAudit.run, /> "[^"]*npm-audit\.json" 2>\/dev\/null/);

    const setupNode = (job.steps ?? []).find((step) =>
      /actions\/setup-node@/.test(step.uses ?? ''),
    );
    assert.equal(setupNode.with.cache, undefined, `${label}: setup-node cache must not consult project npm config`);
  }
});

test('the dormant dependency audit normalizes policy findings without an outcome side channel', () => {
  const steps = audit.doc.jobs['dependency-audit'].steps;
  const npmAudit = steps.find((step) => /^\s*npm audit\b/m.test(step.run ?? ''));
  assert.ok(npmAudit);
  assert.equal(npmAudit['continue-on-error'], undefined);
  assert.match(npmAudit.run, /0\|1\) exit 0/);
  assert.match(npmAudit.run, /\*\) exit 1/);
  assert.equal(
    steps.some((step) => /steps\.audit\.(?:outcome|outputs)/.test(step.if ?? '')),
    false,
  );
});

// ---------------------------------------------------------------------------
// Private report attribution.
//
// The workflow no longer publishes findings to code scanning at all: there is no
// CodeQL job and no SARIF upload. The only egress for a model finding is a
// private vulnerability report, whose summary embeds the audited commit, so a
// historical audit can never be mis-attributed to the current main tip.
// ---------------------------------------------------------------------------

test('no job publishes to code scanning', () => {
  assert.equal(audit.doc.jobs.codeql, undefined, 'the CodeQL job must stay removed');
  assert.equal(
    /codeql-action\//.test(audit.code),
    false,
    'code scanning uploads would publish vulnerability locations on a public repository',
  );
  assert.equal(/upload-sarif/.test(audit.code), false);
  assert.equal(/\.sarif\b/.test(audit.code), false);
});

test('no job uploads an artifact from either security workflow', () => {
  // Artifacts on a public repository are downloadable by anyone, so an audit
  // artifact is a publication channel regardless of intent.
  const files = readdirSync(WORKFLOW_DIR).filter((f) => /\.ya?ml$/.test(f));
  for (const file of files) {
    const code = stripComments(readFileSync(path.join(WORKFLOW_DIR, file), 'utf8'));
    assert.equal(
      /actions\/upload-artifact@/.test(code),
      false,
      `${file}: security findings must not be uploaded as an artifact`,
    );
  }
});

test('the model job submits a private report attributed to the audited commit', () => {
  const job = audit.doc.jobs['model-audit'];
  const submit = (job.steps ?? []).find((step) =>
    /submit-report\.mjs/.test(step.run ?? ''),
  );
  assert.ok(submit, 'the model job must submit a private vulnerability report');
  assert.match(submit.run, /--sha\s+"\$\{TARGET_SHA\}"/);
  assert.match(submit.env.TARGET_SHA, /needs\.validate-inputs\.outputs\.target_sha/);
  assert.match(
    submit.env.SECURITY_ADVISORY_TOKEN,
    /secrets\.SECURITY_ADVISORY_TOKEN/,
  );
  assert.match(submit.run, /> \/dev\/null 2>&1/);
});

test('partial validation submits accepted findings privately before the job fails closed', () => {
  const steps = audit.doc.jobs['model-audit'].steps;
  const validateIndex = steps.findIndex((step) => step.id === 'validate');
  const submitIndex = steps.findIndex((step) => step.id === 'submit');
  const cleanupIndex = steps.findIndex((step) => /Discard model response/.test(step.name ?? ''));
  const gateIndex = steps.findIndex((step) =>
    /steps\.validate\.outcome == 'failure'/.test(step.if ?? ''),
  );

  assert.ok(validateIndex >= 0, 'validation must have a stable outcome id');
  assert.equal(steps[validateIndex]['continue-on-error'], 'true');
  assert.match(steps[validateIndex].run, /> \.security-audit\/model\/validation-diagnostics\.log 2>&1/);
  assert.match(steps[validateIndex].run, /rm -f \.security-audit\/model\/validation-diagnostics\.log/);

  assert.ok(submitIndex > validateIndex, 'private submission must follow validation');
  assert.match(steps[submitIndex].if, /always\(\)/);
  assert.match(steps[submitIndex].if, /hashFiles\('\.security-audit\/model\/report\.json'\)/);
  assert.equal(
    /steps\.validate\.outcome == 'success'/.test(steps[submitIndex].if),
    false,
    'a partial rejection must not suppress accepted findings',
  );

  assert.ok(cleanupIndex > submitIndex, 'runner-local response data must be deleted after submission');
  assert.match(steps[cleanupIndex].run, /rm -f \.security-audit\/model\/report\.json/);
  assert.match(steps[cleanupIndex].run, /rm -f -- "\$\{RESPONSE_FILE\}"/);

  assert.ok(gateIndex > cleanupIndex, 'the validation failure is re-raised only after submission and cleanup');
  assert.match(steps[gateIndex].if, /steps\.submit\.outcome == 'skipped'/);
  assert.equal(steps[gateIndex].run.trim(), 'echo "Security audit: FAIL" >&2\nexit 1');
});

test('a malformed response cannot invoke submission and still fails generically', () => {
  const steps = audit.doc.jobs['model-audit'].steps;
  const validate = steps.find((step) => step.id === 'validate');
  const submit = steps.find((step) => step.id === 'submit');
  const gate = steps.find((step) => /steps\.submit\.outcome == 'skipped'/.test(step.if ?? ''));

  assert.ok(validate && submit && gate);
  assert.match(submit.if, /report\.json/);
  assert.match(gate.if, /steps\.validate\.outcome == 'failure'/);
  assert.equal(/cat |tee |GITHUB_STEP_SUMMARY/.test(validate.run), false);
  assert.equal(/report\.json/.test(gate.run), false);
  assert.equal(/validation|model|finding|rejected|accepted/i.test(gate.run), false);
});

test('the public workflow has no finding-dependent summary or outcome aggregation', () => {
  assert.equal(audit.doc.jobs.summary, undefined);
  assert.equal(/summarize\.mjs/.test(audit.code), false);
  assert.equal(/needs\.[A-Za-z0-9_-]+\.result/.test(audit.code), false);
  assert.equal(/GITHUB_STEP_SUMMARY/.test(audit.code), false);
});

test('the advisory credential is scoped to the submit step, never to inference', () => {
  const job = audit.doc.jobs['model-audit'];
  assert.equal(
    job.env?.SECURITY_ADVISORY_TOKEN,
    undefined,
    'a job-level advisory token would be visible to the model step',
  );
  for (const step of job.steps ?? []) {
    const usesInference = /actions\/ai-inference@|copilot/i.test(step.uses ?? '');
    if (!usesInference) continue;
    assert.equal(
      JSON.stringify(step.env ?? {}).includes('SECURITY_ADVISORY_TOKEN'),
      false,
      `step "${step.name}" must not see the advisory credential`,
    );
  }
  const guard = (job.steps ?? []).find((step) => step.name === 'Require credentials');
  assert.ok(guard, 'the model job needs a credential pre-flight guard');
  assert.equal(guard.env.SECURITY_ADVISORY_TOKEN, undefined);
  assert.equal(guard.env.COPILOT_PAT, undefined);
  assert.match(guard.env.HAS_SECURITY_ADVISORY_TOKEN, /secrets\.SECURITY_ADVISORY_TOKEN != ''/);
  assert.match(guard.env.HAS_COPILOT_PAT, /secrets\.COPILOT_PAT != ''/);

  // The real advisory token value is bound only to the submit process.
  const holders = (job.steps ?? []).filter(
    (step) => step.env?.SECURITY_ADVISORY_TOKEN !== undefined,
  );
  assert.deepEqual(holders.map((step) => step.id), ['submit']);
});

test('the model job fails closed when the advisory credential is missing', () => {
  const job = audit.doc.jobs['model-audit'];
  const guard = (job.steps ?? []).find((step) => step.name === 'Require credentials');
  assert.ok(guard, 'the model job needs a credential pre-flight guard');
  assert.match(guard.run, /HAS_SECURITY_ADVISORY_TOKEN/);
  assert.match(guard.run, /HAS_COPILOT_PAT/);
  assert.match(guard.run, /exit 1/);
  assert.equal(
    /continue-on-error/.test(JSON.stringify(guard)),
    false,
    'the guard must be able to fail the job',
  );
});

test('validate-inputs publishes the outputs the attribution gates depend on', () => {
  const outputs = audit.doc.jobs['validate-inputs'].outputs;
  for (const key of ['target_sha', 'target_ref', 'is_main_tip', 'controller_sha']) {
    assert.ok(outputs[key], `validate-inputs must publish ${key}`);
  }
});

// Repository dispatch is default-branch-only. The validator still checks the
// runner ref as defence in depth, and every job pins its helper checkout to the
// validated main SHA.
test('the trusted dispatch retains a main-ref defence-in-depth guard', () => {
  const job = audit.doc.jobs['validate-inputs'];
  const step = job.steps.find((entry) => /validate-target\.mjs/.test(entry.run ?? ''));
  assert.ok(step, 'validate-inputs must run validate-target.mjs');

  const source = readFileSync(path.join(SCRIPT_DIR, 'validate-target.mjs'), 'utf8');
  const code = stripComments(source);

  // `GITHUB_REF` / `GITHUB_EVENT_NAME` are supplied automatically by the runner.
  assert.match(
    code,
    /GITHUB_EVENT_NAME/,
    'the guard must know which event started the run',
  );
  assert.match(
    code,
    /GITHUB_REF/,
    'the guard must read the controller ref the run was started from',
  );
  assert.match(
    code,
    /refs\/heads\/main/,
    'validate-target must compare the controller ref against refs/heads/main',
  );
  assert.match(
    code,
    /controller_sha/,
    'the validated main SHA must be published so jobs can pin the controller checkout',
  );
});

test('the legacy no-op gitleaks gate is gone from the security workflow', () => {
  const raw = readFileSync(path.join(WORKFLOW_DIR, 'security.yml'), 'utf8');
  const code = stripComments(raw);
  assert.equal(
    /GITLEAKS_LICENSE/.test(code),
    false,
    'the licence gate made the job unconditionally green',
  );
  assert.equal(/gitleaks\/gitleaks-action/.test(code), false);
  assert.match(code, /sha256sum --check --strict/);
  assert.match(code, /case "\$\{status\}" in/);
});

// The model job ships repository source to an external provider. Running it
// before the secret scanner has passed would mean a freshly committed
// credential is egressed to the provider before anyone knows it exists, so the
// dependency edge is part of the security contract rather than an ordering
// preference.
test('the model job cannot run before the secret scan succeeds', () => {
  const needs = audit.doc.jobs['model-audit'].needs;
  assert.ok(Array.isArray(needs), 'model-audit needs must be a list');
  assert.ok(
    needs.includes('validate-inputs'),
    'model-audit consumes validate-inputs outputs',
  );
  assert.ok(
    needs.includes('secret-scan'),
    'no source may reach the provider before the secret scan passes',
  );
});

// Secret-scan output is the one file that can disclose an unrotated
// credential's location. It never leaves the job: the raw report is deleted
// in-job, the sanitized summary is counts only and is consumed solely by the
// fail gate, and nothing is uploaded or written to a job summary. A rule
// identifier paired with a file path tells a reader which file holds which
// credential class, which is pre-rotation disclosure.
test('the secret-scan job keeps every report inside the job', () => {
  const steps = audit.doc.jobs['secret-scan'].steps;
  const sanitizeIndex = steps.findIndex(
    (step) => typeof step.run === 'string' && /rm -f \.security-audit\/gitleaks\.json/.test(step.run),
  );
  assert.ok(sanitizeIndex >= 0, 'the raw gitleaks report must be deleted in-job');

  for (const step of steps) {
    assert.equal(
      /actions\/upload-artifact@/.test(step.uses ?? ''),
      false,
      'no scan output may leave the job as an artifact',
    );
    if (typeof step.run !== 'string') continue;
    assert.equal(
      /GITHUB_STEP_SUMMARY/.test(step.run),
      false,
      'no scan output may reach the public job summary',
    );
  }

  // The console log is a disclosure channel too: gitleaks prints matches.
  const scan = steps.find((step) => step.id === 'scan');
  assert.ok(scan, 'the scan step must be identifiable for the fail gate');
  assert.match(scan.run, /gitleaks-console\.log 2>&1/);
  assert.match(scan.run, /rm -f \.security-audit\/gitleaks-console\.log/);
});

test('the dormant secret scan normalizes finding exits without an outcome side channel', () => {
  const steps = audit.doc.jobs['secret-scan'].steps;
  const scan = steps.find((step) => step.id === 'scan');
  assert.ok(scan);
  assert.equal(scan['continue-on-error'], undefined);
  assert.match(scan.run, /0\|2\) exit 0/);
  assert.match(scan.run, /\*\) exit 1/);
  assert.equal(
    steps.some((step) => /steps\.scan\.(?:outcome|outputs)/.test(step.if ?? '')),
    false,
  );
});

test('pull-request gates expose no finding-dependent result channel', () => {
  const npmSteps = security.doc.jobs.audit.steps;
  const npmAudit = npmSteps.find((step) => /^\s*npm audit\b/m.test(step.run ?? ''));
  assert.ok(npmAudit, 'the protected npm audit step must exist');
  assert.match(npmAudit.run, /validate-npm-audit-inputs\.mjs/);
  assert.match(npmAudit.run, /\[ "\$\{status\}" -ne 0 \] && \[ "\$\{status\}" -ne 1 \]/);
  assert.match(npmAudit.run, /exit 0\s*$/);
  assert.equal(npmAudit['continue-on-error'], undefined);

  const secretSteps = security.doc.jobs.secrets.steps;
  const secretScan = secretSteps.find((step) => /^\s*\.\/gitleaks git\b/m.test(step.run ?? ''));
  assert.ok(secretScan, 'the protected secret scan step must exist');
  assert.match(secretScan.run, /case "\$\{status\}" in/);
  assert.match(secretScan.run, /0\|2\) exit 0/);
  assert.match(secretScan.run, /\*\) exit 1/);
  assert.equal(secretScan['continue-on-error'], undefined);

  for (const [jobName, steps] of [
    ['audit', npmSteps],
    ['secrets', secretSteps],
  ]) {
    assert.equal(
      steps.some((step) => /steps\.(?:audit|scan)\.(?:outcome|outputs)/.test(step.if ?? '')),
      false,
      `${jobName}: no separate step may reveal a finding-dependent result`,
    );
  }
  assert.equal(
    /details were reported privately to maintainers/i.test(security.code),
    false,
    'deterministic checks must not imply that a private report exists',
  );
});

test('gitleaks policy and suppression inputs come only from the protected controller', () => {
  const config = path.join(SCRIPT_DIR, 'gitleaks-controller.toml');
  const ignore = path.join(SCRIPT_DIR, 'gitleaks-controller-ignore');
  assert.equal(existsSync(config), true);
  assert.equal(existsSync(ignore), true);
  assert.match(readFileSync(config, 'utf8'), /useDefault\s*=\s*true/);
  assert.match(readFileSync(config, 'utf8'), /^minVersion\s*=\s*"8\.30\.1"$/m);

  for (const [name, workflow, target] of [
    ['security-audit.yml', audit, 'target'],
    ['security.yml', security, 'target'],
  ]) {
    const scans = Object.values(workflow.doc.jobs)
      .flatMap((job) => job.steps ?? [])
      .filter((step) => /^\s*\.\/gitleaks\s+git\b/m.test(step.run ?? ''));
    assert.ok(scans.length > 0, `${name}: expected a gitleaks scan`);
    for (const scan of scans) {
      assert.match(scan.run, new RegExp(`gitleaks git ${target}\\b`));
      assert.match(scan.run, /--config scripts\/security-audit\/gitleaks-controller\.toml/);
      assert.match(
        scan.run,
        /--gitleaks-ignore-path scripts\/security-audit\/gitleaks-controller-ignore/,
      );
      assert.match(scan.run, /--ignore-gitleaks-allow/);
      assert.match(scan.run, /rm -rf -- target\/\.gitleaks\.toml target\/\.gitleaksignore/);
      assert.equal(/--config\s+target\//.test(scan.run), false);
    }
  }
});

test('the dormant action-pin job captures diagnostics and normalizes policy findings', () => {
  const steps = audit.doc.jobs['action-pins'].steps;
  const installIndex = steps.findIndex((step) => step.name === 'Install audit helper dependencies');
  const check = steps.find((step) => step.id === 'pin-check');
  const checkIndex = steps.indexOf(check);

  assert.ok(installIndex >= 0, 'the YAML-aware checker dependency must be installed');
  assert.ok(installIndex < checkIndex, 'the parser must be installed before the checker runs');
  assert.match(steps[installIndex].run, /npm ci/);
  assert.match(steps[installIndex].run, /--ignore-scripts/);
  assert.match(steps[installIndex].run, /--registry=https:\/\/registry\.npmjs\.org\//);
  assert.equal(
    audit.doc.jobs['secret-scan'].steps.some(
      (step) => step.name === 'Install audit helper dependencies',
    ),
    false,
    'the parser install belongs only in the action-pin job',
  );

  assert.ok(check, 'the action-pin check must exist');
  assert.equal(check['continue-on-error'], undefined);
  assert.match(check.run, /> \.security-audit\/action-pins-diagnostics\.log 2>&1/);
  assert.match(check.run, /rm -f \.security-audit\/action-pins-diagnostics\.log/);
  assert.match(check.run, /0\|2\) exit 0/);
  assert.match(check.run, /\*\) exit 1/);
  assert.equal(/cat |tee |GITHUB_STEP_SUMMARY/.test(check.run), false);
  assert.equal(
    steps.some((step) => /steps\.pin-check\.(?:outcome|outputs)/.test(step.if ?? '')),
    false,
  );
});

// The proposed CLI package is not approved or reproducible from the public npm
// registry, so repository configuration alone must not activate this scaffold.
// A future code review must select the approved version, commit its lockfile and
// remove the hard-disable. The dormant install remains fail-closed and isolated.
test('the Copilot CLI scaffold is hard-disabled pending an approved public lockfile', () => {
  const code = audit.code;
  const job = audit.doc.jobs['model-audit'];
  const lockfile = path.join(REPO_ROOT, 'tools', 'copilot-cli', 'package-lock.json');
  assert.equal(
    /npm install -g/.test(code),
    false,
    'a global ranged install is not reproducible',
  );
  assert.equal(existsSync(lockfile), false, 'an unapproved lockfile must not be committed');
  assert.equal(job.if, '${{ false }}');
  assert.match(code, /npm ci[\s\\]*--ignore-scripts/);
  assert.match(code, /if \[ ! -f tools\/copilot-cli\/package-lock\.json \]/);
  assert.match(code, /--registry=https:\/\/registry\.npmjs\.org\//);
  assert.match(code, /--userconfig="\$\{NPM_USER_CONFIG\}"/);
  assert.match(code, /--globalconfig="\$\{NPM_GLOBAL_CONFIG\}"/);
  assert.match(code, /exit 1/);

  const installIndex = job.steps.findIndex(
    (step) => step.name === 'Install approved Copilot CLI runtime',
  );
  const debugIndex = job.steps.findIndex((step) => step.name === 'Refuse to run under debug logging');
  const corpusIndex = job.steps.findIndex((step) => /collect-corpus\.mjs/.test(step.run ?? ''));
  assert.ok(installIndex >= 0, 'the dormant install guard must remain explicit');
  assert.ok(debugIndex < installIndex, 'the debug guard must precede dependency installation');
  assert.ok(installIndex < corpusIndex, 'the dependency gate must precede source assembly');
  assert.equal(
    job.steps[installIndex].run.includes('tools/copilot-cli/package-lock.json'),
    true,
  );
  assert.equal(
    job.steps[installIndex].run.includes('echo "Security audit: FAIL" >&2'),
    true,
    'the dormant gate must emit only the generic public failure literal',
  );

  const inference = job.steps.find(
    (step) => typeof step.uses === 'string' && step.uses.startsWith('actions/ai-inference@'),
  );
  assert.ok(inference, 'the model job runs the inference action');
  assert.equal(
    inference.with['copilot-cli-path'],
    'tools/copilot-cli/node_modules/.bin/copilot',
  );

  const manifest = JSON.parse(
    readFileSync(path.join(REPO_ROOT, 'tools', 'copilot-cli', 'package.json'), 'utf8'),
  );
  assert.equal(manifest.private, true, 'the tool manifest must never be published');
  const pin = manifest.dependencies['@github/copilot'];
  assert.match(pin, /^\d+\.\d+\.\d+/, 'the Copilot CLI must be pinned to an exact version');
});

// Runner debug logging echoes step inputs, environment and command output
// verbatim into the Actions log, which is world-readable on a public
// repository. Under debug logging the corpus, the prompt and the raw model
// response would all be published. A job cannot opt out of that behaviour, so
// the job must refuse to start -- and it must refuse before anything is
// assembled, installed or sent.
test('the model job refuses to run under debug logging, before any corpus exists', () => {
  const steps = audit.doc.jobs['model-audit'].steps;
  const guardIndex = steps.findIndex(
    (step) =>
      typeof step.env === 'object' &&
      step.env !== null &&
      Object.values(step.env).some((value) => /ACTIONS_STEP_DEBUG/.test(String(value))) &&
      Object.values(step.env).some((value) => /ACTIONS_RUNNER_DEBUG/.test(String(value))),
  );
  assert.ok(guardIndex >= 0, 'a debug-logging guard step must exist');

  const guard = steps[guardIndex];
  assert.ok(
    Object.values(guard.env).some((value) => /runner\.debug/.test(String(value))),
    'the "Enable debug logging" re-run toggle must be covered too',
  );
  assert.match(guard.run, /exit 1/, 'the guard must fail the job, not warn');
  assert.equal(
    /echo\s+"?\$\{?STEP_DEBUG/.test(guard.run),
    false,
    'the guard must test the flags, never print them',
  );

  const laterStep = (pattern) =>
    steps.findIndex(
      (step) =>
        (typeof step.run === 'string' && pattern.test(step.run)) ||
        (typeof step.uses === 'string' && pattern.test(step.uses)),
    );
  for (const [label, pattern] of [
    ['corpus collection', /collect-corpus\.mjs/],
    ['prompt assembly', /build-prompt\.mjs/],
    ['Copilot CLI install', /npm ci[\s\\]*--ignore-scripts/],
    ['inference', /^actions\/ai-inference@/],
  ]) {
    const index = laterStep(pattern);
    assert.ok(index >= 0, `${label} step must exist`);
    assert.ok(
      guardIndex < index,
      `the debug guard must run before ${label}`,
    );
  }
});

// gitleaks prints one block per finding to the console carrying file path,
// line, commit, author and e-mail. `--redact` masks the secret value only, not
// that metadata, and Actions logs are world-readable on a public repository.
// Every scan invocation must therefore discard its console output, and nothing
// may replay a gitleaks log or the raw report back into the log or summary.
test('gitleaks console output is discarded and never replayed', () => {
  const workflows = [
    ['security-audit.yml', audit],
    ['security.yml', readWorkflow(path.join(WORKFLOW_DIR, 'security.yml'))],
  ];

  for (const [name, workflow] of workflows) {
    const steps = Object.values(workflow.doc.jobs)
      .flatMap((job) => job.steps ?? [])
      .filter((step) => typeof step.run === 'string');

    const scans = steps.filter((step) => /^\s*\.\/gitleaks\s+git\b/m.test(step.run));
    assert.ok(scans.length > 0, `${name} must invoke the gitleaks binary`);

    for (const step of scans) {
      assert.match(
        step.run,
        /> \.security-audit\/gitleaks-console\.log 2>&1/,
        `${name}: gitleaks console output must be redirected to a file`,
      );
      assert.match(
        step.run,
        /rm -f \.security-audit\/gitleaks-console\.log/,
        `${name}: the console log must be deleted unread`,
      );
      assert.match(
        step.run,
        /0\|2\) exit 0/,
        `${name}: public results must not distinguish findings from a clean scan`,
      );
    }

    for (const step of steps) {
      assert.equal(
        /\b(cat|head|tail|less)\s+[^\n]*gitleaks-console\.log/.test(step.run),
        false,
        `${name}: the gitleaks console log must never be read back`,
      );
      assert.equal(
        /\b(cat|head|tail|less)\s+[^\n]*\.security-audit\/gitleaks\.json/.test(step.run),
        false,
        `${name}: the raw gitleaks report must never be read back`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// Governance and contributor-disclosure invariants.
//
// These guard the documentation contract reviewed by CELA: the credential model
// must be one that GitHub can actually issue, the open legal questions must stay
// visibly open, contributors must be told what the optional model layer does,
// and the layer itself must stay off.
// ---------------------------------------------------------------------------

const AUDIT_DOC = readFileSync(path.join(REPO_ROOT, 'docs', 'SECURITY-AUDIT.md'), 'utf8');
const CONTRIBUTING_DOC = readFileSync(path.join(REPO_ROOT, 'CONTRIBUTING.md'), 'utf8');
const ROOT_README = readFileSync(path.join(REPO_ROOT, 'README.md'), 'utf8');
const COPILOT_CLI_DOC = readFileSync(
  path.join(REPO_ROOT, 'tools', 'copilot-cli', 'README.md'),
  'utf8',
);

test('credential governance requires a team-owned managed service account', () => {
  // GitHub cannot issue a token to a "team alias" -- a PAT always belongs to an
  // account. Requiring one is an instruction that cannot be followed.
  assert.doesNotMatch(
    AUDIT_DOC,
    /a team alias, not a personal account/,
    'the docs must not ask for a credential model GitHub does not support',
  );

  for (const required of [
    'managed service (machine) GitHub account',
    'Copilot Business or Copilot Enterprise',
    'Individual/Pro seats are disallowed pending CELA',
    'at least two named human owners',
    'explicit expiry',
  ]) {
    assert.ok(
      AUDIT_DOC.includes(required),
      `credential governance must state: ${required}`,
    );
  }

  assert.match(AUDIT_DOC, /cost centre/i, 'premium-request billing must name a cost centre');
  assert.match(AUDIT_DOC, /offboarding checklist/i, 'offboarding must be an explicit obligation');
});

test('future activation determinations are recorded as open, never as approved', () => {
  const heading = '### Future activation determinations (to be completed by CELA/Privacy)';
  const start = AUDIT_DOC.indexOf(heading);
  assert.notEqual(start, -1, 'the activation determinations table must exist');

  const section = AUDIT_DOC.slice(start);
  for (const topic of [/retention/i, /Data residency/, /acceptable-use policy/, /train/i]) {
    assert.match(section, topic, `activation determinations must cover ${topic}`);
  }

  const open = section.match(/Not determined/g) ?? [];
  assert.ok(
    open.length >= 5,
    `every determination must be open; found ${open.length} "Not determined" markers`,
  );

  // Nothing in this repository may assert that legal or privacy review is done.
  assert.doesNotMatch(
    AUDIT_DOC,
    /\bapproved by (CELA|Privacy)\b/i,
    'the docs must not claim CELA or Privacy approval',
  );
});

test('documentation makes no activation-ready or production-schedule claim', () => {
  assert.match(ROOT_README, /not activation-ready/i);
  assert.match(ROOT_README, /no claim that a production weekly audit is active/i);
  assert.match(AUDIT_DOC, /contains an \*\*inactive\*\* security-audit workflow/i);
  assert.match(CONTRIBUTING_DOC, /no claim that a production schedule is active/i);
  assert.match(COPILOT_CLI_DOC, /hard-disabled scaffolding/i);

  assert.doesNotMatch(ROOT_README, /runs a scheduled weekly security audit/i);
  assert.doesNotMatch(AUDIT_DOC, /^## Activating the model-assisted layer$/m);
  assert.doesNotMatch(CONTRIBUTING_DOC, /when a maintainer explicitly enables it/i);
  assert.doesNotMatch(
    COPILOT_CLI_DOC,
    /npm install --package-lock-only/,
    'the blocked scaffold must not present a lockfile-generation activation recipe',
  );
});

test('contributors are told the model layer is disabled by default', () => {
  assert.match(
    CONTRIBUTING_DOC,
    /## Optional model-assisted security analysis/,
    'contributors must be given a disclosure section',
  );
  assert.ok(
    CONTRIBUTING_DOC.includes('**This feature is disabled by default.**'),
    'the disclosure must lead with the disabled-by-default status',
  );

  for (const required of [
    'GitHub Copilot',
    'No separate repository or activity data',
    'No tools, no writes',
    'Advisory and redacted',
    'pull_request_target',
    'maintainer will discuss it with you',
    'docs/SECURITY-AUDIT.md',
  ]) {
    assert.ok(
      CONTRIBUTING_DOC.includes(required),
      `contributor disclosure must state: ${required}`,
    );
  }

  // Wrapped prose: match across the line break rather than pinning the wrap point.
  assert.match(
    CONTRIBUTING_DOC,
    /already-public,\s+git-tracked source files from `main`/,
    'the disclosure must scope the corpus to public tracked source on main',
  );
  assert.match(
    CONTRIBUTING_DOC,
    /third-party\s+model provider/,
    'the disclosure must name the third-party model provider relay',
  );
  assert.match(
    CONTRIBUTING_DOC,
    /does include\s+each selected file's repository-relative path, line count and public source content/,
    'the disclosure must identify the file metadata and content sent to the model',
  );
  assert.match(
    CONTRIBUTING_DOC,
    /may\s+itself contain names, identifiers, credential-shaped strings or environment-variable references/,
    'the disclosure must not make absolute exclusion claims about public source content',
  );
});

test('the model layer remains disabled: nothing in the repository enables it', () => {
  assert.equal(audit.doc.jobs['model-audit'].if, '${{ false }}');

  for (const file of readdirSync(WORKFLOW_DIR)) {
    if (!/\.ya?ml$/.test(file)) continue;
    const raw = readFileSync(path.join(WORKFLOW_DIR, file), 'utf8');
    assert.doesNotMatch(
      raw,
      /SECURITY_AUDIT_AI_ENABLED\s*[:=]\s*['"]?true/,
      `${file} must not set the model-layer variable`,
    );
    assert.doesNotMatch(
      raw,
      /SECURITY_AUDIT_PRIVATE_REPORTING_ENABLED\s*[:=]\s*['"]?true/,
      `${file} must not set the private-reporting variable`,
    );
  }

  assert.ok(
    AUDIT_DOC.includes('The complete workflow is **non-activatable scaffolding**'),
    'the docs must state that the complete workflow cannot be activated',
  );
});
