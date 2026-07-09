// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Tool: container_type_register
 *
 * Registers a container type on the local tenant with the owning app's
 * application permission grants. This MUST run before containers can be created
 * — without `applicationPermissionGrants` the platform rejects container
 * creation with UnauthorizedAccessException (full-setup skill 04.2, gotchas #3).
 *
 * Idempotent: the PUT registration endpoint is safe to call repeatedly.
 */

import { registerContainerType } from "../graph-client.js";
import { readState, writeState } from "../state.js";
import { resolveContextGate } from "./context-gate.js";
import type { McpTool } from "../types.js";

interface RegisterArgs {
  containerTypeId?: string;
  appId?: string;
  contextChoice?: "confirm" | "switch";
}

export const registerContainerTypeTool: McpTool = {
  name: "container_type_register",
  annotations: { plane: "control" },
  description:
    "Register a SharePoint Embedded container type on the local tenant with the owning app's " +
    "permission grants. Required before any containers can be created. Defaults the container " +
    "type ID and owning app ID from the current provisioning state when omitted.",
  inputSchema: {
    type: "object" as const,
    properties: {
      containerTypeId: {
        type: "string",
        description: "The container type ID to register. Defaults to the most recently created one.",
      },
      appId: {
        type: "string",
        description: "The owning app (client) ID to grant. Defaults to the provisioned owning app.",
      },
      contextChoice: {
        type: "string",
        enum: ["confirm", "switch"],
        description:
          "On a freshly restarted session, confirm the remembered owning app / container type " +
          "('confirm') or switch to a different one ('switch'). Supplied in response to the " +
          "confirmation prompt; omit on the first call.",
      },
    },
  },
  handler: async (args) => {
    // Restart confirmation gate (r-appgate): confirm the remembered owning app /
    // container type before mutating tenant registration on a fresh session.
    const gate = await resolveContextGate((args as RegisterArgs).contextChoice);
    if (gate) return gate;

    const state = readState();
    const { containerTypeId = state.containerTypeId, appId = state.appId } = args as RegisterArgs;

    if (!containerTypeId) {
      return {
        content: [{ type: "text" as const, text: "Error: containerTypeId is required (none in state)." }],
        isError: true,
      };
    }
    if (!appId) {
      return {
        content: [{ type: "text" as const, text: "Error: appId is required (no owning app in state). Run project_app_create first." }],
        isError: true,
      };
    }

    try {
      await registerContainerType(containerTypeId, appId);
      writeState({ containerTypeId });

      const output =
        "## Container Type Registered\n\n" +
        "| Property | Value |\n|----------|-------|\n" +
        `| **Container Type ID** | \`${containerTypeId}\` |\n` +
        `| **Owning App** | \`${appId}\` |\n` +
        `| **Permissions** | delegated: full · application: none (opt-in) |\n\n` +
        "> Registration can take 10–30s to propagate. Container creation retries automatically.";

      return { content: [{ type: "text" as const, text: output }] };
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      return {
        content: [{ type: "text" as const, text: `Error registering container type: ${msg}` }],
        isError: true,
      };
    }
  },
};
