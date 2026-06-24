// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Tool: container_create
 *
 * Creates a container in a registered container type and activates it.
 * Handles the registration-propagation delay (10–30s) with retry/backoff, and
 * activates the container since new containers start inactive (full-setup skill
 * 05.1, gotchas #5/#9).
 */

import { activateContainer, createContainer } from "../graph-client.js";
import {
  CONTAINER_CREATE_MAX_ATTEMPTS,
  containerCreateBackoffMs,
  isContainerPropagationError,
} from "../container-retry.js";
import { readState, writeState } from "../state.js";
import type { Container } from "../types.js";
import type { McpTool } from "../types.js";

interface CreateContainerArgs {
  displayName?: string;
  containerTypeId?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const createContainerTool: McpTool = {
  name: "container_create",
  description:
    "Create a container in a registered SharePoint Embedded container type and activate it. " +
    "Retries through the registration propagation delay automatically. Defaults the container " +
    "type ID from the current provisioning state when omitted.",
  inputSchema: {
    type: "object" as const,
    properties: {
      displayName: {
        type: "string",
        description: "Display name for the container (e.g., 'Project Files'). Default: 'My First Container'.",
      },
      containerTypeId: {
        type: "string",
        description: "Container type ID. Defaults to the most recently created/registered one.",
      },
    },
  },
  handler: async (args) => {
    const state = readState();
    const { displayName = "My First Container", containerTypeId = state.containerTypeId } =
      args as CreateContainerArgs;

    if (!containerTypeId) {
      return {
        content: [{ type: "text" as const, text: "Error: containerTypeId is required (none in state). Create and register a container type first." }],
        isError: true,
      };
    }

    let container: Container | undefined;
    let lastError = "";
    for (let attempt = 1; attempt <= CONTAINER_CREATE_MAX_ATTEMPTS; attempt++) {
      try {
        container = await createContainer(containerTypeId, displayName);
        break;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        // Only retry genuine registration-propagation delays. Permanent errors
        // (invalid/unregistered container type → 404, unauthorized → 403) fail
        // fast instead of hanging through ~150s of backoff.
        if (attempt < CONTAINER_CREATE_MAX_ATTEMPTS && isContainerPropagationError(lastError)) {
          await sleep(containerCreateBackoffMs(attempt)); // 15s, 30s, 45s, 60s
          continue;
        }
        return {
          content: [{ type: "text" as const, text: `Error creating container after ${attempt} attempt(s): ${lastError}` }],
          isError: true,
        };
      }
    }

    if (!container) {
      return {
        content: [{ type: "text" as const, text: `Error: container creation failed. ${lastError}` }],
        isError: true,
      };
    }

    // Activate if needed (new containers start inactive).
    let activated = container.status === "active";
    if (!activated) {
      try {
        await activateContainer(container.id);
        activated = true;
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (/already active|activated/i.test(msg)) {
          activated = true;
        }
      }
    }

    writeState({ containerId: container.id, containerName: displayName });

    const output =
      "## Container Created\n\n" +
      "| Property | Value |\n|----------|-------|\n" +
      `| **Container ID** | \`${container.id}\` |\n` +
      `| **Name** | ${displayName} |\n` +
      `| **Container Type** | \`${containerTypeId}\` |\n` +
      `| **Status** | ${activated ? "✅ active" : "⏳ activating"} |\n`;

    return { content: [{ type: "text" as const, text: output }] };
  },
};
