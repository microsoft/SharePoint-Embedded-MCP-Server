# Contributing to SharePoint Embedded MCP Server

Thank you for your interest in contributing! This project welcomes contributions and
suggestions.

## Contributor License Agreement

Most contributions require you to agree to a Contributor License Agreement (CLA)
declaring that you have the right to, and actually do, grant us the rights to use your
contribution. For details, visit <https://cla.opensource.microsoft.com>.

When you submit a pull request, a CLA bot will automatically determine whether you need
to provide a CLA and decorate the PR appropriately (e.g., status check, comment). Simply
follow the instructions provided by the bot. You will only need to do this once across
all repositories using our CLA.

## How to contribute

1. Fork the repository and create your branch from `main`.
2. Install dependencies: `npm install`.
3. Make your change. Add or update tests alongside the code (`src/**/*.test.ts`).
4. Validate locally: `npm run ci` (typecheck + test + build).
5. Open a pull request describing the change and its motivation.

## Code style

- TypeScript, ES modules, strict mode. Run `npm run lint` and `npm run typecheck`
  before opening a PR.
- Each tool is a `{ name, description, inputSchema, handler }` export — see
  "Adding New Tools" in the [README](README.md).

## Code of Conduct

This project has adopted the
[Microsoft Open Source Code of Conduct](https://opensource.microsoft.com/codeofconduct/).
For more information see the
[Code of Conduct FAQ](https://opensource.microsoft.com/codeofconduct/faq/) or contact
[opencode@microsoft.com](mailto:opencode@microsoft.com) with any additional questions or
comments.

## Optional model-assisted security analysis

**This feature is disabled by default.** It is documented here so contributors know what *could*
happen to code they contribute, if maintainers ever enable it.

The repository contains a scheduled weekly security-audit workflow. It has an optional stage that,
when a maintainer explicitly enables it, may send a bounded selection of **already-public,
git-tracked source files from `main`** to **GitHub Copilot**, which relays them to a **third-party
model provider** for advisory security analysis.

What this stage does and does not do:

- **Only public, tracked source.** The corpus is limited to an allowlist of source file extensions
  from committed files on `main`, under a hard file-count and byte cap. Untracked files, local
  working-tree changes, build output and dependencies are never included.
- **No separate repository or activity data.** The corpus does not query issues, pull requests,
  discussions, commit messages, author records, CI logs or the runner environment. It does include
  each selected file's repository-relative path, line count and public source content, which may
  itself contain names, identifiers, credential-shaped strings or environment-variable references.
- **No tools, no writes.** The model runs without tools, without MCP servers, without shell access
  and without any write permission. It cannot open issues, comment, push, or change settings.
- **Advisory and redacted.** Output is schema-validated and redacted before use, is advisory only,
  and is never a required check for merging a pull request.
- **Never published.** Validated findings are submitted only through **GitHub Private Vulnerability
  Reporting**, where they are visible to repository maintainers alone. They are never written to
  job logs, workflow artifacts, job summaries, pull request annotations, code scanning / SARIF,
  public issues, Azure DevOps or IcM. There is no fallback surface: if private reporting is
  unavailable the audit fails closed and publishes nothing. The only public output of an audit run
  is `Security audit: PASS` or
  `Security audit: FAIL — details were reported privately to maintainers.`
- **Never triggered by contributions.** The workflow has no `pull_request` or
  `pull_request_target` trigger. Opening or updating a pull request never sends anything anywhere.

Activation is gated on more than a single switch: a maintainer must enable Private Vulnerability
Reporting on the repository, provision a protected environment and credential for submission, and
set two separate opt-in repository variables. Any one of those being absent leaves the stage off.

The full design, boundaries and activation prerequisites are documented in
[docs/SECURITY-AUDIT.md](docs/SECURITY-AUDIT.md).

If you have concerns about this feature as it relates to your contribution, please open a GitHub
discussion or a non-security issue and a maintainer will discuss it with you.

## Reporting security issues

Please report security issues privately as described in [SECURITY.md](SECURITY.md). Do
not file public GitHub issues for security vulnerabilities.
