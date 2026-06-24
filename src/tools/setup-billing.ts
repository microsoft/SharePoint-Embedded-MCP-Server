// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Tool: billing_setup
 *
 * Attach Standard (Azure) billing to a container type that was ALREADY created
 * as standard (Graph `billingClassification=standard` is set at CT-create time):
 *   1. Register the `Microsoft.Syntex` resource provider on the chosen Azure
 *      subscription and WAIT until `Registered`.
 *   2. Create the `Microsoft.Syntex/accounts` (RaaS) ARM billing account via the
 *      Azure CLI (`az rest` PUT, api-version 2023-01-04-preview) and assert
 *      `provisioningState === "Succeeded"`. Matches the VS Code extension's
 *      ARMProvider exactly.
 *
 * Root cause this replaces: the old Graph PATCH of billing fields onto the
 * container type returns `400 One of the provided arguments is not acceptable`
 * — the v1.0 Update fileStorageContainerType API accepts only name/settings/etag.
 *
 * Decision (owner, non-negotiable): Graph + `az` only. No SharePoint-Admin
 * (`_api/SPO.Tenant`) plane, so there is NO way to convert an existing trial CT
 * to standard — standard must be chosen when the CT is created. This tool only
 * ATTACHES the Azure billing link to an already-standard CT.
 *
 * Rollback: operates on a pre-existing CT and therefore NEVER
 * deletes it. `createSyntexAccount` cleans up only a partially-created ARM
 * account. Standard billing is a one-way transition (cannot revert to trial).
 */

import { createSyntexAccount, ensureSyntexProviderRegistered, getSyntexAccounts } from "../azure-cli.js";
import { getContainerType } from "../graph-client.js";
import { readState, writeState } from "../state.js";
import type { McpTool } from "../types.js";

interface SetupBillingArgs {
  containerTypeId?: string;
  azureSubscriptionId?: string;
  resourceGroup?: string;
  region?: string;
  confirm?: boolean;
}

export const setupBillingTool: McpTool = {
  name: "billing_setup",
  description:
    "Attach Standard (Azure) billing to a SharePoint Embedded container type that was created as " +
    "standard: registers the Microsoft.Syntex resource provider on the chosen Azure subscription " +
    "(Azure CLI), then creates the Microsoft.Syntex/accounts (RaaS) ARM billing account linking the " +
    "container type to that subscription, resource group, and region (Azure CLI / ARM). Defaults the " +
    "container type and subscription/resource group from the current provisioning state. NOTE: standard " +
    "billing must be selected when the container type is created — a trial container type cannot be " +
    "converted. WARNING: Standard billing cannot be reverted to trial.",
  inputSchema: {
    type: "object" as const,
    properties: {
      containerTypeId: { type: "string", description: "Container type ID (must already be standard). Defaults from state." },
      azureSubscriptionId: { type: "string", description: "Azure subscription ID for billing. Defaults from state." },
      resourceGroup: { type: "string", description: "Azure resource group name. Defaults from state." },
      region: { type: "string", description: "Azure region (e.g., 'eastus', 'westus2', 'westeurope'). Default: eastus." },
      confirm: {
        type: "boolean",
        description:
          "Must be true to actually create the IRREVERSIBLE standard Azure billing account. " +
          "Without it the tool returns a preview/warning and makes no change.",
      },
    },
  },
  handler: async (args) => {
    const state = readState();
    const {
      containerTypeId = state.containerTypeId,
      azureSubscriptionId = state.azureSubscriptionId,
      resourceGroup = state.resourceGroup,
      region = "eastus",
      confirm = false,
    } = args as SetupBillingArgs;

    if (!containerTypeId || !azureSubscriptionId || !resourceGroup) {
      const missing = [
        !containerTypeId && "containerTypeId",
        !azureSubscriptionId && "azureSubscriptionId",
        !resourceGroup && "resourceGroup",
      ].filter(Boolean) as string[];
      return {
        content: [{
          type: "text" as const,
          text:
            `Error: missing required ${missing.length === 1 ? "argument" : "arguments"}: ${missing.join(", ")} ` +
            "(not provided and not found in provisioning state). Run azure_subscriptions_list / " +
            "azure_resource_groups_list to choose a subscription and resource group, then pass them in.",
        }],
        isError: true,
      };
    }

    try {
      const current = await getContainerType(containerTypeId);

      // Guard: standard billing classification is set at CT-CREATE time via Graph.
      // With no SharePoint-admin plane there is no supported conversion path, so a
      // non-standard CT cannot be billed by this tool — fail clearly, never 400.
      if (current.billingClassification !== "standard") {
        const classification = current.billingClassification ?? "unknown";
        return {
          content: [{
            type: "text" as const,
            text:
              `Cannot attach standard billing: container type \`${containerTypeId}\` is **${classification}**.\n\n` +
              "Standard billing **must be selected when the container type is CREATED** " +
              "(Microsoft Graph `billingClassification=standard`). There is no supported path to convert an " +
              `existing ${classification} container type to standard (that would require a SharePoint-admin write, ` +
              "which is intentionally excluded).\n\n" +
              "Create a standard container type instead — `container_type_create` with " +
              "`billingClassification=standard` (or `project_provision` with `billingClassification=standard`) — " +
              "then re-run **billing_setup** to attach the Azure billing account.",
          }],
          isError: true,
        };
      }

      // Idempotency: an already-Succeeded Microsoft.Syntex account for THIS CT means
      // billing is already attached → no-op success (no confirm required).
      const accounts = await getSyntexAccounts(azureSubscriptionId, resourceGroup);
      const existing = accounts.find(
        (a) => a.properties?.identityId === containerTypeId && a.properties?.provisioningState === "Succeeded",
      );
      if (existing) {
        writeState({ billingClassification: "standard", azureSubscriptionId, resourceGroup, syntexAccountResourceId: existing.id });
        return {
          content: [{
            type: "text" as const,
            text: `Standard billing is already attached for container type \`${containerTypeId}\` (Microsoft.Syntex account \`${existing.id}\`, provisioningState=Succeeded).`,
          }],
        };
      }

      // Confirm gate: creating the billing account links a billable
      // subscription and is part of the IRREVERSIBLE standard setup.
      if (confirm !== true) {
        const preview =
          "### ⚠️ Confirm standard billing setup\n\n" +
          "This creates a **Microsoft.Syntex (RaaS) Azure billing account** for your **standard** container " +
          "type, linking it to a billable Azure subscription. Standard billing is a **ONE-WAY** configuration and " +
          "**CANNOT be reverted to trial**.\n\n" +
          "| Property | Value |\n|----------|-------|\n" +
          `| **Container Type** | \`${containerTypeId}\` |\n` +
          `| **Current billing** | ${current.billingClassification} |\n` +
          `| **Subscription** | \`${azureSubscriptionId}\` |\n` +
          `| **Resource group** | ${resourceGroup} |\n` +
          `| **Region** | ${region} |\n\n` +
          "> Re-run **billing_setup** with `confirm=true` to proceed. No change has been made.";
        return { content: [{ type: "text" as const, text: preview }] };
      }

      // 1. Azure-side prerequisite: register the Syntex RP and WAIT.
      const provider = await ensureSyntexProviderRegistered(azureSubscriptionId);

      // 2. Create the RaaS ARM billing account and assert Succeeded. On failure it
      // cleans up its own partial account and throws; the caller's CT is untouched.
      const syntexAccountResourceId = await createSyntexAccount(
        azureSubscriptionId, resourceGroup, region, containerTypeId,
      );

      writeState({ billingClassification: "standard", azureSubscriptionId, resourceGroup, syntexAccountResourceId });

      const output =
        "## Standard Billing Configured\n\n" +
        "| Property | Value |\n|----------|-------|\n" +
        `| **Container Type** | \`${containerTypeId}\` |\n` +
        `| **Billing** | standard |\n` +
        `| **Subscription** | \`${azureSubscriptionId}\` |\n` +
        `| **Resource group** | ${resourceGroup} |\n` +
        `| **Region** | ${region} |\n` +
        `| **Microsoft.Syntex RP** | ${provider.registrationState} |\n` +
        `| **Microsoft.Syntex account** | \`${syntexAccountResourceId}\` |\n\n` +
        "> ⚠️ Standard billing is **irreversible** — this container type can no longer be reverted to trial.\n" +
        "> Billing policy may take a few minutes to propagate before billable operations succeed.";

      return { content: [{ type: "text" as const, text: output }] };
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      return { content: [{ type: "text" as const, text: `Error configuring billing: ${msg}` }], isError: true };
    }
  },
};

