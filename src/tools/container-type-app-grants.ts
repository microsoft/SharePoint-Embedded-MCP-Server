// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Tools: container_type_app_grant_add / container_type_app_grants_list /
 * container_type_app_grant_remove
 *
 * Manage the `applicationPermissionGrants` collection on a SharePoint Embedded
 * container type registration via Microsoft Graph **v1.0**. Each grant authorizes
 * one consuming app (by appId) to act on the container type with a set of
 * delegated/application permissions.
 *
 * Relationship to `container_type_register`: registration replaces the WHOLE
 * grants collection for the owning app; these tools add / list / remove a SINGLE
 * app's grant without disturbing the others — the supported way to authorize
 * ADDITIONAL apps on an existing container type registration.
 *
 * (Distinct from `container_type_grant_owner`, which manages the beta-only
 * `owner` role on the container type itself for public-client container creation.)
 */

import {
  grantContainerTypeAppPermission,
  listContainerTypeAppPermissions,
  revokeContainerTypeAppPermission,
} from "../graph-client.js";
import type { McpTool } from "../types.js";
import { authContainerTypeState, err, reason } from "./container-type-shared.js";

/** Coerce a string | string[] arg into a clean string[]; undefined → fallback. */
function toPermissions(value: unknown, fallback: string[]): string[] {
  if (Array.isArray(value)) {
    const cleaned = value.map((v) => String(v).trim()).filter((v) => v !== "");
    return cleaned.length > 0 ? cleaned : fallback;
  }
  if (typeof value === "string" && value.trim() !== "") {
    return value
      .split(",")
      .map((v) => v.trim())
      .filter((v) => v !== "");
  }
  return fallback;
}

export const addContainerTypeAppGrantTool: McpTool = {
  name: "container_type_app_grant_add",
  annotations: { plane: "control" },
  description:
    "Add or update an application permission grant on a SharePoint Embedded container type registration " +
    "(Microsoft Graph v1.0). Authorizes one consuming app (by appId) to act on the container type with the " +
    "given delegated/application permissions. Idempotent upsert — re-running for the same appId overwrites its " +
    "permissions. Defaults the container type to the provisioned one and the appId to the provisioned owning app; " +
    "permissions default to `full`. Use this to authorize additional apps without overwriting existing grants " +
    "(unlike container_type_register, which replaces the whole collection).",
  inputSchema: {
    type: "object" as const,
    properties: {
      containerTypeId: { type: "string", description: "Container type registration id. Default: the provisioned container type." },
      appId: { type: "string", description: "Client (app) id to grant. Default: the provisioned owning app." },
      delegatedPermissions: {
        type: "array",
        items: { type: "string" },
        description:
          "Permissions for delegated (user) tokens, e.g. [\"readContent\",\"writeContent\"] or [\"full\"]. Default: [\"full\"].",
      },
      applicationPermissions: {
        type: "array",
        items: { type: "string" },
        description: "Permissions for application (app-only) tokens, e.g. [\"full\"] or [\"none\"]. Default: [\"full\"].",
      },
    },
  },
  handler: async (args) => {
    const state = authContainerTypeState();
    const containerTypeId = (args.containerTypeId as string) || state.containerTypeId;
    const appId = (args.appId as string) || state.appId;
    if (!containerTypeId) return err("no containerTypeId provided and none in provisioning state.");
    if (!appId) return err("no appId provided and no owning app in provisioning state. Run project_app_create first or pass appId.");

    const delegated = toPermissions(args.delegatedPermissions, ["full"]);
    const application = toPermissions(args.applicationPermissions, ["full"]);

    try {
      const grant = await grantContainerTypeAppPermission(containerTypeId, appId, delegated, application);
      const del = grant.delegatedPermissions ?? delegated;
      const app = grant.applicationPermissions ?? application;
      return {
        content: [{
          type: "text" as const,
          text:
            `## App permission grant added\n\nApp \`${appId}\` is now authorized on container type registration ` +
            `\`${containerTypeId}\`.\n\n| Scope | Permissions |\n|---|---|\n` +
            `| delegated | ${del.join(", ")} |\n| application | ${app.join(", ")} |`,
        }],
      };
    } catch (e) {
      return err(`granting app permission: ${reason(e)}`);
    }
  },
};

export const listContainerTypeAppGrantsTool: McpTool = {
  name: "container_type_app_grants_list",
  annotations: { readOnly: true },
  description:
    "List the application permission grants on a SharePoint Embedded container type registration " +
    "(Microsoft Graph v1.0) — the apps authorized on the container type and their delegated/application permissions.",
  inputSchema: {
    type: "object" as const,
    properties: {
      containerTypeId: { type: "string", description: "Container type registration id. Default: the provisioned container type." },
    },
  },
  handler: async (args) => {
    const state = authContainerTypeState();
    const containerTypeId = (args.containerTypeId as string) || state.containerTypeId;
    if (!containerTypeId) return err("no containerTypeId provided and none in provisioning state.");

    try {
      const grants = await listContainerTypeAppPermissions(containerTypeId);
      if (grants.length === 0) {
        return { content: [{ type: "text" as const, text: `No application permission grants on container type registration \`${containerTypeId}\`.` }] };
      }
      const rows = grants
        .map((g) => `| \`${g.appId ?? "?"}\` | ${g.delegatedPermissions?.join(", ") ?? ""} | ${g.applicationPermissions?.join(", ") ?? ""} |`)
        .join("\n");
      return {
        content: [{
          type: "text" as const,
          text: `## App permission grants on \`${containerTypeId}\`\n\n| App | Delegated | Application |\n|---|---|---|\n${rows}`,
        }],
      };
    } catch (e) {
      return err(`listing app permission grants: ${reason(e)}`);
    }
  },
};

export const removeContainerTypeAppGrantTool: McpTool = {
  name: "container_type_app_grant_remove",
  annotations: { destructive: true, plane: "control" },
  description:
    "Remove an application permission grant from a SharePoint Embedded container type registration " +
    "(Microsoft Graph v1.0), revoking that app's access to the container type. Removing the owning app's grant " +
    "breaks container operations — pass the appId explicitly.",
  inputSchema: {
    type: "object" as const,
    properties: {
      containerTypeId: { type: "string", description: "Container type registration id. Default: the provisioned container type." },
      appId: { type: "string", description: "Client (app) id whose grant to remove (see container_type_app_grants_list)." },
    },
    required: ["appId"],
  },
  handler: async (args) => {
    const state = authContainerTypeState();
    const containerTypeId = (args.containerTypeId as string) || state.containerTypeId;
    const appId = args.appId as string | undefined;
    if (!containerTypeId) return err("no containerTypeId provided and none in provisioning state.");
    if (!appId) return err("appId is required (see container_type_app_grants_list).");

    try {
      await revokeContainerTypeAppPermission(containerTypeId, appId);
      return { content: [{ type: "text" as const, text: `Removed app \`${appId}\`'s permission grant from container type registration \`${containerTypeId}\`.` }] };
    } catch (e) {
      return err(`removing app permission grant: ${reason(e)}`);
    }
  },
};
