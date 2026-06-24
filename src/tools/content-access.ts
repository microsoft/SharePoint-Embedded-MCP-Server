// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Tools: content_access_grant, content_access_revoke
 *
 * Content-plane access (reading/managing files inside the dev's containers) is
 * OFF by default. These tools implement the PRD's opt-in, separately-consented,
 * revocable content access:
 *   - grant: confirm intent (agent-guided elicitation), then mark content
 *     access enabled in state. The next content operation triggers a one-time
 *     sign-in for the content scopes.
 *   - revoke: clear the content-access flag; control-plane work is unaffected.
 *
 * Content tools (upload/search/preview/sharing/seed) check this flag.
 */

import { readState, writeState } from "../state.js";
import type { McpTool, McpToolResult } from "../types.js";

export const grantContentAccessTool: McpTool = {
  name: "content_access_grant",
  description:
    "Grant the SPE Builder access to read and manage files inside your containers (content plane). " +
    "This is off by default and separate from provisioning. Pass confirm=true to enable; the next " +
    "content operation will prompt a one-time sign-in for content scopes. Revoke any time with " +
    "content_access_revoke.",
  inputSchema: {
    type: "object" as const,
    properties: {
      confirm: {
        type: "boolean",
        description: "Set true to confirm you want to enable content (file) access.",
      },
    },
  },
  handler: async (args) => {
    const confirm = args.confirm === true;
    if (!confirm) {
      return {
        content: [{
          type: "text" as const,
          text:
            "### Enable content access?\n\n" +
            "This lets the SPE Builder **read and manage files** inside your containers — separate " +
            "from creating/provisioning resources.\n\n" +
            "> To proceed, re-run `content_access_grant` with `confirm=true`. You can revoke it " +
            "any time with `content_access_revoke`.",
        }],
      };
    }

    writeState({ contentAccessGranted: true });
    return {
      content: [{
        type: "text" as const,
        text:
          "## Content Access Granted\n\n" +
          "File read/manage operations are now enabled. The next content operation will prompt a " +
          "one-time sign-in for the content scopes.\n\n" +
          "> Revoke any time with `content_access_revoke`.",
      }],
    };
  },
};

export const revokeContentAccessTool: McpTool = {
  name: "content_access_revoke",
  description:
    "Revoke the SPE Builder's content-plane (file read/manage) access. Control-plane provisioning " +
    "is unaffected.",
  inputSchema: { type: "object" as const, properties: {} },
  handler: async () => {
    writeState({ contentAccessGranted: false });
    return {
      content: [{
        type: "text" as const,
        text: "## Content Access Revoked\n\nFile read/manage access is disabled. Provisioning still works normally.",
      }],
    };
  },
};

/** Whether content-plane access has been granted (checked by content tools). */
export function isContentAccessGranted(): boolean {
  return readState().contentAccessGranted === true;
}

/**
 * Gate for content-plane tools (upload/create-folder/search/preview/sharing/seed).
 *
 * Content access is OFF by default (PRD opt-in). Call this at the top of every
 * content-plane tool handler and return its result if non-null, so the tool
 * FAILS CLOSED with actionable guidance when the developer has not opted in.
 *
 * @returns an error `McpToolResult` when access is NOT granted, or `null` when
 *          access has been granted and the operation may proceed.
 */
export function requireContentAccess(): McpToolResult | null {
  if (isContentAccessGranted()) {
    return null;
  }
  return {
    content: [{
      type: "text" as const,
      text:
        "### Content access not enabled\n\n" +
        "This tool reads or manages **files inside your containers** (content plane), which is " +
        "**off by default** and separate from provisioning.\n\n" +
        "> To enable it, run `content_access_grant` with `confirm=true`. The next content " +
        "operation will prompt a one-time sign-in for the content scopes. You can revoke access " +
        "any time with `content_access_revoke`.",
    }],
    isError: true,
  };
}

/**
 * Wrap a content-plane tool so its handler fails closed unless content access
 * has been granted. Applied at registration (see index.ts) so the enforcement
 * lives in exactly one place and cannot drift per-handler. Control-plane tools
 * are never wrapped and are therefore unaffected.
 */
export function withContentAccess(tool: McpTool): McpTool {
  return {
    ...tool,
    handler: async (args) => {
      const denied = requireContentAccess();
      if (denied) return denied;
      return tool.handler(args);
    },
  };
}
