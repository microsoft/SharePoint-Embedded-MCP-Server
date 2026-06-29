// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Tool: billing_check
 *
 * Check the billing configuration for a container type.
 */

import { getContainerType, listContainerTypes } from "../graph-client.js";
import { readState } from "../state.js";
import type { McpTool } from "../types.js";

export const checkBillingTool: McpTool = {
  name: "billing_check",
  annotations: { readOnly: true, localRequired: true },
  description:
    "Check the billing configuration for a SharePoint Embedded container type. " +
    "Shows billing classification, trial expiry, and Azure subscription info. " +
    "Defaults to the container type from the current provisioning state when none is given.",
  inputSchema: {
    type: "object" as const,
    properties: {
      containerTypeId: {
        type: "string",
        description:
          "The container type ID to check billing for. Defaults to the provisioned container type in state.",
      },
    },
  },
  handler: async (args) => {
    const containerTypeId = (args.containerTypeId as string) ?? readState().containerTypeId;
    if (!containerTypeId) {
      return {
        content: [
          {
            type: "text",
            text:
              "Error: containerTypeId is required (none provided and none in provisioning state). " +
              "Provision an SPE app first (project_provision) or pass a containerTypeId.",
          },
        ],
        isError: true,
      };
    }

    const ct = await getContainerType(containerTypeId);
    const billing = ct.billingClassification ?? "unknown";

    let output = `## Billing Configuration\n\n`;
    output += `| Property | Value |\n|----------|-------|\n`;
    output += `| **Container Type ID** | \`${containerTypeId}\` |\n`;
    output += `| **Name** | ${ct.displayName ?? "—"} |\n`;
    output += `| **Owning App** | \`${ct.owningAppId}\` |\n`;
    output += `| **Billing** | ${billing} |\n`;

    if (ct.azureSubscriptionId) {
      output += `| **Azure Subscription** | \`${ct.azureSubscriptionId}\` |\n`;
    }

    if (ct.createdDateTime && billing === "trial") {
      const created = new Date(ct.createdDateTime);
      const expiry = new Date(created.getTime() + 30 * 24 * 60 * 60 * 1000);
      const remaining = Math.ceil((expiry.getTime() - Date.now()) / (24 * 60 * 60 * 1000));
      output += `| **Trial Expires** | ${expiry.toISOString().split("T")[0]} (${remaining > 0 ? `${remaining} days remaining` : "EXPIRED"}) |\n`;
    }

    // Count trial CTs
    if (billing === "trial") {
      try {
        const allCts = await listContainerTypes();
        const trialCount = allCts.filter(c => c.billingClassification === "trial").length;
        output += `| **Trial CTs** | ${trialCount} of 3 max |\n`;
      } catch {
        // Skip if listing fails
      }
    }

    return { content: [{ type: "text", text: output }] };
  },
};
