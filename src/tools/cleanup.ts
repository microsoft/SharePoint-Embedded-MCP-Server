// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Tool: project_cleanup
 *
 * Tears down what the SPE Builder provisioned and clears local provisioning
 * state. Deletion policy (deliberately conservative): only a TRIAL container
 * type and its owning Entra app are ever auto-deleted. Standard and
 * direct-to-customer (DTC) container types are billed, tenant-level production
 * resources whose owning app is shared with live containers, so they are
 * PRESERVED unless the caller passes an explicit `deleteStandard=true` override
 * (strongly discouraged, but not blocked). Requires confirm=true so an agent
 * cannot delete resources unprompted. Ports the full-setup skill `06-cleanup.ps1`.
 */

import { bootstrapTokenProvider } from "../bootstrap.js";
import { setAuthConfig } from "../auth.js";
import { deleteApplication, deleteContainerType } from "../graph-client.js";
import { clearState, readState } from "../state.js";
import type { McpTool } from "../types.js";

/**
 * The only billing classification that is safe to tear down automatically. SPE
 * classifications are "trial" | "standard" | "directToCustomer"; everything that
 * is not exactly "trial" (including unknown/missing state) is treated as a
 * PROTECTED, billed resource so we never delete it without an explicit override.
 */
function isTrialContainerType(billingClassification?: string): boolean {
  return billingClassification === "trial";
}

export const cleanupTool: McpTool = {
  name: "project_cleanup",
  description:
    "Delete the SharePoint Embedded resources provisioned by the SPE Builder and clear local state. " +
    "By default only a TRIAL container type and its owning Entra app are removed; standard / " +
    "direct-to-customer container types are preserved (they are billed, production resources) unless you " +
    "explicitly pass deleteStandard=true. Destructive — requires confirm=true.",
  inputSchema: {
    type: "object" as const,
    properties: {
      confirm: { type: "boolean", description: "Must be true to actually delete. Without it, shows what would be deleted." },
      deleteStandard: {
        type: "boolean",
        description:
          "Override required to delete a STANDARD or direct-to-customer (DTC) container type and its " +
          "owning app. Strongly discouraged — these are billed, tenant-level production resources shared " +
          "with live containers. Not needed for trial container types. Default false.",
      },
    },
  },
  handler: async (args) => {
    const state = readState();
    const confirm = args.confirm === true;
    const deleteStandard = args.deleteStandard === true;

    if (!state.appId && !state.containerTypeId) {
      return { content: [{ type: "text" as const, text: "Nothing to clean up — no provisioned resources in state." }] };
    }

    // Classify the teardown. We only auto-delete a container type we are SURE is
    // trial; standard, direct-to-customer, or unknown classifications are
    // PROTECTED and require an explicit deleteStandard=true override.
    const classLabel = state.billingClassification ?? "unknown";
    const ctProtected = !!state.containerTypeId && !isTrialContainerType(state.billingClassification);

    if (!confirm) {
      const lines: string[] = ["### Confirm cleanup\n\n"];
      if (ctProtected) {
        lines.push(
          `> ⚠️ **Protected:** container type \`${state.containerTypeId}\` is **${classLabel}** (not trial). ` +
            `Standard / direct-to-customer container types are billed, tenant-level production resources and the ` +
            `owning app is shared with any live containers, so cleanup will **preserve** them.\n\n`,
        );
      }
      lines.push("This will delete:\n\n");
      if (state.containerTypeId) {
        lines.push(
          ctProtected
            ? `- ~~Container type \`${state.containerTypeId}\` (${classLabel})~~ — **preserved**\n`
            : `- Container type \`${state.containerTypeId}\` (trial)\n`,
        );
      }
      if (state.appId) {
        lines.push(
          ctProtected
            ? `- ~~Owning app \`${state.appId}\`${state.appDisplayName ? ` (${state.appDisplayName})` : ""}~~ — **preserved**\n`
            : `- Owning app \`${state.appId}\`${state.appDisplayName ? ` (${state.appDisplayName})` : ""}\n`,
        );
      }
      lines.push("- Local provisioning state\n\n");
      lines.push(
        ctProtected
          ? "> Re-run with `confirm=true` to clear local state. To ALSO delete the standard/DTC container type " +
              "and its owning app (strongly discouraged), pass `confirm=true` **and** `deleteStandard=true`."
          : "> Re-run `project_cleanup` with `confirm=true` to proceed.",
      );
      return { content: [{ type: "text" as const, text: lines.join("") }] };
    }

    // confirm === true. A protected (standard/DTC) container type is left fully
    // intact — including local state — unless the explicit override is present.
    if (ctProtected && !deleteStandard) {
      return {
        content: [{
          type: "text" as const,
          text:
            "## Cleanup skipped — protected container type\n\n" +
            `\`${state.containerTypeId}\` is a **${classLabel}** container type. Standard and ` +
            "direct-to-customer container types are billed, tenant-level production resources, and the owning app " +
            `\`${state.appId}\` is shared with any live containers and their data. To avoid breaking production, ` +
            "cleanup will **not** delete them.\n\n" +
            "Nothing was deleted. If you are certain, re-run with `confirm=true` **and** `deleteStandard=true` " +
            "to override (strongly discouraged).",
        }],
      };
    }

    const results: string[] = [];
    if (ctProtected && deleteStandard) {
      results.push(`⚠️ Override: deleting a **${classLabel}** container type and its owning app as explicitly requested.`);
    }

    // Container-type deletion uses the owning-app token. In bootstrap mode,
    // restore auth config from persisted state so getAccessToken() is usable.
    if (state.appId && state.tenantId) {
      setAuthConfig({ clientId: state.appId, tenantId: state.tenantId });
    }

    if (state.containerTypeId) {
      try {
        await deleteContainerType(state.containerTypeId);
        results.push(`✅ Deleted container type \`${state.containerTypeId}\``);
      } catch (error) {
        results.push(`⚠️ Container type delete failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    if (state.appObjectId) {
      try {
        await deleteApplication(state.appObjectId, bootstrapTokenProvider);
        results.push(`✅ Deleted owning app \`${state.appId}\``);
      } catch (error) {
        results.push(`⚠️ App delete failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    clearState();
    results.push("✅ Cleared local provisioning state");

    return { content: [{ type: "text" as const, text: `## Cleanup Complete\n\n${results.join("\n")}` }] };
  },
};
