# Changelog

All notable changes to this project will be documented in this file. The format
is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0-alpha.2]

### Security

- **Process-invocation hardening.** All Azure CLI (`az`), Azure Developer CLI
  (`azd`), and local dev-server child processes are now launched through a single
  shared, shell-free process launcher that resolves platform executable shims
  (including Windows `.cmd`/`.bat`) without spawning a command interpreter. Command
  arguments are never routed through a shell, so shell metacharacters in
  user-influenced values (for example subscription IDs and resource-group names)
  can no longer alter the executed command line. In addition, Azure subscription
  IDs and resource-group names are now strictly validated against an allowlist at
  the tool boundary and re-asserted at the process-invocation boundary as
  defense-in-depth. Valid inputs and existing behavior are unchanged.

## [0.2.0-alpha.1]

### Added

- **Per-instance data directory.** New `--data-dir <path>` flag and `SPE_DATA_DIR`
  environment variable select where the provisioning `state.json` and MSAL token
  cache are stored (precedence: flag > env > default `~/.spe-mcp`). Point each
  server instance at a unique directory to run multiple instances (e.g. two
  tenants, or a published build alongside a local build) without clobbering
  shared state. Applies uniformly to `start`, `auth`, and `logout`. The default
  path is unchanged and byte-identical to prior releases.

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
