# Known issues

## Eventual consistency

New container types, registrations, containers, permission changes, and uploaded content may take time to propagate across Graph, SharePoint Embedded, and Microsoft 365 search. Retry read/search operations after a short delay.

## Trial billing expiry

Trial container types are intended for evaluation and expire after 30 days. For production or longer-running development, create a new container type with `billingClassification=standard` and complete `billing_setup`.

## Trial-to-standard conversion is not supported

This server does not use SharePoint-admin write APIs, so it cannot convert an existing trial container type to standard billing. Choose standard at creation time with `project_provision` or `container_type_create`.

## Public-client app limitations

The server uses a public-client Entra app for local developer flows. Do not put client secrets in MCP client configuration. Some enterprise Conditional Access policies may require interactive sign-in or admin consent before delegated SPE or ARM operations succeed.

## Local run and deployment dependencies

`project_run_local` requires the scaffold's runtime toolchain (Node.js/npm for React SPA + Functions, .NET SDK for C# web). `project_deploy` requires Azure Developer CLI (`azd`) and an Azure login.

## Search freshness

`content_search` may lag behind `content_file_upload` or sample seeding because search indexing is asynchronous.
