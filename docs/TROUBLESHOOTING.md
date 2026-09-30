# Troubleshooting

## VS Code install error: `Cannot create property 'type' on string ...`

If VS Code shows this error in Developer Tools after clicking an install badge:

```text
TypeError: Cannot create property 'type' on string 'SharePoint Embedded MCP Server'
```

the local MCP JSON is malformed. This is a config-shape issue, not a server runtime issue.

Common causes:

- `servers` contains a string value instead of a server object.
- The entry is structured as `"servers": { "name": "...", "type": "...", ... }` (missing a server key like `"spe"`).
- Markdown/link text was pasted into JSON args (for example `@microsoft/[spe-mcp...](vscode-file://...)`).

Use this minimal valid shape instead:

```json
{
  "servers": {
    "spe": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@microsoft/spe-mcp", "start"]
    }
  }
}
```

Recovery steps:

1. Open your MCP config (`.vscode/mcp.json` or user-level MCP config).
2. Remove malformed SPE entries and any markdown-style link text in `args`.
3. Paste the valid shape above.
4. Reload VS Code (`Developer: Reload Window`) and retry install.

## `az login` has not been run

Most provisioning and billing flows start with `status_get`. If it reports no Azure CLI identity, run:

```bash
az login --allow-no-subscriptions
```

Use `--allow-no-subscriptions` for M365-only tenants that do not have an Azure subscription.

## Auth, scope, or consent errors

The owning Entra public-client app needs SPE delegated permissions such as `FileStorageContainer.Selected`, `FileStorageContainerType.Manage.All`, and `FileStorageContainerTypeReg.Manage.All`. Re-run the provisioning flow or grant/admin-consent the missing permissions in Entra ID.

For ARM Conditional Access or claims-challenge errors during standard billing, complete an interactive ARM-scoped sign-in and retry:

```bash
az login --scope https://management.core.windows.net//.default --tenant <tenant-id>
```

If your tenant requires an auth-context step-up that Azure CLI cannot satisfy, complete the step-up in the SharePoint admin center, then retry the MCP tool.

## Container-type registration delays

After `container_type_register` or `project_provision`, Graph and SharePoint registration state can take time to propagate. If `container_create`, `container_type_get`, or app access fails immediately after registration, retry after a short delay.

## Billing or Microsoft.Syntex RP failures

Standard billing requires a container type created with `billingClassification=standard`; trial container types cannot be converted. Use:

1. `azure_subscriptions_list`
2. `azure_resource_groups_list`
3. `billing_setup` without `confirm` to preview
4. `billing_setup` with `confirm=true` after explicit approval
5. `billing_check` to verify

If the `Microsoft.Syntex` resource provider is not registered or is still registering, retry after registration completes.

## Search index latency

`content_search` depends on Microsoft 365 indexing. Newly uploaded files may not appear immediately. Retry after indexing has caught up.

## Content tools fail before `content_access_grant`

Content-plane tools are intentionally off by default and fail closed. Before `project_seed_sample_data`, `content_file_upload`, `content_folder_create`, `content_search`, `content_file_preview`, or `content_sharing_manage`, ask for explicit opt-in and run:

```text
content_access_grant confirm=true
```

Access can be disabled later with `content_access_revoke`.

## Update notice: missing, stale, or registry unreachable

The server checks the public npm registry at most once every 24 hours for the same running
package version and registry across processes sharing the retained data-directory cache. If a
newer release exists, it appends a one-line
`Update available: …` notice to a single tool result. It never blocks, never retries in-band,
and **never updates itself** — there is no auto-update.

Common situations:

- **No notice appears, but a newer version exists.** The check is skipped by design when
  running from a source checkout, in CI (`CI`, `GITHUB_ACTIONS`, `TF_BUILD`, …), or when any
  opt-out is set: `SPE_MCP_UPDATE_CHECK=false` (preferred), `--no-update-check`,
  `SPE_NO_UPDATE_CHECK=1` (legacy alias), `NO_UPDATE_NOTIFIER=1`, or
  `SPE_MCP_COLLECT_TELEMETRY=false` (the telemetry opt-out suppresses the registry request
  entirely; it does not merely omit the `User-Agent`). Channel and stable targets are suppressed
  independently, so each detected target version is shown only once per cache. Run `status_get`
  to see the **Update check** row, which reports the exact state
  and skip reason. When skipped, **no network request, stderr notice, or cache write occurs**.
- **Offline, proxied, or firewalled registry.** The lookup has a 2-second timeout and fails
  silently; the failure is cached so the server does not retry on every call. `status_get`
  reports `— unavailable (registry not reachable)`. This is harmless — no functionality
  depends on it.
- **Proxy-only environment.** Routing depends on the Node.js runtime configuration. Releases
  that support Node's environment-proxy mode (including current Node 24/26 releases) can honor
  `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` when it is enabled with
  `NODE_USE_ENV_PROXY=1` or `--use-env-proxy`; Node 22 may ignore those variables and attempt a
  direct connection. Enforce mandatory proxy routing at the runtime or network layer, or
  disable the check with `SPE_MCP_UPDATE_CHECK=false`.
- **Internal/mirror registry.** Set `SPE_NPM_REGISTRY` to your mirror. It must be an `https:`
  URL with no embedded credentials, query string, or fragment; anything else is ignored and
  the check is disabled for that run. Redirects and cross-host responses are rejected. The
  notice and `status_get` identify a configured registry neutrally; its operator and compliance
  boundary depend on your configuration.
- **A one-time stderr notice appeared at startup.** Before the first registry request, the
  server prints a single collection notice to **stderr** naming the endpoint and the opt-out.
  For the default `registry.npmjs.org` endpoint it names npm, Inc./GitHub and the boundary; for
  a configured registry it does not guess the operator or boundary. It is informational; stdout
  is never written to. Set any opt-out above to suppress it entirely.
- **Delete the cached update state.** The cache lives at `<data dir>/update-check.json` (path
  shown by `status_get`), contains **no identifier**, and is retained until removed. Delete it
  with `spe-mcp logout`, `spe-mcp auth --reset`, or by removing the file manually. Deleting it
  also forces a re-check on the next start.
- **Multiple server processes start together.** An owner-only `update-check.json.lock` file
  serializes stale-cache refreshes. The lock owner records the 24-hour attempt before egress;
  other processes make no request. The lock is normally removed immediately and an abandoned
  regular-file lock is reclaimed after 30 seconds only after its recorded local process is no
  longer alive. Lock or cache errors fail closed without contacting the registry. Changing the
  running package version or registry, or deleting the cache, intentionally starts a new
  24-hour window.

## Correlation IDs

When a tool fails, the client-facing error carries a short **correlation ID**,
for example:

```text
The tool failed. See server logs for details. (correlationId: a1b2c3d4)
```

That same id is logged to the server's **stderr** at the point of failure:

```text
[2026-07-08T12:34:56.789Z] [MCP] Tool error (a1b2c3d4) {"tool":"container_create","argKeys":["displayName","containerTypeId"], ...}
```

To debug a reported failure, grep the server's stderr log for the id to find the
redacted argument preview and the sanitized upstream (Graph/ARM) error that
produced it:

```bash
grep a1b2c3d4 spe-mcp.log
```

(stdout is reserved for the MCP JSON-RPC protocol, so all logs — including this
line — go to stderr; redirect stderr to a file to retain it, e.g.
`node dist/cli.js start 2> spe-mcp.log`.) The correlation ID is a client↔log
join key only: it is generated locally per failure and is **not** sent to
Graph/ARM as an `x-ms-client-request-id`.
