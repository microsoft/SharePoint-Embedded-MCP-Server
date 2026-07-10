# E2E prompt catalog

Use these natural-language prompts for MCP UX regression across clients.

## Provisioning flow

- "Create a SharePoint Embedded trial app for a construction document portal, scaffold a React sample, hydrate config, and offer to run it locally."
- "Create a standard-billing SPE app for a legal document review portal; let me choose the Azure subscription and resource group before provisioning."

## Individual provisioning tools

- `status_get`: "Check whether I am signed in and ready to provision SharePoint Embedded resources."
- `project_app_create`: "Create the owning Entra app for my SPE project."
- `container_type_create`: "Create a standard SPE container type named Contoso Docs for my owning app."
- `container_type_register`: "Register my SPE container type so consuming apps can use it."
- `container_create`: "Create a demo container for my registered SPE container type."
- `container_type_list`: "List my SPE container types."
- `container_type_get`: "Show details for this SPE container type ID."
- `container_list`: "List containers for this SPE container type."
- `container_get`: "Show details for this SPE container."
- `container_type_update`: "Rename this SPE container type."
- `container_type_grant_owner`: "Grant another app owner access to this container type."
- `container_type_owners_list`: "List owner grants on this container type."
- `container_type_revoke_owner`: "Revoke an owner grant from this container type."
- `container_type_app_grant_add`: "Authorize a consuming app for this registered container type."
- `container_type_app_grants_list`: "List consuming app grants for this container type registration."
- `container_type_app_grant_remove`: "Remove a consuming app grant from this container type registration."
- `container_type_delete`: "Delete this unused trial container type after confirming what will be removed."

## Billing flow

- "Set up standard billing for my current SPE container type; show me subscriptions and resource groups, preview first, then ask before confirming."
- `azure_subscriptions_list`: "List Azure subscriptions I can use for SPE standard billing."
- `azure_resource_groups_list`: "List resource groups in this Azure subscription for SPE billing."
- `billing_setup`: "Attach standard billing to this already-standard container type, but preview before making changes."
- `billing_check`: "Check billing status and trial expiry for my SPE container type."

## Scaffold, run, and deploy

- `project_scaffold`: "Show SPE reference app options, then scaffold the React SPA + Functions sample into ./spe-demo."
- `project_hydrate_config`: "Hydrate the scaffolded app configuration from my current SPE provisioning state."
- `project_run_local`: "Run my scaffolded SPE app locally and tell me the URL."
- `project_deploy`: "Deploy my scaffolded SPE app to Azure in eastus and return the live URL."

## Content operations

- `content_access_grant`: "Enable content access so you can seed sample documents in my SPE container."
- `project_seed_sample_data`: "Seed sample containers and documents for my current SPE project."
- `content_folder_create`: "Create a Reports folder in this SPE container."
- `content_file_upload`: "Upload this small sample document to my SPE container."
- `content_search`: "Search my SPE content for permit documents."
- `content_file_preview`: "Preview this file from my SPE container."
- `content_sharing_manage`: "List sharing links for this SPE file."
- `content_access_revoke`: "Revoke content-plane access after the demo."

## Container lifecycle and permissions

- `container_permissions_manage`: "Grant this user access to the demo SPE container."
- `container_archive_restore`: "Archive this demo container after confirming."
- `container_delete`: "Delete this test container after confirming."

## Docs and troubleshooting

- `docs_search`: "Find official Microsoft documentation for SharePoint Embedded container type registration."
- `docs_fetch`: "Fetch the full Microsoft Learn page for this SharePoint Embedded article URL."
- "Troubleshoot why standard billing fails with a Microsoft.Syntex resource provider error."
- "Troubleshoot why content search cannot find the file I just uploaded."

## Cleanup flow

- `project_cleanup`: "Preview cleanup for my current SPE project and ask before deleting anything."
