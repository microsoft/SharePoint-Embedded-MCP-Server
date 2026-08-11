# Changelog

All notable changes to this project will be documented in this file. The format
is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0-alpha.1]

### Added

- **Bounded install-source attribution.** The `start` command accepts optional
  `--install-source`, `--install-content`, and `--install-campaign` arguments (plus
  environment-variable equivalents) and appends their validated, non-personal labels to
  the existing Graph/ARM request `User-Agent`. After MCP initialization, the server also
  maps the self-reported client name to a bounded agent-host label (for example `vscode`
  or `claude-code`); unknown raw client names are never transmitted.
  `--no-install-attribution` provides an explicit opt-out for all attribution labels. The
  README install links declare `github-readme` as their source.
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
