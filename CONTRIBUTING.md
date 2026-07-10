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

## Reporting security issues

Please report security issues privately as described in [SECURITY.md](SECURITY.md). Do
not file public GitHub issues for security vulnerabilities.
