# Weekly repository security audit

This repository runs a scheduled security audit
([`.github/workflows/security-audit.yml`](../.github/workflows/security-audit.yml)) every Monday,
plus on demand via **Actions → Weekly security audit → Run workflow**.

The audit has two layers:

| Layer | Jobs | Gating |
| --- | --- | --- |
| **Deterministic** | dependency audit, secret scan, action pinning | Failures fail the run |
| **Model-assisted** | `model-audit` (real) / `model-audit-dry-run` (synthetic) | Never gating; findings are reported privately |

> [!IMPORTANT]
> The model-assisted layer ships **disabled**, and it stays disabled until an administrator
> completes the [activation checklist](#activating-the-model-assisted-layer) — which includes
> enabling **private vulnerability reporting** on the repository and provisioning a protected
> advisory credential. There is no partially-enabled mode: if any prerequisite is missing the
> job fails closed rather than running without a private reporting channel.

> [!CAUTION]
> **Disclosure policy — absolute.** Nothing this workflow discovers is ever published. No
> finding, path, rule identifier, advisory URL, count or exploit detail is written to a public
> log, an Actions artifact, a pull-request annotation, code scanning, a public issue, Azure
> DevOps or IcM. Validated model findings leave the runner through exactly one channel:
> a **private security advisory report** created through GitHub Private Vulnerability Reporting
> (PVR) and visible only to repository maintainers. There is **no** fallback channel — if the
> private channel is unavailable the run fails and the findings are discarded with the runner.
>
> The only two strings the run may write to a public job summary are:
>
> - `Security audit: PASS`
> - `Security audit: FAIL — details were reported privately to maintainers.`
>
> `Security audit: PASS` means the deterministic checks passed. It is **not** a statement that
> the repository is free of vulnerabilities, and it makes no claim about the model layer.

## What runs

### Deterministic jobs

| Job | What it does | Notes |
| --- | --- | --- |
| `validate-inputs` | Normalizes and validates the manual inputs | Target must be a 40-hex SHA reachable from `main`; scope and model come from allowlists. Scheduled runs supply no ref, so the current `origin/main` tip is resolved to a full SHA and then validated by the same rules |
| `dependency-audit` | `npm audit --audit-level=high` | The raw JSON never leaves the runner. It is reduced in-job to severity **counts only** — no package names, versions, advisory identifiers or advisory URLs — and the counts are not published either |
| `secret-scan` | Gitleaks **CLI**, downloaded at a pinned version and SHA256-verified | Nothing is published. Rule identifiers, file paths, line numbers, commit metadata and the matched secret never leave the runner; the raw report and the scanner console output are discarded inside the job. Counts are computed for in-job gating only |
| `action-pins` | Fails if any workflow uses a mutable action ref | Enforces 40-hex commit pinning recursively across `.github/workflows` **and** every composite `action.yml`/`action.yaml` in the repository. Pin regressions are configuration errors, not vulnerabilities, so a generic failure message is sufficient |
| `summary` | Emits the generic public pass/fail literal | Fails the run if any deterministic job did not succeed. It renders no job names, targets, scopes or counts |

Dependency installation in the audit path uses `npm ci --ignore-scripts`, so no repository
lifecycle script executes while untrusted content is being collected.

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

### Trusted controller vs audited target

Any commit reachable from `main` can be audited, including commits from before this workflow
existed. The audit therefore never runs code from the commit it is auditing:

- **Controller** — the validation job checks out protected `main` and resolves its tip to
  `controller_sha`. Every downstream controller checkout pins that exact SHA at the workspace
  root, independent of the event-selected ref or audited target. This is where
  `scripts/security-audit/**`, `package.json` and the workflow itself come from.
- **Target** — checked out into `target/` at the validated SHA. It is **data**, never an
  executable surface.

Every helper is invoked from the controller checkout and pointed at the target explicitly
(`collect-corpus.mjs --repo-root target`, `check-action-pins.mjs --dir target/.github/workflows
--root target`, `npm ci`/`npm audit` under `working-directory: target`, `gitleaks git target`).
Tests assert that no `node scripts/security-audit/...` invocation ever resolves out of `target/`.

> **Ordering constraint.** `actions/checkout` runs `git clean -ffdx` in its destination, so a
> root checkout performed *after* a `target/` checkout would delete the target. The controller
> checkout must always come **first**; a test enforces the ordering.

Auditing an ancestor such as `819431d` — a commit with no `scripts/security-audit/` directory at
all — is a supported case and is covered by a regression test.

### Result attribution

Because there is no upload path, attribution is carried entirely inside the private report. Each
report's summary line embeds the audited commit:

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

### Model-assisted job

`model-audit` sends a **bounded, allowlisted corpus** to a model and validates every finding
before anything is retained:

- Corpus caps: 40 files, 96 KiB per file, 512 KiB total (`scripts/security-audit/lib/constants.mjs`).
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

Validated findings leave the runner through exactly one channel:
`POST /repos/{owner}/{repo}/security-advisories/reports` — the REST endpoint behind GitHub
**Private Vulnerability Reporting**. `scripts/security-audit/submit-report.mjs` runs inside the
same protected `model-audit` job, *after* the tool-less model process has exited and
`validate-response.mjs` has accepted the response.

| Property | Behaviour |
| --- | --- |
| Cardinality | **One aggregate report per audited commit.** Every accepted finding for that SHA becomes a section of a single report's markdown description — not one report per finding |
| Title | `SPE automated security audit — <first 12 hex of the target SHA>` |
| Severity | The maximum severity across the accepted findings |
| `vulnerabilities` | Deliberately **omitted** — these are source findings, not package advisories |
| `start_private_fork` | `false` |
| Deduplication | Before submitting, the script pages through the repository's existing `triage` **and** `draft` reports and matches on the exact summary string. A re-run for the same SHA is a no-op |
| Visibility | Repository **maintainers only**. A report is not an advisory and is not published; maintainers triage it in the Security tab |
| Retry | `5xx` only, at most twice, fixed 5 s apart. Every other error — `401`, `403`, `404`, `422`, network failure, malformed body — **fails the job immediately with no fallback** |
| Output | Exactly one line on stdout: `report: submitted`, `report: existing`, `report: none` or `report: failed`. No status code, response body, GHSA identifier or advisory URL is ever printed |

If the private channel cannot be used — PVR not enabled, credential missing, endpoint rejecting —
the run **fails**. Findings are not written anywhere else, not retried through another surface,
and not retained after the job ends. There is no ADO work item, no IcM incident, no GitHub issue
and no artifact fallback, by design.

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
| `corpus-manifest.json` | Files collected, byte/line counts, skipped files, the run nonce |
| `system.txt` | Rendered auditor preamble (vocabulary injected from `constants.mjs`) |
| `prompt.txt` | Nonce-fenced corpus followed by the trusted output-contract suffix |
| `model-report.json` | Accepted findings, rejected findings with reasons, redaction count |

The dry run validates that `model-report.json` matches the schema `submit-report.mjs` consumes,
then reports success generically. It never contacts GitHub, never builds a report body from real
findings and never prints finding detail.

Individual stages can be run directly — see
[`scripts/security-audit/README.md`](../scripts/security-audit/README.md).

## Triaging results

1. **A failing run tells you only that it failed.** The public summary is `Security audit: FAIL —
   details were reported privately to maintainers.` and nothing else — no job name, no scanner
   identity, no rule, no path, no count. That is deliberate: this repository is public, so Actions
   logs, job summaries and artifacts are world-readable. Start triage from the job list (which job
   is red) and reproduce locally.
2. **Dependency findings reproduce locally.** Clone the repository, check out the audited commit,
   then run `npm ci --ignore-scripts && npm audit --audit-level=high`. The workflow writes the raw
   JSON report to the runner's workspace, reduces it to counts, and deletes it — the report is
   never uploaded and the counts are never published.
3. **Secret-scan hits publish nothing at all.** Neither rule identifiers nor file paths nor counts
   leave the job. A rule id paired with a path states which file holds which class of credential,
   which is exactly the pre-rotation disclosure an attacker wants — and the scanner's console
   output repeats file path, line, commit, author and e-mail for every finding, so it is discarded
   inside the job and the raw Gitleaks report is deleted before the job ends. To locate a hit,
   reproduce the scan **locally, at the commit the run audited**, on a machine you control:
   `git clone <repo> && cd <repo> && git checkout <target-sha>` then
   `gitleaks git . --redact --no-banner`. Rotate the credential *before* removing it from source,
   then re-run the workflow to confirm. Keep the local report on the workstation — do not paste
   rule identifiers or paths into an issue, a pull request or any other public surface.
4. **Action-pin failures are configuration errors, not vulnerabilities.** Run
   `npm run security:audit:pins` locally; the output names the offending workflow and action.
5. **Model findings arrive as a private report.** Open the repository's **Security → Advisories**
   tab and look for `SPE automated security audit — <12hex>`. Each accepted finding carries a
   confidence and a control anchor: they are leads, not verdicts. Confirm the code path by hand
   before acting. A high rejection count usually means the model drifted off the corpus or
   attempted to smuggle content — treat it as a signal about the run, not about the code.
6. **Report real vulnerabilities privately** per [`SECURITY.md`](../SECURITY.md), through the same
   Private Vulnerability Reporting channel the automated audit uses. Never open a public issue for
   an unfixed vulnerability, and never file one in an external tracker.

## Activating the model-assisted layer

The model layer ships **disabled**. Nothing in this repository stores, references or reuses a
credential, and the deterministic jobs are fully functional without one. Activation requires
repository-administrator rights and is deliberately **not** automated.

**Approval gate.** The model layer sends repository source to a third-party inference provider.
Obtain **CELA and Privacy sign-off before setting `SECURITY_AUDIT_AI_ENABLED`**. Enabling the
variable is the act that authorizes egress; every other step below is inert without it.

**Two switches, both required.** The job runs only when `SECURITY_AUDIT_AI_ENABLED` **and**
`SECURITY_AUDIT_PRIVATE_REPORTING_ENABLED` are both `true`. The second variable exists so that
the model layer can never run before the private reporting channel is available: without a place
to send findings privately, the only remaining options would be to publish them or to discard
them, and both are unacceptable. There is no partially-enabled mode.

Steps, in order:

1. **Generate and commit the Copilot CLI lockfile.** The install step fails closed when
   `tools/copilot-cli/package-lock.json` is absent. Generate it on a network with direct access
   to `registry.npmjs.org` and verify the `resolved` and `integrity` fields before committing —
   see [`tools/copilot-cli/README.md`](../tools/copilot-cli/README.md).
2. **Enable Private Vulnerability Reporting on the repository** (Settings → Code security →
   Private vulnerability reporting). This is a hard prerequisite: the submission endpoint returns
   an error while it is off, and the job fails closed rather than falling back to any other
   surface.
3. **Create and protect the `security-audit-private-report` environment**: required reviewers,
   plus a deployment-branch rule limited to `main`.
4. **Provision a team-owned managed service account, then add a least-scope `COPILOT_PAT`
   environment secret** (Copilot Requests only — no `repo`, no `workflow`, no `write:*`).
   GitHub has no "team alias" credential: a personal access token is always bound to a GitHub
   *account*, so the token must be issued from a **managed service (machine) account owned by the
   team**, never from an individual maintainer's account. This is the only supported credential
   path; see the governance requirements below.
5. **Add the `SECURITY_ADVISORY_TOKEN` environment secret to the same environment.** The workflow
   `GITHUB_TOKEN` **cannot** be granted the `repository-advisories` permission — GitHub Actions
   does not expose it — so a separate credential is unavoidable. Use, in order of preference:
   - a **short-lived GitHub App installation token** for an App installed on this repository only,
     with *Repository security advisories: write*, minted per run; or
   - a **fine-grained personal access token** scoped to this single repository with *Repository
     security advisories: write* and no other permission, issued from the same team-managed
     service account and governed by the same rules as `COPILOT_PAT`.

   The token is exposed to the submission step only. It is not present in the environment of the
   corpus, prompt, install or inference steps, so the model process never sees a credential that
   can write to the repository.
6. **Set the repository variables `SECURITY_AUDIT_AI_ENABLED` and
   `SECURITY_AUDIT_PRIVATE_REPORTING_ENABLED` to `true`.** The job stays skipped until both
   variables exist, so the protected environment is never implicitly created.
7. **Validate the model id** is accepted by the provider before the first real run. The allowlist
   holds exactly **one** model for the MVP (`claude-opus-5`), so the provider and subprocessor
   chain is fixed and reviewable. Adding a second model widens that chain and requires its own
   CELA/Privacy determination — it is not a configuration change. `claude-opus-5` is an allowlist
   entry that has not been exercised end to end.

A missing credential, a disabled reporting channel or a rejected submission **fails the job**. No
step degrades to a pass, and no step writes the findings anywhere else.

### `COPILOT_PAT` governance requirements

These are prerequisites for step 4, not suggestions. If any cannot be met, leave the layer
disabled — the deterministic jobs are unaffected.

| Requirement | Obligation |
| --- | --- |
| Account | The token must be issued from a **team-owned managed service (machine) GitHub account**, provisioned through the organization's standard process and recorded in the team's asset inventory. A token issued from an individual maintainer's account is disqualifying: it silently inherits that person's entitlements and dies with their offboarding. |
| Seat | The service account must hold a **Copilot Business or Copilot Enterprise** seat. **Individual/Pro seats are disallowed pending CELA review** — their terms, retention and training posture differ from the business/enterprise agreements. |
| Named owners | Record **at least two named human owners** (primary and backup) for the service account and the token, alongside the environment. A machine account with no named owner is unmaintainable. |
| Scope | Copilot Requests only. Any `repo`, `workflow`, `write:*` or `admin:*` scope is disqualifying. |
| Expiry | Set an **explicit expiry**. Tokens configured with "no expiration" are disqualifying. |
| Rotation | Rotate on a fixed cadence no longer than the organization's standard for CI credentials, and immediately on any suspected exposure. |
| Offboarding | Add the token to the team's **offboarding checklist**. Revoke and reissue whenever a named owner changes role or leaves, and whenever the service account changes hands. |
| Cost centre | Copilot premium requests are metered and billed against the service account's entitlement. Record the **cost centre** that absorbs them before enabling; a weekly run over the full corpus is not free. |
| Debug logs | The `model-audit` job **fails closed** before any corpus is collected when `ACTIONS_STEP_DEBUG` or `ACTIONS_RUNNER_DEBUG` is set, or when the run was started with "Enable debug logging". Debug logging can flush prompt and response content into logs that are world-readable on a public repository, so the job refuses to run rather than relying on an operator instruction. Disable debug logging and re-run. |

There is **no** alternative credential mechanism implemented. If a different provider or an
OIDC-based flow is adopted later, it must be implemented and reviewed on its own merits — do not
assume it is available.

### Activation determinations (to be completed by CELA/Privacy)

Nothing in this table is answered, agreed or approved. These are **open questions** that CELA and
Privacy must determine and record before `SECURITY_AUDIT_AI_ENABLED` is set. This repository makes
no claim about any of them; the rows exist so that activation cannot proceed on assumption.

| Determination | Question to be answered | Status |
| --- | --- | --- |
| Prompt/completion retention | How long does the provider retain the prompt (repository source) and the completion, and where is that retention documented? | ☐ Not determined |
| Data residency | In which regions are prompts processed and stored, and is that acceptable for this repository's content? | ☐ Not determined |
| Provider terms and AUP | Do the applicable terms of service and acceptable-use policy permit automated source analysis of this repository under the seat type in use? | ☐ Not determined |
| Model training/improvement | Are prompts or completions used for model training, fine-tuning or product improvement, and can that be disabled? | ☐ Not determined |
| Telemetry and provider-side logging | What request metadata and content is logged provider-side, who can access it, and for how long? | ☐ Not determined |
| Contributor disclosure sufficiency | Is the disclosure in [`../CONTRIBUTING.md`](../CONTRIBUTING.md) sufficient notice to external contributors? | ☐ Not determined |
| Export/third-party review | Are there export-control or third-party-review obligations triggered by sending this source to the provider? | ☐ Not determined |

If any row is unresolved, leave the layer disabled. The deterministic jobs are unaffected and
continue to run on schedule.

Related administrative follow-ups (independent of the model layer):

- Enable **Private Vulnerability Reporting** on the repository. This is a hard prerequisite for
  the model-assisted layer (see step 2 above) and is also the channel external researchers use.
- Enable **native secret scanning** and **push protection** on the repository.
- Add the deterministic jobs as **required status checks** in the organization ruleset.
  Do **not** make the model job a required check. It is advisory, non-deterministic, and its
  findings are delivered privately rather than as a public check result.

### Assumption: audited commits are reachable from `main`

`validate-target.mjs` requires the target SHA to be an ancestor of `refs/remotes/origin/main`.
That is the point of the check — it stops a dispatch from pointing the audit at an arbitrary
unreviewed commit — but it interacts with the repository's merge settings.

At the time of writing the repository allows **all three** merge methods (merge commit, squash,
rebase). Squash and rebase merges rewrite commits, so a pull request's original head SHA is
**not** reachable from `main` after the merge, and passing it here is rejected by design. Audit
the resulting commit on `main` instead — that is the code that actually ships. Administrators who
want dispatch-by-PR-head to work must standardize on merge commits; the audit intentionally does
not relax the reachability rule to accommodate rewritten history.

Scheduled runs are unaffected: they supply no ref, so the current `origin/main` tip is resolved
and validated by the same rules.

Reachability does **not** imply the commit contains this workflow. Older ancestors are audited
using the controller/target split described above. Auditing a historical commit needs no special
handling: nothing is published, so there is no code-scanning alert to misattribute, and the
private report names the audited commit explicitly — see [Result attribution](#result-attribution).

## Design constraints

- The workflow has **no** `pull_request` or `pull_request_target` trigger, so untrusted forks
  can never reach the audit path or its secrets.
- Workflow-level permissions are `{}` (deny-all); each job re-grants only what it needs.
- Every action is pinned to a 40-hex commit SHA with the version in a trailing comment, and
  `action-pins` fails the run if that ever regresses.
- Checkouts use `persist-credentials: false`.
- Audit logic always executes from the protected `main` controller checkout; the audited commit is
  mounted at `target/` and treated as data.
- Model findings have exactly one egress path: a private vulnerability report visible only to
  maintainers. There is no artifact, job summary, code-scanning, issue or external-tracker
  fallback, and the audited commit is named inside the report itself.
- The public job summary is one of two fixed literals and carries no scanner identity, path, rule,
  count, advisory link, commit or scope.
- Every `continue-on-error: true` step is paired with an explicit failure gate that re-raises
  the failure after the raw report has been sanitized — a test enforces this invariant.
