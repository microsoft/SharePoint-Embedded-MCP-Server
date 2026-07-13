# Notices and disclaimers

This file consolidates the notices and disclaimers for the SharePoint Embedded MCP server
(`@microsoft/spe-mcp`) — a Model Context Protocol (MCP) server released as open source by
Microsoft. It is the canonical copy of the MCP-specific disclaimers; the same points are
summarized in the [README](README.md#important-notices) and [PRIVACY.md](PRIVACY.md).

## Data collection

The software may collect information about you and your use of the software and send it to
Microsoft. Microsoft may use this information to provide services and improve our products
and services. You may turn off the telemetry as described in the repository. There are also
some features in the software that may enable you and Microsoft to collect data from users
of your applications. If you use these features, you must comply with applicable law,
including providing appropriate notices to users of your applications together with a copy
of Microsoft's privacy statement. You can learn more about data collection and use in the
help documentation and our privacy statement. Your use of the software operates as your
consent to these practices.

> **What this build sends.** `@microsoft/spe-mcp` opens **no separate telemetry channel** and
> sends **no usage analytics or personal, tenant, or per-user data** to Microsoft. The only
> Microsoft-bound signal is a static product `User-Agent` token
> (`spe-mcp-server/<version>`) attached to the Microsoft Graph and Azure Resource Manager
> requests you already make on your own behalf; it carries no personal, tenant, or usage
> data and is used only for aggregate traffic attribution. It is **on by default** and can be
> suppressed with `SPE_COLLECT_TELEMETRY=false` (see below). See [PRIVACY.md](PRIVACY.md) and
> [docs/DATA-FLOW.md](docs/DATA-FLOW.md) for the full data-flow description.

## Telemetry configuration

Telemetry collection is controlled by the `SPE_COLLECT_TELEMETRY` environment variable and is
**on by default**. The only telemetry this build emits is the static product `User-Agent`
token (`spe-mcp-server/<version>`) stamped on outbound Graph/ARM requests for aggregate traffic
attribution — there is no usage-analytics channel and no personal, tenant, or per-user data. To
opt out, set `SPE_COLLECT_TELEMETRY=false` in your environment; the product token is then
omitted from all outbound requests.

## Compliance responsibility

This MCP server may interact with clients and services outside Microsoft compliance
boundaries. You are responsible for ensuring that any integration complies with applicable
organizational, regulatory, and contractual requirements.

## Third-party components

This MCP server may use or depend on third-party components, such as third-party MCP
clients, hosts, agents, AI applications, and/or models. You are responsible for reviewing
and complying with the licenses of any third-party components and vetting the security of
any third-party components. The open-source libraries this server depends on directly are
disclosed in [THIRD-PARTY-NOTICES](THIRD-PARTY-NOTICES).

## Underlying resources

This MCP server may provide access to underlying resources, such as tools, services, and/or
data. Your use of that underlying resource via this MCP server is governed by the underlying
resource's license terms. In particular, SharePoint Embedded, Microsoft Graph, and other
Microsoft Online Services reached through this server are licensed separately and governed by
the [Microsoft Product Terms](https://www.microsoft.com/licensing/terms/) and the
[Microsoft Products and Services Data Protection Addendum (DPA)](https://www.microsoft.com/licensing/docs/view/Microsoft-Products-and-Services-Data-Protection-Addendum-DPA).
This open-source tool grants no rights to any Microsoft Online Service and does not modify
those terms.

## Export control

Use of this software must comply with all applicable export laws and regulations, including
U.S. Export Administration Regulations and local jurisdiction requirements.

## No warranty / limitation of liability

This software is provided "as is" without warranties or conditions of any kind, either
express or implied. Microsoft shall not be liable for any damages arising from use, misuse,
or misconfiguration of this software. See the [MIT License](LICENSE) for the warranty
disclaimer and limitation of liability that govern this project.
