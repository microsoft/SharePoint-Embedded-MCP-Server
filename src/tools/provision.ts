// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Tool: project_provision
 *
 * One-call orchestrator for the SharePoint Embedded control-plane setup:
 *   owning app → container type → (standard billing) → registration → container.
 *
 * Composes the lower-level operations with the two-token handoff handled
 * internally (az bootstrap token creates the app; the owning-app token does the
 * SPE operations). Idempotent and resumable via ~/.spe-mcp/state.json.
 *
 * Billing: when `billingClassification` is "standard", a subscription +
 * resource group are required; the tool registers the Microsoft.Syntex provider
 * and creates the container type linked to that subscription. When omitted and
 * none can be defaulted, the tool asks the user to choose (agent-guided
 * elicitation) rather than guessing.
 */

import { bootstrapTokenProvider, getSignedInIdentity } from "../bootstrap.js";
import { createSyntexAccount, ensureSyntexProviderRegistered, getSyntexAccounts } from "../azure-cli.js";
import {
  activateContainer,
  addSpePermissions,
  createApplication,
  createContainer,
  createContainerType,
  deleteContainerType,
  findApplicationByAppId,
  findApplicationByName,
  getSignedInUser,
  grantContainerTypeOwner,
  listContainerTypes,
  registerContainerType,
} from "../graph-client.js";
import { setAuthConfig } from "../auth.js";
import {
  CONTAINER_CREATE_MAX_ATTEMPTS,
  containerCreateBackoffMs,
  isContainerPropagationError,
} from "../container-retry.js";
import { needChoice } from "../elicitation.js";
import { readState, writeState } from "../state.js";
import type { McpTool } from "../types.js";

interface ProvisionArgs {
  appDisplayName?: string;
  appSelection?: "reuse" | "new";
  containerTypeName?: string;
  containerName?: string;
  billingClassification?: "trial" | "standard";
  azureSubscriptionId?: string;
  resourceGroup?: string;
  region?: string;
  seedSampleData?: boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export const provisionTool: McpTool = {
  name: "project_provision",
  description:
    "Provision a complete SharePoint Embedded setup in one call: create the owning Entra app, " +
    "create and register a container type, and create an active container. Supports trial or " +
    "standard billing (standard requires an Azure subscription + resource group). Idempotent and " +
    "resumable. Returns the IDs needed to wire an app. Use this for 'build me an SPE app' requests.",
  inputSchema: {
    type: "object" as const,
    properties: {
      appDisplayName: { type: "string", description: "Owning app display name. Default: 'SPE Builder App'." },
      appSelection: {
        type: "string",
        enum: ["reuse", "new"],
        description:
          "When a previously-used owning app is remembered, set 'reuse' to use it again or 'new' to " +
          "create/target a different one. If omitted and an app is remembered, the tool asks first.",
      },
      containerTypeName: { type: "string", description: "Container type name. Default: '<app> Container Type'." },
      containerName: { type: "string", description: "First container name. Default: 'Default Container'." },
      billingClassification: {
        type: "string",
        enum: ["trial", "standard"],
        description: "Billing model. 'trial' (free, 30 days, max 3) or 'standard' (Azure subscription).",
      },
      azureSubscriptionId: { type: "string", description: "Azure subscription ID (required for standard billing)." },
      resourceGroup: { type: "string", description: "Azure resource group (required for standard billing)." },
      region: { type: "string", description: "Azure region for standard billing. Default: eastus." },
      seedSampleData: { type: "boolean", description: "Reserved: seed sample containers/docs after provisioning (see project_seed_sample_data)." },
    },
  },
  handler: async (args) => {
    const state = readState();
    const {
      appDisplayName = "SPE Builder App",
      containerTypeName,
      containerName = "Default Container",
      billingClassification,
      azureSubscriptionId = state.azureSubscriptionId,
      resourceGroup = state.resourceGroup,
      region = "eastus",
    } = args as ProvisionArgs;
    // An explicit appDisplayName targets that named app even when state holds
    // another appId; absent one, resume by the persisted appId below.
    const explicitAppName =
      typeof args.appDisplayName === "string" && args.appDisplayName.trim() !== ""
        ? args.appDisplayName
        : undefined;
    // The user's explicit decision about a remembered owning app: "reuse" the
    // last one or use a "new"/different one. Undefined until asked.
    const appSelection =
      args.appSelection === "reuse" || args.appSelection === "new" ? args.appSelection : undefined;

    try {
      // 0. Confirm signed-in identity (bootstrap/control plane).
      const identity = await getSignedInIdentity();
      if (!identity) {
        return {
          content: [{ type: "text" as const, text: "⛔ Not signed in to Azure CLI. Run `az login --allow-no-subscriptions`, then retry." }],
          isError: true,
        };
      }

      // Ask before silently reusing the last app (PM feedback: "it favors using
      // the last one — it should ask"). Only when an app is remembered and the
      // caller hasn't already chosen (an explicit name, or a prior reuse/new
      // pick). Comes before the billing prompt so the app is settled first; the
      // chosen app also drives which signed-in identity the SPE calls use.
      if (state.appId && !explicitAppName && !appSelection) {
        return needChoice(
          `You previously used the owning app "${state.appDisplayName ?? state.appId}". Reuse it, or use a different app?`,
          [
            {
              label: `Reuse "${state.appDisplayName ?? state.appId}"`,
              value: "reuse",
              description: `the remembered app (client ID ${state.appId})`,
            },
            {
              label: "Use a different app",
              value: "new",
              description: "create or target another owning app — also pass appDisplayName with its name",
            },
          ],
          "appSelection",
        );
      }

      // Elicit billing model if not provided and not already standard in state.
      if (!billingClassification) {
        return needChoice(
          "What billing model for your container type?",
          [
            { label: "Trial", value: "trial", description: "free, 30 days, max 3 per tenant" },
            { label: "Standard", value: "standard", description: "billed to an Azure subscription you choose" },
          ],
          "billingClassification",
        );
      }

      // For standard billing, require subscription + resource group (elicit if missing).
      if (billingClassification === "standard" && (!azureSubscriptionId || !resourceGroup)) {
        return {
          content: [{
            type: "text" as const,
            text:
              "Standard billing needs an Azure subscription and resource group.\n\n" +
              "1. Run **azure_subscriptions_list** and pick one → pass `azureSubscriptionId`.\n" +
              "2. Run **azure_resource_groups_list** for that subscription and pick one → pass `resourceGroup`.\n" +
              "3. Re-run **project_provision** with `billingClassification=standard`, `azureSubscriptionId`, and `resourceGroup`.",
          }],
        };
      }

      const steps: string[] = [];

      // 1. Owning app (bootstrap token), idempotent.
      const getToken = bootstrapTokenProvider;
      // Resolution order: an EXPLICIT appDisplayName targets that named app
      // (created if missing). Otherwise "reuse" (or a first run with nothing
      // remembered) resumes by the persisted appId (stable identity), while
      // "new" forces name/default resolution instead of the remembered id.
      const resumeByAppId = !explicitAppName && appSelection !== "new" && !!state.appId;
      let app = explicitAppName
        ? await findApplicationByName(explicitAppName, getToken)
        : resumeByAppId
          ? await findApplicationByAppId(state.appId as string, getToken)
          : await findApplicationByName(appDisplayName, getToken);
      if (!app) {
        app = await createApplication(appDisplayName, getToken);
        steps.push(`Created owning app **${app.displayName}** (\`${app.appId}\`)`);
        // Create path: permissions are required, so errors propagate.
        await addSpePermissions(app.objectId, getToken);
      } else {
        steps.push(`Reused owning app **${app.displayName}** (\`${app.appId}\`)`);
        // Attach/reuse path: adding permissions is best-effort and non-blocking.
        await addSpePermissions(app.objectId, getToken, { bestEffort: true });
      }
      writeState({ tenantId: identity.tenantId, appId: app.appId, appObjectId: app.objectId, appDisplayName: app.displayName });
      // Hand off to the owning-app token for SPE operations.
      setAuthConfig({ clientId: app.appId, tenantId: identity.tenantId });

      // 2. Standard billing prerequisite: register the Syntex provider.
      if (billingClassification === "standard" && azureSubscriptionId) {
        const provider = await ensureSyntexProviderRegistered(azureSubscriptionId);
        steps.push(`Microsoft.Syntex provider: ${provider.registrationState}`);
      }

      // 3. Container type (reuse by owning app — 1:1), with billing.
      const ctName = containerTypeName ?? `${appDisplayName} Container Type`;
      const existingCts = await listContainerTypes();
      let containerTypeId =
        existingCts.find((c) => c.owningAppId?.toLowerCase() === app!.appId.toLowerCase())?.containerTypeId;
      let createdCt = false;
      if (!containerTypeId) {
        const ct = await createContainerType({
          displayName: ctName,
          owningAppId: app.appId,
          billingClassification,
          azureSubscriptionId: billingClassification === "standard" ? azureSubscriptionId : undefined,
          resourceGroup: billingClassification === "standard" ? resourceGroup : undefined,
          region: billingClassification === "standard" ? region : undefined,
        });
        containerTypeId = ct.containerTypeId;
        createdCt = true;
        steps.push(`Created container type **${ctName}** (\`${containerTypeId}\`, ${billingClassification})`);
      } else {
        steps.push(`Reused container type \`${containerTypeId}\``);
      }

      // 3a. Standard billing: create the Microsoft.Syntex (RaaS) ARM billing
      // account (az). Orchestration parity with the VS Code extension: on ANY
      // billing failure, roll back by deleting a JUST-CREATED CT (transactional);
      // a reused/pre-existing CT is never deleted.
      let syntexAccountResourceId: string | undefined;
      if (billingClassification === "standard" && azureSubscriptionId && resourceGroup) {
        // Idempotency: reuse an already-Succeeded Microsoft.Syntex account for this
        // CT (mirrors billing_setup) instead of attempting a duplicate that would
        // fail; only create one when none is attached yet.
        const existingAccounts = await getSyntexAccounts(azureSubscriptionId, resourceGroup).catch(() => []);
        syntexAccountResourceId = existingAccounts.find(
          (a) => a.properties?.identityId === containerTypeId && a.properties?.provisioningState === "Succeeded",
        )?.id;
        try {
          if (syntexAccountResourceId) {
            steps.push(`Reused Microsoft.Syntex billing account (\`${syntexAccountResourceId}\`)`);
          } else {
            syntexAccountResourceId = await createSyntexAccount(
              azureSubscriptionId, resourceGroup, region, containerTypeId,
            );
            steps.push(`Created Microsoft.Syntex billing account (\`${syntexAccountResourceId}\`)`);
          }
        } catch (billingError) {
          const billingMsg = billingError instanceof Error ? billingError.message : String(billingError);
          if (createdCt && containerTypeId) {
            let rollbackNote = " The just-created container type was rolled back (deleted).";
            try {
              await deleteContainerType(containerTypeId);
            } catch (rbErr) {
              const rb = rbErr instanceof Error ? rbErr.message : String(rbErr);
              rollbackNote = ` WARNING: rollback ALSO failed — container type \`${containerTypeId}\` may still exist and should be deleted manually (${rb}).`;
            }
            return {
              content: [{ type: "text" as const, text: `Error during provisioning: standard billing account creation failed: ${billingMsg}.${rollbackNote} Fix the Azure billing prerequisite and re-run project_provision.` }],
              isError: true,
            };
          }
          return {
            content: [{ type: "text" as const, text: `Error during provisioning: standard billing account creation failed: ${billingMsg}. The pre-existing container type was left intact — re-run billing_setup once the prerequisite is fixed.` }],
            isError: true,
          };
        }
      }

      writeState({
        containerTypeId,
        containerTypeName: ctName,
        billingClassification,
        ...(billingClassification === "standard"
          ? { azureSubscriptionId, resourceGroup, syntexAccountResourceId }
          : {}),
      });

      // 4. Register on the tenant (required before containers).
      await registerContainerType(containerTypeId, app.appId);
      steps.push("Registered container type on tenant");

      // 4a. Grant the signed-in user the `owner` role on the container type
      // (Graph beta). Owners can create containers using a public client (PCA),
      // so the deployed sample app's user — not just this bootstrap path — can
      // create containers. Best-effort: the container type's creator is already
      // an auto-owner, so a failure here is non-fatal.
      try {
        const me = await getSignedInUser(getToken);
        await grantContainerTypeOwner(containerTypeId, me.id);
        steps.push(`Granted owner role to ${me.userPrincipalName ?? me.id} (enables PCA container creation)`);
      } catch (grantError) {
        steps.push(`⚠️ Owner grant skipped: ${grantError instanceof Error ? grantError.message : String(grantError)}`);
      }

      // 5. Create + activate a container, with propagation backoff.
      let containerId = "";
      let lastError = "";
      for (let attempt = 1; attempt <= CONTAINER_CREATE_MAX_ATTEMPTS; attempt++) {
        try {
          const container = await createContainer(containerTypeId, containerName);
          containerId = container.id;
          if (container.status !== "active") {
            try {
              await activateContainer(containerId);
            } catch {
              /* activation may lag; status will settle */
            }
          }
          break;
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error);
          // Retry only genuine registration-propagation delays. A wrong/
          // unregistered container type (404) or authorization failure (403)
          // is permanent — fail fast rather than hang ~150s through every
          // backoff.
          if (attempt < CONTAINER_CREATE_MAX_ATTEMPTS && isContainerPropagationError(lastError)) {
            await sleep(containerCreateBackoffMs(attempt));
            continue;
          }
          break;
        }
      }
      if (containerId) {
        writeState({ containerId, containerName });
        steps.push(`Created container **${containerName}** (\`${containerId}\`)`);
      } else if (isContainerPropagationError(lastError)) {
        // Transient: the grant is still propagating. The earlier steps DID
        // succeed; the container can be created later with `container_create`.
        steps.push(`⚠️ Container creation still pending (registration propagation) — retry with \`container_create\`: ${lastError}`);
      } else {
        // Permanent: a typo'd/unknown containerTypeId or unrecoverable error.
        // This will NOT self-resolve — surface it as a failure, not "pending".
        steps.push(`❌ Container creation FAILED (not recoverable by retry — check the container type ID): ${lastError}`);
      }

      const summary =
        "## SPE Provisioned\n\n" +
        steps.map((s, i) => `${i + 1}. ${s}`).join("\n") +
        "\n\n### Config\n\n" +
        "| Key | Value |\n|-----|-------|\n" +
        `| TENANT_ID | \`${identity.tenantId}\` |\n` +
        `| CLIENT_ID | \`${app.appId}\` |\n` +
        `| CONTAINER_TYPE_ID | \`${containerTypeId}\` |\n` +
        `| CONTAINER_ID | \`${containerId || "(pending)"}\` |\n` +
        (billingClassification === "standard"
          ? `| SUBSCRIPTION_ID | \`${azureSubscriptionId}\` |\n| RESOURCE_GROUP | ${resourceGroup} |\n| SYNTEX_ACCOUNT | \`${syntexAccountResourceId ?? "(pending)"}\` |\n`
          : "") +
        "\n> Next: `project_hydrate_config` to write these into a project, then `project_scaffold` to generate an app.";

      return { content: [{ type: "text" as const, text: summary }] };
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      return { content: [{ type: "text" as const, text: `Error during provisioning: ${msg}` }], isError: true };
    }
  },
};
