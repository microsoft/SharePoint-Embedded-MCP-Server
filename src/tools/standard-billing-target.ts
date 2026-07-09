// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Guided standard-billing target resolution (PR #3 review).
 *
 * When a caller selects STANDARD billing but has not supplied an Azure
 * subscription and/or resource group, this runs the Azure CLI listings INLINE
 * and prompts the user to pick — via native MCP elicitation when the client
 * supports it, or the agent-guided fallback otherwise — so the user never has to
 * break out of the provisioning flow to call `azure_subscriptions_list` /
 * `azure_resource_groups_list` and re-invoke by hand. The reviewer's ask: "if
 * they pick standard, figure out their subs, and once they've picked a sub,
 * figure out their RGs within that sub" and "run these tools during this step so
 * the user doesn't break out of it during creation."
 *
 * Behavior:
 *   - Subscriptions: zero → a clear, non-crashing error (sign in with `az login`);
 *     exactly one → auto-selected (no needless prompt), recorded as a note; many →
 *     an `elicitChoice` pick.
 *   - Resource groups (only after a subscription is known): zero → prompt for a
 *     NEW name via `elicitText` (the server cannot create the group itself), or a
 *     clear "create one with `az group create`" message on the fallback path;
 *     exactly one → auto-selected; many → an `elicitChoice` pick.
 *
 * The resolved subscription + resource group are returned to the caller, which
 * threads them through the EXISTING downstream gates (region check, the
 * `confirmBilling` financial-safety gate, and standard-billing rollback) entirely
 * unchanged — this only fills the target BEFORE those gates run. On the fallback
 * path each unresolved step returns the agent-guided `needChoice`/no-op result
 * (via the elicitation helpers) that the orchestrator re-invokes with the chosen
 * arg; the resolved arg is threaded on re-invoke, so there is no loop.
 */

import { listResourceGroups, listSubscriptions } from "../azure-cli.js";
import { elicitChoice, elicitText } from "../elicitation.js";
import type { McpToolResult } from "../types.js";

/**
 * Outcome of guided resolution. `resolved` carries the chosen subscription +
 * resource group and any human-readable `notes` (e.g. an auto-selected
 * singleton) for the caller to surface. `!resolved` carries an `McpToolResult`
 * to return verbatim — a native elicitation prompt, the agent-guided fallback
 * ask, or a clear error — so the caller does not have to know which.
 */
export type BillingTargetResolution =
  | { resolved: true; azureSubscriptionId: string; resourceGroup: string; notes: string[] }
  | { resolved: false; result: McpToolResult };

function textResult(text: string, isError = false): McpToolResult {
  return { content: [{ type: "text", text }], isError };
}

/**
 * Resolve the Azure subscription + resource group for STANDARD billing, guiding
 * the user through any missing piece. Call ONLY when billing is standard.
 * Already-supplied values are passed through untouched (so an explicit
 * subscription still gets its resource groups listed).
 */
export async function resolveStandardBillingTarget(input: {
  azureSubscriptionId?: string;
  resourceGroup?: string;
}): Promise<BillingTargetResolution> {
  const notes: string[] = [];
  // Treat empty/whitespace as missing so a blank arg triggers guidance rather
  // than flowing an invalid value into ARM.
  let azureSubscriptionId = input.azureSubscriptionId?.trim() || undefined;
  let resourceGroup = input.resourceGroup?.trim() || undefined;

  // ── Subscription ──────────────────────────────────────────────────────────
  if (!azureSubscriptionId) {
    let subs;
    try {
      subs = await listSubscriptions();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { resolved: false, result: textResult(`Could not list Azure subscriptions: ${msg}`, true) };
    }

    if (subs.length === 0) {
      return {
        resolved: false,
        result: textResult(
          "No enabled Azure subscriptions were found for the signed-in user, so standard billing " +
            "cannot be set up. Sign in with `az login` (or `az login --allow-no-subscriptions` if your " +
            "account has none), then re-run.",
          true,
        ),
      };
    }

    if (subs.length === 1) {
      // Trivial single choice — auto-select instead of prompting.
      azureSubscriptionId = subs[0].id;
      notes.push(`Using the only Azure subscription "${subs[0].name}" (\`${subs[0].id}\`).`);
    } else {
      const choice = await elicitChoice(
        "Which Azure subscription should bill standard storage?",
        subs.map((s) => ({ label: s.name, value: s.id, description: s.id })),
        "azureSubscriptionId",
      );
      if (!choice.resolved) return { resolved: false, result: choice.result };
      azureSubscriptionId = choice.value;
    }
  }

  // ── Resource group (only once a subscription is known) ────────────────────
  if (!resourceGroup) {
    let rgs;
    try {
      rgs = await listResourceGroups(azureSubscriptionId);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return {
        resolved: false,
        result: textResult(
          `Could not list resource groups for subscription \`${azureSubscriptionId}\`: ${msg}`,
          true,
        ),
      };
    }

    if (rgs.length === 0) {
      // Nothing to select. The server cannot create a resource group itself
      // (billing account PUT requires it to already exist), so ask for a name —
      // natively when possible — and otherwise return actionable guidance.
      const named = await elicitText(
        `No resource groups exist in subscription \`${azureSubscriptionId}\`. Enter a name for the resource ` +
          "group to use for standard billing — create it first with `az group create` if it does not already exist.",
        "resourceGroup",
        { title: "Resource group name" },
      );
      if (named.resolved) {
        resourceGroup = named.value;
        notes.push(
          `Using resource group "${resourceGroup}" — ensure it exists in the subscription ` +
            "(create it with `az group create` if needed).",
        );
      } else {
        return {
          resolved: false,
          result: textResult(
            `No resource groups exist in subscription \`${azureSubscriptionId}\`. Create one first, e.g. ` +
              "`az group create --name <name> --location <region>`, then re-run with `resourceGroup` set to its name.",
          ),
        };
      }
    } else if (rgs.length === 1) {
      resourceGroup = rgs[0].name;
      notes.push(`Using the only resource group "${rgs[0].name}" (${rgs[0].location}).`);
    } else {
      const choice = await elicitChoice(
        "Which resource group should hold the standard billing account?",
        rgs.map((g) => ({ label: g.name, value: g.name, description: g.location })),
        "resourceGroup",
      );
      if (!choice.resolved) return { resolved: false, result: choice.result };
      resourceGroup = choice.value;
    }
  }

  return { resolved: true, azureSubscriptionId, resourceGroup, notes };
}
