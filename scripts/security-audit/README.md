# `scripts/security-audit`

Zero-dependency Node ESM helpers behind
[`.github/workflows/security-audit.yml`](../../.github/workflows/security-audit.yml).
They use only the Node standard library, so they run with `node` alone — no `npm ci` required.

Operator-facing documentation lives in [`docs/SECURITY-AUDIT.md`](../../docs/SECURITY-AUDIT.md).

## Controller vs target

In CI these scripts always run from a checkout of protected `main` (the *controller*), while the
commit being audited is checked out separately into `target/` and treated purely as data. Scripts
that read repository content therefore accept `--repo-root` (default `.`) so the controller can
point them at the target without ever executing code from it. Locally the default is what you
want — the working tree is both controller and target.

## Scripts

| Script | Purpose | Exit codes |
| --- | --- | --- |
| `validate-target.mjs` | Validates the manual inputs: 40-hex SHA reachable from `main`, allowlisted scope/model, boolean dry-run. An empty/absent ref (scheduled runs) resolves to the `origin/main` tip and is then held to the same rules. Also publishes `target_ref` and `is_main_tip` for provenance | `0` ok, `1` rejected |
| `collect-corpus.mjs` | Collects the allowlisted, capped corpus from `--repo-root`, wraps each file in per-run nonce fences, and writes a manifest with repository-relative keys | `0` ok, `1` error |
| `build-prompt.mjs` | Renders `system.txt` (preamble) and `prompt.txt` (corpus + trusted suffix) from the manifest nonce | `0` ok, `1` error |
| `validate-response.mjs` | Parses, schema-checks, rejects, and redacts the model response | `0` ok, `1` malformed, `3` unsafe (fail closed) |
| `submit-report.mjs` | Submits the validated report as **one** private vulnerability report per audited SHA, de-duplicated by title. Prints only `report: submitted\|existing\|none\|failed` | `0` ok, `1` failed (fail closed) |
| `sanitize-findings.mjs` | Reduces `npm audit` / gitleaks reports to counts only — no paths, rules, advisory URLs, GHSA or CVE identifiers | `0` ok, `1` error |
| `check-action-pins.mjs` | Fails if any workflow **or composite action** uses an action that is not pinned to a 40-hex SHA | `0` clean, `1` violations |
| `summarize.mjs` | Emits the public pass/fail literal and decides pass/fail | `0` pass, `1` a deterministic job failed |
| `dry-run.mjs` | Offline end-to-end run against a synthetic response, honouring `--repo-root` | `0` ok, non-zero on failure |

## Disclosure policy

These scripts operate under an absolute non-disclosure rule: **automated security findings and any
exploit detail never become public.** Nothing here writes findings to job logs, workflow artifacts,
job summaries, pull request annotations, code scanning / SARIF, public issues, Azure DevOps or IcM.
There is no SARIF converter and no artifact upload anywhere in the audit path.

The only egress for a validated model finding is `submit-report.mjs`, which posts to
`POST /repos/{owner}/{repo}/security-advisories/reports` — GitHub Private Vulnerability Reporting,
visible to repository maintainers only. There is no fallback: if that submission cannot happen the
audit fails closed and publishes nothing.

Public output is limited to two literals, produced by `summarize.mjs`:

```text
Security audit: PASS
Security audit: FAIL — details were reported privately to maintainers.
```

`Security audit: PASS` reports the deterministic checks only; it makes no claim about
model-detectable issues.

### `submit-report.mjs` contract

- One aggregate report per audited commit, titled
  `SPE automated security audit — <first 12 hex of the target SHA>`.
- De-duplicated against paginated `triage` **and** `draft` reports by exact title match, so
  re-auditing the same commit does not create a second report.
- Body is built in process: `summary`, markdown `description`, `severity` (the maximum severity
  across findings), `start_private_fork: false`. `vulnerabilities` is deliberately omitted — the
  findings are source-level, not package-level.
- Stdout is exactly one line: `report: submitted`, `report: existing`, `report: none` or
  `report: failed`. Response bodies, status codes, GHSA identifiers and URLs are never printed.
- `5xx` responses are retried at most twice with a fixed 5s delay. Every other error fails closed.
- Credentials come only from `SECURITY_ADVISORY_TOKEN`; configuration only from environment and
  path arguments. `SECURITY_AUDIT_API_BASE` exists for tests and accepts an `http:` loopback origin
  only, so a workflow cannot redirect submissions to a non-GitHub host.

## Prompt assembly

`actions/ai-inference` **concatenates** the system prompt and the prompt, so `system-prompt-file`
is not a privileged channel. The payload is therefore assembled deliberately:

1. `collect-corpus.mjs` generates a 24-byte run nonce, rewrites any occurrence of the static
   delimiter sentinel inside a file body to a neutral marker, fences every file with
   `<<<SPE_AUDIT_UNTRUSTED_FILE_BEGIN:<nonce>>>>` / `…_END:<nonce>>>>`, then re-counts the fences
   and fails unless both counts equal the file count. It records the nonce in
   `corpus-manifest.json`.
2. `build-prompt.mjs` reads that manifest, re-verifies the nonce shape and fence integrity, and
   renders two templates — injecting the nonce, the fences, and the category/severity/confidence
   vocabularies straight from `lib/constants.mjs`, so the prompt can never drift from the
   validator. Unresolved `{{TOKEN}}` placeholders are a hard error.
3. `prompt.txt` = fenced corpus + `prompt-suffix.md`. The output contract is re-asserted **after**
   the untrusted content, as the last thing the model reads.

None of this is a security control on its own. `validate-response.mjs` is the enforceable
boundary: it re-derives the allowlists from `constants.mjs`, requires each finding to anchor to a
real corpus file and line, rejects credentials/GUIDs/absolute paths/weaponized payloads, and exits
non-zero if anything was rejected.

`prompt.md` and `prompt-suffix.md` are templates, not literal payloads — read the rendered
`system.txt` / `prompt.txt` from a dry run to see what is actually sent.

## Layout

```
lib/constants.mjs    single source of truth: caps, allowlists, nonce API, statuses
lib/mini-yaml.mjs    fail-closed YAML-subset parser used by the tests
lib/controls.mjs     parses docs/SECURITY-CONTROLS.md into a code set
lib/redaction.mjs    reject/redact pattern sets
prompt.md            auditor preamble template  -> rendered to system.txt
prompt-suffix.md     trusted output contract    -> appended after the corpus
fixtures/            synthetic, malformed, unsafe, injection and delimiter fixtures
tests/               node:test suites (no vitest, no coverage thresholds)
```

## Common invocations

```bash
node scripts/security-audit/validate-target.mjs --ref <40-hex-sha> --scope server-core
node scripts/security-audit/validate-target.mjs --scope server-core   # empty ref -> origin/main tip
node scripts/security-audit/collect-corpus.mjs  --scope server-core --out .security-audit
node scripts/security-audit/build-prompt.mjs    --corpus .security-audit --out .security-audit
node scripts/security-audit/validate-response.mjs \
  --response .security-audit/response.txt \
  --manifest .security-audit/corpus-manifest.json \
  --out      .security-audit/model-report.json
node scripts/security-audit/check-action-pins.mjs
```

The CI shape, where the audited commit lives under `target/`:

```bash
node scripts/security-audit/collect-corpus.mjs \
  --scope server-core --out .security-audit --repo-root target
node scripts/security-audit/check-action-pins.mjs \
  --dir target/.github/workflows --root target
```

`validate-target.mjs` needs `refs/remotes/origin/main` to exist locally (the workflow checks out
with `fetch-depth: 0`). `SECURITY_AUDIT_TEST_MODE=1` skips only the reachability check and is used
by the test suite; no workflow sets it, and a test asserts that.

Or via npm: `security:audit:dry-run`, `security:audit:test`, `security:audit:pins`.

## Tests

```bash
npm run security:audit:test
```

- `pipeline.test.mjs` — target validation (scheduled/empty ref resolves to the `origin/main` tip,
  branch names and short SHAs refused, unreachable SHAs refused, scope/model allowlists), corpus
  caps, per-run nonce fences (two runs never share a nonce, a malformed nonce throws, the
  repository's own `constants.mjs` is neutralized, and a forged-delimiter fixture cannot close the
  fence), prompt assembly (the nonce reaches both rendered files, no `{{PLACEHOLDER}}` survives,
  the trusted suffix follows the last corpus fence, and the vocabulary is injected from
  `constants.mjs` so it cannot drift), schema validation, every rejection reason,
  credential/shell smuggling, prompt injection, findings-cap overflow, redaction, sanitizers
  reducing to counts with no advisory URLs, composite-action pin coverage, the public summary
  emitting only the two approved literals, the offline dry run, `--repo-root` isolation (the corpus
  reads the audited tree, not the controller cwd, and keys stay repository-relative), the
  historical-ancestor regression using a commit that predates these scripts, and a repo walk
  proving no script creates issues, comments, or repository writes.
- `submit-report.test.mjs` — the private reporting path, driven entirely against a loopback
  `node:http` stub via `SECURITY_AUDIT_API_BASE`; **no test contacts GitHub.** Covers the request
  body shape (no `vulnerabilities`, `start_private_fork: false`, maximum severity, title prefix and
  length caps), `201` submission, de-duplication across paginated `triage` and `draft` states,
  empty findings performing no HTTP at all, `403`/`404`/`422` failing closed, `5xx` retried at most
  twice then failing closed, network errors failing closed, the absence of a credential preventing
  any POST, and stdout being restricted to the four allowed `report:` tokens with no status codes,
  bodies, GHSA identifiers or URLs.
- `workflow-invariants.test.mjs` — parses the real workflow YAML and asserts: no PR triggers,
  weekly Monday schedule, deny-all workflow permissions, **no write permission of any kind** (no
  `security-events: write` anywhere — model findings never reach code scanning), per-job timeouts
  and concurrency, allowlisted inputs, 40-hex action pins, no shell interpolation of model output,
  the model job is gated on two separate opt-in variables, environment-protected and tool-less, the
  advisory credential is exposed only to the submit step and never to inference, no job uploads
  artifacts, no job writes to `$GITHUB_STEP_SUMMARY` except the generic pass/fail literal,
  `--ignore-scripts` in the audit path, no workflow sets `SECURITY_AUDIT_TEST_MODE` (the
  reachability escape hatch stays unreachable from CI), `persist-credentials: false`, every
  `continue-on-error` step is re-raised, the controller checkout precedes the `target/` checkout in
  every job that runs a helper, helpers and `npm` are confined to `target/` as data, the submit step
  carries the audited SHA, and the legacy no-op gitleaks gate is gone.

Fixtures never contain a literal credential; token-shaped strings are constructed at runtime so
the repository's own secret scanner does not flag its test data.
