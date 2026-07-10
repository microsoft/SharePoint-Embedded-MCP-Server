# SPE MCP Server

A [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server for SharePoint Embedded. Lets any MCP-compatible AI client (VS Code Copilot, Claude Desktop, Cursor, Azure Foundry) manage SPE resources via natural language.

> ⚠️ **Preview software.** Provisioning SharePoint Embedded resources can incur Azure
> charges, and any connected AI agent can act on your tenant with your credentials. Please
> read the **[Important notices](#important-notices)** before use.

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

### VS Code / Cursor

Add an MCP server entry to `.vscode/mcp.json` (VS Code) or your Cursor MCP
configuration:

```json
{
  "servers": {
    "spe": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@microsoft/spe-mcp-server"]
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
      "args": ["-y", "@microsoft/spe-mcp-server"]
    }
  }
}
```

> Bootstrap mode needs no app-specific environment variables; sign in once with
> `az login --allow-no-subscriptions`.

### Updating / removing

Because clients run the package through `npx`, they pick up published updates
without a global install. Pin a specific version with
`@microsoft/spe-mcp-server@0.1.0-alpha.1`. To remove the server, delete the MCP
client config entry.

## Prerequisites

- **Node.js** >= 18

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
| `--data-dir` | `SPE_DATA_DIR` | Directory for the token cache + provisioning state (default `~/.spe-mcp`). Point each instance at a unique **absolute** path (or `~/...`; CWD-relative paths are rejected) to run multiple servers without clobbering state |

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
      "args": ["-y", "@microsoft/spe-mcp-server"],
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
      "args": ["-y", "@microsoft/spe-mcp-server"],
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
spe-mcp start [--client-id ID] [--tenant-id ID] [--read-only] [--tools <profileOrCsv>]

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
      "args": ["-y", "@microsoft/spe-mcp-server", "start"],
      "env": { "SPE_DATA_DIR": "~/.spe-mcp-tenantA", "SPE_TENANT_ID": "<tenant-A>" }
    },
    "spe-tenantB": {
      "command": "npx",
      "args": ["-y", "@microsoft/spe-mcp-server", "start"],
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
├── user-agent.ts           — Product User-Agent string (no telemetry channel)
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

<!--
  MCP notices. The standardized notice/disclaimer wording for Microsoft MCP servers is
  owned by frontline CELA (CELA-only guidance: https://aka.ms/MCP4CELA). The text below is
  a good-faith draft that covers the required topics; the exact MCP disclaimer wording is
  pending frontline-CELA confirmation for Matter-0000001599.
-->
## Important notices

> **Preview software.** `@microsoft/spe-mcp-server` is an early (alpha) preview released for
> evaluation and feedback. It is provided **"as is"**, without warranty of any kind; see the
> [MIT License](LICENSE). Tool names, options, and behavior may change without notice.

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

The server opens **no separate telemetry channel** and sends **no usage analytics** to
Microsoft. Outbound Graph/ARM requests carry a **static product `User-Agent`**
(`spe-mcp-server/<version>`) that contains **no personal, tenant, or usage data** and is
used only for aggregate traffic attribution. Authentication tokens are cached locally with
owner-only permissions (**SEC-003**). For details see [PRIVACY.md](PRIVACY.md) and
[docs/DATA-FLOW.md](docs/DATA-FLOW.md); Microsoft's handling of data you send to its online
services is described in the
[Microsoft Privacy Statement](https://privacy.microsoft.com/privacystatement).

### Data residency and EU Data Boundary

This tool performs **no independent cross-region processing** and stores no customer content
of its own. Because it calls your own tenant's Microsoft Graph and Azure endpoints, data
location, residency, and **EU Data Boundary (EUDB)** commitments follow the underlying
Microsoft Online Services and your tenant configuration — not this tool. The only additional
endpoint is the read-only, public [Microsoft Learn MCP](https://learn.microsoft.com/api/mcp)
documentation service (no authentication, no customer data; host-validated per **SEC-007**),
which can be disabled with `--tools`. All outbound calls target Microsoft-operated services;
the server contacts **no non-Microsoft services**.

### Product Terms

SharePoint Embedded, Microsoft Graph, and other Microsoft Online Services accessed through
this tool are **licensed separately**, and their use is governed by the agreement under which
you obtained them — including the
[Microsoft Product Terms](https://www.microsoft.com/licensing/terms/) and the
[Microsoft Products and Services Data Protection Addendum (DPA)](https://www.microsoft.com/licensing/docs/view/Microsoft-Products-and-Services-Data-Protection-Addendum-DPA).
This open-source tool grants no rights to any Microsoft Online Service and does not modify
those terms.

## Trademarks

This project may contain trademarks or logos for projects, products, or services.
Authorized use of Microsoft trademarks or logos is subject to and must follow
[Microsoft's Trademark & Brand Guidelines](https://www.microsoft.com/legal/intellectualproperty/trademarks/usage/general).
Use of Microsoft trademarks or logos in modified versions of this project must not cause
confusion or imply Microsoft sponsorship. Any use of third-party trademarks or logos is
subject to those third-parties' policies.

## License

Licensed under the [MIT License](LICENSE).
