# Security Controls

The SharePoint Embedded MCP server tags its security-relevant behaviors with
short, stable control codes (`SAFE-00x`, `SEC-00x`). These codes appear in code
comments and test labels so that a given safeguard can be traced across the
codebase and discussed unambiguously.

**User-facing surfaces (CLI help, error messages) never rely on these codes** —
they describe the behavior in plain language. This legend is the single place
that maps each code to a human-readable name and a one-line description.

## SAFE — tool-exposure and destructive-operation safeguards

| Code | Name | What it does |
|------|------|--------------|
| SAFE-002 | Destructive-operation confirmation gate | Mutating/irreversible operations (e.g. permanent delete) require an explicit `confirm: true`; the call is rejected before it reaches Graph/Azure otherwise. |
| SAFE-003 | Read-only mode | When enabled (`--read-only` / `SPE_READ_ONLY`), only tools annotated read-only are advertised and callable; every mutating call is rejected. |
| SAFE-004 | Tool allowlist / profiles | Restricts the exposed tool set (`--tools` / `SPE_TOOLS`) to a built-in profile (`readOnly`, `docsOnly`, `provisioning`, `content`, `admin`) or a comma-separated tool list. |

## SEC — data-handling and hardening safeguards

| Code | Name | What it does |
|------|------|--------------|
| SEC-002 | Client-safe error messages | Tool `catch` blocks surface only sanitized, consistent messages to clients; internal detail stays in server-side logs. |
| SEC-003 | Secure filesystem (owner-only) | Credential and state files (token cache, server state) are written owner-only (POSIX `0o600`; ACL-governed on Windows). |
| SEC-007 | Docs endpoint validation | The Microsoft Learn MCP endpoint is resolved and validated before use to prevent redirection to an untrusted host. |

> Adding a new safeguard? Give it the next code in its family and add a row here
> so code comments and tests have a lookup.
