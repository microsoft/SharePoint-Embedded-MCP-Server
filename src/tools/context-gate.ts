// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Restart confirmation gate for control-plane MUTATION tools (WI-12, r-appgate).
 *
 * A freshly restarted process must not act on the remembered owning app /
 * container type until the user has confirmed that context under the current
 * session (see session.ts). This gate is wired at the TOP of the control-plane
 * MUTATION handlers (create/register a container type, grant/revoke owners,
 * add/remove app grants). Read-only/status tools are intentionally NOT gated —
 * reads should never nag.
 *
 * Elicitation stays host-agnostic: the gate returns a structured `needChoice`
 * McpToolResult (agent-guided), never a native MCP elicitation capability.
 */

import { needChoice } from "../elicitation.js";
import { isContextConfirmedThisSession, stampContextConfirmed } from "../session.js";
import { readState } from "../state.js";
import type { McpToolResult } from "../types.js";

/**
 * If there is a remembered owning app / container type that has NOT been
 * confirmed under the current session, return a choice asking the user to
 * confirm (continue) or switch (pick a different app/container type). Returns
 * `null` when already confirmed this session (no friction mid-session) or when
 * there is nothing remembered to confirm.
 */
export function requireConfirmedContext(): McpToolResult | null {
  const s = readState();
  if (!(s.appId || s.containerTypeId)) return null; // nothing to confirm
  if (isContextConfirmedThisSession(s)) return null; // already confirmed this session

  const app = s.appDisplayName ?? s.appId ?? "(unknown app)";
  const ct = s.containerTypeName ?? s.containerTypeId ?? "(none)";
  const priorNote = s.contextConfirmedAt
    ? " This context is remembered from a **prior session** (the server has since restarted)."
    : "";
  const staleNote =
    s.owningAppManagesAllContainerTypes === false
      ? "\n\n> ⚠️ The remembered container-type list may be **stale**: the owning app lacks " +
        "`FileStorageContainerType.Manage.All`, so it cannot enumerate all container types."
      : "";

  return needChoice(
    `Confirm the active SharePoint Embedded context before continuing.\n\n` +
      `- **Owning app:** ${app}\n` +
      `- **Container type:** ${ct}${priorNote}${staleNote}`,
    [
      {
        label: "Yes, continue with this app/container type",
        value: "confirm",
        description: "keep using the remembered owning app + container type",
      },
      {
        label: "No, choose a different app/container type",
        value: "switch",
        description: "run project_provision / project_app_create to pick another app",
      },
    ],
    "contextChoice",
  );
}

/**
 * Resolve the gate for a mutation handler given the caller-supplied
 * `contextChoice` argument:
 *   - "confirm" → stamp the session as confirmed and return `null` (proceed).
 *   - "switch"  → return a short message directing the user to re-provision.
 *   - absent    → return the confirmation choice (or `null` if already OK).
 *
 * A handler should call this first and, when it returns non-null, return that
 * result immediately (before touching the owning app / container type).
 */
export function resolveContextGate(contextChoice?: string): McpToolResult | null {
  if (contextChoice === "confirm") {
    stampContextConfirmed();
    return null;
  }
  if (contextChoice === "switch") {
    return {
      content: [
        {
          type: "text",
          text:
            "Switching owning app / container type. Run **project_provision** " +
            "(or **project_app_create**) and choose the app you want, then retry this operation.",
        },
      ],
      isError: false,
    };
  }
  return requireConfirmedContext();
}
