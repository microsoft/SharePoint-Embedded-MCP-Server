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
| SEC-008 | Update-check hardening | The optional npm version check is HTTPS-only (`SPE_NPM_REGISTRY` must be `https:` with no credentials/query/fragment), requests **exactly one** fixed package path per refresh (no query, no fragment), **rejects redirects and any response served by a different host**, is unauthenticated (no `Authorization`, cookies, `credentials: "omit"`, no `.npmrc`, no `npm` subprocess), sends **no identifier** (no install GUID, machine, user, tenant, subscription, correlation, or session data), discloses only what any HTTPS connection reveals (IP address, the static product `User-Agent`, and standard TLS/HTTP connection metadata such as the TLS handshake/SNI, `Host`/`Accept` headers, and request timing), is bounded (2 s timeout, 64 KB response cap), parsed defensively (strict SemVer, prototype-pollution-safe key filtering), and cached owner-only via SEC-003 with a 24 h TTL. An owner-only cross-process refresh lock serializes stale-cache refreshes, and its owner records a failure reservation before egress so concurrent starts, failed checks, and mid-request process exits still allow at most one request per 24 h for the same running package version and registry across processes sharing the retained data-directory cache. Changing that version/registry or deleting the cache starts a new window. The cache is deleted on `logout` / `auth --reset`; channel and stable notification suppression is persisted independently and claimed before return for at-most-once cross-process delivery (a crash after claim but before response delivery can lose the notice). The check announces itself with a one-time stderr collection notice before the first request, is **notify-only** (never downloads, installs, or executes anything), and is fully disableable with **zero network and zero disk access** (`SPE_MCP_UPDATE_CHECK=false`, `--no-update-check`, `SPE_NO_UPDATE_CHECK` (legacy alias), `NO_UPDATE_NOTIFIER`, `SPE_MCP_COLLECT_TELEMETRY=false` — the telemetry opt-out suppresses the registry request entirely rather than merely omitting the `User-Agent`; auto-skipped in CI and source checkouts). Proxy routing follows the runtime configuration: releases that support Node's environment-proxy mode (including current Node 24/26 releases) can use `HTTP(S)_PROXY`/`NO_PROXY` when enabled with `NODE_USE_ENV_PROXY=1` or `--use-env-proxy`, while Node 22 may ignore those variables and attempt a direct connection. |

> Adding a new safeguard? Give it the next code in its family and add a row here
> so code comments and tests have a lookup.
