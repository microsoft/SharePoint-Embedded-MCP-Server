# Repository security audit scaffolding

This repository contains an **inactive** security-audit workflow
([`.github/workflows/security-audit.yml`](../.github/workflows/security-audit.yml)) with a Monday
cadence and a fixed `security-audit` repository-dispatch event. Every job has a literal `false`
activation guard. Scheduled and dispatched runs therefore execute no audit code and expose only
the same skipped state. Repository variables, secrets, or payload values cannot activate it.

The audit has two layers:

| Layer | Jobs | Gating |
| --- | --- | --- |
| **Deterministic scaffold** | dependency audit, secret scan, action pinning | Hard-disabled |
| **Model-assisted scaffold** | `model-audit` / `model-audit-dry-run` | Hard-disabled |

> [!IMPORTANT]
> The complete workflow is **non-activatable scaffolding**, not an activation-ready feature.
> Every job expression is exactly `${{ false }}`, so repository variables and secrets cannot
> start deterministic, synthetic, or model-assisted execution.
> The proposed Copilot CLI version is unavailable from `registry.npmjs.org`, no reproducible
> lockfile is committed, and package/license/CELA/Privacy approvals remain open. A future reviewed
> code change must resolve every item under
> [Blocked prerequisites](#model-assisted-scaffold-blocked-prerequisites) before removing that
> hard-disable.

> [!CAUTION]
> **Disclosure policy — absolute.** Finding existence itself is private. No finding, scanner,
> path, rule identifier, advisory URL, count, exploit detail, or private-submission outcome may
> influence or appear in a public job name, step name, conclusion, log, artifact, pull-request
> annotation, job summary, code-scanning result, public issue, Azure DevOps item, or IcM incident.
> Validated model findings have exactly one designed egress:
> a **private security advisory report** created through GitHub Private Vulnerability Reporting
> (PVR) and visible only to repository maintainers. There is no fallback channel. Because a public
> Actions success/failure conclusion would itself disclose private state, activation stays disabled
> until operational failure and submission handling can satisfy the same invariant. The workflow
> publishes no pass/fail summary.

## What is present but inactive

### Deterministic jobs

| Internal job | Dormant design | Notes |
| --- | --- | --- |
| `validate-inputs` | Normalizes and validates dispatch payload | Hard-disabled |
| `dependency-audit` | Lockfile-only dependency analysis | Hard-disabled; finding exit is normalized and raw output remains runner-local |
| `secret-scan` | Repository-history secret analysis | Hard-disabled; finding exit is normalized and raw output remains runner-local |
| `action-pins` | Immutable action/image policy | Hard-disabled; diagnostics remain runner-local. Dockerfile `ADD` accepts only literal local sources; remote or dynamic/expanded sources fail closed |
| `model-audit` | Model-assisted analysis and PVR submission | Hard-disabled pending all activation prerequisites |
| `model-audit-dry-run` | Synthetic rehearsal | Hard-disabled in public Actions; run locally only |

All public job display names are the same generic inactive label. There is no summary job and no
job-result aggregation. This keeps job, step, and workflow outcomes invariant with respect to
findings and private-report submission state.

The pin contract still runs in normal CI through `scripts/security-audit/ci-contracts.mjs`. That
wrapper captures the complete pin/invariant test output and emits only one generic error if a
repository contract regresses. It never forwards synthetic fixtures, paths, action references, or
scanner output into the public log.

In the dormant design, dependency validation and audit run from a runner-owned directory containing only
`package.json` and `package-lock.json`. The trusted preflight validator rejects unsupported source
forms and workspace-like expansion before npm runs, and `npm audit --package-lock-only` uses empty
runner-owned user/global configuration files plus the explicit public npm registry. A target
`.npmrc`, unrelated project content, and dependency tarballs therefore do not execute or install in
the audit job.

### Code scanning is not part of this workflow

This workflow does **not** run CodeQL and does **not** hold `security-events: write` in any job.
On a public repository, code scanning alerts are publicly visible, so uploading SARIF would
publish vulnerability locations — the exact outcome the disclosure policy forbids. Scanning and
then silently discarding the results would be worse: it would burn the analysis while pretending
a control exists. So the custom CodeQL job was removed outright.

**Model-discovered findings never reach CodeQL or code scanning.** There is no SARIF conversion
step, no SARIF artifact, and no upload path anywhere in `security-audit.yml`.

If the organization wants continuous static analysis, enable GitHub's **default setup** for code
scanning at the repository or organization level and treat it as a separately-owned platform
control with its own visibility model. It is independent of this workflow and receives nothing
from it.

### Dormant controller/target design

If a future activation satisfies every prerequisite, any commit reachable from `main` can be
audited, including commits from before this workflow existed. The design never runs code from the
commit it is auditing:

- **Controller** — the validation job checks out protected `main` and resolves its tip to
  `controller_sha`. Every downstream controller checkout pins that exact SHA at the workspace
  root, independent of the event-selected ref or audited target. This is where
  `scripts/security-audit/**`, `package.json` and the workflow itself come from.
- **Target** — checked out into `target/` at the validated SHA. It is **data**, never an
  executable surface.

Every helper is invoked from the controller checkout and pointed at the target explicitly
(`collect-corpus.mjs --repo-root target`, `check-action-pins.mjs --dir target/.github/workflows
--root target`, target package manifests copied into a runner-owned npm directory, and
`gitleaks git target`).
Tests assert that no `node scripts/security-audit/...` invocation ever resolves out of `target/`.

> **Ordering constraint.** `actions/checkout` runs `git clean -ffdx` in its destination, so a
> root checkout performed *after* a `target/` checkout would delete the target. The controller
> checkout must always come **first**; a test enforces the ordering.

Auditing an ancestor such as `819431d` — a commit with no `scripts/security-audit/` directory at
all — is a supported case and is covered by a regression test.

### Dormant result attribution design

If activated, attribution would be carried entirely inside the private report. Each report's
summary line embeds the audited commit:

```
SPE automated security audit — <first 12 hex of the target SHA>
```

That makes a historical audit unambiguous: the report describes the commit named in its own title,
never "the current tip". Auditing an ancestor is therefore a fully supported case and needs no
suppression rule — earlier revisions of this workflow suppressed historical uploads precisely
because code scanning defines `sha` as *the head of the supplied ref* and cannot describe an
ancestor truthfully. Private reports have no such constraint, so that gate has been removed along
with the upload path it protected.

Findings are never published as a downloadable artifact. On a public repository that would
disclose unfixed vulnerabilities, so it is not offered in any form, for any target.

### Model-assisted job scaffold

`model-audit` is hard-disabled in this PR. If a future reviewed activation change satisfies the
blocked prerequisites, the scaffold is designed to send a **bounded, allowlisted corpus** to a
model and validate every finding before anything is retained:

- Corpus caps: 128 files, 96 KiB per file, 1 MiB total (`scripts/security-audit/lib/constants.mjs`).
- Instruction surfaces (`AGENTS.md`, `CLAUDE.md`, `.github/copilot-instructions.md`, `.github/instructions/`,
  `.github/agents/`, `.copilot/`, `Skills/*/SKILL.md`, …) are denied from the corpus outright, so
  agent-directed text can never be re-presented to the auditing model as repository content.
- Every file is wrapped in **per-run nonce delimiters** — see
  [Prompt-injection containment](#prompt-injection-containment) below.
- The job is tool-less: no MCP servers, no shell, no repository write. `copilot-allow-tools`
  is deliberately left unset (empty means no tools).
- Model output is **never** interpolated into a shell command — only file paths are passed
  through `env:`.
- Findings are rejected outright if they carry tokens, GUIDs, absolute paths, or weaponized
  payloads; e-mail addresses, query strings, and long hex blobs are redacted.
- Findings must anchor to a corpus file and a line inside that file, and must cite a control
  from [`SECURITY-CONTROLS.md`](SECURITY-CONTROLS.md) (or the literal `UNMAPPED`).

### Private vulnerability reporting

After a future approved activation, validated findings are designed to leave the runner through
exactly one channel:
`POST /repos/{owner}/{repo}/security-advisories/reports` — the REST endpoint behind GitHub
**Private Vulnerability Reporting**. `scripts/security-audit/submit-report.mjs` runs inside the
same protected `model-audit` job, *after* the tool-less model process has exited and
`validate-response.mjs` has sanitized the response. If a response contains both accepted and
rejected findings, accepted findings are submitted privately first and the model job then fails
closed. A malformed response writes no report and makes no submission.

| Property | Behaviour |
| --- | --- |
| Cardinality | **One aggregate report per audited commit.** Every accepted finding for that SHA becomes a section of a single report's markdown description — not one report per finding |
| Title | `SPE automated security audit — <first 12 hex of the target SHA>` |
| Severity | The maximum severity across the accepted findings |
| `vulnerabilities` | Deliberately **omitted** — these are source findings, not package advisories |
| `start_private_fork` | `false` |
| Deduplication | Before submitting, the script follows GitHub's cursor `Link` headers through existing `triage`, `draft`, `published` and `closed` reports and matches the exact summary string. Every continuation must remain on `api.github.com` and the same repository advisory endpoint. A re-run for the same SHA is a no-op |
| Visibility | Repository **maintainers only**. A report is not an advisory and is not published; maintainers triage it in the Security tab |
| Retry | Idempotent `GET` requests retry `5xx` at most twice, fixed 5 s apart. A report `POST` is attempted exactly once because a `5xx` can be ambiguous after persistence; retrying could create a duplicate. Every other error **fails the job immediately with no fallback** |
| Output | The standalone CLI writes exactly one result token to stdout and no private metadata. No outcome token or finding-dependent process result may reach public Actions |

If the private channel cannot be used — PVR not enabled, credential missing, endpoint rejecting —
processing must halt fail closed. Findings are not written anywhere else, retried through another
surface, or retained after the job ends. There is no ADO work item, IcM incident, GitHub issue, or
artifact fallback. Activation remains prohibited until that operational state can be conveyed
privately without changing public behavior or conclusion.

Nothing else from the model layer is published: no issues, no comments, no raw-finding artifacts,
no code scanning alerts, no job-summary detail.

### Prompt-injection containment

The corpus is untrusted by construction: it is repository source, and anyone who can land a
commit can write text into it. Containment is layered, and only the last layer is trusted.

1. **Per-run nonce fences.** `collect-corpus.mjs` generates a 24-byte random nonce for every run
   and wraps each file in `<<<SPE_AUDIT_UNTRUSTED_FILE_BEGIN:<nonce>>>>` /
   `…_END:<nonce>>>>`. A static delimiter is forgeable — the literal sentinel already appears in
   this repository's own `constants.mjs` — so any occurrence of the sentinel inside a file body
   is rewritten to a neutral marker before fencing, and a body that somehow contains the live
   nonce aborts the run. After emission the collector re-counts fences and fails unless the
   begin/end counts both equal the file count, so a corpus that can close its own fence never
   reaches the model.
2. **Nonce conveyance.** The nonce is recorded in `corpus-manifest.json`, and `build-prompt.mjs`
   renders it into both prompt files. The model is told the exact fence to expect, so a forged
   fence carrying a different (or no) nonce is visibly not the real boundary.
3. **Trusted suffix, not a privileged role.** `actions/ai-inference` concatenates the system
   prompt and the prompt, so `system-prompt-file` is *not* a separate privileged channel — text
   later in the payload is not inherently less authoritative. The output contract is therefore
   re-asserted **after** the corpus, from `prompt-suffix.md`, as the last thing the model reads.
4. **`validate-response.mjs` is the enforceable boundary.** Everything above is defence in depth
   and none of it is a security control on its own: prompt text cannot be enforced. The schema
   validator is the control. It re-derives the allowlists from `constants.mjs`, requires every
   finding to anchor to a real corpus file and a line that exists in it, rejects secrets/GUIDs/
   absolute paths/weaponized payloads, redacts the rest, and **exits non-zero if anything was
   rejected** (fail-closed). If the model ignores every instruction it was given, the run fails;
   it does not silently emit attacker-shaped output.

## Running it locally

No credentials and no runtime dependencies are needed for the offline path.

```bash
# End-to-end synthetic run: corpus → validation → redaction → report schema check
npm run security:audit:dry-run

# The script test suite (schema, redaction, injection, workflow invariants)
npm run security:audit:test

# Fail if any workflow action is not pinned to a commit SHA
npm run security:audit:pins
```

Both `security:audit:dry-run` and `collect-corpus.mjs` accept `--repo-root <dir>`, which is how
the workflow points the controller's helpers at the `target/` checkout. It defaults to `.`, so
local runs audit the working tree and need no extra flag. Manifest keys stay repository-relative
regardless of the root, so a finding reported against `src/server.ts` reads the same locally and
in CI.

`security:audit:dry-run` writes to `.security-audit/dry-run/` (git-ignored):

| File | Contents |
| --- | --- |
| `corpus-manifest.json` | Complete eligible file inventory, byte/line counts, and the run nonce |
| `system.txt` | Rendered auditor preamble (vocabulary injected from `constants.mjs`) |
| `prompt.txt` | Nonce-fenced corpus followed by the trusted output-contract suffix |
| `model-report.json` | Accepted findings and rejected finding indexes with reason codes |

The dry run validates that `model-report.json` matches the schema `submit-report.mjs` consumes,
then reports success generically. It never contacts GitHub, never builds a report body from real
findings and never prints finding detail.

Individual stages can be run directly — see
[`scripts/security-audit/README.md`](../scripts/security-audit/README.md).

## Dispatch behavior while inactive

The fixed `security-audit` repository-dispatch event remains declared for future design work, but a
dispatch cannot run an audit. Every job is independently blocked by a literal `false` condition, so
scheduled and dispatched runs have the same all-skipped public shape. Payload values, repository
variables, secrets, and environment configuration cannot bypass those gates.

## Local validation and private triage

The normal-CI contract wrapper is the only active automated integration. Maintainers investigating a
generic contract failure should reproduce it on a controlled local workstation:

- `npm run security:audit:test` validates the security-audit contract suite.
- `npm run security:audit:pins` validates immutable external action and Docker references.
- `npm run security:audit:ci` executes both while suppressing their detailed output, matching CI.

The local pin checker exits `0` when compliant, `2` for policy violations, and `1` for an
operational or parsing failure. Local diagnostics can identify paths and references and therefore
must not be copied to public PRs, issues, CI logs, Azure DevOps, or IcM.

Report real vulnerabilities privately per [`SECURITY.md`](../SECURITY.md), using GitHub Private
Vulnerability Reporting. Never open a public issue for an unfixed vulnerability and never record
finding existence or private-submission outcome in an external tracker.

## Model-assisted scaffold: blocked prerequisites

This section is **not an activation procedure**. Every workflow job is hard-disabled by a literal
`false` in its job condition. Repository administrators cannot enable it with variables, secrets,
payloads, or environment configuration. Nothing in this repository stores, references, or reuses a
credential.

The runtime currently recorded in `tools/copilot-cli/package.json` is a proposal only:

- `@github/copilot@1.0.80-1` is not available from `https://registry.npmjs.org/`;
- the corporate registry resolves it through an internal feed, which a public GitHub-hosted runner
  cannot use and which must not be committed into a public lockfile;
- `tools/copilot-cli/package-lock.json` is therefore intentionally absent; and
- package licensing plus CELA and Privacy determinations remain open.

Do **not** generate or commit a lockfile from an internal mirror, and do not replace the package
version merely to make installation pass. Either action would silently choose an unapproved
runtime or make the public workflow dependent on an unavailable private feed.

A future activation requires a separate reviewed change. Before that change may remove the
literal hard-disable, it must provide evidence for all of the following:

1. **Approved, publicly reproducible runtime.** Select a Copilot CLI version approved for this use,
   available directly from `registry.npmjs.org`, and compatible with the pinned
   `actions/ai-inference` revision. Generate the lockfile with the existing npm client and verify
   every `resolved` URL and `sha512-…` integrity value. A clean `npm ci --ignore-scripts` must pass
   with empty user/global npm configuration and the public registry explicitly selected.
2. **CELA and Privacy sign-off.** The model layer sends repository source to a third-party
   inference provider. Every determination below must be recorded before egress is authorized.
3. **Private reporting channel.** Enable GitHub Private Vulnerability Reporting and prove that the
   submission credential can create a private report without any public fallback.
4. **Protected environment and managed credentials.** Create
   `security-audit-private-report` with required reviewers and a `main` deployment rule. Provision
   the team-owned credentials described below; individual-maintainer credentials are not
   acceptable.
5. **Provider/model compatibility.** Validate the allowlisted model and subprocessor chain without
   publishing prompts, responses, findings, counts or submission outcomes.
6. **Private operational handling.** Processing or submission failure must be reported only through
   a maintainer-private channel. Public job, step, and workflow status must remain invariant with
   respect to findings and submission outcome. If that cannot be implemented fail closed without a
   public signal, activation is prohibited.
7. **Code-reviewed enablement.** Only after items 1–6 are approved may a code change remove any
   literal hard-disable. That future redesign must add independently reviewed defence-in-depth
   enablement controls; no repository variable currently exists as an activation mechanism.

No activation may turn a missing credential, processing error, unavailable reporting channel, or
rejected submission into either a success-shaped fallback or a distinguishable public failure.
Operational problems must be conveyed privately and the audit must fail closed. If both conditions
cannot be met, leave every job disabled. No step may write findings anywhere else.

### `COPILOT_PAT` governance requirements

These are prerequisites for step 4, not suggestions. If any cannot be met, leave the entire
workflow disabled.

| Requirement | Obligation |
| --- | --- |
| Account | The token must be issued from a **team-owned managed service (machine) GitHub account**, provisioned through the organization's standard process and recorded in the team's asset inventory. A token issued from an individual maintainer's account is disqualifying: it silently inherits that person's entitlements and dies with their offboarding. |
| Seat | The service account must hold a **Copilot Business or Copilot Enterprise** seat. **Individual/Pro seats are disallowed pending CELA review** — their terms, retention and training posture differ from the business/enterprise agreements. |
| Named owners | Record **at least two named human owners** (primary and backup) for the service account and the token, alongside the environment. A machine account with no named owner is unmaintainable. |
| Scope | Copilot Requests only. Any `repo`, `workflow`, `write:*` or `admin:*` scope is disqualifying. |
| Expiry | Set an **explicit expiry**. Tokens configured with "no expiration" are disqualifying. |
| Rotation | Rotate on a fixed cadence no longer than the organization's standard for CI credentials, and immediately on any suspected exposure. |
| Offboarding | Add the token to the team's **offboarding checklist**. Revoke and reissue whenever a named owner changes role or leaves, and whenever the service account changes hands. |
| Cost centre | Copilot premium requests are metered and billed against the service account's entitlement. Record the **cost centre** that would absorb them before a future enablement; repeated full-corpus runs are not free. |
| Debug logs | The `model-audit` job **fails closed** before any corpus is collected when `ACTIONS_STEP_DEBUG` or `ACTIONS_RUNNER_DEBUG` is set, or when the run was started with "Enable debug logging". Debug logging can flush prompt and response content into logs that are world-readable on a public repository, so the job refuses to run rather than relying on an operator instruction. Disable debug logging and re-run. |

There is **no** alternative credential mechanism implemented. If a different provider or an
OIDC-based flow is adopted later, it must be implemented and reviewed on its own merits — do not
assume it is available.

### Future activation determinations (to be completed by CELA/Privacy)

Nothing in this table is answered, agreed or approved. These are **open questions** that CELA and
Privacy must determine and record before any model enablement change is approved. This repository
makes no claim about any of them; the rows exist so that activation cannot proceed on assumption.

| Determination | Question to be answered | Status |
| --- | --- | --- |
| Prompt/completion retention | How long does the provider retain the prompt (repository source) and the completion, and where is that retention documented? | ☐ Not determined |
| Data residency | In which regions are prompts processed and stored, and is that acceptable for this repository's content? | ☐ Not determined |
| Provider terms and AUP | Do the applicable terms of service and acceptable-use policy permit automated source analysis of this repository under the seat type in use? | ☐ Not determined |
| Model training/improvement | Are prompts or completions used for model training, fine-tuning or product improvement, and can that be disabled? | ☐ Not determined |
| Telemetry and provider-side logging | What request metadata and content is logged provider-side, who can access it, and for how long? | ☐ Not determined |
| Contributor disclosure sufficiency | Is the disclosure in [`../CONTRIBUTING.md`](../CONTRIBUTING.md) sufficient notice to external contributors? | ☐ Not determined |
| Export/third-party review | Are there export-control or third-party-review obligations triggered by sending this source to the provider? | ☐ Not determined |

If any row is unresolved, every literal hard-disable must remain.

Related administrative follow-ups (independent of the model layer):

- Enable **Private Vulnerability Reporting** on the repository. This is a hard prerequisite for
  any future model-assisted layer (see item 3 above) and is also the channel external researchers
  use.
- Enable **native secret scanning** and **push protection** on the repository.
- Keep the generic normal-CI repository-contract check required. Do not require or activate any
  dormant audit job: its public conclusion could reveal finding or submission state.

### Assumption: audited commits are reachable from `main`

`validate-target.mjs` requires the target SHA to be an ancestor of `refs/remotes/origin/main`.
That is the point of the check — it stops a repository-dispatch payload from pointing the audit at
an arbitrary unreviewed commit — but it interacts with the repository's merge settings.

At the time of writing the repository allows **all three** merge methods (merge commit, squash,
rebase). Squash and rebase merges rewrite commits, so a pull request's original head SHA is
**not** reachable from `main` after the merge, and passing it here is rejected by design. Audit
the resulting commit on `main` instead — that is the code that actually ships. Administrators who
want auditing by a PR's original head to work must standardize on merge commits; the audit does
not relax the reachability rule to accommodate rewritten history.

While the workflow is inactive, scheduled runs resolve no target and execute no audit step.

Reachability does **not** imply the commit contains this workflow. Older ancestors are audited
using the controller/target split described above. Auditing a historical commit needs no special
handling: nothing is published, so there is no code-scanning alert to misattribute, and the
private report names the audited commit explicitly — see [Result attribution](#result-attribution).

## Design constraints

- The workflow has **no** `pull_request` or `pull_request_target` trigger, so untrusted forks
  can never reach the audit path or its secrets.
- Workflow-level permissions are `{}` (deny-all); each job re-grants only what it needs.
- Every external action is pinned to a 40-hex commit SHA with the version in a trailing comment.
  The pin checker recursively resolves every workflow-referenced local action and reusable workflow,
  even under broad discovery exclusions such as `dist`, `coverage`, `node_modules`, and
  `.security-audit`. It validates nested `uses:` and `runs.image` references, workflow job and
  service containers, Dockerfiles, version comments, path containment, metadata ambiguity, cycles,
  and symlinks fail closed. Dockerfile image references use an adjacent
  `# pin-version: <version>` comment.
- Dependency audit stays lockfile-only: the workflow validates copied manifests first and never
  installs target-controlled packages in the privileged audit job.
- Checkouts use `persist-credentials: false`.
- Audit logic always executes from the protected `main` controller checkout; the audited commit is
  mounted at `target/` and treated as data.
- Model findings have exactly one egress path: a private vulnerability report visible only to
  maintainers. There is no artifact, job summary, code-scanning, issue or external-tracker
  fallback, and the audited commit is named inside the report itself.
- Public job names, step names, conclusions, and summaries do not vary with finding existence,
  scanner identity, private-report submission, or operational outcome because all audit jobs are
  inactive and there is no result aggregator.
- Dormant deterministic finding exit codes are normalized before any later control flow. Operational
  errors remain fail closed, but activation is prohibited until those errors can be handled without
  a distinguishable public outcome.
