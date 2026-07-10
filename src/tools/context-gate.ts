// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Restart confirmation gate for control-plane MUTATION tools (PR #3 review: r-appgate).
 *
 * A freshly restarted process must not act on the remembered owning app /
 * container type until the user has confirmed that context under the current
 * session (see session.ts). This gate is wired at the TOP of the control-plane
 * MUTATION handlers (create/register a container type, grant/revoke owners,
 * add/remove app grants). Read-only/status tools are intentionally NOT gated —
 * reads should never nag.
 *
 * Elicitation prefers the NATIVE MCP capability (PR #3 review): on a client
 * that supports `elicitation/create`, the gate prompts the user directly and,
 * on "confirm", continues in-band (stamps the session and returns `null`). When
 * the client does not support elicitation, it falls back to a structured
 * `needChoice` McpToolResult (agent-guided) — identical to prior behavior.
 */

import { elicitChoice } from "../elicitation.js";
import { isContextConfirmedThisSession, stampContextConfirmed } from "../session.js";
import { readState } from "../state.js";
import type { McpToolResult } from "../types.js";

/**
 * Short message directing the user to re-provision when they choose to switch
 * away from the remembered owning app / container type.
 */
function switchContextMessage(): McpToolResult {
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

/**
 * If there is a remembered owning app / container type that has NOT been
 * confirmed under the current session, ask the user to confirm (continue) or
 * switch (pick a different app/container type).
 *
 * Prefers native MCP elicitation: on a capable client the user is prompted
 * directly and, on "confirm", we stamp the session and return `null` so the
 * caller PROCEEDS in-band; on "switch" we return the re-provision message. When
 * elicitation is unavailable the fallback `needChoice` text is returned (the
 * agent re-invokes with `contextChoice`). Returns `null` when already confirmed
 * this session (no friction mid-session) or when there is nothing remembered.
 */
export async function requireConfirmedContext(): Promise<McpToolResult | null> {
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

  const choice = await elicitChoice(
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
  if (!choice.resolved) return choice.result; // fallback text ask, or user declined
  // Native path resolved the ask in-band.
  if (choice.value === "confirm") {
    stampContextConfirmed();
    return null; // proceed
  }
  return switchContextMessage(); // "switch"
}

/**
 * Resolve the gate for a mutation handler given the caller-supplied
 * `contextChoice` argument:
 *   - "confirm" → stamp the session as confirmed and return `null` (proceed).
 *   - "switch"  → return a short message directing the user to re-provision.
 *   - absent    → prompt (native elicitation, else the fallback choice), or
 *                 `null` if already confirmed / nothing remembered.
 *
 * A handler should call this first and, when it returns non-null, return that
 * result immediately (before touching the owning app / container type).
 */
export async function resolveContextGate(contextChoice?: string): Promise<McpToolResult | null> {
  if (contextChoice === "confirm") {
    stampContextConfirmed();
    return null;
  }
  if (contextChoice === "switch") {
    return switchContextMessage();
  }
  return await requireConfirmedContext();
}
