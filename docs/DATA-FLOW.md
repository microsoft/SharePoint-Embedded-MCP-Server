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
- Every outbound network call is HTTPS. All calls that carry your data go to a
  **Microsoft-operated** endpoint, made **on your behalf**, using **your** credentials, into
  **your** tenant and subscription. The single exception is an unauthenticated public-package
  lookup on the npm registry (below). That request sends **no customer content and no
  application-level user, tenant, subscription, or install identifier** — the package name in
  the request path is the only application-level content. As with any HTTPS request, the
  connection itself necessarily exposes your **source IP address** and **standard transport
  metadata** (TLS handshake and SNI, `Host`/`Accept`/`User-Agent` headers, request timing) to
  the registry operator; see the endpoint table below for the full disclosure.

## Outbound endpoints

| Endpoint | Purpose | Authentication | Data sent | Boundary |
|----------|---------|----------------|-----------|----------|
| Microsoft Entra / MSAL (`login.microsoftonline.com`) | Interactive/silent sign-in and token acquisition | User (PKCE / device code) | Your sign-in and auth-code exchange | Microsoft first-party |
| Microsoft Graph (`graph.microsoft.com`) | Create/manage app registrations, container types, containers, and content | Your delegated token | The requests you invoke, in your tenant | Microsoft first-party, in-tenant |
| Azure Resource Manager (`management.azure.com`) | Register the `Microsoft.Syntex` provider and wire SPE billing to your subscription | Your Azure token | ARM requests in your subscription | Microsoft first-party, in-subscription |
| Microsoft Learn MCP (`learn.microsoft.com/api/mcp`) | Read-only public documentation lookup (`docs_search`) | **None** | Documentation queries only — **no customer data** | Microsoft first-party, public docs |
| npm registry (`registry.npmjs.org`, override `SPE_NPM_REGISTRY`) | Update check: read the published version list for `@microsoft/spe-mcp` at most once per 24 h (control **SEC-008**) | **None** | Package name in the request path only. Necessarily discloses your **IP address**, the static **`User-Agent`** `spe-mcp-server/<version>`, **standard TLS/HTTP connection metadata** (TLS handshake and SNI, `Host`/`Accept` headers, request timing), and the request time. Opting out of telemetry suppresses this request entirely. **No** customer data, tenant/user/subscription identifier, install GUID, machine name, session ID, or usage data | ⚠️ **Third party (npm, Inc. / GitHub) — not a Microsoft 365 or Azure Online Service; OUTSIDE the Microsoft 365 / Azure compliance boundary and not covered by the Microsoft Product Terms, DPA, or EUDB** |

Only two calls leave your tenant, and neither carries customer data:

- The **Microsoft Learn documentation lookup** is unauthenticated and out-of-tenant; it is
  host-validated before use (control **SEC-007**) and can be disabled with `--tools`.
- The **npm update check** is the only destination that is **not a Microsoft 365 or Azure Online
  Service** and the only endpoint
  **outside the Microsoft 365 / Azure compliance boundary**. It issues exactly one request —
  `GET https://registry.npmjs.org/@microsoft%2fspe-mcp`, the exact package path with no query
  string and no fragment — the same request `npm view` issues, with a 2-second timeout, a 64 KB
  response cap, HTTPS enforced, **redirects to any other host rejected**, no
  credentials/cookies/`Authorization`/`.npmrc`, and no `npm` subprocess. It only *notifies*;
  **nothing is downloaded, installed, or executed — there is no auto-update**. Before the first
  such request in a process, a one-time notice naming the endpoint, the boundary, and the
  opt-out is printed to **stderr**. It is skipped automatically in CI and source checkouts, and
  disabled by `SPE_MCP_UPDATE_CHECK=false` (preferred), `--no-update-check`,
  `SPE_NO_UPDATE_CHECK=1` (legacy alias), `NO_UPDATE_NOTIFIER=1`, or
  `SPE_MCP_COLLECT_TELEMETRY=false` (the telemetry opt-out suppresses the registry request
  **entirely** — it does not merely drop the `User-Agent`) — in
  which case no request is made, no notice is printed, and no cache is written. See
  [PRIVACY.md](../PRIVACY.md).
  - **Known limitation:** Node's built-in `fetch` ignores `HTTP_PROXY` / `HTTPS_PROXY` /
    `NO_PROXY`, so this request cannot be routed through an egress proxy for inspection. It
    fails closed (the check is silently skipped) rather than falling back to another route.
    Fixing this would require a new runtime dependency, which the project avoids; recorded as
    an **open, unresolved tradeoff**. Disable the check where all egress must be proxied.

## Local artifacts

These never leave your machine:

- The MSAL **token cache** and the **provisioning-state** file, written owner-only (control
  **SEC-003**).
- The **update-check cache** (`update-check.json` in the data directory), written owner-only
  (control **SEC-008**). It holds only the last-checked timestamp, the registry base URL, the
  version that was current at check time, the published version strings, and which versions you
  have already been notified about — **no identifiers of any kind**. It is **retained until you
  delete it**; `spe-mcp logout` and `spe-mcp auth --reset` remove it, and `status_get` prints
  its full path.
- **stderr** diagnostic logs, with tokens and secrets redacted (`src/logging.ts`).

## Compliance boundary and EU Data Boundary (EUDB)

- Microsoft Graph, Azure Resource Manager, and SharePoint Embedded are Microsoft Online
  Services operating **within the Microsoft 365 / Azure compliance boundary**. Requests you
  make through this tool stay within that boundary and your tenant's configured data location.
- ⚠️ **One endpoint is outside that boundary:** the npm registry (`registry.npmjs.org`),
  operated by npm, Inc. (GitHub). It is **not a Microsoft 365 or Azure Online Service**, is
  **not** covered by the Microsoft Product Terms or the Microsoft Products and Services Data
  Protection Addendum (DPA), and is **not** subject to any **EU Data Boundary**
  commitment applying to your tenant. Only the package name is requested; the connection
  discloses your IP address, the static `User-Agent`, standard TLS/HTTP connection metadata
  (TLS handshake and SNI, `Host`/`Accept` headers, request timing), and the request time.
  Disable the update check to remove this endpoint entirely.
- The tool performs **no independent cross-region processing** and stores **no customer
  content** of its own. Data location, residency, and **EU Data Boundary** commitments are
  determined by those underlying services and your tenant configuration — not by this tool.

## Telemetry

The server opens **no usage-analytics channel** and does **not** collect telemetry — it only
adds a product `User-Agent` for aggregate product-usage attribution. That signal is a static
product `User-Agent` (`spe-mcp-server/<version>`) with no personal, tenant, or usage data,
stamped on outbound Graph/ARM requests. It is **on by default**; set
`SPE_MCP_COLLECT_TELEMETRY=false` to omit it. Opting out neither silences the request nor adds a
new signal — outbound calls simply fall back to the underlying tool's default `User-Agent`
(the Azure CLI's own token for `az`/`azd`; the Node runtime default for direct Graph calls),
whose logging is governed by those services' own terms. The npm update check is **not**
telemetry: it is an inbound-information request (does a newer version exist?) that sends **no
customer content and no application-level user, tenant, subscription, or install identifier**,
and can be disabled independently. Like any HTTPS request it still exposes your **source IP
address** and **standard transport metadata** to the registry operator, as documented in the
endpoint table above. See [PRIVACY.md](../PRIVACY.md) for details.
