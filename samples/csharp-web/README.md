# spe-sample-csharp-web

A **SharePoint Embedded** reference app scaffolded by the SPE Builder MCP and based on the
ODSP security-approved azd template
[`microsoft/app-with-sharepoint-knowledge`](https://azure.github.io/ai-app-templates/repo/microsoft/app-with-sharepoint-knowledge/).
It deploys to **Azure Container Apps**.

## Security model (why this template)

- **No client secrets.** A user-assigned **managed identity** is federated to the Entra app
  (`federatedIdentityCredentials`), so the app gets tokens via
  `SignedAssertionFromManagedIdentity` — there is nothing to leak or rotate.
- **Least-privilege RBAC.** The identity is granted only **AcrPull** to pull its image.
- **Declarative + reproducible.** Subscription-scoped `infra/main.bicep` provisions its own
  resource group; names are derived from `abbreviations.json` + a `resourceToken`.

## Configuration

SPE settings are injected by `project_hydrate_config` into `.env` /
`appsettings.Development.json`: `TENANT_ID`, `CLIENT_ID`, `CONTAINER_TYPE_ID`, `CONTAINER_ID`.
In Azure they are surfaced to the container as `SharePointEmbedded__*` environment variables
(see `infra/app/web.bicep`).

## Run locally

```bash
dotnet run
```

## Deploy to Azure

```bash
azd up
```

This provisions the managed identity, Azure Container Registry, Container Apps environment, the
federated Entra app, and the container app — then deploys the image. The Entra app's production
redirect URI is configured automatically from the deployed app's FQDN.
