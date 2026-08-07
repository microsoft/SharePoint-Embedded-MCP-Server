# Changelog

All notable changes to this project will be documented in this file. The format
is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Agent Plugins 1.0 MCP-only pilot.** Repository-level `plugin.json` and
  `mcp.json` launch the exact published `@microsoft/spe-mcp@0.2.0-alpha.1`
  package over local `stdio`, default to `--read-only`, and keep plugin-owned
  token/state files in the client-managed `${PLUGIN_DATA}` directory. Includes
  schema, packaging, startup, and security-contract tests plus installation and
  removal documentation. No skills, remote transport, OAuth, hooks, agents, or
  server behavior changes are included. The subprocess also uses
  `${PLUGIN_DATA}` as its working directory so `npx` cannot confuse the plugin
  source root with an installed package on Windows.
- **Release-safe plugin stamping and schema validation.** The npm version and
  prepack lifecycle now keep `package.json`, `plugin.json`, and the exact MCP
  package pin synchronized for prerelease and official packages. Manifest tests
  validate against vendored, authoritative Agent Plugins 1.0 schemas. Safe
  transitive lockfile updates clear all high-severity npm audit findings.

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
