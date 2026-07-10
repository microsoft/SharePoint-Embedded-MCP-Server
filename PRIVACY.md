# Privacy

`@microsoft/spe-mcp` ("the tool") is an open-source Model Context Protocol (MCP)
server that you run **locally** to manage **your own** SharePoint Embedded, Microsoft Graph,
and Azure resources. This notice explains what the tool does and does not do with data. It is
provided for transparency and does not replace the
[Microsoft Privacy Statement](https://privacy.microsoft.com/privacystatement) or your
organization's agreements with Microsoft.

## What the tool collects and sends

**The tool does not collect telemetry or usage analytics, and it opens no dedicated channel
to send data to Microsoft.** Specifically:

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
- **Product `User-Agent`.** Outbound Graph/ARM requests are stamped with a static
  `User-Agent` of the form `spe-mcp-server/<version>` (`src/user-agent.ts`). It contains
  **no personal, tenant, or usage information** and exists only so the service can measure
  aggregate traffic driven by this tool. It is a request header on calls you already make —
  not a separate data feed.

See [docs/DATA-FLOW.md](docs/DATA-FLOW.md) for the full list of network endpoints and what
travels to each.

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

Because the tool has no telemetry channel, there is nothing to opt out of. To further limit
outbound calls you can run with `--read-only` (no mutating operations) or `--tools` (restrict
the exposed tool set, including the optional Microsoft Learn documentation lookup). See
[docs/DATA-FLOW.md](docs/DATA-FLOW.md) and [docs/SECURITY-CONTROLS.md](docs/SECURITY-CONTROLS.md).
