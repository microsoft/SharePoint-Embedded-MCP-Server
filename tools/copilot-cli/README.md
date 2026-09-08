# Pinned GitHub Copilot CLI (security audit only)

This directory exists for one reason: `.github/workflows/security-audit.yml` runs
[`actions/ai-inference`](https://github.com/actions/ai-inference), which does not
talk to a model directly. It shells out to the **GitHub Copilot CLI**, which must
already be installed on the runner.

The complete workflow is currently **hard-disabled scaffolding**. Every job
condition is exactly `${{ false }}`, so repository variables and secrets
cannot make any audit run. The dormant install step deliberately refuses global or
floating installation and would require `npm ci --ignore-scripts` from an
approved manifest and committed lockfile before any repository source is
assembled.

## Contents

| File | Purpose |
| --- | --- |
| `package.json` | Proposed exact version. `private: true`, never published; not an approval record. |
| `package-lock.json` | Intentionally absent while the proposed runtime is unapproved and unavailable from the public registry. |

`tools/` is not listed in the root `package.json` `files` array, so nothing here
is included in the published `@microsoft/spe-mcp` tarball.

## Proposed version and unresolved approval

| Package | Proposed version | Status |
| --- | --- | --- |
| `@github/copilot` | `1.0.80-1` (exact, no range) | Not available from `https://registry.npmjs.org/`; license is `SEE LICENSE IN LICENSE.md`; package/license/CELA/Privacy approval remains open |

The corporate npm configuration can resolve this version from an internal feed.
That does **not** make it reproducible on a public GitHub-hosted runner, and an
internal-feed URL must not be committed into this public repository.

Because the package is not permissively licensed, a future runtime selection also
requires the licensing/CELA/Privacy sign-off described in
[`docs/SECURITY-AUDIT.md`](../../docs/SECURITY-AUDIT.md). This file records a
proposal, not approval.

## Why there is no lockfile

`package-lock.json` is intentionally absent. A direct, credential-free query to
`registry.npmjs.org` cannot resolve the proposed version. Generating the lockfile
with the machine's default corporate npm configuration would instead record an
internal feed that GitHub-hosted runners cannot access.

Do not generate a lockfile from the internal feed, and do not downgrade or replace
the proposed package merely to make installation pass. A future reviewed change
must first select an approved, compatible version that is directly available from
the public registry. It must then generate and verify the lockfile using empty
user/global npm configuration and the explicit public registry. Until that code
change lands, every literal `false` guard in `security-audit.yml` must remain.

## Future runtime update

1. Obtain package/license/CELA/Privacy approval for the selected runtime.
2. Confirm compatibility with the pinned `actions/ai-inference` revision.
3. Pin the exact version in `package.json`.
4. Generate `package-lock.json` against `https://registry.npmjs.org/` with empty
   user/global npm configuration.
5. Verify every `resolved` URL uses that public registry and every integrity value
   is `sha512-…`; run a clean `npm ci --ignore-scripts`.
6. Satisfy the public-outcome invariance and private operational-failure requirements.
7. Remove hard-disables only in the same reviewed change.

Dependabot watches this directory (`.github/dependabot.yml`), so version bumps
surface as pull requests once the lockfile exists.
