// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Tools: azure_subscriptions_list, azure_resource_groups_list
 *
 * Surface the developer's Azure subscriptions and resource groups so an agent
 * (or the user via elicitation) can pick where SPE standard billing lands.
 * Ports EVAL.md `list-azure-subscriptions` / `list-resource-groups`.
 */

import { isSignedIn, listResourceGroups, listSubscriptions } from "../azure-cli.js";
import type { McpTool } from "../types.js";

export const listSubscriptionsTool: McpTool = {
  name: "azure_subscriptions_list",
  annotations: { readOnly: true, localRequired: true },
  description:
    "List the Azure subscriptions the signed-in user can access (via Azure CLI). " +
    "Use this to choose a subscription for SharePoint Embedded standard billing.",
  inputSchema: { type: "object" as const, properties: {} },
  handler: async () => {
    try {
      const subs = await listSubscriptions();
      if (subs.length === 0) {
        // `az account list` returns [] with exit 0 both when the user is not
        // signed in AND when they are signed in with zero subscriptions. Probe
        // the sign-in state so we give the right guidance.
        if (!(await isSignedIn())) {
          return {
            content: [
              {
                type: "text" as const,
                text:
                  "You're not signed in to the Azure CLI, so no subscriptions could be listed.\n\n" +
                  "Run `az login` (or `az login --allow-no-subscriptions` if your account has no " +
                  "subscriptions) and try again.",
              },
            ],
            isError: true,
          };
        }
        return {
          content: [{ type: "text" as const, text: "No enabled Azure subscriptions found for the signed-in user." }],
        };
      }
      let output = `## Azure Subscriptions (${subs.length})\n\n| Name | Subscription ID | Default |\n|------|-----------------|---------|\n`;
      for (const s of subs) {
        output += `| ${s.name} | \`${s.id}\` | ${s.isDefault ? "✅" : ""} |\n`;
      }
      return { content: [{ type: "text" as const, text: output }] };
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      return { content: [{ type: "text" as const, text: `Error listing subscriptions: ${msg}` }], isError: true };
    }
  },
};

export const listResourceGroupsTool: McpTool = {
  name: "azure_resource_groups_list",
  annotations: { readOnly: true, localRequired: true },
  description:
    "List the resource groups in an Azure subscription (via Azure CLI). " +
    "Use this to choose a resource group for SharePoint Embedded standard billing.",
  inputSchema: {
    type: "object" as const,
    properties: {
      subscriptionId: {
        type: "string",
        description: "The Azure subscription ID to list resource groups for.",
      },
    },
    required: ["subscriptionId"],
  },
  handler: async (args) => {
    const subscriptionId = (args.subscriptionId as string | undefined)?.trim();
    if (!subscriptionId) {
      return { content: [{ type: "text" as const, text: "Error: subscriptionId is required" }], isError: true };
    }
    try {
      const groups = await listResourceGroups(subscriptionId);
      if (groups.length === 0) {
        return {
          content: [{ type: "text" as const, text: `No resource groups found in subscription \`${subscriptionId}\`. You can create one with \`az group create\`.` }],
        };
      }
      let output = `## Resource Groups (${groups.length})\n\n| Name | Location |\n|------|----------|\n`;
      for (const g of groups) {
        output += `| ${g.name} | ${g.location} |\n`;
      }
      return { content: [{ type: "text" as const, text: output }] };
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      return { content: [{ type: "text" as const, text: `Error listing resource groups: ${msg}` }], isError: true };
    }
  },
};
