// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Tools: container_type_registration_get / container_type_registration_list /
 * container_type_registration_delete
 *
 * CRUDL on the container type **registration RECORD** itself (the tenant↔
 * containerType binding) via Microsoft Graph v1.0 — distinct from the per-app
 * `applicationPermissionGrants` managed by the `container_type_app_grant_*`
 * tools, and from `container_type_register` (Create).
 *
 * Why delete matters: a container type can only be deleted once it has NO
 * registrations, and a registration can only be deleted once it has NO
 * containers AND NO deleted (recycle-bin) containers. Removing an app *grant* is
 * NOT the same as deleting the registration — this is the operation that
 * actually unblocks `container_type_delete`.
 */

import { setAuthConfig } from "../auth.js";
import { AppError } from "../errors.js";
import {
  deleteContainerTypeRegistration,
  getContainerTypeRegistration,
  listContainers,
  listContainerTypeRegistrations,
  listDeletedContainers,
} from "../graph-client.js";
import { readState } from "../state.js";
import type { McpTool } from "../types.js";

/** Point MSAL at the owning app and return the provisioned container-type id
 *  (== registration id) as the default. */
function authState(): { containerTypeId?: string; appId?: string } {
  const state = readState();
  if (state.appId && state.tenantId) {
    setAuthConfig({ clientId: state.appId, tenantId: state.tenantId });
  }
  return { containerTypeId: state.containerTypeId, appId: state.appId };
}

function err(text: string) {
  return { content: [{ type: "text" as const, text: `Error: ${text}` }], isError: true };
}
function reason(e: unknown): string {
  if (e instanceof AppError) return e.safeMessage ?? e.message;
  return e instanceof Error ? e.message : String(e);
}

export const getContainerTypeRegistrationTool: McpTool = {
  name: "container_type_registration_get",
  annotations: { readOnly: true },
  description:
    "Read a SharePoint Embedded container type registration record (the tenant↔container-type binding) " +
    "via Microsoft Graph v1.0. Use this to inspect a registration's status and owning app when diagnosing " +
    "why a container type can't be deleted. Defaults the registration id to the provisioned container type.",
  inputSchema: {
    type: "object" as const,
    properties: {
      containerTypeId: {
        type: "string",
        description: "Container type registration id. Default: the provisioned container type.",
      },
    },
  },
  handler: async (args) => {
    const state = authState();
    const containerTypeId = (args.containerTypeId as string) || state.containerTypeId;
    if (!containerTypeId) return err("no containerTypeId provided and none in provisioning state.");

    try {
      const reg = await getContainerTypeRegistration(containerTypeId);
      const grants = reg.applicationPermissionGrants ?? [];
      return {
        content: [{
          type: "text" as const,
          text:
            `## Container Type Registration\n\n` +
            "| Property | Value |\n|----------|-------|\n" +
            `| **Registration / container type id** | \`${reg.id ?? reg.containerTypeId ?? containerTypeId}\` |\n` +
            `| **Registered by app** | ${reg.registeredByAppId ? `\`${reg.registeredByAppId}\`` : "—"} |\n` +
            `| **Registered** | ${reg.registeredDateTime ?? "—"} |\n` +
            `| **App permission grants** | ${grants.length} |\n`,
        }],
      };
    } catch (e) {
      return err(`reading container type registration: ${reason(e)}`);
    }
  },
};

export const listContainerTypeRegistrationsTool: McpTool = {
  name: "container_type_registration_list",
  annotations: { readOnly: true },
  description:
    "List the SharePoint Embedded container type registrations on the tenant (Microsoft Graph v1.0) — the " +
    "container types registered for use in this tenant and the apps that registered them. Use this to find " +
    "registrations that must be deleted before their container types can be removed.",
  inputSchema: {
    type: "object" as const,
    properties: {},
  },
  handler: async () => {
    authState();
    try {
      const regs = await listContainerTypeRegistrations();
      if (regs.length === 0) {
        return { content: [{ type: "text" as const, text: "No container type registrations found on this tenant." }] };
      }
      const rows = regs
        .map(
          (r) =>
            `| \`${r.id ?? r.containerTypeId ?? "?"}\` | ${r.registeredByAppId ? `\`${r.registeredByAppId}\`` : "—"} | ${r.registeredDateTime ?? "—"} |`,
        )
        .join("\n");
      return {
        content: [{
          type: "text" as const,
          text: `## Container Type Registrations (${regs.length})\n\n| Registration id | Registered by app | Registered |\n|---|---|---|\n${rows}`,
        }],
      };
    } catch (e) {
      return err(`listing container type registrations: ${reason(e)}`);
    }
  },
};

export const deleteContainerTypeRegistrationTool: McpTool = {
  name: "container_type_registration_delete",
  annotations: { destructive: true, plane: "control" },
  description:
    "Delete a SharePoint Embedded container type REGISTRATION record (Microsoft Graph v1.0), unregistering the " +
    "container type from the tenant. This is REQUIRED before a container type can be deleted, and is NOT the same " +
    "as removing an app's permission grant. A registration can only be deleted once it has NO live containers AND " +
    "NO deleted (recycle-bin) containers — this tool checks both first and tells you exactly what is blocking. " +
    "Destructive: requires confirm=true.",
  inputSchema: {
    type: "object" as const,
    properties: {
      containerTypeId: {
        type: "string",
        description: "Container type registration id to delete. Default: the provisioned container type.",
      },
      confirm: {
        type: "boolean",
        description: "Must be true to actually delete the registration.",
      },
    },
  },
  handler: async (args) => {
    const state = authState();
    const containerTypeId = (args.containerTypeId as string) || state.containerTypeId;
    if (!containerTypeId) return err("no containerTypeId provided and none in provisioning state.");

    // Surface blockers up front (live + recycle-bin containers) so the agent gets
    // an actionable list instead of a raw 409 from the DELETE.
    let liveCount: number | undefined;
    let deletedCount: number | undefined;
    try {
      liveCount = (await listContainers(containerTypeId)).length;
    } catch { /* non-fatal: fall through to the DELETE, which will 409 if blocked */ }
    try {
      deletedCount = (await listDeletedContainers(containerTypeId)).length;
    } catch { /* deletedContainers may be unavailable in some clouds; non-fatal */ }

    if (args.confirm !== true) {
      const blockers: string[] = [];
      if (liveCount) blockers.push(`${liveCount} live container(s)`);
      if (deletedCount) blockers.push(`${deletedCount} recycle-bin container(s)`);
      const blockNote =
        blockers.length > 0
          ? `\n\n> ⚠️ **Blocked:** this registration still has ${blockers.join(" and ")}. Permanently ` +
            "delete them first (container_delete → soft-delete, then permanent-delete; list the recycle bin " +
            "with container_deleted_list) — the registration delete will fail until both are empty."
          : "";
      return {
        content: [{
          type: "text" as const,
          text:
            `### Confirm delete registration\n\nThis will unregister container type \`${containerTypeId}\` ` +
            `from the tenant. Re-run with \`confirm=true\` to proceed.${blockNote}`,
        }],
      };
    }

    // Pre-flight block: if we KNOW there are containers, fail fast with guidance
    // rather than emitting a raw 409.
    if (liveCount || deletedCount) {
      const blockers: string[] = [];
      if (liveCount) blockers.push(`${liveCount} live container(s)`);
      if (deletedCount) blockers.push(`${deletedCount} recycle-bin container(s)`);
      return err(
        `cannot delete registration \`${containerTypeId}\`: it still has ${blockers.join(" and ")}. ` +
          "Permanently delete all containers (soft-delete then permanent-delete; use container_deleted_list " +
          "to find recycle-bin containers) before deleting the registration.",
      );
    }

    try {
      await deleteContainerTypeRegistration(containerTypeId);
      return {
        content: [{
          type: "text" as const,
          text:
            `Deleted container type registration \`${containerTypeId}\`. The container type can now be deleted ` +
            "with container_type_delete (trial container types only).",
        }],
      };
    } catch (e) {
      // NOT_FOUND → treat as already-unregistered (idempotent teardown).
      if (e instanceof AppError && e.code === "NOT_FOUND") {
        return {
          content: [{
            type: "text" as const,
            text: `Container type registration \`${containerTypeId}\` was already deleted (not found).`,
          }],
        };
      }
      if (e instanceof AppError && e.code === "CONFLICT") {
        return err(
          `cannot delete registration \`${containerTypeId}\` yet: it still has containers or recycle-bin ` +
            "containers. Permanently delete them first (use container_deleted_list to find recycle-bin " +
            "containers), then retry.",
        );
      }
      return err(`deleting container type registration: ${reason(e)}`);
    }
  },
};
