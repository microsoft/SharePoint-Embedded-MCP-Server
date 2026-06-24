// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Tools: container_type_grant_owner / container_type_owners_list /
 * container_type_revoke_owner
 *
 * Manage the `permissions` (owner) collection on a fileStorageContainerType via
 * Microsoft Graph **beta**. Granting a USER the `owner` role lets that user
 * create containers using a public client (PCA) — the v1.0 container endpoint
 * rejects container creation by public clients ("Container creation by a public
 * client is not allowed"). Only the `owner` role and a user identity are
 * supported; max 3 owners per container type.
 */

import { bootstrapTokenProvider } from "../bootstrap.js";
import { setAuthConfig } from "../auth.js";
import {
  getSignedInUser,
  grantContainerTypeOwner,
  listContainerTypePermissions,
  revokeContainerTypePermission,
} from "../graph-client.js";
import { readState } from "../state.js";
import type { McpTool } from "../types.js";

/** Point MSAL at the owning app (so SPE calls use its token) and return the
 *  provisioned container-type id as the default. */
function authAndDefaultCt(): string | undefined {
  const state = readState();
  if (state.appId && state.tenantId) {
    setAuthConfig({ clientId: state.appId, tenantId: state.tenantId });
  }
  return state.containerTypeId;
}

function err(text: string) {
  return { content: [{ type: "text" as const, text: `Error: ${text}` }], isError: true };
}
function reason(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export const grantContainerTypeOwnerTool: McpTool = {
  name: "container_type_grant_owner",
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
    },
  },
  handler: async (args) => {
    const defaultCt = authAndDefaultCt();
    const containerTypeId = (args.containerTypeId as string) || defaultCt;
    if (!containerTypeId) return err("no containerTypeId provided and none in provisioning state.");

    let userId = args.userId as string | undefined;
    let who = "";
    if (!userId) {
      try {
        const me = await getSignedInUser(bootstrapTokenProvider);
        userId = me.id;
        who = ` (signed-in user ${me.userPrincipalName ?? me.id})`;
      } catch (e) {
        return err(`could not resolve the signed-in user — pass userId explicitly. ${reason(e)}`);
      }
    }

    try {
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
      return err(`granting owner: ${reason(e)}`);
    }
  },
};

export const listContainerTypeOwnersTool: McpTool = {
  name: "container_type_owners_list",
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

export const revokeContainerTypeOwnerTool: McpTool = {
  name: "container_type_revoke_owner",
  description: "Remove an owner permission from a SharePoint Embedded container type (Microsoft Graph beta).",
  inputSchema: {
    type: "object" as const,
    properties: {
      containerTypeId: { type: "string", description: "Container type id. Default: the provisioned container type." },
      permissionId: { type: "string", description: "The permission id to remove (from container_type_owners_list)." },
    },
    required: ["permissionId"],
  },
  handler: async (args) => {
    const defaultCt = authAndDefaultCt();
    const containerTypeId = (args.containerTypeId as string) || defaultCt;
    const permissionId = args.permissionId as string | undefined;
    if (!containerTypeId) return err("no containerTypeId provided and none in provisioning state.");
    if (!permissionId) return err("permissionId is required (see container_type_owners_list).");

    try {
      await revokeContainerTypePermission(containerTypeId, permissionId);
      return { content: [{ type: "text" as const, text: `Removed owner permission \`${permissionId}\` from container type \`${containerTypeId}\`.` }] };
    } catch (e) {
      return err(`revoking owner: ${reason(e)}`);
    }
  },
};
