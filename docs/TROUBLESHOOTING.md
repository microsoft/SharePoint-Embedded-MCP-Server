# Troubleshooting

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
