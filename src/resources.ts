// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * MCP Resources — reference architectures and copy/paste operational guides.
 * Each reference architecture is exposed as a JSON manifest. Static guides are
 * inline text resources so clients can retrieve them without network access.
 */

import { REFERENCE_ARCHITECTURES, findArchitecture } from "./reference-architectures.js";

const ARCH_URI_PREFIX = "spe://reference-architectures/";

interface StaticResource {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
  text: string;
}

const STATIC_RESOURCES: StaticResource[] = [
  {
    uri: "spe://client-config/vscode",
    name: "VS Code MCP configuration",
    description: "Copy/paste .vscode/mcp.json block for @microsoft/spe-mcp.",
    mimeType: "application/json",
    text: `{
  "servers": {
    "spe": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "-p", "@microsoft/spe-mcp", "spe-mcp", "start"]
    }
  }
}
`,
  },
  {
    uri: "spe://client-config/claude-desktop",
    name: "Claude Desktop MCP configuration",
    description: "Copy/paste claude_desktop_config.json block for @microsoft/spe-mcp.",
    mimeType: "application/json",
    text: `{
  "mcpServers": {
    "spe": {
      "command": "npx",
      "args": ["-y", "-p", "@microsoft/spe-mcp", "spe-mcp", "start"]
    }
  }
}
`,
  },
  {
    uri: "spe://client-config/cursor",
    name: "Cursor MCP configuration",
    description: "Copy/paste Cursor MCP server block for @microsoft/spe-mcp.",
    mimeType: "application/json",
    text: `{
  "mcpServers": {
    "spe": {
      "command": "npx",
      "args": ["-y", "-p", "@microsoft/spe-mcp", "spe-mcp", "start"]
    }
  }
}
`,
  },
  {
    uri: "spe://guides/auth-consent-model",
    name: "SPE auth and consent model",
    description: "Explains control-plane provisioning, content-plane opt-in access, and step-up consent.",
    mimeType: "text/markdown",
    text: `# SPE MCP auth and consent model

## Bootstrap mode

By default the server uses the developer's Azure CLI session for bootstrap/control-plane work. Sign in once before starting an MCP client:

\`\`\`bash
az login --allow-no-subscriptions
\`\`\`

## Control plane

Control-plane tools create and manage SPE infrastructure: owning Entra app, container type, registration, containers, permissions, and billing. Examples include \`status_get\`, \`project_provision\`, \`container_type_create\`, \`container_type_register\`, \`container_create\`, \`billing_setup\`, and \`project_cleanup\`.

## Content plane

Content-plane tools read or manage files inside containers. They are off by default and fail closed until the user opts in with \`content_access_grant\` and \`confirm=true\`. Examples include \`project_seed_sample_data\`, \`content_file_upload\`, \`content_folder_create\`, \`content_search\`, \`content_file_preview\`, and \`content_sharing_manage\`. Access can be revoked with \`content_access_revoke\`.

## Step-up consent and Conditional Access

Standard billing performs Azure Resource Manager writes. If Conditional Access requires MFA or an auth-context step-up, retry after an interactive ARM-scoped sign-in:

\`\`\`bash
az login --scope https://management.core.windows.net//.default --tenant <tenant-id>
\`\`\`

Graph/SPE scope errors usually mean the owning public-client app needs the delegated SPE permissions and tenant/user consent.
`,
  },
  {
    uri: "spe://runbooks/billing-trial-vs-standard",
    name: "Billing runbook: trial vs standard",
    description: "Operational guidance for trial billing, standard billing, and billing troubleshooting.",
    mimeType: "text/markdown",
    text: `# SPE billing runbook

## Trial billing

- Choose \`billingClassification=trial\` for a no-cost developer evaluation.
- Trial container types expire after 30 days.
- Trial cleanup is safe by default: \`project_cleanup\` previews first, then deletes trial resources only when re-run with \`confirm=true\`.

## Standard billing

- Standard billing must be selected when the container type is created: \`billingClassification=standard\`.
- A trial container type cannot be converted to standard by this server.
- Use \`azure_subscriptions_list\` and \`azure_resource_groups_list\` to choose the billing location.
- Run \`billing_setup\` first without \`confirm\` to preview. Re-run with \`confirm=true\` only after explicit approval.
- \`billing_setup\` registers the \`Microsoft.Syntex\` resource provider and creates a \`Microsoft.Syntex/accounts\` billing account that links the container type to the selected subscription/resource group/region.
- Verify with \`billing_check\`.

## Common failures

- Azure CLI not signed in: run \`az login --allow-no-subscriptions\`.
- ARM Conditional Access claims challenge: run \`az login --scope https://management.core.windows.net//.default --tenant <tenant-id>\`.
- \`Microsoft.Syntex\` RP not registered or still registering: retry after registration completes.
- Container type is trial: create a new standard container type; do not call \`billing_setup\` on the trial type.
`,
  },
];

export const SPE_RESOURCES = [
  ...REFERENCE_ARCHITECTURES.map((a) => ({
    uri: `${ARCH_URI_PREFIX}${a.id}`,
    name: a.name,
    description: a.description,
    mimeType: "application/json",
  })),
  ...STATIC_RESOURCES.map(({ uri, name, description, mimeType }) => ({ uri, name, description, mimeType })),
];

export function readResource(uri: string) {
  const staticResource = STATIC_RESOURCES.find((r) => r.uri === uri);
  if (staticResource) {
    return {
      contents: [
        {
          uri,
          mimeType: staticResource.mimeType,
          text: staticResource.text,
        },
      ],
    };
  }

  if (!uri.startsWith(ARCH_URI_PREFIX)) {
    throw new Error(`Unknown resource URI: ${uri}`);
  }
  const id = uri.slice(ARCH_URI_PREFIX.length);
  const arch = findArchitecture(id);
  if (!arch) {
    throw new Error(`Unknown reference architecture: ${id}`);
  }
  const manifest = {
    id: arch.id,
    name: arch.name,
    description: arch.description,
    language: arch.language,
    files: Object.keys(arch.files(arch.id)),
  };
  return {
    contents: [
      {
        uri,
        mimeType: "application/json",
        text: JSON.stringify(manifest, null, 2),
      },
    ],
  };
}
