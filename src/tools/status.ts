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
import { DEFAULT_REGISTRY, getUpdateStatus } from "../update-check.js";

/**
 * Render the server-version and update-awareness (SEC-008) rows shared by every
 * `status_get` table. Reads already-resolved in-memory state plus the local
 * cache file only: it never waits on, or triggers, a network call.
 *
 * The extra rows exist for privacy transparency: a user can see exactly what is
 * cached locally, when it was last refreshed, which registry would be
 * contacted, and where to delete the file — without any egress.
 */
function versionRows(): string {
  const status = getUpdateStatus();
  let updateCell: string;
  switch (status.state) {
    case "disabled":
      updateCell = `disabled${status.skipReason ? ` (${status.skipReason})` : ""}`;
      break;
    case "pending":
      updateCell = "in progress";
      break;
    case "up-to-date":
      updateCell = "✅ up to date";
      break;
    case "update-available":
      updateCell = `⬆️ ${status.latestVersion ?? "newer version"} available — informational only; updating requires a person to point the MCP client config (or the installed copy) at \`${status.updateAvailable?.packageSpec ?? ""}\``;
      break;
    default:
      updateCell = "— unavailable (registry not reachable)";
      break;
  }

  let rows = `| **Server version** | \`${status.currentVersion}\` |\n| **Update check** | ${updateCell} |\n`;
  if (status.latestVersion) {
    rows += `| **Latest known version** | \`${status.latestVersion}\` (cached locally) |\n`;
  }
  rows += `| **Last update check** | ${status.lastCheckedAt ?? "never"} |\n`;
  if (status.registry) {
    const registryDescription =
      status.registry === DEFAULT_REGISTRY
        ? "public npm registry; third party, outside the M365/Azure boundary"
        : "configured registry; operator and compliance boundary depend on your configuration";
    rows += `| **Update registry** | \`${status.registry}\` (${registryDescription}) |\n`;
  }
  if (status.cacheFile) {
    rows += `| **Update cache file** | \`${status.cacheFile}\` |\n`;
  }
  rows += "| **Opt out of update check** | `--no-update-check` or `SPE_MCP_UPDATE_CHECK=false` |\n";
  return rows;
}

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
        content: [
          {
            type: "text" as const,
            text:
              `## SPE Status\n\n⛔ ${msg}\n\n` +
              "| Property | Value |\n|----------|-------|\n" +
              versionRows(),
          },
        ],
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
              "| **Signed in** | ❌ not signed in |\n" +
              versionRows() +
              "\n" +
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
      `| **Container** | ${state.containerId ? `\`${state.containerId}\`${state.containerName ? ` (${state.containerName})` : ""}` : "— not created yet"} |\n` +
      versionRows() +
      "\n" +
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
