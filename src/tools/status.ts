// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Tool: status_get
 *
 * Reports the SPE Builder server's current state: the signed-in Azure CLI
 * (bootstrap) identity and provisioning readiness. This is the developer's
 * "where am I?" check and the first consumer of the bootstrap auth plane.
 *
 * Phase 0: reports az identity + readiness. Phase 1+ enriches this with the
 * provisioned owning app, container type, registration, and containers.
 */

import { assertAzCli, getSignedInIdentity } from "../bootstrap.js";
import { readState } from "../state.js";
import type { McpTool } from "../types.js";

export const statusTool: McpTool = {
  name: "status_get",
  annotations: { readOnly: true },
  description:
    "Report SharePoint Embedded Builder status: the signed-in Azure CLI identity " +
    "(tenant and user) used for control-plane provisioning, and whether the environment " +
    "is ready to provision. Use this first to confirm sign-in before creating apps, " +
    "container types, or containers.",
  inputSchema: {
    type: "object" as const,
    properties: {},
  },
  handler: async () => {
    try {
      await assertAzCli();
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      return {
        content: [{ type: "text" as const, text: `## SPE Status\n\n⛔ ${msg}` }],
        isError: true,
      };
    }

    const identity = await getSignedInIdentity();

    if (!identity) {
      return {
        content: [
          {
            type: "text" as const,
            text:
              "## SPE Status\n\n" +
              "| Property | Value |\n|----------|-------|\n" +
              "| **Azure CLI** | ✅ installed |\n" +
              "| **Signed in** | ❌ not signed in |\n\n" +
              "> Run `az login --allow-no-subscriptions` to sign in, then try again.",
          },
        ],
      };
    }

    const state = readState();
    const hasOwningApp = !!state.appId;
    const text =
      "## SPE Status\n\n" +
      "| Property | Value |\n|----------|-------|\n" +
      "| **Azure CLI** | ✅ installed |\n" +
      `| **Signed in as** | ${identity.username} |\n` +
      `| **Tenant** | \`${identity.tenantId}\` |\n` +
      `| **Owning app** | ${state.appId ? `\`${state.appId}\`${state.appDisplayName ? ` (${state.appDisplayName})` : ""}` : "— not provisioned yet"} |\n` +
      `| **Container type** | ${state.containerTypeId ? `\`${state.containerTypeId}\`${state.containerTypeName ? ` (${state.containerTypeName})` : ""}` : "— not provisioned yet"} |\n` +
      `| **Container** | ${state.containerId ? `\`${state.containerId}\`${state.containerName ? ` (${state.containerName})` : ""}` : "— not created yet"} |\n\n` +
      (state.containerTypeId
        ? "> Provisioning in progress — resources above are saved and reused on re-runs."
        : hasOwningApp
          ? "> Owning app ready. Next: create a container type, then containers."
          : "> **Container types and containers require an owning app first.** Run `project_app_create` to " +
            "create (or reuse) one — the server then signs in as that app automatically (a browser opens " +
            "for one-time consent; no restart). Then you can list/create container types and containers.");

    return { content: [{ type: "text" as const, text }] };
  },
};
