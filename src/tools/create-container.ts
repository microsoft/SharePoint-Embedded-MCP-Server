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
import { defineTool, z } from "../tooling/define-tool.js";
import { fail, ok } from "../responses.js";
import { clientSafeMessage } from "../errors.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const createContainerSchema = z.object({
  displayName: z.string().optional().describe("Display name for the container (e.g., 'Project Files'). Default: 'My First Container'."),
  containerTypeId: z.string().optional().describe("Container type ID. Defaults to the most recently created/registered one."),
});

export const createContainerTool = defineTool({
  name: "container_create",
  description:
    "Create a container in a registered SharePoint Embedded container type and activate it. " +
    "Retries through the registration propagation delay automatically. Defaults the container " +
    "type ID from the current provisioning state when omitted.",
  annotations: {
    idempotent: false,
    plane: "control",
  },
  schema: createContainerSchema,
  handler: async (args) => {
    const state = readState();
    const { displayName = "My First Container", containerTypeId = state.containerTypeId } =
      args;

    if (!containerTypeId) {
      return fail("INVALID_ARGS", "containerTypeId is required (none in state). Create and register a container type first.");
    }

    let container: Container | undefined;
    let lastError = "";
    let lastSafeError = "";
    for (let attempt = 1; attempt <= CONTAINER_CREATE_MAX_ATTEMPTS; attempt++) {
      try {
        container = await createContainer(containerTypeId, displayName);
        break;
      } catch (error) {
        // Keep the raw message for propagation-pattern detection; surface only
        // the sanitized message to the client (SEC-002).
        lastError = error instanceof Error ? error.message : String(error);
        lastSafeError = clientSafeMessage(error);
        // Only retry genuine registration-propagation delays. Permanent errors
        // (invalid/unregistered container type → 404, unauthorized → 403) fail
        // fast instead of hanging through ~150s of backoff.
        if (attempt < CONTAINER_CREATE_MAX_ATTEMPTS && isContainerPropagationError(lastError)) {
          await sleep(containerCreateBackoffMs(attempt)); // 15s, 30s, 45s, 60s
          continue;
        }
        return fail("UPSTREAM", `creating container after ${attempt} attempt(s): ${lastSafeError}`);
      }
    }

    if (!container) {
      return fail("UPSTREAM", `container creation failed. ${lastSafeError}`);
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

    return ok({ container, containerTypeId, displayName, activated }, output);
  },
});
