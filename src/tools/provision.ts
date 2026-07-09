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
import { createSyntexAccount, ensureSyntexProviderRegistered, getSyntexAccounts, assertSyntexRegionSupported } from "../azure-cli.js";
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
  toClassifiableError,
  type ClassifiableError,
} from "../container-retry.js";
import { needChoice } from "../elicitation.js";
import { isContextConfirmedThisSession, stampContextConfirmed } from "../session.js";
import { readState, writeState } from "../state.js";
import type { Guid, McpTool, OwnerScope } from "../types.js";

interface ProvisionArgs {
  appDisplayName?: string;
  appSelection?: "reuse" | "new";
  ownerScope?: OwnerScope;
  containerTypeName?: string;
  containerName?: string;
  billingClassification?: "trial" | "standard";
  azureSubscriptionId?: Guid;
  resourceGroup?: string;
  region?: string;
  confirmBilling?: boolean;
  seedSampleData?: boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Structured stderr log (matches the per-module convention used in bootstrap.ts
 * / graph-client.ts). Provisioning is a multi-minute orchestration; without a
 * live signal the buffered `steps` array only surfaces at the very end, so the
 * server log looks frozen mid-run. Logging each completed step here (rather than
 * threading MCP `notifications/progress` through index.ts, which another work
 * item owns this batch) gives operators live movement with no protocol plumbing.
 */
function log(message: string): void {
  console.error(`[${new Date().toISOString()}] [Provision] ${message}`);
}

/**
 * Append a completed step to the running list AND emit it to the server log so
 * progress is visible while the orchestration is still in flight.
 */
function recordStep(steps: string[], text: string): void {
  steps.push(text);
  log(`step ${steps.length}: ${text}`);
}

/**
 * Render the steps completed so far as a partial-progress block for an
 * early-return / failure path. A mid-flow failure that returned only its own
 * error text used to hide how far provisioning got; because the flow is
 * idempotent/resumable, surfacing the completed steps (and where it stopped)
 * makes a half-finished run debuggable and resumable. Returns "" when no steps
 * have run yet (e.g. sign-in / elicitation gates), so those returns are
 * unchanged rather than carrying an empty, noisy section.
 */
function partialProgress(steps: string[], stoppedAt: string): string {
  if (steps.length === 0) return "";
  const done = steps.map((s, i) => `${i + 1}. ${s}`).join("\n");
  return (
    "\n\n### Progress before this stop\n\n" +
    done +
    `\n\n_Stopped at: ${stoppedAt}. Provisioning is idempotent — re-run \`project_provision\` to resume from here._`
  );
}

export const provisionTool: McpTool = {
  name: "project_provision",
  annotations: { plane: "control" },
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
      ownerScope: {
        type: "string",
        enum: ["manage-all", "selected"],
        description:
          "Least-privilege intent for the owning app's SPE permissions (PR #3 review). " +
          "'selected' requests only the scopes needed to manage this app's own container type (standard " +
          "ISV/LOB). 'manage-all' also requests the broad *.Manage.All scopes to administer ALL container " +
          "types in the tenant (admin/console app). If omitted on an unconfirmed session, the tool asks. " +
          "Persisted and reused on later runs.",
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
      confirmBilling: {
        type: "boolean",
        description:
          "Must be true to create the IRREVERSIBLE, CHARGEABLE standard Azure billing account " +
          "(Microsoft.Syntex/accounts). Without it, standard provisioning returns a cost preview and " +
          "makes no change. Ignored for trial billing and for resumes where billing is already set up.",
      },
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
      confirmBilling = false,
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

    // Declared before the try so every early-return error path AND the catch-all
    // below can surface how far provisioning got (partial-steps summary).
    const steps: string[] = [];

    try {
      // 0. Confirm signed-in identity (bootstrap/control plane).
      const identity = await getSignedInIdentity();
      if (!identity) {
        return {
          content: [{ type: "text" as const, text: "⛔ Not signed in to Azure CLI. Run `az login --allow-no-subscriptions`, then retry." + partialProgress(steps, "sign-in check") }],
          isError: true,
        };
      }

      // Ask before silently reusing the last app (PM feedback: "it favors using
      // the last one — it should ask"). Critical always-ask (r-appgate): fire
      // whenever an app is remembered, this call carries no appSelection, and
      // the context is NOT confirmed under the current session — so a freshly
      // restarted process always re-asks even though state already holds an app.
      // The agent re-invokes with appSelection (reuse/new); no loop. An explicit
      // appDisplayName alone no longer bypasses the ask on an unconfirmed
      // session (appSelection is the new-vs-existing answer). Comes before the
      // billing prompt so the app is settled first; the chosen app also drives
      // which signed-in identity the SPE calls use.
      if (state.appId && !appSelection && !isContextConfirmedThisSession(state)) {
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
              "3. Re-run **project_provision** with `billingClassification=standard`, `azureSubscriptionId`, and `resourceGroup`." +
              partialProgress(steps, "standard billing prerequisites (subscription + resource group)"),
          }],
        };
      }

      // Pre-flight: validate the Azure region BEFORE creating anything. A
      // standard container type CANNOT be deleted (Graph 422 "Cannot delete
      // container type for non trial"), so if we only discovered an unsupported
      // region at billing-account creation time — after the CT already exists —
      // the rollback would fail and leave an orphaned CT (observed with
      // 'westus2'). Failing here keeps an invalid region cost-free and
      // reversible. (per PR #3 review — provisioning safety)
      if (billingClassification === "standard") {
        try {
          assertSyntexRegionSupported(region);
        } catch (regionError) {
          return {
            content: [{
              type: "text" as const,
              text:
                `${regionError instanceof Error ? regionError.message : String(regionError)}` +
                partialProgress(steps, "standard billing region validation"),
            }],
            isError: true,
          };
        }
      }

      // Financial-safety gate (per PR #3 review): standard billing creates a
      // CHARGEABLE Microsoft.Syntex (RaaS) Azure account. Require an explicit
      // confirmation before ANY owning app / container type / billing account is
      // created, so a "build me an SPE app" request can never silently incur
      // Azure cost. Skipped for trial. The skip for an idempotent resume is
      // scoped to the SAME billing target — reusing the remembered app AND the
      // same subscription/resource group — so a stale Syntex id from a previous
      // (different) app can't wave through a brand-new chargeable account. The
      // check is fail-closed: only a literal `true` proceeds. Makes no change.
      const resumingSameBillingTarget =
        !!state.syntexAccountResourceId &&
        appSelection !== "new" &&
        (!explicitAppName || explicitAppName === state.appDisplayName) &&
        azureSubscriptionId === state.azureSubscriptionId &&
        resourceGroup === state.resourceGroup;
      if (billingClassification === "standard" && confirmBilling !== true && !resumingSameBillingTarget) {
        return {
          content: [{
            type: "text" as const,
            text:
              "### Confirm standard (paid) billing\n\n" +
              "**Standard** billing will create a **chargeable** `Microsoft.Syntex/accounts` (RaaS) Azure " +
              "billing account, plus a new owning Entra app and container type. This incurs Azure costs " +
              "and **cannot be reverted to trial**.\n\n" +
              `- **Subscription:** \`${azureSubscriptionId}\`\n` +
              `- **Resource group:** ${resourceGroup}\n` +
              `- **Region:** ${region}\n\n` +
              "> Re-run **project_provision** with `confirmBilling=true` to proceed. For a free setup, " +
              "re-run with `billingClassification=trial` instead. No changes were made.",
          }],
        };
      }

      // Least-privilege intent gate (PR #3 review): choose whether the owning app
      // administers ALL container types in the tenant (broad *.Manage.All scopes,
      // an admin/console app) or only its own container type (least privilege,
      // standard ISV/LOB). Placed AFTER the billing gates so the app + billing are
      // settled first. Fires only when no intent is known (neither the arg nor
      // persisted state) AND the session is unconfirmed — so a freshly restarted
      // process asks at most once; the agent re-invokes with ownerScope and
      // provisioning persists it below, so this is resumable and never loops.
      const resolvedOwnerScope: OwnerScope | undefined =
        args.ownerScope === "manage-all" || args.ownerScope === "selected"
          ? args.ownerScope
          : state.ownerScope;
      if (resolvedOwnerScope === undefined && !isContextConfirmedThisSession(state)) {
        return needChoice(
          "Should this owning app manage ALL container types (an admin/console app), or just this one app's container type (standard ISV/LOB)?",
          [
            {
              label: "Manage all container types",
              value: "manage-all",
              description: "admin/console app — requests the broad *.Manage.All scopes for every container type",
            },
            {
              label: "This app only (least privilege)",
              value: "selected",
              description: "standard ISV/LOB — only the scopes needed for this app's own container type",
            },
          ],
          "ownerScope",
        );
      }
      // Least privilege by default once the session is confirmed but no intent was
      // recorded (e.g., an older resumed setup provisioned before this prompt).
      const ownerScope: OwnerScope = resolvedOwnerScope ?? "selected";

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
      // Capture created-vs-reused BEFORE `app` is reassigned in the create branch:
      // a found app is reused, a null result means we freshly create one below.
      const reusedApp = !!app;
      if (!app) {
        app = await createApplication(appDisplayName, getToken);
        recordStep(steps, `Created owning app **${app.displayName}** (\`${app.appId}\`)`);
        // Create path: permissions are required, so errors propagate.
        await addSpePermissions(app.objectId, getToken, { ownerScope });
      } else {
        recordStep(steps, `Reused owning app **${app.displayName}** (\`${app.appId}\`)`);
        // Attach/reuse path: adding permissions is best-effort and non-blocking.
        await addSpePermissions(app.objectId, getToken, { bestEffort: true, ownerScope });
      }
      // Mark this session confirmed (r-appgate) as the app is settled, and hand
      // off to the owning-app token for SPE operations. Confirming here keeps the
      // always-ask above from re-firing on later calls in the same process.
      // Record the least-privilege intent too (PR #3 review). Both scope sets
      // (manage-all AND selected) grant FileStorageContainerType.Manage.All, so a
      // freshly CREATED owning app can enumerate all container types → flag true.
      // For a REUSED app we defer the flag to the listContainerTypes call below,
      // which self-corrects it from the live grant (a 403 sets it false).
      stampContextConfirmed({
        tenantId: identity.tenantId,
        appId: app.appId,
        appObjectId: app.objectId,
        appDisplayName: app.displayName,
        ownerScope,
        ...(reusedApp ? {} : { owningAppManagesAllContainerTypes: true }),
      });
      setAuthConfig({ clientId: app.appId, tenantId: identity.tenantId });

      // 2. Standard billing prerequisite: register the Syntex provider.
      if (billingClassification === "standard" && azureSubscriptionId) {
        const provider = await ensureSyntexProviderRegistered(azureSubscriptionId);
        recordStep(steps, `Microsoft.Syntex provider: ${provider.registrationState}`);
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
        recordStep(steps, `Created container type **${ctName}** (\`${containerTypeId}\`, ${billingClassification})`);
      } else {
        recordStep(steps, `Reused container type \`${containerTypeId}\``);
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
            recordStep(steps, `Reused Microsoft.Syntex billing account (\`${syntexAccountResourceId}\`)`);
          } else {
            syntexAccountResourceId = await createSyntexAccount(
              azureSubscriptionId, resourceGroup, region, containerTypeId,
            );
            recordStep(steps, `Created Microsoft.Syntex billing account (\`${syntexAccountResourceId}\`)`);
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
              content: [{ type: "text" as const, text: `Error during provisioning: standard billing account creation failed: ${billingMsg}.${rollbackNote} Fix the Azure billing prerequisite and re-run project_provision.` + partialProgress(steps, "standard billing account creation (Microsoft.Syntex)") }],
              isError: true,
            };
          }
          return {
            content: [{ type: "text" as const, text: `Error during provisioning: standard billing account creation failed: ${billingMsg}. The pre-existing container type was left intact — re-run billing_setup once the prerequisite is fixed.` + partialProgress(steps, "standard billing account creation (Microsoft.Syntex)") }],
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
      recordStep(steps, "Registered container type on tenant");

      // 4a. Grant the signed-in user the `owner` role on the container type
      // (Graph beta). Owners can create containers using a public client (PCA),
      // so the deployed sample app's user — not just this bootstrap path — can
      // create containers. Best-effort: the container type's creator is already
      // an auto-owner, so a failure here is non-fatal.
      try {
        const me = await getSignedInUser(getToken);
        await grantContainerTypeOwner(containerTypeId, me.id);
        recordStep(steps, `Granted owner role to ${me.userPrincipalName ?? me.id} (enables PCA container creation)`);
      } catch (grantError) {
        recordStep(steps, `⚠️ Owner grant skipped: ${grantError instanceof Error ? grantError.message : String(grantError)}`);
      }

      // 5. Create + activate a container, with propagation backoff.
      let containerId = "";
      let lastError = "";
      let lastErrorClass: ClassifiableError = { message: "" };
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
          lastErrorClass = toClassifiableError(error);
          // Retry only genuine registration-propagation delays. A wrong/
          // unregistered container type (404) or authorization failure (403)
          // is permanent — fail fast rather than hang ~150s through every
          // backoff. Classify on the error object (HTTP status), not a message
          // substring.
          if (attempt < CONTAINER_CREATE_MAX_ATTEMPTS && isContainerPropagationError(lastErrorClass)) {
            await sleep(containerCreateBackoffMs(attempt));
            continue;
          }
          break;
        }
      }
      if (containerId) {
        writeState({ containerId, containerName });
        recordStep(steps, `Created container **${containerName}** (\`${containerId}\`)`);
      } else if (isContainerPropagationError(lastErrorClass)) {
        // Transient: the grant is still propagating. The earlier steps DID
        // succeed; the container can be created later with `container_create`.
        recordStep(steps, `⚠️ Container creation still pending (registration propagation) — retry with \`container_create\`: ${lastError}`);
      } else {
        // Permanent: a typo'd/unknown containerTypeId or unrecoverable error.
        // This will NOT self-resolve — surface it as a failure, not "pending".
        recordStep(steps, `❌ Container creation FAILED (not recoverable by retry — check the container type ID): ${lastError}`);
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
      // A mid-flow throw (e.g. permissions, container-type, or registration
      // call failing) used to surface only this message and hide how far the
      // orchestration got. Include the completed steps so a partially-provisioned
      // run is debuggable and resumable.
      return { content: [{ type: "text" as const, text: `Error during provisioning: ${msg}` + partialProgress(steps, `an unexpected error (${msg})`) }], isError: true };
    }
  },
};
