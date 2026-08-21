# Pinned GitHub Copilot CLI (security audit only)

This directory exists for one reason: `.github/workflows/security-audit.yml` runs
[`actions/ai-inference`](https://github.com/actions/ai-inference), which does not
talk to a model directly. It shells out to the **GitHub Copilot CLI**, which must
already be installed on the runner.

The workflow therefore installs the CLI itself. It does **not** use
`npm install -g @github/copilot@<version>`, because a global install resolves
transitive dependencies at install time: the exact bytes executed on the runner
are decided by whatever the registry serves that day. That is not acceptable for
a job that is handed repository source code and a credential.

Instead the CLI is installed with `npm ci --ignore-scripts` from the manifest and
lockfile in this directory, which installs exactly the tree recorded in
`package-lock.json` and fails if the manifest and lockfile disagree.

## Contents

| File | Purpose |
| --- | --- |
| `package.json` | Exact version pin. `private: true`, never published. |
| `package-lock.json` | **Not committed yet — see below.** Integrity-checked dependency tree. |

`tools/` is not listed in the root `package.json` `files` array, so nothing here
is included in the published `@microsoft/spe-mcp` tarball.

## Pinned version and licensing

| Package | Version | License |
| --- | --- | --- |
| `@github/copilot` | `1.0.80-1` (exact, no range) | `SEE LICENSE IN LICENSE.md` (GitHub Copilot CLI terms; review before activation) |
| `detect-libc` | `2.1.2` (only transitive runtime dependency; declared `^2.1.2`) | Apache-2.0 |
| `@github/copilot-<platform>` | `1.0.80-1` (exact) | Ships with `@github/copilot` as `optionalDependencies`; one per platform |

`@github/copilot@1.0.80-1` declares **no** `scripts` field, so `--ignore-scripts`
does not skip anything the package needs. It is used to guarantee that installing
the CLI cannot execute arbitrary install-time code on the runner.

Because `@github/copilot` is not permissively licensed, activation of the
model-assisted audit requires the licensing/CELA sign-off described in
[`docs/SECURITY-AUDIT.md`](../../docs/SECURITY-AUDIT.md).

## Activation prerequisite: generate the lockfile

`package-lock.json` is intentionally **absent from this branch**. It must be
generated once, by a maintainer, on a host that reaches `registry.npmjs.org`
directly:

```bash
cd tools/copilot-cli
npm install --package-lock-only --ignore-scripts
git add package-lock.json
```

Then verify before committing:

- every `resolved` URL points at `https://registry.npmjs.org/`, not at a mirror,
  proxy or internal feed; and
- every `integrity` value is `sha512-…`, not `sha1-…`.

A lockfile generated behind a registry proxy fails both checks: proxies rewrite
`resolved` to internal hostnames and commonly strip `dist.integrity`, leaving npm
to fall back to the weak SHA-1 `shasum`. Committing such a lockfile would look
like supply-chain pinning while pinning nothing verifiable, so this branch does
not ship one.

Until the lockfile is committed, the `Install Copilot CLI` step **fails closed**
with an actionable error rather than falling back to a floating install. This is
safe: the model-assisted job is disabled by default (`vars.SECURITY_AUDIT_AI_ENABLED`),
is gated on a protected environment, and is never a required status check, so the
deterministic scanners are unaffected.

## Updating the pin

1. Bump the exact version in `package.json`.
2. Regenerate `package-lock.json` using the command above and re-run the two
   verification checks.
3. Re-review the upstream license and release notes.

Dependabot watches this directory (`.github/dependabot.yml`), so version bumps
surface as pull requests once the lockfile exists.
