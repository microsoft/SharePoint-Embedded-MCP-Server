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
 * browser) automatically.
 *
 * Idempotency model: the stable key is the **appId** (client ID), not the
 * display name. Entra display names are NOT unique — multiple apps can share
 * one — so once an owning app has been provisioned we remember its appId and
 * resume by appId (findApplicationByAppId) on every subsequent run. A
 * display-name lookup is only a best-effort convenience for the very first run
 * (nothing remembered yet) or when the caller explicitly targets a named app;
 * if several apps share that name it resolves the first match. Net effect:
 * re-running is idempotent (no duplicate app is created) and, after the first
 * run, precise because it keys on the unique appId.
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
import { clientSafeMessage } from "../errors.js";
import { elicitChoice, elicitText } from "../elicitation.js";
import { isContextConfirmedThisSession, stampContextConfirmed } from "../session.js";
import { readState } from "../state.js";
import type { McpTool } from "../types.js";

export const createAppTool: McpTool = {
  name: "project_app_create",
  annotations: { plane: "control" },
  description:
    "Create the owning Entra application for a SharePoint Embedded setup (a public-client app " +
    "with the required SPE delegated permissions). Uses your signed-in Azure CLI session — no " +
    "first-party app or pre-authorization needed. This is the first provisioning step; the " +
    "container type and containers are created afterward as this app. Idempotent: re-running " +
    "does not create a duplicate — once provisioned it resumes by the app's unique client ID " +
    "(appId), not by display name (Entra display names are not unique).",
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
    // `let` because a native "different app" prompt can supply a name in-band.
    const explicitName =
      typeof args.displayName === "string" && args.displayName.trim() !== ""
        ? args.displayName
        : undefined;
    let displayName = explicitName ?? "SPE Builder App";
    // The user's explicit decision (relayed by the agent) about a remembered
    // app: "reuse" the last one or use a "new"/different one. Undefined until asked.
    let appSelection =
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
      // the last one — it should ask"). Critical always-ask (r-appgate): the
      // choice must fire not only when no intent was expressed, but ALSO on the
      // first touch of a freshly restarted process — i.e., whenever an app is
      // remembered, this call carries no appSelection, and the context has NOT
      // been confirmed under the current session.
      //
      // Prefer NATIVE MCP elicitation (PR #3 review): on a capable client the
      // user is prompted directly and we CONTINUE in-band with their pick — no
      // re-invoke needed and no loop. On a client without elicitation, elicitChoice
      // falls back to the agent-guided text ask (needChoice), which the agent
      // re-invokes with `appSelection` (reuse/new) — identical to prior behavior.
      // NOTE: an explicit `displayName` alone no longer bypasses the ask on an
      // unconfirmed session — appSelection (not a name) is the answer to
      // new-vs-existing; "different app" tells the caller to also pass displayName.
      const persisted = readState();
      if (persisted.appId && !appSelection && !isContextConfirmedThisSession(persisted)) {
        const choice = await elicitChoice(
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
        if (!choice.resolved) return choice.result;
        appSelection = choice.value as "reuse" | "new";
        // Native path resolved the ask in-band. For a "different app" with no
        // explicit name, prompt for one too so the flow is complete instead of
        // silently defaulting; on decline/no-capability we keep the default.
        if (appSelection === "new" && !explicitName) {
          const name = await elicitText("Name for the new owning app?", "displayName", {
            title: "New app name",
          });
          if (name.resolved) displayName = name.value;
        }
      }

      // Resolution order:
      //  - An EXPLICIT displayName targets that named app (created if missing),
      //    so a caller can address a specific app even when state holds another.
      //    NOTE: display names are NOT unique in Entra, so a name lookup resolves
      //    the first match; the unique key is the appId, which is why the reuse
      //    path below (and every run after the first) keys on the persisted appId.
      //  - "reuse" (or a first run with nothing remembered) resumes by the
      //    persisted appId (stable, unique identity); "new" forces name/default
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
      // stampContextConfirmed marks this session as confirmed (r-appgate) so the
      // always-ask above does NOT re-fire on later calls in the same process;
      // the next restart starts unconfirmed and asks again.
      stampContextConfirmed({
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
        "> The server is now **configured to sign in as this app** for SharePoint Embedded " +
        "operations — **no restart needed**. The first SPE call opens a browser for a one-time " +
        "consent (or unset `SPE_NON_INTERACTIVE`); after that, container types and containers can be created.";

      return { content: [{ type: "text" as const, text: output }] };
    } catch (error) {
      return {
        content: [{ type: "text" as const, text: `Error creating owning app: ${clientSafeMessage(error)}` }],
        isError: true,
      };
    }
  },
};
