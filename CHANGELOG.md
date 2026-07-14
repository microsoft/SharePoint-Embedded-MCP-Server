# Changelog

All notable changes to this project will be documented in this file. The format
is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0-alpha.1]

### Added

- **Per-instance data directory.** New `--data-dir <path>` flag and `SPE_DATA_DIR`
  environment variable select where the provisioning `state.json` and MSAL token
  cache are stored (precedence: flag > env > default `~/.spe-mcp`). Point each
  server instance at a unique directory to run multiple instances (e.g. two
  tenants, or a published build alongside a local build) without clobbering
  shared state. Applies uniformly to `start`, `auth`, and `logout`. The default
  path is unchanged and byte-identical to prior releases.
- **Guided issue reporting.** A general **Bug report** GitHub issue form (for
  tool failures, scaffolding/build/deploy, install/packaging, or unexpected
  output) and a dedicated **Sign-in / AADSTS error** form for auth failures,
  plus a **Report an SPE MCP issue** agent skill
  (`.github/skills/report-spe-mcp-issue`) that picks the right form, gathers the
  diagnostics, redacts secrets, and drafts the issue. New "React SPA sign-in
  fails with `AADSTS9002326`" troubleshooting section.

### Fixed

- **Misleading `AADSTS9002326` sign-in guidance.** The scaffolded React SPA
  could fail sign-in with `AADSTS9002326` even when the SPA redirect URI was
  already registered, and the app's own error copy asserted this was definitively
  a server-side missing-redirect-URI problem. The guidance
  (`auth-error-guidance.ts` and its `App.tsx` twin, plus the `project_run_local`
  note) is reframed as "almost always a configuration mismatch" and now leads
  with confirming the running build's `VITE_CLIENT_ID` / `VITE_TENANT_ID` match
  the app in the portal Overview (and rebuilding after `.env` changes) before the
  redirect-URI add steps.
- **Silent SPA self-repair failure surfaced.** When `project_app_create` reuses
  an existing owning app, a best-effort `addSpaRedirectUris` failure (e.g.
  missing `Application.ReadWrite`) was swallowed, leaving the app unrepaired with
  no signal. The tool now emits a non-blocking advisory naming the client id /
  object id and the exact `az rest` PATCH/GET to self-repair.
- **`project_hydrate_config` verification advisory.** The tool now appends an
  offline "verify this `.env` targets the right app" advisory to its output
  (never to `.env`) and warns when the tenant id is blank (invalid MSAL
  authority), so a stale/mismatched app identity is caught before sign-in.

### Security

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
