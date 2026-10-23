# SPE MCP Server

A [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server for SharePoint Embedded. Lets any MCP-compatible AI client (VS Code Copilot, Claude Desktop, Cursor, Azure Foundry) manage SPE resources via natural language.

> ⚠️ **Preview software.** Provisioning SharePoint Embedded resources can incur Azure
> charges, and any connected AI agent can act on your tenant with your credentials. Please
> read the **[Important notices](#important-notices)** before use.

**One-click install** — add the `@microsoft/spe-mcp` server to your MCP client (stdio, launched via `npx -y @microsoft/spe-mcp start`):

[![Install in VS Code](https://img.shields.io/badge/VS_Code-0098FF?style=flat-square&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect/mcp/install?name=spe&config=%7B%22type%22%3A%22stdio%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40microsoft%2Fspe-mcp%22%2C%22start%22%5D%7D) [![Install in VS Code Insiders](https://img.shields.io/badge/VS_Code_Insiders-24bfa5?style=flat-square&logo=visualstudiocode&logoColor=white)](https://insiders.vscode.dev/redirect/mcp/install?name=spe&config=%7B%22type%22%3A%22stdio%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40microsoft%2Fspe-mcp%22%2C%22start%22%5D%7D) [![Install in Visual Studio](https://img.shields.io/badge/Visual_Studio-C16FDE?style=flat-square&logo=visualstudio&logoColor=white)](https://aka.ms/vs/mcp-install?%7B%22name%22%3A%22spe%22%2C%22type%22%3A%22stdio%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40microsoft%2Fspe-mcp%22%2C%22start%22%5D%7D) [![Install in Cursor](https://img.shields.io/badge/Cursor-000000?style=flat-square&logo=cursor&logoColor=white)](https://cursor.com/en/install-mcp?name=spe&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBtaWNyb3NvZnQvc3BlLW1jcCIsInN0YXJ0Il19) [![Install in Claude Code](https://img.shields.io/badge/Claude_Code-Install-orange?style=flat-square)](#install)

Prefer the command line? Run `claude mcp add spe -- npx -y @microsoft/spe-mcp start` (Claude Code) or `codex mcp add spe -- npx -y @microsoft/spe-mcp start` (Codex CLI). Claude Desktop and manual configuration are covered in [Install](#install).

## Documentation

- **Get started on Microsoft Learn:** [SharePoint Embedded MCP server](https://learn.microsoft.com/sharepoint/dev/embedded/getting-started/spe-mcp-server)
- **SharePoint Embedded product docs:** <https://learn.microsoft.com/sharepoint/dev/embedded/>
- **In this repo:** [Available Tools](#available-tools) · [Configuration](#configuration) · [Security controls](docs/SECURITY-CONTROLS.md) · [Troubleshooting](docs/TROUBLESHOOTING.md)

## Available Tools

The server exposes **40 tools**, plus an MCP **Prompt** (`provision_spe_app`) and **Resources** (reference architectures).

**Provisioning & status**

| Tool | Description |
|------|-------------|
| `status_get` | Signed-in identity (Azure CLI) + provisioning readiness |
| `project_app_create` | Create the owning Entra app (via az bootstrap token) |
| `project_provision` | One-call orchestrator: app → container type → (billing) → register → container |
| `container_type_create` / `container_type_register` / `container_create` | Individual provisioning steps |
| `container_type_list` / `container_list` / `container_get` / `container_type_get` | Read operations |
| `container_type_update` / `container_type_delete` | Update or delete a container type |
| `container_type_grant_owner` / `container_type_revoke_owner` / `container_type_owners_list` | Manage container-type owners (beta; enables PCA container creation) |
| `container_type_app_grant_add` / `container_type_app_grant_remove` / `container_type_app_grants_list` | Manage application permission grants on a container type registration (authorize consuming apps; v1.0) |

**Billing**

| Tool | Description |
|------|-------------|
| `azure_subscriptions_list` / `azure_resource_groups_list` | Pick where standard billing lands (az) |
| `billing_setup` | Register Microsoft.Syntex RP + link the container type (standard) |
| `billing_check` | Inspect billing classification / trial expiry |

**Scaffold, run & deploy**

| Tool | Description |
|------|-------------|
| `project_scaffold` | Materialize a reference architecture (React SPA+Functions, C# web) |
| `project_hydrate_config` | Write `.env` / `appsettings` / `azure.yaml` from provisioning state |
| `project_seed_sample_data` | Seed sample containers + documents (closed loop) |
| `project_run_local` | Start the scaffolded app locally |
| `project_deploy` | Deploy to Azure with `azd up`, return the live URL |

**Content plane (opt-in) & lifecycle**

| Tool | Description |
|------|-------------|
| `content_access_grant` / `content_access_revoke` | Opt-in file read/manage consent |
| `content_file_upload` / `content_folder_create` / `content_search` / `content_file_preview` / `content_sharing_manage` / `container_permissions_manage` / `container_archive_restore` / `container_delete` | Container & content operations |
| `project_cleanup` | Delete provisioned CT + owning app (confirm required) |

**Documentation (grounded via Microsoft Learn MCP)**

| Tool | Description |
|------|-------------|
| `docs_search` | Search official SPE / Graph docs (proxies the [Microsoft Learn MCP](https://learn.microsoft.com/api/mcp)) |
| `docs_fetch` | Fetch a full Microsoft Learn doc page by URL |

> The documentation tools require the public **Microsoft Learn MCP** server
> (`https://learn.microsoft.com/api/mcp`, no auth). Override the endpoint with
> `SPE_LEARN_MCP_URL` (used by tests).

## Install

Run the published npm package directly from your MCP client with `npx`; no
global install is required.

### One-click install

[Install in Visual Studio Code](https://aka.ms/spe-mcp/install/github/vscode)

One-click install is also available for [Visual Studio Code Insiders](https://aka.ms/spe-mcp/install/github/vscode-insiders), [Visual Studio](https://aka.ms/spe-mcp/install/github/visual-studio), and [Cursor](https://aka.ms/spe-mcp/install/github/cursor). From the command line, run `claude mcp add spe -- npx -y @microsoft/spe-mcp start --install-source github-readme --install-content readme-install --install-campaign docs-install-buttons` for Claude Code or `codex mcp add spe -- npx -y @microsoft/spe-mcp start --install-source github-readme --install-content readme-install --install-campaign docs-install-buttons` for the Codex CLI.

These configurations add bounded, non-personal install-source labels to the
existing Graph and Azure request `User-Agent`; they create no separate telemetry
channel. Remove the three install-attribution arguments, or add
`--no-install-attribution`, to omit the labels.

After the MCP handshake, the server also maps the client's self-reported
`clientInfo.name` to a bounded agent-host value such as `vscode`, `cursor`, or
`claude-code`. Unrecognized names become `other`; missing or generic SDK values
become `unknown`. The raw client name and client version are not transmitted, and
the classification is used only for attribution—not for authorization or any
security decision.

### VS Code / Cursor

Add an MCP server entry to `.vscode/mcp.json` (VS Code) or your Cursor MCP
configuration:

```json
{
  "servers": {
    "spe": {
      "type": "stdio",
      "command": "npx",
      "args": [
        "-y",
        "@microsoft/spe-mcp",
        "start",
        "--install-source",
        "github-readme",
        "--install-content",
        "readme-install",
        "--install-campaign",
        "docs-install-buttons"
      ]
    }
  }
}
```

<!-- Registry publishing note: confirm the final immutable MCP Registry name before public release (`io.github.microsoft/SharePoint-Embedded-MCP-Server` for GitHub ownership verification vs. `com.microsoft/...` for a Microsoft-owned DNS namespace). -->

### Claude Desktop

Add to `%APPDATA%\Claude\claude_desktop_config.json` (Windows) or
`~/Library/Application Support/Claude/claude_desktop_config.json` (macOS):

```json
{
  "mcpServers": {
    "spe": {
      "command": "npx",
      "args": [
        "-y",
        "@microsoft/spe-mcp",
        "start",
        "--install-source",
        "github-readme",
        "--install-content",
        "readme-install",
        "--install-campaign",
        "docs-install-buttons"
      ]
    }
  }
}
```

> Bootstrap mode needs no app-specific environment variables; sign in once with
> `az login --allow-no-subscriptions`.

### Updating / removing

How you update depends on how your MCP client launches the server, so update the
copy the client actually runs:

- **Unpinned `npx -y @microsoft/spe-mcp` (the config above).** `npx` may keep
  starting a cached build, so pin the package spec in the client config to the
  version or channel you want — for example `@microsoft/spe-mcp@alpha` or
  `@microsoft/spe-mcp@0.2.0-alpha.1` — and restart the client.
- **Global install.** Reinstall it: `npm install -g @microsoft/spe-mcp@alpha`.
- **Project-local install.** Update the dependency in that project and reinstall.

To remove the server, delete the MCP client config entry (and uninstall the
package if you installed it globally or locally).

### Update notifications

To make it obvious when you are running an old build, the server checks the
public npm registry by default (or the HTTPS registry you set with
`SPE_NPM_REGISTRY`) **once a day, in the background**, for a newer published
release and — if one exists — appends a short notice to a single tool result.
That daily limit applies to processes sharing the data directory for the same
running package version and registry while the cache is retained:

```text
Update available: @microsoft/spe-mcp 0.2.0-alpha.1 -> 0.2.0-alpha.4 (alpha channel).
Note: This is just a notice. If you choose to update, update the MCP server manually. No command should run automatically.
Silence with --no-update-check.
```

The current version and the update state are also reported by `status_get`, so
they are always available for a bug report.

How it behaves:

- **Notify only — the server never updates itself.** Nothing is downloaded,
  installed, or executed; you choose when to update. There is no auto-update.
- **Never blocks a tool call.** The check is fire-and-forget with a 2-second
  timeout; if the registry is slow or unreachable, the result is simply dropped.
- **Channel-aware.** A prerelease install (e.g. `alpha`) is compared against its
  own dist-tag. The `latest` target is mentioned separately as **stable** only
  when it resolves to a non-prerelease version.
- **Quiet.** Channel and stable targets are tracked independently. A target is
  claimed in the shared cache before its notice is returned, so processes
  sharing that cache do not return duplicate notices. This is an at-most-once
  guarantee: a process crash after the durable claim but before the client
  receives the tool result can lose that notice. The update remains visible in
  `status_get`.
- **Unauthenticated, without a user identifier.** Exactly one unauthenticated
  `GET` of the package metadata — by default,
  `https://registry.npmjs.org/@microsoft%2fspe-mcp` — with no query string and
  redirects rejected. No credentials, cookies, `.npmrc`, or `npm` subprocess are
  involved, and **no install GUID, machine, user, tenant, subscription, or
  session identifier** is sent. As with any HTTPS request, npm sees your IP
  address, the static `User-Agent` `spe-mcp-server/<version>`, standard TLS/HTTP
  connection metadata (TLS handshake and SNI, `Host`/`Accept` headers, timing),
  and the time of the request. Opting out of telemetry
  (`SPE_MCP_COLLECT_TELEMETRY=false`) suppresses the request entirely, so none of
  that is disclosed.
- **Announced.** Before the first check in a process, a one-time notice is
  printed to **stderr** naming the endpoint actually contacted (the registry from
  `SPE_NPM_REGISTRY` if you set one, otherwise `registry.npmjs.org`), the
  applicable boundary information, and the opt-out. Configured registries are
  described neutrally because their operator and compliance boundary depend on
  your configuration.
- **Cached locally.** The result is stored owner-only at
  `<data dir>/update-check.json` and **kept until you delete it**;
  `spe-mcp logout` and `spe-mcp auth --reset` remove it, and `status_get` prints
  the path. Processes sharing the data directory coordinate stale-cache
  refreshes with an owner-only lock and write the 24-hour attempt reservation
  before egress, preventing concurrent starts or a mid-request process exit from
  producing another request inside that window. Changing the running package
  version or registry, or deleting the cache, intentionally starts a new window.

> ⚠️ **Boundary note.** `registry.npmjs.org` is operated by npm, Inc. (GitHub).
> It is **not a Microsoft 365 or Azure Online Service**, so it is not covered by
> the Microsoft Product Terms, the Microsoft Products and Services Data
> Protection Addendum (DPA), or the EU Data Boundary. It is the **only** endpoint
> this server contacts by default that is **outside the Microsoft 365 / Azure
> compliance boundary**. If you configure another registry, its operator,
> policies, and compliance boundary depend on your configuration. Disable the
> update check to remove registry egress entirely.

> **Proxy routing.** Routing follows the Node.js runtime configuration. Releases
> that support Node's environment-proxy mode (including current Node 24/26
> releases) can honor `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` when it is
> enabled with `NODE_USE_ENV_PROXY=1` or `--use-env-proxy`. Node 22 may ignore
> those variables and attempt a direct connection. If proxy routing is
> mandatory, enforce it at the runtime or network layer, or disable the update
> check.

It is skipped automatically when the server is run from a source checkout or in
CI, and can be turned off explicitly:

```bash
SPE_MCP_UPDATE_CHECK=false spe-mcp start     # preferred env var
spe-mcp start --no-update-check              # flag
SPE_NO_UPDATE_CHECK=1 spe-mcp start          # legacy alias
NO_UPDATE_NOTIFIER=1 spe-mcp start           # community-standard opt-out
SPE_MCP_COLLECT_TELEMETRY=false spe-mcp start # telemetry opt-out suppresses the request entirely
```

When disabled, **no network request, no stderr notice, and no cache write happen
at all**. See [PRIVACY.md](PRIVACY.md) and
[docs/DATA-FLOW.md](docs/DATA-FLOW.md) for the full data-flow description.

## Prerequisites

- **Node.js** 22, 24, or 26

### Running modes

**Bootstrap mode (default, recommended for the standalone POC)** — no Microsoft
app registration required. The server uses your **Azure CLI** session for the
control plane and provisions the owning app on demand.

- Install the [Azure CLI](https://aka.ms/install-azure-cli)
- Sign in once: `az login --allow-no-subscriptions` (the flag is required for M365-only tenants with no Azure subscription)
- Start the server with **no** `--client-id`

> **Conditional Access / step-up authentication (standard billing).** Standard-billing
> provisioning performs Azure Resource Manager (ARM) writes — registering the
> `Microsoft.Syntex` resource provider and creating the `Microsoft.Syntex/accounts`
> billing account. If your tenant has a Conditional Access policy that requires a
> step-up (MFA / auth-context) for ARM, `az` can fail with `InteractionRequired` /
> `AADSTS50076` / a **claims challenge**. The MCP server detects this and surfaces an
> actionable error. To satisfy the policy, re-authenticate **interactively in your own
> terminal**, then retry:
>
> ```bash
> az login --scope https://management.core.windows.net//.default --tenant <your-tenant-id>
> ```
>
> If interactive browser sign-in still doesn't clear the policy (e.g. an auth-context
> "p1" step-up), complete the step-up via the **SharePoint admin center**, then retry the
> operation. The Azure CLI cannot redeem a claims challenge non-interactively, so the
> server does **not** automate this step (detect + surface + document only).

**Pre-provisioned-app mode (back-compat)** — pass an existing public-client
Entra app that already has these admin-consented delegated permissions:

- `FileStorageContainer.Selected`
- `FileStorageContainerType.Manage.All`
- `FileStorageContainerTypeReg.Manage.All`

> Don't have an app? Create one manually in the [Azure Portal](https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade). The app must be a **public client** (`isFallbackPublicClient: true`) with `http://localhost` as a redirect URI.

## Quick Start (from source)

```bash
# 1. Install dependencies
npm install

# 2. Build
npm run build

# 3a. Bootstrap mode — just sign into Azure CLI (no app needed)
az login --allow-no-subscriptions
npx @modelcontextprotocol/inspector node dist/cli.js start

# 3b. OR pre-provisioned-app mode — authenticate as an existing app (once)
node dist/cli.js auth --client-id YOUR_CLIENT_ID --tenant-id YOUR_TENANT_ID

# 4. Test with MCP Inspector
npx @modelcontextprotocol/inspector node dist/cli.js start
```

For step 4, set these **Environment Variables** in the Inspector UI:
- `SPE_CLIENT_ID` = your client ID
- `SPE_TENANT_ID` = your tenant ID

## Configuration

The server accepts configuration via CLI flags or environment variables:

| CLI Flag | Env Var | Description |
|----------|---------|-------------|
| `--client-id` | `SPE_CLIENT_ID` | Entra ID Application (Client) ID |
| `--tenant-id` | `SPE_TENANT_ID` | Entra ID Tenant ID |
| `--read-only` | `SPE_READ_ONLY` | Advertise/allow only read/list/get/search tools; reject mutating calls |
| `--tools` | `SPE_TOOLS` | Restrict exposed tools to a profile (`readOnly`, `docsOnly`, `provisioning`, `content`, `admin`) or a comma-separated tool list |
| `--install-source` | `SPE_INSTALL_SOURCE` | Optional bounded install surface: `microsoft-learn`, `github-readme`, `github-release`, `mcp-registry`, `npm`, or `other` |
| `--install-content` | `SPE_INSTALL_CONTENT` | Optional bounded content identifier: `readme-install`, `sharepoint-embedded-mcp-server`, `quickstart-vscode`, `create-container-type`, or `create-manage-containers`; requires an install source |
| `--install-campaign` | `SPE_INSTALL_CAMPAIGN` | Optional bounded campaign identifier: `docs-install-buttons`; requires an install source |
| `--no-install-attribution` | `SPE_INSTALL_ATTRIBUTION=off` | Omit install-source and agent-host labels from outbound request metadata |
| `--data-dir` | `SPE_DATA_DIR` | Directory for the token cache + provisioning state (default `~/.spe-mcp`). Point each instance at a unique **absolute** path (or `~/...`; CWD-relative paths are rejected) to run multiple servers without clobbering state |
| `--no-update-check` | `SPE_MCP_UPDATE_CHECK=false` | Disable the once-a-day npm version check that tells you when a newer server release is published (see [Update notifications](#update-notifications)). Also honours `SPE_NO_UPDATE_CHECK=1` (**legacy alias**), the community-standard `NO_UPDATE_NOTIFIER=1`, and `SPE_MCP_COLLECT_TELEMETRY=false`. When disabled, no network request, stderr notice, or cache write occurs |
| _(none)_ | `SPE_NPM_REGISTRY` | Registry base URL for the update check (default `https://registry.npmjs.org` — npm, Inc./GitHub, **not a Microsoft 365 or Azure Online Service** and outside the Microsoft 365 / Azure compliance boundary). **HTTPS only**; credentials, query strings, and fragments are rejected |
| _(none)_ | `SPE_MCP_COLLECT_TELEMETRY` | Product and optional bounded `User-Agent` attribution tokens on outbound Graph/ARM requests. On by default; set to `false` to opt out — this also suppresses the update-check request entirely (see [PRIVACY.md](PRIVACY.md)) |

> The CLI flag wins when both a flag and its env var are set. Run
> `spe-mcp start --help` to see the authoritative option list and descriptions.
>
> The `--read-only` and `--tools` behaviors are part of the server's documented
> security model — see [docs/SECURITY-CONTROLS.md](docs/SECURITY-CONTROLS.md)
> for the full legend of security-control codes used in the source.

For troubleshooting, see [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md).

## Usage with VS Code

Add an MCP server entry to `.vscode/mcp.json` in your workspace:

```json
{
  "servers": {
    "spe": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@microsoft/spe-mcp"],
      "env": {
        "SPE_CLIENT_ID": "your-client-id",
        "SPE_TENANT_ID": "your-tenant-id"
      }
    }
  }
}
```

Then in Copilot Chat you can ask:
- *"List my SPE container types"*
- *"Create a trial container type called Contoso Docs for app ID abc-123"*

To point an MCP client at a local source build instead:

```json
{
  "servers": {
    "spe": {
      "type": "stdio",
      "command": "node",
      "args": ["<path-to>\\mcp-server\\dist\\cli.js", "start"],
      "env": {
        "SPE_CLIENT_ID": "your-client-id",
        "SPE_TENANT_ID": "your-tenant-id"
      }
    }
  }
}
```

> **`npx -y`** suppresses the install prompt so VS Code can launch the server
> non-interactively. Bootstrap mode needs no app, so you can drop the `env` block
> and just `az login --allow-no-subscriptions`.

## Usage with Claude Desktop

Add to `%APPDATA%\Claude\claude_desktop_config.json` (Windows) or `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS):

```json
{
  "mcpServers": {
    "spe": {
      "command": "npx",
      "args": ["-y", "@microsoft/spe-mcp"],
      "env": {
        "SPE_CLIENT_ID": "your-client-id",
        "SPE_TENANT_ID": "your-tenant-id"
      }
    }
  }
}
```

## CLI Commands

```bash
# Start the MCP server (stdio transport)
spe-mcp start [--client-id ID] [--tenant-id ID] [--read-only] [--tools <profileOrCsv>] [--install-source <source>] [--no-update-check]

# Authenticate interactively (cache tokens for headless use)
spe-mcp auth --client-id ID --tenant-id ID [--reset]

# Clear cached tokens
spe-mcp logout
```

Every command has built-in help — run `spe-mcp <command> --help` (e.g.
`spe-mcp start --help`) for the full flag list and descriptions. `start` flags:

| Flag | Description |
|------|-------------|
| `--client-id <id>` | Owning Entra app Client ID. Omit to run in bootstrap mode (Azure CLI control plane). |
| `--tenant-id <id>` | Entra ID Tenant ID. Discovered from the Azure CLI when omitted. |
| `--read-only` | Read-only mode: only read/list/get/search tools are exposed and callable. |
| `--tools <profileOrCsv>` | Tool allowlist: a profile (`readOnly`, `docsOnly`, `provisioning`, `content`, `admin`) or a comma-separated list of tool names. |
| `--no-update-check` | Disable the daily npm version check (see [Update notifications](#update-notifications)). |
| `--install-source <source>` | Add a bounded install surface to the existing Graph/ARM request `User-Agent`. |
| `--install-content <id>` | Add one of the bounded content identifiers listed in [Configuration](#configuration); requires `--install-source`. |
| `--install-campaign <id>` | Add the bounded `docs-install-buttons` campaign identifier; requires `--install-source`. |
| `--no-install-attribution` | Omit install-source and agent-host labels from outbound request metadata. |

## Authentication

The server uses [MSAL](https://learn.microsoft.com/en-us/entra/identity-platform/msal-overview) with this auth waterfall:

1. **Silent** — uses a cached token from `~/.spe-mcp/token-cache.<tenantId>.<clientId>.json`
2. **Interactive browser** — opens a browser for PKCE sign-in. This runs **in-process by default, even when the server is launched over stdio** by an MCP client — so the first SharePoint Embedded call opens a browser for a one-time consent and caches the token live (no terminal, no restart).
3. **Device code** — prints a URL + code to stderr; used only as a fallback when a terminal (TTY) is attached to see the code. The device code is valid for ~15 minutes (the Azure AD lifetime); the server waits up to that long for you to complete sign-in and **never cancels a code that is still valid**.

For most developers nothing extra is needed: create the owning app with the `project_app_create` tool, then the first SPE call prompts a browser consent automatically.

**Automation / headless:** in CI (`CI=true`) or a Linux host with no display, interactive sign-in is disabled by default, and SPE operations return an actionable error. Pre-cache a token by running `spe-mcp auth --client-id <appId> --tenant-id <tenantId>` once in a terminal. Override the defaults with `SPE_INTERACTIVE=1` (force browser sign-in) or `SPE_NON_INTERACTIVE=1` (force off).

### Headless & orchestrator / sub-agent sign-in

Interactive sign-in is **enabled by default for local use** (the server can open a browser on your machine) and **disabled by default in obvious automation/headless environments** — CI (`CI=true`) or Linux with no `DISPLAY`/`WAYLAND_DISPLAY` — so a tool call never silently blocks on a browser that can't open. The defaults are only defaults; explicit overrides always win:

| Variable | Effect |
| --- | --- |
| `SPE_INTERACTIVE=1` | Force interactive sign-in **on** (browser + device-code fallback), even when the environment looks headless. |
| `SPE_NON_INTERACTIVE=1` | Force interactive sign-in **off**; SPE calls fail fast with an actionable error instead of prompting. |

**Why interactive is supported (and on by default) locally.** A developer building an SPE app benefits from a one-time browser consent: it caches a token live on the first SPE call — no separate terminal step, no restart. Automation gets the opposite default (off) because there is no human to complete a browser flow.

**Orchestrator / sub-agent / agent-team scenarios.** When the MCP server runs over stdio and is driven by a *calling* agent (an orchestrator spawning sub-agents), the sub-agent's terminal is usually **not visible** to the caller. The device-code prompt is printed to **stderr**, which the calling agent typically cannot see — so a device-code wait would block invisibly. To avoid that, the server only offers device code when its stderr prompt is on a real **TTY**; otherwise it **fails fast** with actionable guidance rather than hanging. Recommended pattern for headless/agent setups:

1. **Pre-authenticate before starting the server.** For the bootstrap / control-plane token, run `az login` (`--allow-no-subscriptions` for M365-only tenants). For the owning-app token, sign in once interactively in a **visible** terminal: `spe-mcp auth --client-id <appId> --tenant-id <tenantId>`.
2. **Restart the server after signing in** so it re-primes auth from the freshly cached token (startup auth is stamped for the session), then let the agent drive tool calls.

This keeps sub-agents non-blocking: they either use a pre-cached token silently or return a clear "sign in first" error instead of stalling on an invisible prompt.


### Token Storage

Tokens are cached under the **data directory** (default `~/.spe-mcp/`, or a `--data-dir` / `SPE_DATA_DIR` override) in per-identity files named `token-cache.<tenantId>.<clientId>.json` (a legacy `token-cache.json` may also exist). Each file contains MSAL's serialized token cache (refresh tokens, account info). On macOS/Linux the cache directory is created `0700` and the cache files `0600` (owner read/write only), and the server fails closed if the directory is a symlink, owned by another user, or group/other-accessible; on Windows the files are protected by the per-user profile ACL (an off-profile `--data-dir` override is given an owner-only DACL, or refused).

### Running multiple instances (isolating state)

The data directory holds a single provisioning `state.json` plus the token cache, so two servers pointed at the **same** directory can clobber each other's state. To run more than one instance (e.g. two tenants, or a published build alongside a local build), give each its own `--data-dir` / `SPE_DATA_DIR`:

```jsonc
// .vscode/mcp.json — two isolated instances
{
  "servers": {
    "spe-tenantA": {
      "command": "npx",
      "args": [
        "-y",
        "@microsoft/spe-mcp",
        "start",
        "--install-source",
        "github-readme",
        "--install-content",
        "readme-install",
        "--install-campaign",
        "docs-install-buttons"
      ],
      "env": { "SPE_DATA_DIR": "~/.spe-mcp-tenantA", "SPE_TENANT_ID": "<tenant-A>" }
    },
    "spe-tenantB": {
      "command": "npx",
      "args": [
        "-y",
        "@microsoft/spe-mcp",
        "start",
        "--install-source",
        "github-readme",
        "--install-content",
        "readme-install",
        "--install-campaign",
        "docs-install-buttons"
      ],
      "env": { "SPE_DATA_DIR": "~/.spe-mcp-tenantB", "SPE_TENANT_ID": "<tenant-B>" }
    }
  }
}
```

The path must be **absolute** (a leading `~/` is expanded against your home directory); CWD-relative paths are rejected so credentials can never be written into a working directory. The same value must be used for `start`, `auth`, and `logout` of a given instance — set it once via `SPE_DATA_DIR` (as above) and all three commands agree.

### Full Local Auth Reset

If you want a completely clean local auth/provisioning state (tokens + Azure CLI session + remembered owning app/tenant), run:

```powershell
npx spe-mcp logout
az logout
Remove-Item "$HOME/.spe-mcp/state.json" -Force -ErrorAction SilentlyContinue
```

`spe-mcp logout` clears MSAL token cache files, while `state.json` stores persisted provisioning metadata used to prime bootstrap auth on startup.

> **TODO:** Add OS keychain support via [keytar](https://github.com/nicktrav/keytar) as the primary cache, falling back to file cache. Keytar provides OS-managed encryption (Windows Credential Manager / macOS Keychain / Linux Secret Service) but hit data size limits with MSAL's multi-scope cache during initial testing.

## Architecture

```
src/
├── index.ts                — MCP server: TOOLS registry, dispatch, transport, prompts/resources wiring
├── cli.ts                  — CLI entry point (start, auth, logout)
├── auth.ts                 — MSAL auth (silent → browser → device code)
├── bootstrap.ts            — Azure CLI bootstrap (signed-in identity, az token)
├── azure-cli.ts            — az invocations (subscriptions, resource groups, RP registration)
├── graph-client.ts         — Microsoft Graph client with retry + auth
├── docs-client.ts          — Microsoft Learn MCP proxy (docs_search / docs_fetch)
├── container-retry.ts      — Retry helper for registration propagation delays
├── validation.ts           — Shared input validation
├── state.ts                — Provisioning state persistence
├── prompts.ts              — MCP Prompt (provision_spe_app)
├── resources.ts            — MCP Resources (reference architectures)
├── reference-architectures.ts — Reference-architecture catalog (reads ../samples/)
├── elicitation.ts          — Interactive consent / step-up prompts
├── user-agent.ts           — Product/bounded User-Agent attribution + telemetry opt-out
├── types.ts                — Shared TypeScript types
└── tools/                  — 31 tools across 28 modules (one McpTool per export)
    ├── status.ts                   — status_get
    ├── create-app.ts / provision.ts — project_app_create, project_provision
    ├── create-container-type.ts / register-container-type.ts / list-container-types.ts
    ├── create-container.ts / list-containers.ts / get-container.ts
    ├── manage-permissions.ts / archive-restore.ts / delete-container.ts
    ├── upload-file.ts / create-folder.ts / search-content.ts / preview-file.ts / manage-sharing.ts
    ├── content-access.ts           — content_access_grant / content_access_revoke (+ withContentAccess gate)
    ├── check-billing.ts / setup-billing.ts / list-azure.ts
    ├── scaffold.ts / hydrate-config.ts / seed-sample-data.ts / run-local.ts / deploy-azure.ts
    ├── cleanup.ts                  — project_cleanup
    └── search-docs.ts              — docs_search / docs_fetch
```

> Unit/integration tests live alongside their modules as `*.test.ts` (run with `npm test`).

Architecture highlights:
- Transport connects before auth (MCP handshake never blocked)
- Auth initializes in background; retries on first tool call if startup auth fails
- Tools are `{ name, description, inputSchema, handler }` — ListTools strips handlers for serialization
- Content-plane tools are wrapped with `withContentAccess(...)` so they stay gated behind the opt-in consent

## Adding New Tools

1. Create `src/tools/your-tool.ts`. Name the tool in grouped `snake_case`
   (`<domain>_<action>`, e.g. `container_get`, `content_file_upload`):

```typescript
import type { McpTool } from "../types.js";

export const yourTool: McpTool = {
  name: "container_example_action",
  description: "What the tool does",
  inputSchema: {
    type: "object",
    properties: {
      param: { type: "string", description: "..." },
    },
    required: ["param"],
  },
  handler: async (args) => {
    // Call graph-client functions
    return {
      content: [{ type: "text", text: "result" }],
    };
  },
};
```

2. Add Graph API calls to `src/graph-client.ts` (or `azure-cli.ts` for `az`-backed tools)
3. Import the tool and add it to the `TOOLS` array in `src/index.ts`. If it reads or
   writes container content, wrap it with `withContentAccess(...)` so it respects the
   content-plane opt-in gate.
4. Rebuild: `npm run build`

## Testing

```bash
npm test          # vitest unit/integration tests (tool logic, mocked I/O)
npm run lint      # eslint
npm run typecheck # tsc --noEmit
npm run ci        # typecheck + test + build (what CI runs)
```

Vitest runs in watch mode with `npm run test:watch`, which is handy alongside a
debugger (see below). `npm run build:watch` recompiles on save.

## Debugging

The server is a **stdio MCP server**: its entry point is `dist/cli.js start`
(the `spe-mcp` bin), and its stdout carries the MCP JSON-RPC stream while all
logs/diagnostics go to stderr. TypeScript is compiled with `sourceMap: true`, so
`.js.map` files are shipped next to the build and breakpoints set in `src/*.ts`
map straight onto the running `dist/*.js`.

**1. Build first** so the source maps exist:

```bash
npm run build
```

**2. VS Code — launch the server (and tests) under the debugger.** Add a
`.vscode/launch.json`:

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "type": "node",
      "request": "launch",
      "name": "Debug SPE MCP server",
      "program": "${workspaceFolder}/dist/cli.js",
      "args": ["start"],
      "console": "integratedTerminal",
      "sourceMaps": true,
      "outFiles": ["${workspaceFolder}/dist/**/*.js"]
    },
    {
      "type": "node",
      "request": "launch",
      "name": "Debug vitest",
      "program": "${workspaceFolder}/node_modules/vitest/vitest.mjs",
      "args": ["run"],
      "console": "integratedTerminal",
      "sourceMaps": true
    }
  ]
}
```

Set breakpoints in `src/` (e.g. a tool handler, `dispatch` in `index.ts`, or the
`catch` in `startServer`), then press **F5**. The "Debug SPE MCP server" config
starts a bootstrap-mode session (sign in first with
`az login --allow-no-subscriptions`); pass `--client-id`/`--tenant-id` in `args`
for pre-provisioned-app mode.

**3. Attach with `--inspect` (CLI, Chrome DevTools, or when an MCP client spawns
the server).** Break on the first line so you can attach before startup runs:

```bash
node --inspect-brk dist/cli.js start
```

Then attach from VS Code (**Attach to Node Process**) or open `chrome://inspect`.
Because logs are on stderr, the inspector banner and server logs never corrupt
the JSON-RPC stream on stdout. You can also exercise the server interactively
under the debugger with the MCP Inspector:

```bash
npx @modelcontextprotocol/inspector node dist/cli.js start
```

When a failure surfaces a `correlationId`, grep the server's stderr for that id
to find the matching `Tool error (<id>)` log line — see
[docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md#correlation-ids).

## Contributing

This project welcomes contributions and suggestions. See
[CONTRIBUTING.md](CONTRIBUTING.md) for details. Most contributions require you to agree
to a Contributor License Agreement (CLA); for details visit
<https://cla.opensource.microsoft.com>.

This project has adopted the
[Microsoft Open Source Code of Conduct](https://opensource.microsoft.com/codeofconduct/).
For more information see the
[Code of Conduct FAQ](https://opensource.microsoft.com/codeofconduct/faq/) or contact
[opencode@microsoft.com](mailto:opencode@microsoft.com) with any additional questions or
comments.

## Security

Microsoft takes security seriously. If you believe you have found a security
vulnerability, please report it privately as described in [SECURITY.md](SECURITY.md) —
**do not** file a public GitHub issue.

## Important notices

The MCP-specific notices and disclaimers for this project are consolidated in
[NOTICE.md](NOTICE.md); the key points are summarized below.

> **Preview software.** `@microsoft/spe-mcp` is an early (alpha) preview released for
> evaluation and feedback. It is provided **"as is"**, without warranty of any kind; see the
> [MIT License](LICENSE). Tool names, options, and behavior may change without notice.
> Microsoft shall not be liable for any damages arising from use, misuse, or misconfiguration
> of this software.

### Autonomous and agent-invoked operations

This server exposes tools that **create, modify, and delete real resources** in your
Microsoft Entra tenant and Azure subscription — for example app registrations, SharePoint
Embedded container types, containers, and their content. Any connected MCP client,
**including autonomous AI agents**, can invoke these tools on your behalf, and you are
responsible for the actions taken with your credentials. To stay in control:

- **Review each action.** State-changing tools require an explicit confirmation
  (`confirm: true`) before they run — the destructive-operation confirmation gate
  (**SAFE-002**).
- **Explore read-only.** Start the server with `--read-only` (or `SPE_READ_ONLY`) to
  advertise and allow only read-only tools (**SAFE-003**).
- **Limit the surface.** Use the `--tools` allowlist / profiles (or `SPE_TOOLS`) to expose
  only the tools you need (**SAFE-004**).

See [docs/SECURITY-CONTROLS.md](docs/SECURITY-CONTROLS.md) for the full list of safeguards.

### Cost and billing

SharePoint Embedded is a **metered, billable** service (standard billing is registered
through the `Microsoft.Syntex` resource provider in your Azure subscription). Provisioning
or using SPE resources with this tool **may incur charges** on the subscription you connect.
A free **trial** container type is available for evaluation. You are responsible for any
charges incurred in your tenant and subscription.

### Data, privacy, and telemetry

The server runs **locally** and talks to your MCP client over stdio. It authenticates **to
your own tenant** and calls Microsoft first-party endpoints — Microsoft Graph and Azure
Resource Manager — **on your behalf**; the content and directory data involved flow only
between your machine, your MCP client, and those Microsoft services in your own
tenant/subscription.

The server opens **no separate telemetry channel**. Each authenticated Graph/ARM request
carries a product `User-Agent` (`spe-mcp-server/<version>`). An install configuration can
add bounded source, content, campaign, and self-reported agent-host labels to that
request header. The raw MCP client name and version are not sent in these labels.
The labels contain no personal or tenant identifiers, but Microsoft services can
associate them with the authenticated request in normal service logs. Omit install and
agent-host labels with `--no-install-attribution`, or all attribution tokens with
`SPE_MCP_COLLECT_TELEMETRY=false`. Authentication tokens are cached locally with owner-only
permissions (**SEC-003**). For details see [PRIVACY.md](PRIVACY.md) and
[docs/DATA-FLOW.md](docs/DATA-FLOW.md); Microsoft's handling of data you send to its online
services is described in the
[Microsoft Privacy Statement](https://privacy.microsoft.com/privacystatement).

The one destination contacted by default that is **not a Microsoft 365 or Azure Online Service**
is the public npm registry (`https://registry.npmjs.org`, operated by npm, Inc./GitHub), contacted
at most once a day per running package version and registry (while the shared cache is retained)
by the [update check](#update-notifications) to read the published version list for
`@microsoft/spe-mcp`. ⚠️ Because it is not a Microsoft Online Service, it is **not covered by the
Microsoft Product Terms, the Microsoft Products and Services Data Protection Addendum (DPA), or
the EU Data Boundary**, and it is **outside the Microsoft 365 / Azure compliance
boundary**. The request is **unauthenticated and carries no user identifier** — exactly
`GET https://registry.npmjs.org/@microsoft%2fspe-mcp` with no query string, no credentials or
cookies, redirects rejected, and **no install GUID, machine, user, tenant, subscription,
correlation, or session identifier**; it is an ordinary public package lookup, identical to
what `npm view` would issue. As with any HTTPS request, npm can observe your **IP address**,
the static `User-Agent`, **standard TLS/HTTP connection metadata** (TLS handshake and SNI,
`Host`/`Accept` headers, request timing), and the **time of the request**;
those are disclosed by the connection itself, not added by this tool. Nothing is downloaded,
installed, or executed — there is **no auto-update**. Before the first check, a one-time
notice naming the endpoint and the opt-out is printed to **stderr**. Disable it with
`SPE_MCP_UPDATE_CHECK=false` (preferred), `--no-update-check`, `SPE_NO_UPDATE_CHECK=1` (legacy
alias), `NO_UPDATE_NOTIFIER=1`, or `SPE_MCP_COLLECT_TELEMETRY=false` — the telemetry opt-out
suppresses the registry request **entirely**, it does not merely drop the `User-Agent`. When
disabled, the request is
never made and nothing is cached. It is also skipped automatically in CI and in source
checkouts. The cached result lives at `<data dir>/update-check.json`, is retained until you
delete it, and is removed by `spe-mcp logout` / `spe-mcp auth --reset`. npm's own handling of
registry requests is governed by the
[npm privacy policy](https://docs.npmjs.com/policies/privacy).
If `SPE_NPM_REGISTRY` is set, the request goes to that configured endpoint instead. Its operator,
policies, and compliance boundary depend on your configuration; the server does not attribute it
to npm/GitHub or classify it as inside or outside a particular boundary.

**Data collection (standard Microsoft notice).** The software may collect information about
you and your use of the software and send it to Microsoft; Microsoft may use this information
to provide and improve products and services, and your use of the software operates as your
consent to these practices (full text in [NOTICE.md](NOTICE.md#data-collection)). **This
build opens no usage-analytics channel** — its only Microsoft-bound signals are the bounded
`User-Agent` attribution tokens described above, which you can turn off with
`SPE_MCP_COLLECT_TELEMETRY=false`. Separately, the default-on
[update check](#update-notifications) contacts the **public npm registry by default**
(`registry.npmjs.org`, operated by npm, Inc./GitHub). That endpoint is **not a Microsoft 365 or
Azure Online Service**: it sits **outside the Microsoft 365 / Azure compliance boundary** and is
not covered by the Microsoft Product Terms, the Microsoft Products and Services Data Protection
Addendum (DPA), or the EU Data Boundary. See the npm registry disclosure above and
[NOTICE.md — Third-party services contacted](NOTICE.md#third-party-services-contacted) for what
is and is not disclosed, how configured registries are handled, and how to turn it off.

**Telemetry configuration.** Attribution is gated by the `SPE_MCP_COLLECT_TELEMETRY` environment
variable and is **on by default**. The only telemetry emitted is the product and optional
bounded attribution tokens in the `User-Agent` on outbound Graph/ARM requests (aggregate
traffic attribution — no usage analytics or personal/tenant/per-user data). Set
`SPE_MCP_COLLECT_TELEMETRY=false` to omit all attribution tokens from outbound requests;
those requests then fall back to the underlying tool's
default `User-Agent` (the Azure CLI's own token for `az`/`azd`; the Node runtime default for
direct Graph calls).

### Data residency and EU Data Boundary

This tool performs **no independent cross-region processing** and stores no customer content
of its own. Because it calls your own tenant's Microsoft Graph and Azure endpoints, data
location, residency, and **EU Data Boundary (EUDB)** commitments follow the underlying
Microsoft Online Services and your tenant configuration — not this tool. The only additional
Microsoft endpoint is the read-only, public [Microsoft Learn MCP](https://learn.microsoft.com/api/mcp)
documentation service (no authentication, no customer data; host-validated per **SEC-007**),
which can be disabled with `--tools`. Apart from the opt-out-able npm update check described
above, all outbound calls target Microsoft-operated services; the public npm registry is the
**only** endpoint that is **not a Microsoft 365 or Azure Online Service** and therefore the only
one outside Product Terms / DPA / EUDB coverage.

### Compliance responsibility

This MCP server may interact with clients and services outside Microsoft compliance
boundaries — in particular, the third-party MCP client, host, or agent you choose to connect
it to. You are responsible for ensuring that any integration complies with applicable
organizational, regulatory, and contractual requirements.

### Third-party components

This MCP server may use or depend on third-party components, such as third-party MCP clients,
hosts, agents, AI applications, and/or models. You are responsible for reviewing and
complying with the licenses of any third-party components and vetting the security of any
third-party components. The open-source libraries this server depends on directly are
disclosed in [THIRD-PARTY-NOTICES](THIRD-PARTY-NOTICES).

### Export control

Use of this software must comply with all applicable export laws and regulations, including
U.S. Export Administration Regulations and local jurisdiction requirements.

### Product Terms

SharePoint Embedded, Microsoft Graph, and other Microsoft Online Services accessed through
this tool are **licensed separately**, and their use is governed by the agreement under which
you obtained them — including the
[Microsoft Product Terms](https://www.microsoft.com/licensing/terms/) and the
[Microsoft Products and Services Data Protection Addendum (DPA)](https://www.microsoft.com/licensing/docs/view/Microsoft-Products-and-Services-Data-Protection-Addendum-DPA).
This open-source tool grants no rights to any Microsoft Online Service and does not modify
those terms. More generally, this server may provide access to underlying resources — tools,
services, and/or data — and your use of any such underlying resource via this server is
governed by that resource's own license terms.

## Trademarks

This project may contain trademarks or logos for projects, products, or services.
Authorized use of Microsoft trademarks or logos is subject to and must follow
[Microsoft's Trademark & Brand Guidelines](https://www.microsoft.com/legal/intellectualproperty/trademarks/usage/general).
Use of Microsoft trademarks or logos in modified versions of this project must not cause
confusion or imply Microsoft sponsorship. Any use of third-party trademarks or logos is
subject to those third-parties' policies.

## License

Licensed under the [MIT License](LICENSE).
