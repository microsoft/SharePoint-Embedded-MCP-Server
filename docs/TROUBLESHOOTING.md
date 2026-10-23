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

## React SPA sign-in fails with `AADSTS9002326` (redirect URI already registered)

Sign-in in the scaffolded React SPA fails with
`AADSTS9002326: … cross-origin … Single-Page Application …` even though
`http://localhost:5173` **is** listed as a **Single-page application (SPA)**
redirect URI on the app registration you are looking at.

`AADSTS9002326` literally means Entra refused the cross-origin SPA token
redemption because the caller's origin is not a registered **SPA** redirect URI
**on the app that is signing in**. When the URI looks correct, it is almost
always a **configuration mismatch** — the running build is signing in as a
*different* app (or tenant) than the one you edited — not a bug in the sample:

1. **Confirm the running build's identity matches the app you edited.** The SPA
   authenticates with the `VITE_CLIENT_ID` / `VITE_TENANT_ID` values from its
   `.env`. Vite **inlines env vars at build time**, so editing `.env` has no
   effect until you rebuild. Compare the sample's `.env` values against the
   **Application (client) ID** and **Directory (tenant) ID** on the app's
   **Overview** blade in the Entra portal. If they differ, you added the redirect
   URI to the wrong registration (a duplicate display name can select the wrong
   app). Point `.env` at the correct app and **rebuild** (`project_hydrate_config`
   emits a verification advisory reminding you to do this).

2. **Verify the SPA redirect URI on *that* app** (the client id from `.env`, not
   whichever app you happened to open):

   ```bash
   az rest --method GET \
     --url "https://graph.microsoft.com/v1.0/applications?\$filter=appId eq '<VITE_CLIENT_ID>'&\$select=appId,spa" \
     -o json
   ```

   If `spa.redirectUris` does not contain `http://localhost:5173`, add it (note
   the `spa` platform — a Web or public-client redirect will **not** satisfy the
   SPA code-redemption check):

   ```bash
   az rest --method PATCH \
     --url "https://graph.microsoft.com/v1.0/applications/<objectId>" \
     --headers "Content-Type=application/json" \
     --body '{"spa":{"redirectUris":["http://localhost:5173"]}}'
   ```

3. **Reused-app self-repair may have been skipped.** `project_app_create`
   self-repairs a *reused* owning app by adding the SPA redirect URI, but that
   step needs `Application.ReadWrite` on the signed-in identity. If it could not
   be confirmed, the tool now prints a **non-blocking advisory** naming the exact
   client id / object id and the `az rest` commands above — run them (or re-run
   provisioning with sufficient permissions).

4. **Guest / B2B users.** If you signed in as a guest/external user, redemption
   can be refused cross-tenant. Sign in with a member account of the tenant that
   owns the app, or provision in that tenant.

If none of the above resolves it, open a
[Sign-in / AADSTS error issue](https://github.com/microsoft/SharePoint-Embedded-MCP-Server/issues/new?template=signin_issue.yml)
with the diagnostics that template collects.

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
