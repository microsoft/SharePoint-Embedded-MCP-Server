// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Tool: container_update
 *
 * Update (rename / edit) a SharePoint Embedded container's editable properties
 * (displayName, description) via Microsoft Graph: PATCH
 * /storage/fileStorage/containers/{id}. Completes container CRUDL (the Update
 * verb) alongside container_create / container_get / container_list /
 * container_delete.
 */

import { setAuthConfig } from "../auth.js";
import { updateContainer } from "../graph-client.js";
import { ok, fail } from "../responses.js";
import { clientSafeMessage } from "../errors.js";
import { readState, writeState } from "../state.js";
import type { McpTool } from "../types.js";

export const updateContainerTool: McpTool = {
  name: "container_update",
  annotations: { plane: "control", idempotent: true },
  description:
    "Update (rename or edit the description of) a SharePoint Embedded container. " +
    "Use this to change a container's display name or description after creation. " +
    "Provide containerId and at least one of displayName / description; defaults the container to the " +
    "most recently provisioned one.",
  inputSchema: {
    type: "object" as const,
    properties: {
      containerId: {
        type: "string",
        description: "The container ID to update. Defaults to the most recently created container.",
      },
      displayName: { type: "string", description: "New display name for the container." },
      description: { type: "string", description: "New description for the container." },
    },
  },
  handler: async (args) => {
    const state = readState();
    if (state.appId && state.tenantId) {
      setAuthConfig({ clientId: state.appId, tenantId: state.tenantId });
    }

    const containerId = (args.containerId as string) || state.containerId;
    if (!containerId) {
      return fail("INVALID_ARGS", "containerId is required (none in provisioning state).");
    }

    const displayName = typeof args.displayName === "string" ? args.displayName : undefined;
    const description = typeof args.description === "string" ? args.description : undefined;
    if (displayName === undefined && description === undefined) {
      return fail(
        "INVALID_ARGS",
        "nothing to update: provide displayName and/or description.",
        "Pass at least one editable field.",
      );
    }

    try {
      const updated = await updateContainer(containerId, { displayName, description });

      // Keep persisted container name in sync when the provisioned container is
      // renamed, so status_get reflects it.
      if (displayName !== undefined && containerId === state.containerId) {
        writeState({ containerName: displayName });
      }

      const output =
        "## Container Updated\n\n" +
        "| Property | Value |\n|----------|-------|\n" +
        `| **Container ID** | \`${containerId}\` |\n` +
        `| **Display name** | ${updated.displayName ?? displayName ?? "—"} |\n` +
        (description !== undefined ? `| **Description** | ${updated.description ?? description} |\n` : "");
      return ok({ container: updated, containerId }, output);
    } catch (e) {
      return fail("UPSTREAM", `updating container: ${clientSafeMessage(e)}`);
    }
  },
};
