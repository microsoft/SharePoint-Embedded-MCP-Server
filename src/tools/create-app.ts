// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Tool: project_app_create
 *
 * Creates the owning Entra application for a SharePoint Embedded setup, using
 * the Azure CLI **bootstrap token** (no Microsoft first-party app required).
 * This is the first step of the two-token model:
 *   1. az bootstrap token  → create owning app + add SPE permissions  (here)
 *   2. owning-app token     → all SPE container-type/container operations
 *
 * After creating the app, we point MSAL auth at the new app's client ID so the
 * subsequent SPE tools acquire a delegated owning-app token (device code /
 * browser) automatically. Idempotent: reuses an existing app by display name.
 *
 * Ports the full-setup skill `02-app.ps1`.
 */

import { bootstrapTokenProvider, getSignedInIdentity } from "../bootstrap.js";
import {
  addSpaRedirectUris,
  addSpePermissions,
  createApplication,
  findApplicationByAppId,
  findApplicationByName,
} from "../graph-client.js";
import { LOCAL_SPA_REDIRECT_URI } from "../constants.js";
import { setAuthConfig } from "../auth.js";
import { needChoice } from "../elicitation.js";
import { readState, writeState } from "../state.js";
import type { McpTool } from "../types.js";

export const createAppTool: McpTool = {
  name: "project_app_create",
  description:
    "Create the owning Entra application for a SharePoint Embedded setup (a public-client app " +
    "with the required SPE delegated permissions). Uses your signed-in Azure CLI session — no " +
    "first-party app or pre-authorization needed. This is the first provisioning step; the " +
    "container type and containers are created afterward as this app. Idempotent: reuses an " +
    "existing app with the same display name.",
  inputSchema: {
    type: "object" as const,
    properties: {
      displayName: {
        type: "string",
        description: "Display name for the owning app (e.g., 'Contoso Docs App'). Default: 'SPE Builder App'.",
      },
      appSelection: {
        type: "string",
        enum: ["reuse", "new"],
        description:
          "When a previously-used owning app is remembered, set 'reuse' to use it again or 'new' to " +
          "create/target a different one. If omitted and an app is remembered, the tool asks first " +
          "instead of silently reusing the last one.",
      },
    },
  },
  handler: async (args) => {
    // An explicitly-provided displayName targets that specific named app; absent
    // one we use the default (and prefer resuming the persisted appId below).
    const explicitName =
      typeof args.displayName === "string" && args.displayName.trim() !== ""
        ? args.displayName
        : undefined;
    const displayName = explicitName ?? "SPE Builder App";
    // The user's explicit decision (relayed by the agent) about a remembered
    // app: "reuse" the last one or use a "new"/different one. Undefined until asked.
    const appSelection =
      args.appSelection === "reuse" || args.appSelection === "new" ? args.appSelection : undefined;

    try {
      const identity = await getSignedInIdentity();
      if (!identity) {
        return {
          content: [
            {
              type: "text" as const,
              text: "⛔ Not signed in to Azure CLI. Run `az login --allow-no-subscriptions`, then retry.",
            },
          ],
          isError: true,
        };
      }

      const getToken = bootstrapTokenProvider;

      // Ask before silently reusing the last app (PM feedback: "it favors using
      // the last one — it should ask"). Only prompt when there IS a remembered
      // app and the caller has not already expressed intent (an explicit name,
      // or a prior reuse/new choice). Auth identity follows the chosen app
      // (setAuthConfig repoints MSAL on a client change), so this choice also
      // governs which signed-in identity the subsequent SPE calls use.
      const persisted = readState();
      if (persisted.appId && !explicitName && !appSelection) {
        return needChoice(
          `You previously used the owning app "${persisted.appDisplayName ?? persisted.appId}". Reuse it, or use a different app?`,
          [
            {
              label: `Reuse "${persisted.appDisplayName ?? persisted.appId}"`,
              value: "reuse",
              description: `the remembered app (client ID ${persisted.appId})`,
            },
            {
              label: "Use a different app",
              value: "new",
              description: "create or target another owning app — also pass displayName with its name",
            },
          ],
          "appSelection",
        );
      }

      // Resolution order:
      //  - An EXPLICIT displayName targets that named app (created if missing),
      //    so a caller can address a specific app even when state holds another.
      //  - "reuse" (or a first run with nothing remembered) resumes by the
      //    persisted appId (stable identity); "new" forces name/default
      //    resolution instead of the remembered id.
      //  - Otherwise fall back to a default-name lookup.
      const resumeByAppId = !explicitName && appSelection !== "new" && !!persisted.appId;
      let app = explicitName
        ? await findApplicationByName(explicitName, getToken)
        : resumeByAppId
          ? await findApplicationByAppId(persisted.appId as string, getToken)
          : await findApplicationByName(displayName, getToken);
      let reused = false;
      if (app) {
        reused = true;
        // Attach/reuse path: adding permissions is best-effort and non-blocking.
        await addSpePermissions(app.objectId, getToken, { bestEffort: true });
        // self-repair the SPA redirect URI on a pre-existing owning
        // app. Apps created before have no `spa` platform, so the
        // generated browser app's MSAL.js auth-code + PKCE sign-in fails with
        // AADSTS9002326 — and the fresh-create path (createApplication) never
        // runs for a reused app, so without this the app stays broken on re-run.
        // Idempotent (addSpaRedirectUris no-ops when the origin is already
        // present) and best-effort (a missing Application.ReadWrite grant must
        // not fail app reuse — mirrors addSpePermissions above). Only on the
        // reuse path: createApplication already sets `spa` at create time.
        await addSpaRedirectUris(app.objectId, [LOCAL_SPA_REDIRECT_URI], getToken, {
          bestEffort: true,
        });
      } else {
        app = await createApplication(displayName, getToken);
        // Create path: permissions are required, so errors propagate.
        await addSpePermissions(app.objectId, getToken);
      }

      // Persist and point MSAL at the new owning app for subsequent SPE calls.
      writeState({
        tenantId: identity.tenantId,
        appId: app.appId,
        appObjectId: app.objectId,
        appDisplayName: app.displayName,
      });
      setAuthConfig({ clientId: app.appId, tenantId: identity.tenantId });

      const output =
        `## Owning App ${reused ? "Found" : "Created"}\n\n` +
        "| Property | Value |\n|----------|-------|\n" +
        `| **Display name** | ${app.displayName} |\n` +
        `| **Application (client) ID** | \`${app.appId}\` |\n` +
        `| **Object ID** | \`${app.objectId}\` |\n` +
        `| **Tenant** | \`${identity.tenantId}\` |\n` +
        `| **Client type** | Public client (no secret) |\n` +
        `| **SPE permissions** | FileStorageContainer.Manage.All, FileStorageContainer.Selected, ContainerType.Manage.All, ContainerTypeReg.Manage.All, ContainerTypeReg.Selected |\n\n` +
        "> Next: create a container type. The first SPE call will prompt a one-time sign-in " +
        "as this app (device code / browser).";

      return { content: [{ type: "text" as const, text: output }] };
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      return {
        content: [{ type: "text" as const, text: `Error creating owning app: ${msg}` }],
        isError: true,
      };
    }
  },
};

/** Resolve the owning app ID from explicit arg or persisted state. */
export function resolveOwningAppId(explicit?: string): string | undefined {
  return explicit || readState().appId;
}
