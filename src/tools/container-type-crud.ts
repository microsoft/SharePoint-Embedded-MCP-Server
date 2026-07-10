// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Tools: container_type_get / container_type_update / container_type_delete
 *
 * Read / Update / Delete operations on SharePoint Embedded container types via
 * Microsoft Graph **beta** (Create + List already exist as container_type_create
 * / container_type_list). Delete reuses the trial-only deletion policy: standard
 * and direct-to-customer container types are PROTECTED unless deleteStandard=true.
 */

import { setAuthConfig } from "../auth.js";
import { AppError } from "../errors.js";
import {
  deleteContainerType,
  getContainerType,
  listContainerTypes,
  updateContainerType,
} from "../graph-client.js";
import { readState } from "../state.js";
import type { McpTool } from "../types.js";

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

export const getContainerTypeTool: McpTool = {
  name: "container_type_get",
  annotations: { readOnly: true },
  description: "Get a SharePoint Embedded container type by id (Microsoft Graph beta).",
  inputSchema: {
    type: "object" as const,
    properties: {
      containerTypeId: { type: "string", description: "Container type id. Default: the provisioned container type." },
    },
  },
  handler: async (args) => {
    const defaultCt = authAndDefaultCt();
    const id = (args.containerTypeId as string) || defaultCt;
    if (!id) return err("no containerTypeId provided and none in provisioning state.");
    try {
      const ct = await getContainerType(id);
      return {
        content: [{
          type: "text" as const,
          text:
            "## Container Type\n\n| Property | Value |\n|---|---|\n" +
            `| Id | \`${ct.containerTypeId}\` |\n` +
            `| Name | ${ct.displayName} |\n` +
            `| Owning app | \`${ct.owningAppId}\` |\n` +
            `| Billing | ${ct.billingClassification ?? "?"} |\n` +
            `| Created | ${ct.createdDateTime ?? "?"} |\n` +
            `| Expires | ${ct.expirationDateTime ?? "—"} |`,
        }],
      };
    } catch (e) {
      return err(`getting container type: ${reason(e)}`);
    }
  },
};

export const updateContainerTypeTool: McpTool = {
  name: "container_type_update",
  annotations: { plane: "control" },
  description: "Update a SharePoint Embedded container type's mutable properties, e.g. displayName (Microsoft Graph beta).",
  inputSchema: {
    type: "object" as const,
    properties: {
      containerTypeId: { type: "string", description: "Container type id. Default: the provisioned container type." },
      displayName: { type: "string", description: "New display name for the container type." },
    },
  },
  handler: async (args) => {
    const defaultCt = authAndDefaultCt();
    const id = (args.containerTypeId as string) || defaultCt;
    if (!id) return err("no containerTypeId provided and none in provisioning state.");
    const update: Record<string, unknown> = {};
    if (typeof args.displayName === "string" && args.displayName.trim() !== "") {
      // The beta Update fileStorageContainerType API accepts the display name as
      // `name` (NOT `displayName`, which it rejects with HTTP 400 — it accepts
      // only name/settings/etag).
      update.name = args.displayName;
    }
    if (Object.keys(update).length === 0) return err("nothing to update — provide displayName.");
    try {
      await updateContainerType(id, update);
      return { content: [{ type: "text" as const, text: `Updated container type \`${id}\` (now "${args.displayName}").` }] };
    } catch (e) {
      return err(`updating container type: ${reason(e)}`);
    }
  },
};

export const deleteContainerTypeTool: McpTool = {
  name: "container_type_delete",
  annotations: { destructive: true, plane: "control" },
  description:
    "Delete a SharePoint Embedded container type (Microsoft Graph beta). Trial-only by default: standard / " +
    "direct-to-customer container types are billed production resources and are PROTECTED unless you pass " +
    "deleteStandard=true. Requires confirm=true.",
  inputSchema: {
    type: "object" as const,
    properties: {
      containerTypeId: { type: "string", description: "Container type id. Default: the provisioned container type." },
      confirm: { type: "boolean", description: "Must be true to actually delete." },
      deleteStandard: { type: "boolean", description: "Override to delete a STANDARD / direct-to-customer container type. Strongly discouraged." },
    },
  },
  handler: async (args) => {
    const defaultCt = authAndDefaultCt();
    const id = (args.containerTypeId as string) || defaultCt;
    if (!id) return err("no containerTypeId provided and none in provisioning state.");

    // Resolve the container type's billing classification up front (used by both
    // the preview and the protection gate). Only a TRIAL container type is safe
    // to auto-delete; unknown is treated as protected (fail safe).
    let classification: string | undefined;
    try {
      const cts = await listContainerTypes();
      classification = cts.find((c) => c.containerTypeId === id)?.billingClassification;
    } catch {
      /* leave undefined → protected */
    }
    const isTrial = classification === "trial";

    if (args.confirm !== true) {
      const protectedNote = isTrial
        ? "Re-run with `confirm=true`."
        : `> ⚠️ **Protected:** this container type is **${classification ?? "unknown"}** (not trial) — a billed ` +
          "production resource. Re-run with `confirm=true` **and** `deleteStandard=true` (strongly discouraged).";
      return {
        content: [{
          type: "text" as const,
          text: `### Confirm delete\n\nThis will delete container type \`${id}\`.\n\n${protectedNote}`,
        }],
      };
    }

    if (!isTrial && args.deleteStandard !== true) {
      return err(
        `container type \`${id}\` is **${classification ?? "unknown"}** (not trial). Standard / ` +
          "direct-to-customer container types are billed, production resources and are protected. Pass " +
          "deleteStandard=true to override (strongly discouraged).",
      );
    }

    try {
      await deleteContainerType(id);
      return {
        content: [{
          type: "text" as const,
          text: `Deleted container type \`${id}\`${isTrial ? " (trial)" : ` (**${classification}** — override)`}.`,
        }],
      };
    } catch (e) {
      // The most common failure is a 409 because the container type still has a
      // registration. Removing app *grants* does NOT clear this — the
      // registration RECORD must be deleted. Point the caller at the right tool.
      if (e instanceof AppError && e.code === "CONFLICT") {
        return err(
          `cannot delete container type \`${id}\`: it still has an active registration. ` +
            "Delete the registration first with `container_type_registration_delete` (a registration can only " +
            "be deleted once its live and recycle-bin containers are permanently removed — use " +
            "`container_deleted_list` to find recycle-bin containers). Removing an app permission *grant* is not " +
            "sufficient. Then retry container_type_delete.",
        );
      }
      return err(`deleting container type: ${reason(e)}`);
    }
  },
};
