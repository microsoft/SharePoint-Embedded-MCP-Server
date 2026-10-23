# Privacy

`@microsoft/spe-mcp` ("the tool") is an open-source Model Context Protocol (MCP)
server that you run **locally** to manage **your own** SharePoint Embedded, Microsoft Graph,
and Azure resources. This notice explains what the tool does and does not do with data. It is
provided for transparency and does not replace the
[Microsoft Privacy Statement](https://privacy.microsoft.com/privacystatement) or your
organization's agreements with Microsoft.

## What the tool collects and sends

**The tool opens no dedicated usage-analytics channel and sends no personal, tenant, or
per-user data to Microsoft.** Its Microsoft-bound attribution signals are bounded `User-Agent`
tokens, which are on by default and can be turned off (see
[Turning it off](#turning-it-off)). The only destination that is **not a Microsoft 365 or Azure
Online Service** is an unauthenticated public-package lookup on the configured npm registry,
sent without a user identifier to notify you of newer releases; it can also be turned off.
Specifically:

- **No telemetry channel.** The tool does not implement application telemetry and does not
  "phone home." Diagnostic logs are written to the local process's **stderr only**, with
  tokens and secrets redacted (`src/logging.ts`), and are never transmitted by the tool.
- **Authentication against your tenant.** You sign in with your own Microsoft Entra identity
  via [MSAL](https://learn.microsoft.com/entra/identity-platform/msal-overview). Access and
  refresh tokens are cached **locally** with owner-only file permissions (control
  **SEC-003**). The tool does not send your tokens anywhere other than the standard Microsoft
  authentication and API calls you initiate.
- **API calls you initiate.** When you invoke a tool, the server calls Microsoft first-party
  endpoints — Microsoft Graph and Azure Resource Manager — **on your behalf**, in **your**
  tenant and subscription. The content and directory data involved flow between your machine
  and those Microsoft services; the tool adds no additional recipients.
- **Product and install-source `User-Agent`.** Outbound Graph/ARM requests are stamped
  with `spe-mcp-server/<version>` (`src/user-agent.ts`). Install links can also configure
  bounded source, content, and campaign labels such as `microsoft-learn` and an article
  slug. The MCP handshake's self-reported client name is mapped to a bounded agent-host
  label; the raw name and client version are not transmitted in the request metadata.
  These labels contain **no personal or tenant identifiers**, but they accompany each
  authenticated request and Microsoft services can associate them with that request in
  normal service logs. They exist so the service can measure aggregate traffic driven by
  published install surfaces and agent hosts; they are not a separate data feed. Attribution
  is **on by default**; set `SPE_MCP_COLLECT_TELEMETRY=false` to omit all of these tokens.
- **Update check (public npm registry by default; configurable).** At most once every 24 hours
  for the same running package version and registry, across server processes sharing the same
  retained data-directory cache, the tool reads the
  published version list for `@microsoft/spe-mcp` from
  `https://registry.npmjs.org`, or from the HTTPS registry you set with `SPE_NPM_REGISTRY`, so
  it can tell you when a newer release exists (`src/update-check.ts`).

  > **Boundary disclosure.** `registry.npmjs.org` is operated by **npm, Inc. (GitHub)**. It is
  > **not a Microsoft 365 or Azure Online Service**, so it is **outside the Microsoft 365 /
  > Azure compliance boundary** and outside any **EU Data Boundary** commitment that applies to
  > your tenant. Data sent there is **not covered by the Microsoft Product Terms or by the
  > Microsoft Products and Services Data Protection Addendum (DPA)**; it is governed by the
  > [npm privacy policy](https://docs.npmjs.com/policies/privacy).

  > **Configured-registry disclosure.** If you set `SPE_NPM_REGISTRY`, the request goes to that
  > endpoint instead of `registry.npmjs.org`. Its operator, contractual terms, data handling,
  > and compliance boundary depend on your configuration; this project does not classify a
  > configured endpoint as npm/GitHub or as inside or outside any particular boundary.

  **Each refresh attempt makes exactly one request,** to the exact package path
  with no query string and no fragment:

  ```text
  GET https://registry.npmjs.org/@microsoft%2fspe-mcp
  ```

  **What the registry operator can see.** The request is an **unauthenticated HTTP GET of
  public package metadata, sent without a user identifier** — the same lookup `npm view` performs.
  The request body and headers
  carry no identifiers, but the connection itself necessarily discloses to the registry
  operator (npm for the default endpoint):

  | Disclosed to npm | Why |
  |------------------|-----|
  | Your **IP address** (or your egress/NAT address) | Inherent to making an HTTPS connection |
  | The **package name** `@microsoft/spe-mcp` | It is the resource being requested |
  | The static product **`User-Agent`** `spe-mcp-server/<version>` | Standard client identification |
  | Standard **TLS/HTTP connection metadata** — TLS handshake parameters and the SNI host name, the `Host` and `Accept` request headers, and connection/request timing | Inherent to any HTTPS request; not set or enriched by this tool |
  | Approximate **time of the request** | Inherent to any server-side request log |

  Setting `SPE_MCP_COLLECT_TELEMETRY=false` **suppresses the registry request entirely** — it is
  a skip reason, so no connection is opened and none of the rows above occur. (The shared
  user-agent helper also omits the product `User-Agent` when telemetry is off; for this endpoint
  that is defense in depth only, because no request is made at all.)

  **What is never sent:** no credentials, tokens, cookies, or `Authorization` header; no
  `.npmrc` and no npm subprocess; **no install GUID, machine identifier, hostname, user name,
  tenant ID, subscription ID, correlation ID, or session ID**; no usage, prompt, or content
  data; no data about which tools you invoked. The request and persistent cache contain **no
  identifier of any kind**. A transient local lock records the operating-system process ID only
  to verify that an abandoned lock owner has exited; it is never transmitted or copied into the
  persistent cache. Redirects are rejected outright, so the request cannot be bounced to a
  different host.

  **No auto-update.** Nothing is downloaded, installed, executed, or modified. The tool only
  *notifies* you; the notice is informational, and acting on it is a human decision — updating
  means pointing your MCP client configuration (or reinstalling the copy it actually launches)
  at a newer package spec.

  **Local retention.** The result is cached on your machine at
  `<data dir>/update-check.json`, written with the same owner-only permissions as the token
  cache (0700 directory / 0600 file, control **SEC-003**; the check itself is control
  **SEC-008**). `<data dir>` defaults to `%USERPROFILE%\.spe-mcp` on Windows or `~/.spe-mcp`
  elsewhere, can be overridden with `SPE_DATA_DIR`, and the exact path in use is reported by
  `status_get`. The cache contains only the checked version strings, the
  registry URL, a timestamp, and which versions you have already been told about — **no
  identifier**. It is **retained locally until you delete it**: there is no automatic expiry of
  the file itself, only of its freshness. Run `spe-mcp logout` or `spe-mcp auth --reset` to
  delete it, or remove the file by hand. A transient owner-only
  uniquely named `update-check.json.lock-*` files coordinate processes that share the data
  directory. Each contains only the local process ID, lock-acquisition timestamp, a random
  contender name, and a local ordering number; it is removed after the operation, and an
  abandoned contender can be reclaimed after 30 seconds only after the recorded process is no
  longer alive. Names are never reused, so stale cleanup cannot delete a successor lock. The
  refresh-lock owner writes the 24-hour attempt timestamp to the cache
  before opening the registry connection, so another process cannot start a duplicate request
  if the first process exits after egress. Changing the running package version or registry, or
  deleting the cache, intentionally starts a new 24-hour window. If the process exits while
  atomically publishing a lock, an owner-only `.tmp-*` lock file can remain; the next eligible
  check removes it after 30 seconds once its recorded process has exited. With no later check it
  remains local until you delete the data directory. The same atomic-write pattern can leave an
  owner-only `update-check.json.tmp-*` file after an abrupt exit; it is cleaned by the next
  eligible check after 30 seconds or by logout/reset.

  A process claims a pending update target in this cache before returning its notice, preventing
  duplicate delivery by processes that share the cache. This is at-most-once delivery: a crash
  after the durable claim but before the client receives the response can lose the notice rather
  than repeat it. The cached update remains available through `status_get`.

  Logout/reset also writes an owner-only `update-check.json.deleted` generation containing only
  a timestamp before deleting the cached result. That local tombstone prevents a registry
  request already in flight from recreating the cache after deletion. It is not transmitted,
  does not contain the registry result or any identifier, and remains until the data directory
  is deleted.

  **First-run notice.** Before the **first** network request in a process, the tool prints a
  one-time notice to **stderr** naming the endpoint and how to turn the check off. The default
  endpoint gets the npm/GitHub boundary disclosure; a configured endpoint is described
  neutrally because its operator and boundary depend on your configuration. No notice is
  printed when the check is disabled or served from cache.

  **Turning it off.** The check is **skipped automatically** in CI and when running from a
  source checkout, and can be disabled outright (see [Turning it off](#turning-it-off)); when
  disabled, **no request is made, no notice is printed, and no cache file is written**.

  **Proxy routing.** Routing depends on the Node.js runtime configuration. Releases that support
  Node's environment-proxy mode (including current Node 24/26 releases) can honor `HTTP_PROXY` /
  `HTTPS_PROXY` / `NO_PROXY` when it is enabled with `NODE_USE_ENV_PROXY=1` or
  `--use-env-proxy`; Node 22 may ignore those variables and attempt a direct connection. If
  proxy routing is required, enforce it at the runtime or network layer, or disable the check.
See [docs/DATA-FLOW.md](docs/DATA-FLOW.md) for the full list of network endpoints and what
travels to each.

> **Standard Microsoft data-collection notice.** Microsoft's standard notice states that
> software "may collect information about you and your use of the software and send it to
> Microsoft" (full text in [NOTICE.md](NOTICE.md#data-collection)). It is reproduced for
> completeness; **this build opens no usage-analytics channel** — the only Microsoft-bound
> signals are the bounded `User-Agent` attribution tokens described above, which are on by default
> and can be turned off (see [Turning it off](#turning-it-off) and the
> [Telemetry configuration](NOTICE.md#telemetry-configuration) note). Separately from anything
> sent to Microsoft, the default-on update check contacts the public npm registry by default,
> which is
> **not a Microsoft 365 or Azure Online Service** and is outside the M365/Azure compliance
> boundary, the Product Terms/DPA, and the EU Data Boundary — see
> [Update check (public npm registry)](#what-the-tool-collects-and-sends) above and
> [NOTICE.md — Third-party services contacted](NOTICE.md#third-party-services-contacted). A
> configured registry replaces that endpoint and has configuration-dependent ownership and
> boundary treatment as described above.

## Service-side data handling

Microsoft Graph, Azure, and SharePoint Embedded are Microsoft Online Services. Any data you
create or access through them is handled under the
[Microsoft Product Terms](https://www.microsoft.com/licensing/terms/), the
[Microsoft Products and Services Data Protection Addendum (DPA)](https://www.microsoft.com/licensing/docs/view/Microsoft-Products-and-Services-Data-Protection-Addendum-DPA),
and the [Microsoft Privacy Statement](https://privacy.microsoft.com/privacystatement),
according to your tenant's configuration (including any **EU Data Boundary** commitments).
This tool does not change that handling.

## Third-party MCP clients

You connect the tool to an MCP client (for example VS Code, Claude Desktop, or Cursor). The
prompts you type and the data the client displays are handled under **that client's** privacy
terms, which are outside the control of this project.

## Turning it off

Because the tool has no telemetry channel, there is no separate telemetry stream to opt out
of. To omit install-source labels while retaining the product token, remove the
`--install-source`, `--install-content`, and `--install-campaign` arguments from the MCP
client configuration. To omit both install-source and agent-host labels, add
`--no-install-attribution`. All attribution is **on by default**. To opt out, set
`SPE_MCP_COLLECT_TELEMETRY=false` in your environment; the tool then omits the product,
install-source, content, campaign, and agent-host tokens from all outbound Graph and Azure
Resource Manager requests. Those requests still go out — they simply
carry the underlying tool's default `User-Agent` instead (e.g. the Azure CLI's own token for
`az`/`azd`, or the Node runtime default for direct Graph calls), whose logging is governed by
those services' own terms.

The **update check** uses the public npm registry by default — the only default outbound
destination that is not a Microsoft 365 or Azure Online Service and therefore the only default
call outside the Microsoft 365 / Azure compliance boundary (and the Product Terms / DPA / EUDB
commitments). A configured registry replaces that endpoint and has configuration-dependent
ownership and boundary treatment. The check is on by default in published installs. Any one of
the following disables it completely:

| Opt-out | Effect |
|---------|--------|
| `SPE_MCP_UPDATE_CHECK=false` | **Preferred public control.** Disables the check for every instance in that environment (`0`, `off`, `no` also accepted) |
| `spe-mcp start --no-update-check` | Disables the check for that server instance |
| `SPE_NO_UPDATE_CHECK=1` | **Legacy alias** for `SPE_MCP_UPDATE_CHECK=false`, honoured identically |
| `NO_UPDATE_NOTIFIER=1` | Community-standard opt-out, honoured identically |
| `SPE_MCP_COLLECT_TELEMETRY=false` | Opting out of telemetry suppresses the registry request entirely |

When disabled, the tool makes **no registry request, prints no collection notice, and writes no
update-check cache file** — the code path exits before any network or disk access. `status_get`
still reports the state, reading only what is already on disk.

The check is also skipped automatically in CI (`CI`, `GITHUB_ACTIONS`, `TF_BUILD`, …) and when
the server is run from a source checkout rather than an installed package.

To delete data already cached by the check, run `spe-mcp logout` or `spe-mcp auth --reset` —
both remove `<data dir>/update-check.json` along with the cached authentication tokens. You can
also delete the file by hand; `status_get` prints its full path.

To further limit
outbound calls you can run with `--read-only` (no mutating operations) or `--tools` (restrict
the exposed tool set, including the optional Microsoft Learn documentation lookup). See
[docs/DATA-FLOW.md](docs/DATA-FLOW.md), [docs/SECURITY-CONTROLS.md](docs/SECURITY-CONTROLS.md),
and the consolidated [NOTICE.md](NOTICE.md).
