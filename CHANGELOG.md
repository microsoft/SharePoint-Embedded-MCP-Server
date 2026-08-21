# Changelog

All notable changes to this project will be documented in this file. The format
is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0-alpha.1]

### Added

- **Update awareness (notify only).** The server now checks the public npm registry at
  most once every 24 hours and, when a newer release of `@microsoft/spe-mcp` exists,
  appends a single concise `Update available: …` notice to one tool result (plus an
  optional `structuredContent.updateAvailable` payload). The check is fire-and-forget —
  it never blocks a tool call, never writes to stdout, and **never downloads, installs, or
  executes anything**; auto-update is explicitly out of scope. It is channel-aware (an
  `alpha` install is compared against the `alpha` dist-tag, and a newer `latest` is
  reported separately), adds **zero new runtime dependencies**, and is skipped
  automatically in CI and when running from a source checkout. Disable it with
  `SPE_MCP_UPDATE_CHECK=false` (preferred), `--no-update-check`, `SPE_NO_UPDATE_CHECK=1`
  (legacy alias), `NO_UPDATE_NOTIFIER=1`, or `SPE_MCP_COLLECT_TELEMETRY=false` (the telemetry
  opt-out suppresses the registry request entirely);
  when disabled, **no network request, stderr notice, or cache write occurs**. Point it at a
  mirror with `SPE_NPM_REGISTRY` (HTTPS-only).
- **Transparency for the update check.** Before the first registry request in a process, the
  server prints a one-time **stderr** collection notice naming the endpoint, the boundary, and
  the opt-out. `status_get` now reports the running server version, the update-check state,
  the locally cached latest version, the time of the last check, the registry in use, the
  cache-file path, and the opt-out controls — all read from disk, with **no network access**.
- **Update-check cache lifecycle.** The cached result at `<data dir>/update-check.json`
  contains **no identifier** and is retained until deleted; `spe-mcp logout` and
  `spe-mcp auth --reset` now remove it alongside the cached tokens. A version is recorded
  as "already notified" only when the notice is actually delivered on a tool result, so a
  process that exits before any tool call replays the notice on the next run instead of
  losing it.
- **Boundary disclosure.** `NOTICE.md` (new **Third-party services contacted** section),
  `README.md`, `PRIVACY.md`, `docs/DATA-FLOW.md`,
  `docs/SECURITY-CONTROLS.md`, and `docs/TROUBLESHOOTING.md` document that
  `registry.npmjs.org` (npm, Inc./GitHub) is **not a Microsoft 365 or Azure Online Service** and
  is therefore the only endpoint **outside the Microsoft 365 / Azure compliance boundary** and
  not covered by the Microsoft Product Terms, the DPA, or EU Data Boundary commitments; that the
  connection discloses IP address, the static `User-Agent`, standard TLS/HTTP connection
  metadata, and the request time; that no auto-update exists; and
  that Node's built-in `fetch` cannot route through `HTTP(S)_PROXY` — an open, unresolved
  tradeoff accepted to preserve the zero-runtime-dependency budget. `docs/DATA-FLOW.md`
  states precisely that the registry lookup sends no customer content and no
  application-level user, tenant, subscription, or install identifier, while the HTTPS
  connection itself still exposes the source IP address and standard transport metadata —
  it makes no absolute-anonymity claim.
- **Informational-only update guidance.** The update notice and `status_get` state that the
  message is informational, that nothing is installed or changed automatically, and that
  updating requires a person to change the MCP client configuration (or reinstall the copy the
  client actually launches) — it is never phrased as a command to run. The guidance is
  execution-mode neutral (`npx`, global install, or project-local install) and reports the
  package spec to target rather than a single install command. The published package now also
  ships `NOTICE.md`, `PRIVACY.md`, `CHANGELOG.md`, `SUPPORT.md`, `SECURITY.md`,
  `CONTRIBUTING.md`, `docs/DATA-FLOW.md`, `docs/SECURITY-CONTROLS.md`, and
  `docs/TROUBLESHOOTING.md`, so the disclosure links in the installed `README.md` resolve.
- **Per-instance data directory.** New `--data-dir <path>` flag and `SPE_DATA_DIR`
  environment variable select where the provisioning `state.json` and MSAL token
  cache are stored (precedence: flag > env > default `~/.spe-mcp`). Point each
  server instance at a unique directory to run multiple instances (e.g. two
  tenants, or a published build alongside a local build) without clobbering
  shared state. Applies uniformly to `start`, `auth`, and `logout`. The default
  path is unchanged and byte-identical to prior releases.

### Security

- **Update-check hardening (SEC-008).** The npm version check is HTTPS-only and requests
  exactly one fixed package path with no query string; redirects and cross-host responses are
  rejected. It is unauthenticated (no `Authorization`, cookies, `credentials: "omit"`, no
  `.npmrc`, no `npm` subprocess), sends **no install GUID, machine, user, tenant, subscription,
  correlation, or session identifier**, and discloses only what any HTTPS connection reveals
  (IP address, the static product `User-Agent`, and standard TLS/HTTP connection metadata).
  Setting `SPE_MCP_COLLECT_TELEMETRY=false` suppresses the registry request entirely.
  It is bounded by a 2-second timeout and a 64 KB response
  cap, parsed with strict SemVer and prototype-pollution-safe key filtering, and cached
  owner-only (SEC-003) with a 24-hour TTL — a failed check backs off for the same 24 hours,
  so at most one request per day is made either way — deleted on `logout` /
  `auth --reset`. `SPE_NPM_REGISTRY` values carrying credentials, a query string, or a
  fragment are rejected. **Known limitation:** Node's built-in `fetch` ignores
  `HTTP(S)_PROXY`/`NO_PROXY`, so the request cannot be routed through an egress proxy; it
  fails closed.

- **Fail-closed credential/state file handling.** The data directory and token
  cache files are now validated fail-closed: a symlinked, foreign-owned, or
  group/other-accessible directory is refused (POSIX `0o700`); an off-`%USERPROFILE%`
  Windows override is given an owner-only DACL or refused. Reads and writes use
  `O_NOFOLLOW` + `fstat` fd verification and `fchmod` the descriptor (never the
  path) to defeat symlink/TOCTOU swaps. A caller-supplied `--data-dir` must be an
  absolute (or `~/`-relative) path; CWD-relative paths are rejected so credentials
  can never be written into a working directory. On an insecure/unverifiable
  target, refresh-token persistence is skipped (forcing a fresh interactive
  sign-in) rather than writing a token to an unsafe location.

## [0.1.0]

Initial release.
