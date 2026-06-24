# spe-sample-react-spa-functions

A runnable **SharePoint Embedded** React SPA (Vite + TypeScript), scaffolded by the SPE Builder MCP.
Signs in with MSAL as your owning app and lists the container type's containers and files via Microsoft Graph.

## Configuration

`project_hydrate_config` writes SPE settings into `.env` as Vite variables:
`VITE_TENANT_ID`, `VITE_CLIENT_ID`, `VITE_CONTAINER_TYPE_ID`, `VITE_CONTAINER_ID`.

## Run locally

```bash
npm install
npm run dev      # Vite dev server on http://localhost:5173
```

## Deploy to Azure

```bash
azd up           # provisions a resource group + Azure Static Web App (Free) and deploys dist/
```

The infrastructure in `infra/` is **subscription-scoped** and creates its own resource group, so
`azd up --no-prompt` needs only an environment name, location, and subscription.

> Sign-in note: the owning Entra app must allow this app's origin as a **SPA redirect URI**
> (`project_deploy` adds the deployed URL automatically; for local dev add `http://localhost:5173`).
