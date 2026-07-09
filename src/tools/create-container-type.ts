// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Tool: container_type_create
 *
 * Creates a new SharePoint Embedded container type via Microsoft Graph.
 *
 * Key gotchas (from live testing — see Skills/full-setup/gotchas.md):
 *   - Use `displayName` field (Graph API), not `name`
 *   - Response field is `containerTypeId`, not `id`
 *   - One container type per owning app (1:1 relationship)
 *   - Trial billing: max 3 per tenant, expires after 30 days
 *   - After creation, must register the CT before creating containers
 */

import { ensureSyntexProviderRegistered } from "../azure-cli.js";
// These are Microsoft Graph API wrappers from graph-client (not other tools'
// handlers). All four are used by this one tool: listContainerTypes enforces the
// 1:1 owning-app→CT check, createContainerType creates it, deleteContainerType
// rolls back on a failed standard-billing setup, and registerContainerType
// performs the default auto-registration.
import {
  createContainerType,
  deleteContainerType,
  listContainerTypes,
  registerContainerType,
} from "../graph-client.js";
import { readState, writeState } from "../state.js";
import { defineTool, z } from "../tooling/define-tool.js";
import { fail, ok } from "../responses.js";
import { clientSafeMessage } from "../errors.js";

// Local-only argument shape for this tool's handler. Per repo convention,
// shared Graph/MCP domain types live centrally in `src/types.ts`, while per-tool
// argument interfaces are kept local to their tool file (see deploy-azure,
// provision, register-container-type, etc.). This one is not reused elsewhere,
// so it stays local rather than being centralized.
interface CreateContainerTypeArgs {
  displayName: string;
  owningAppId?: string;
  billingClassification?: "trial" | "standard" | "directToCustomer";
  azureSubscriptionId?: string;
  resourceGroup?: string;
  region?: string;
  autoRegister?: boolean;
}

/** Allowed billing models — must mirror the tool inputSchema enum. */
const BILLING_CLASSIFICATIONS = ["trial", "standard", "directToCustomer"] as const;

async function executeCreateContainerType(args: CreateContainerTypeArgs) {
  const {
    displayName,
    owningAppId = readState().appId,
    billingClassification = "trial",
    azureSubscriptionId,
    resourceGroup,
    region,
    autoRegister = true,
  } = args;

  // Validate inputs BEFORE any Graph call so wrong-typed / out-of-enum values
  // never reach the Graph API. MCP clients can send arbitrary JSON,
  // so the declared inputSchema is not enforced at the transport boundary.
  if (typeof displayName !== "string" || displayName.trim() === "") {
    return { success: false, error: "displayName is required and must be a non-empty string" };
  }
  if (!(BILLING_CLASSIFICATIONS as readonly string[]).includes(billingClassification)) {
    return {
      success: false,
      error:
        `Invalid billingClassification '${String(billingClassification)}'. ` +
        `Must be one of: ${BILLING_CLASSIFICATIONS.join(", ")}.`,
    };
  }
  if (!owningAppId) {
    return { success: false, error: "owningAppId (Application/Client ID) is required — run project_app_create first or pass it explicitly" };
  }

  // Standard billing requires an Azure subscription + resource group. Validate
  // up front (parity with project_provision) so we never emit a misconfigured
  // Graph request that omits the subscription and then falsely reports success.
  // Region may default, so it is not required here.
  if (billingClassification === "standard" && (!azureSubscriptionId || !resourceGroup)) {
    return {
      success: false,
      error:
        "Standard billing needs an Azure subscription and resource group.\n\n" +
        "1. Run **azure_subscriptions_list** and pick one → pass `azureSubscriptionId`.\n" +
        "2. Run **azure_resource_groups_list** for that subscription and pick one → pass `resourceGroup`.\n" +
        "3. Re-run **container_type_create** with `billingClassification=standard`, `azureSubscriptionId`, and `resourceGroup`.\n\n" +
        "(For a free container type, use `billingClassification=trial` instead.)",
    };
  }

  // Check for existing container type with the same owning app
  // (SPE enforces 1:1 relationship between owning app and container type)
  const existing = await listContainerTypes();
  const existingCt = existing.find(
    (ct) => ct.owningAppId?.toLowerCase() === owningAppId.toLowerCase(),
  );

  if (existingCt) {
    writeState({ containerTypeId: existingCt.containerTypeId, containerTypeName: existingCt.displayName });
    return {
      success: true,
      alreadyExisted: true,
      containerType: existingCt,
      message: `Container type already exists for app ${owningAppId}. SPE enforces a 1:1 relationship between owning app and container type.`,
    };
  }

  // Create the container type
  const ct = await createContainerType({
    displayName,
    owningAppId,
    billingClassification,
    azureSubscriptionId,
    resourceGroup,
    region,
  });

  // Standard billing requires an Azure-side prerequisite AFTER the CT exists:
  // the Microsoft.Syntex resource provider must be registered on the chosen
  // subscription. If that setup fails, the just-created container type would be
  // orphaned. Roll it back (transactional delete) so a failed standard-billing
  // setup never leaks an unusable CT. The CT is only persisted to
  // state after this step succeeds.
  if (billingClassification === "standard" && ct.containerTypeId) {
    try {
      await ensureSyntexProviderRegistered(azureSubscriptionId as string);
    } catch (billingError) {
      const billingMsg = billingError instanceof Error ? billingError.message : String(billingError);
      let rolledBack = true;
      let rollbackNote = "";
      try {
        await deleteContainerType(ct.containerTypeId);
      } catch (rollbackError) {
        rolledBack = false;
        rollbackNote = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
      }
      return {
        success: false,
        error:
          `Standard billing setup failed after the container type was created: ${billingMsg}. ` +
          (rolledBack
            ? "The container type was rolled back (deleted) so no orphan remains — fix the billing prerequisite and re-run container_type_create."
            : `WARNING: rollback ALSO failed — container type \`${ct.containerTypeId}\` may still exist and should be deleted manually (${rollbackNote}).`),
      };
    }
  }

  writeState({
    containerTypeId: ct.containerTypeId,
    containerTypeName: displayName,
    billingClassification,
  });

  let registrationDone = false;

  // Auto-register the container type with full permissions for the owning app
  if (autoRegister && ct.containerTypeId) {
    try {
      await registerContainerType(ct.containerTypeId, owningAppId);
      registrationDone = true;
    } catch (error) {
      // Registration may fail if propagation hasn't completed yet.
      // This is expected — the user can retry later.
      const msg = error instanceof Error ? error.message : String(error);
      return {
        success: true,
        containerType: ct,
        registrationDone: false,
        registrationError: msg,
        message: `Container type created but registration failed (propagation delay). Retry with container_type_register after ~15 seconds.`,
      };
    }
  }

  return {
    success: true,
    alreadyExisted: false,
    containerType: ct,
    registrationDone,
    message: registrationDone
      ? "Container type created and registered successfully."
      : "Container type created. Registration was skipped (autoRegister=false).",
  };
}

function formatResult(result: Awaited<ReturnType<typeof executeCreateContainerType>>): string {
  if (!result.success) {
    return `Error: ${result.error}`;
  }

  const ct = result.containerType;
  let output = result.alreadyExisted
    ? "## Existing Container Type Found\n\n"
    : "## Container Type Created\n\n";

  output += `| Property | Value |\n`;
  output += `|----------|-------|\n`;
  output += `| **Container Type ID** | \`${ct?.containerTypeId ?? "N/A"}\` |\n`;
  output += `| **Display Name** | ${ct?.displayName ?? "N/A"} |\n`;
  output += `| **Owning App ID** | \`${ct?.owningAppId ?? "N/A"}\` |\n`;
  output += `| **Billing** | ${ct?.billingClassification ?? "N/A"} |\n`;
  output += `| **Registration** | ${result.registrationDone ? "✅ Done" : result.alreadyExisted ? "—" : "⏳ Pending"} |\n`;

  if (result.message) {
    output += `\n> ${result.message}\n`;
  }
  if (result.registrationError) {
    output += `\n> ⚠️ Registration error: ${result.registrationError}\n`;
  }

  return output;
}

const createContainerTypeSchema = z.object({
  displayName: z.string().trim().min(1).describe("Display name for the container type (e.g., 'Contoso Legal Documents')"),
  owningAppId: z.string().optional().describe(
    "Application (Client) ID of the Entra ID app that will own this container type. " +
    "Defaults to the app created by project_app_create when omitted.",
  ),
  billingClassification: z.enum(BILLING_CLASSIFICATIONS).optional().describe(
    "Billing model: 'trial' (free, 30 days, max 3), 'standard' (billed to owning tenant), 'directToCustomer' (billed to consuming tenant). Default: trial",
  ),
  azureSubscriptionId: z.string().optional().describe("Azure subscription ID for standard billing. Required when billingClassification is 'standard'."),
  resourceGroup: z.string().optional().describe("Azure resource group for standard billing."),
  region: z.string().optional().describe("Azure region for standard billing."),
  autoRegister: z.boolean().optional().describe(
    "Automatically register the container type with full permissions for the owning app. Default: true. " +
    "Registration is REQUIRED before any containers can be created.",
  ),
});

function createContainerTypeValidationMessage(error: z.ZodError): string {
  const issue = error.issues[0];
  if (issue?.path[0] === "displayName") {
    return "displayName is required and must be a non-empty string";
  }
  if (issue?.path[0] === "billingClassification") {
    const received = "received" in issue ? String(issue.received) : "unknown";
    return `Invalid billingClassification '${received}'. Must be one of: ${BILLING_CLASSIFICATIONS.join(", ")}.`;
  }
  return issue?.message ?? "Invalid container type arguments";
}

export const createContainerTypeTool = defineTool({
  name: "container_type_create",
  description:
    "Create a new SharePoint Embedded container type. A container type defines the relationship between your application and a set of containers. " +
    "Each owning application can have exactly one container type (1:1 relationship). " +
    "By default, the container type is automatically registered with full permissions for the owning app. " +
    "Trial container types are limited to 3 per tenant and expire after 30 days.",
  annotations: {
    destructive: true,
    idempotent: true,
    plane: "control",
  },
  schema: createContainerTypeSchema,
  validationErrorMessage: createContainerTypeValidationMessage,
  handler: async (args) => {
    try {
      const result = await executeCreateContainerType(args);
      return result.success
        ? ok(result, formatResult(result))
        : fail("INVALID_ARGS", result.error ?? "Container type creation failed");
    } catch (error) {
      return fail("UPSTREAM", `creating container type: ${clientSafeMessage(error)}`);
    }
  },
});
