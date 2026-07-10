# Data flow and network endpoints

This document enumerates every network destination the SPE MCP server can contact, what
travels there, and how that maps to Microsoft compliance boundaries. It backs the
"Data, privacy, and telemetry" and "Data residency and EU Data Boundary" notices in the
[README](../README.md#important-notices) and the [PRIVACY](../PRIVACY.md) notice.

## Topology

```
MCP client  <--stdio-->  spe-mcp-server (local process)  <--HTTPS-->  Microsoft endpoints
```

- The server is a **local** process. It talks to your MCP client over **stdio**; it opens no
  network socket for the client connection.
- Every outbound network call is HTTPS to a **Microsoft-operated** endpoint, made **on your
  behalf**, using **your** credentials, into **your** tenant and subscription.

## Outbound endpoints

| Endpoint | Purpose | Authentication | Data sent | Boundary |
|----------|---------|----------------|-----------|----------|
| Microsoft Entra / MSAL (`login.microsoftonline.com`) | Interactive/silent sign-in and token acquisition | User (PKCE / device code) | Your sign-in and auth-code exchange | Microsoft first-party |
| Microsoft Graph (`graph.microsoft.com`) | Create/manage app registrations, container types, containers, and content | Your delegated token | The requests you invoke, in your tenant | Microsoft first-party, in-tenant |
| Azure Resource Manager (`management.azure.com`) | Register the `Microsoft.Syntex` provider and wire SPE billing to your subscription | Your Azure token | ARM requests in your subscription | Microsoft first-party, in-subscription |
| Microsoft Learn MCP (`learn.microsoft.com/api/mcp`) | Read-only public documentation lookup (`docs_search`) | **None** | Documentation queries only — **no customer data** | Microsoft first-party, public docs |

The server contacts **no non-Microsoft services**. The Microsoft Learn documentation lookup
is the only unauthenticated, out-of-tenant call; it carries no customer data, is host-
validated before use (control **SEC-007**), and can be disabled with `--tools`.

## Local artifacts

These never leave your machine:

- The MSAL **token cache** and the **provisioning-state** file, written owner-only (control
  **SEC-003**).
- **stderr** diagnostic logs, with tokens and secrets redacted (`src/logging.ts`).

## Compliance boundary and EU Data Boundary (EUDB)

- Microsoft Graph, Azure Resource Manager, and SharePoint Embedded are Microsoft Online
  Services operating **within the Microsoft 365 / Azure compliance boundary**. Requests you
  make through this tool stay within that boundary and your tenant's configured data location.
- The tool performs **no independent cross-region processing** and stores **no customer
  content** of its own. Data location, residency, and **EU Data Boundary** commitments are
  determined by those underlying services and your tenant configuration — not by this tool.

## Telemetry

The server opens **no telemetry channel** and sends **no usage analytics**. Outbound requests
carry only a static product `User-Agent` (`spe-mcp-server/<version>`) with no personal,
tenant, or usage data. See [PRIVACY.md](../PRIVACY.md) for details.
