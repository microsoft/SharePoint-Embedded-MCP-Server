// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Tools: container_type_owner_grant / container_type_owners_list /
 * container_type_owner_delete
 *
 * Manage the `permissions` (owner) collection on a fileStorageContainerType via
 * Microsoft Graph **beta**. Granting a USER the `owner` role lets that user
 * create containers using a public client (PCA) — the v1.0 container endpoint
 * rejects container creation by public clients ("Container creation by a public
 * client is not allowed"). Only the `owner` role and a user identity are
 * supported; max 3 owners per container type.
 */

import { azureCliTokenProvider } from "../azure-cli-token.js";
import {
  getSignedInUser,
  grantContainerTypeOwner,
  listContainerTypePermissions,
  revokeContainerTypePermission,
} from "../graph-client.js";
import type { McpTool } from "../types.js";
import { authContainerTypeState, err, reason } from "./container-type-shared.js";
import { resolveContextGate } from "./context-gate.js";

/** Optional restart-confirmation arg surfaced on the mutation tools (r-appgate). */
const contextChoiceSchema = {
  type: "string" as const,
  enum: ["confirm", "switch"],
  description:
    "On a freshly restarted session, confirm the remembered owning app / container type ('confirm') " +
    "or switch to a different one ('switch'). Supplied in response to the confirmation prompt; omit on the first call.",
};

/** Point MSAL at the owning app and return the provisioned container-type id as
 *  the default. Thin wrapper over the shared helper (owner tools only need the
 *  container-type id). */
function authAndDefaultCt(): string | undefined {
  return authContainerTypeState().containerTypeId;
}

/**
 * Does a Graph error look like the "a guest (B2B) user cannot be a container-type
 * owner" rejection? Heuristic on the error text — used to turn the raw API
 * failure into clear, actionable guidance when an explicit guest `userId` was
 * supplied (its `userType` is unknown without an extra lookup). Conservative:
 * only matches when the message mentions a guest / external (`#EXT#`) user, which
 * in the grant-owner context is the owner restriction. (PR #3 review.)
 */
function isGuestOwnerRejection(e: unknown): boolean {
  const m = reason(e).toLowerCase();
  return m.includes("guest") || m.includes("#ext#");
}

export const ownerGrantContainerTypeTool: McpTool = {
  name: "container_type_owner_grant",
  annotations: { plane: "control" },
  description:
    "Grant the `owner` role on a SharePoint Embedded container type to a user (Microsoft Graph beta). " +
    "An owner can create containers using a public client (PCA) — the v1.0 container API rejects container " +
    "creation by public clients. Defaults the container type to the provisioned one and the user to the " +
    "signed-in user. Max 3 owners per container type.",
  inputSchema: {
    type: "object" as const,
    properties: {
      containerTypeId: { type: "string", description: "Container type id. Default: the provisioned container type." },
      userId: { type: "string", description: "Object id of the user to grant `owner`. Default: the signed-in user." },
      contextChoice: contextChoiceSchema,
    },
  },
  handler: async (args) => {
    // Whether the grant targets the SIGNED-IN user (no explicit userId). Declared
    // before the try so the catch can scope the guest-owner remap to this
    // self-target path only. (PR #3 review.)
    const targetIsSignedInUser = !(args.userId as string | undefined);
    try {
      // Restart confirmation gate (r-appgate) before mutating owners on a fresh
      // session. Inside the try so a stamp-write failure on `contextChoice=confirm`
      // (writeState / writeSecureFile) is classified by this tool's own error
      // handling below, like its other errors. (PR #3 review.)
      const gate = await resolveContextGate(args.contextChoice as string | undefined);
      if (gate) return gate;

      const defaultCt = authAndDefaultCt();
      const containerTypeId = (args.containerTypeId as string) || defaultCt;
      if (!containerTypeId) return err("no containerTypeId provided and none in provisioning state.");

      let userId = args.userId as string | undefined;
      let who = "";
      if (!userId) {
        let me: Awaited<ReturnType<typeof getSignedInUser>>;
        try {
          me = await getSignedInUser(azureCliTokenProvider);
        } catch (e) {
          return err(`could not resolve the signed-in user — pass userId explicitly. ${reason(e)}`);
        }
        // Guest (B2B) users cannot be container-type owners — the Graph API rejects
        // them. Detect it up front (from the /me `userType`) and return a clear,
        // actionable message instead of defaulting the grant to a guest and
        // surfacing a raw API error. NON-BLOCKING guidance: pass a member user's
        // `userId` to proceed. Guest sign-in itself remains fully supported.
        // (PR #3 review.)
        if (me.userType === "Guest") {
          return err(
            `the signed-in user ${me.userPrincipalName ?? me.id} is a guest (B2B) account, and guest ` +
              "users cannot be granted the container-type `owner` role. Re-run with `userId` set to a " +
              "**member** user of the target tenant.",
          );
        }
        userId = me.id;
        who = ` (signed-in user ${me.userPrincipalName ?? me.id})`;
      }

      const perm = await grantContainerTypeOwner(containerTypeId, userId);
      return {
        content: [{
          type: "text" as const,
          text:
            `## Owner granted\n\nUser \`${userId}\`${who} now has the **owner** role on container type ` +
            `\`${containerTypeId}\` (permission \`${perm.id ?? "?"}\`).\n\n` +
            "> This user can now create containers on this container type using a public client (PCA).",
        }],
      };
    } catch (e) {
      // The Graph API also rejects a guest owner when we defaulted to the signed-in
      // user and that account turns out to be a guest (its userType can be absent
      // from /me). Map that specific rejection to the same clear guidance — but ONLY
      // on the self-target path. For an EXPLICIT `userId`, an unrelated failure that
      // merely mentions "guest" must surface its raw reason, not misdirected guest
      // guidance. (PR #3 review.)
      if (targetIsSignedInUser && isGuestOwnerRejection(e)) {
        return err(
          "guest (B2B) users cannot be granted the container-type `owner` role. Grant it to a " +
            "**member** user of the target tenant (pass their `userId`).",
        );
      }
      return err(`granting owner: ${reason(e)}`);
    }
  },
};

export const listContainerTypeOwnersTool: McpTool = {
  name: "container_type_owners_list",
  annotations: { readOnly: true },
  description: "List the owner permissions on a SharePoint Embedded container type (Microsoft Graph beta).",
  inputSchema: {
    type: "object" as const,
    properties: {
      containerTypeId: { type: "string", description: "Container type id. Default: the provisioned container type." },
    },
  },
  handler: async (args) => {
    const defaultCt = authAndDefaultCt();
    const containerTypeId = (args.containerTypeId as string) || defaultCt;
    if (!containerTypeId) return err("no containerTypeId provided and none in provisioning state.");

    try {
      const perms = await listContainerTypePermissions(containerTypeId);
      if (perms.length === 0) {
        return { content: [{ type: "text" as const, text: `No owner permissions on container type \`${containerTypeId}\`.` }] };
      }
      const rows = perms
        .map((p) => `| \`${p.id ?? "?"}\` | ${p.roles?.join(", ") ?? ""} | ${p.grantedToV2?.user?.id ?? p.grantedToV2?.user?.userPrincipalName ?? "?"} |`)
        .join("\n");
      return {
        content: [{
          type: "text" as const,
          text: `## Owners of \`${containerTypeId}\`\n\n| Permission | Roles | User |\n|---|---|---|\n${rows}`,
        }],
      };
    } catch (e) {
      return err(`listing owners: ${reason(e)}`);
    }
  },
};

export const ownerDeleteContainerTypeTool: McpTool = {
  name: "container_type_owner_delete",
  annotations: { destructive: true, plane: "control" },
  description: "Remove an owner permission from a SharePoint Embedded container type (Microsoft Graph beta).",
  inputSchema: {
    type: "object" as const,
    properties: {
      containerTypeId: { type: "string", description: "Container type id. Default: the provisioned container type." },
      permissionId: { type: "string", description: "The permission id to remove (from container_type_owners_list)." },
      contextChoice: contextChoiceSchema,
    },
    required: ["permissionId"],
  },
  handler: async (args) => {
    try {
      // Restart confirmation gate (r-appgate) before mutating owners on a fresh
      // session. Inside the try so a stamp-write failure on `contextChoice=confirm`
      // (writeState / writeSecureFile) is classified by this tool's own error
      // handling below, like its other errors. (PR #3 review.)
      const gate = await resolveContextGate(args.contextChoice as string | undefined);
      if (gate) return gate;

      const defaultCt = authAndDefaultCt();
      const containerTypeId = (args.containerTypeId as string) || defaultCt;
      const permissionId = args.permissionId as string | undefined;
      if (!containerTypeId) return err("no containerTypeId provided and none in provisioning state.");
      if (!permissionId) return err("permissionId is required (see container_type_owners_list).");

      await revokeContainerTypePermission(containerTypeId, permissionId);
      return { content: [{ type: "text" as const, text: `Removed owner permission \`${permissionId}\` from container type \`${containerTypeId}\`.` }] };
    } catch (e) {
      return err(`revoking owner: ${reason(e)}`);
    }
  },
};
