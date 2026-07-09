// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Elicitation helper — prefers NATIVE MCP elicitation, falls back to agent-guided.
 *
 * The Model Context Protocol defines an **elicitation** capability
 * (`elicitation/create`) that lets the SERVER ask the CLIENT to prompt the USER
 * for structured input. When the connected client advertises it, the SPE Builder
 * uses it (via `server.elicitInput`) so the ask reaches a HUMAN.
 *
 * Why this matters (PR #3 review): the reuse-vs-new-app and trial-vs-standard
 * asks were previously ONLY agent-guided — a text tool result asking the
 * orchestrating model to re-invoke with the chosen arg. In practice the host
 * model auto-answered without surfacing the question, so the ask never reached
 * the user. Native elicitation puts the decision in front of the person.
 *
 * Not every host supports elicitation, so this module degrades gracefully: when
 * the client does NOT advertise the capability — or the native request throws or
 * is declined — it falls back to **agent-guided elicitation** via `needChoice`,
 * which returns a structured "choose one" tool result the agent re-invokes with
 * the chosen arg. On hosts without elicitation, behavior is identical to before.
 *
 * Elicitation is used only for non-sensitive choices (billing model, reuse/new,
 * confirm/switch) and a new-app display name — never secrets or tokens, per the
 * spec's rule that servers MUST NOT request sensitive information this way.
 */

import type { McpToolResult } from "./types.js";

export interface Choice {
  label: string;
  value: string;
  description?: string;
}

/**
 * Build a tool result that asks the user to choose among options. The agent
 * relays this to the user and re-invokes the tool with the chosen value. This is
 * the fallback used whenever native elicitation is unavailable.
 */
export function needChoice(question: string, options: Choice[], paramName: string): McpToolResult {
  let text = `### ${question}\n\n`;
  for (const o of options) {
    text += `- **${o.label}** — \`${paramName}=${o.value}\`${o.description ? ` · ${o.description}` : ""}\n`;
  }
  text += `\n> Choose one and re-run with \`${paramName}\` set to the selected value.`;
  return { content: [{ type: "text", text }], isError: false };
}

// ─── Native MCP elicitation ───────────────────────────────────────────────────

/**
 * The subset of the MCP SDK's `ElicitResult` this module consumes. `action`
 * mirrors the spec's accept/decline/cancel; `content` (present on accept) is the
 * user's answer keyed by the requested-schema property name.
 */
export type ElicitInputResult = {
  action: "accept" | "decline" | "cancel";
  content?: Record<string, unknown>;
};

/**
 * The minimal surface of the MCP `Server` the elicitation helpers need. Declared
 * locally (rather than importing the SDK `Server`) so tool handlers — which never
 * receive the server instance — can reach `elicitInput` through this module, and
 * so tests can wire a lightweight fake. The real `Server` satisfies this shape.
 */
export interface ElicitationCapableServer {
  elicitInput(params: {
    mode: "form";
    message: string;
    requestedSchema: Record<string, unknown>;
  }): Promise<ElicitInputResult>;
  getClientCapabilities(): { elicitation?: unknown } | undefined;
}

let wired: ElicitationCapableServer | null = null;

/**
 * Wire the live MCP server so the elicitation helpers can issue native
 * `elicitation/create` requests. Called once at startup (index.ts). Until it is
 * called — e.g. in unit tests — every helper uses the agent-guided fallback.
 */
export function wireElicitation(server: ElicitationCapableServer): void {
  wired = server;
}

/** Test hook: clear the wired server between cases. */
export function resetElicitationForTests(): void {
  wired = null;
}

/**
 * True only when a client that advertises the elicitation capability is wired.
 * Capabilities are read lazily (always post-`initialize`), so this reflects the
 * live client. The SDK further gates form mode on `elicitation.form` and throws
 * otherwise — that throw is caught by the callers below and falls back.
 */
function nativeElicitationAvailable(): boolean {
  return !!wired && !!wired.getClientCapabilities()?.elicitation;
}

/**
 * Build the restricted form-mode `requestedSchema` for a single-select choice.
 * Form elicitation permits only a FLAT object of primitives; an enum with
 * human-readable labels is expressed with `oneOf` const/title entries.
 */
function choiceSchema(question: string, options: Choice[], paramName: string): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      [paramName]: {
        type: "string",
        title: paramName,
        description: question,
        oneOf: options.map((o) => ({
          const: o.value,
          title: o.description ? `${o.label} — ${o.description}` : o.label,
        })),
      },
    },
    required: [paramName],
  };
}

/** Friendly no-op result when the user declines/cancels (or accepts an invalid value). */
function declinedChoiceResult(options: Choice[]): McpToolResult {
  const values = options.map((o) => o.value).join(", ");
  return {
    content: [
      {
        type: "text",
        text: `No selection made — no changes were applied. Re-run and choose one of: ${values}.`,
      },
    ],
    isError: false,
  };
}

export type ChoiceResolution =
  | { resolved: true; value: string }
  | { resolved: false; result: McpToolResult };

/**
 * Ask the user to pick one of `options`, preferring native MCP elicitation.
 *
 *  - Native (client advertises elicitation): issue an `elicitation/create` form
 *    request. On `accept` with a value matching one of the options → resolve
 *    in-band (`{ resolved: true }`) so the caller CONTINUES without a re-invoke.
 *    On `decline`/`cancel` (or accept-but-invalid) → a friendly no-op result. On
 *    ANY thrown error (e.g. client lacks form support) → fall through to the
 *    agent-guided fallback.
 *  - Fallback (not wired / no capability / threw): return `needChoice(...)` — the
 *    agent-guided ask the orchestrator re-invokes with the chosen arg. Identical
 *    to the pre-native behavior.
 */
export async function elicitChoice(
  question: string,
  options: Choice[],
  paramName: string,
): Promise<ChoiceResolution> {
  if (nativeElicitationAvailable() && wired) {
    try {
      const res = await wired.elicitInput({
        mode: "form",
        message: question,
        requestedSchema: choiceSchema(question, options, paramName),
      });
      if (res.action === "accept") {
        const picked = res.content?.[paramName];
        if (typeof picked === "string" && options.some((o) => o.value === picked)) {
          return { resolved: true, value: picked };
        }
        // Accepted but the value did not match a known option — treat as no-op.
        return { resolved: false, result: declinedChoiceResult(options) };
      }
      // decline / cancel → the user opted out; make no change.
      return { resolved: false, result: declinedChoiceResult(options) };
    } catch {
      // Native path unsupported/failed at runtime → agent-guided fallback below.
    }
  }
  return { resolved: false, result: needChoice(question, options, paramName) };
}

export type TextResolution =
  | { resolved: true; value: string }
  | { resolved: false; result: McpToolResult | null };

/**
 * Ask the user for a short free-text value (e.g. a new app display name),
 * preferring native MCP elicitation. Unlike `elicitChoice`, the fallback is
 * SILENT: when the client cannot elicit natively (or the user declines), this
 * returns `{ resolved: false, result: null }` so the caller keeps its existing
 * default rather than emitting a new text prompt for an optional value.
 */
export async function elicitText(
  message: string,
  paramName: string,
  opts?: { title?: string },
): Promise<TextResolution> {
  if (nativeElicitationAvailable() && wired) {
    try {
      const res = await wired.elicitInput({
        mode: "form",
        message,
        requestedSchema: {
          type: "object",
          properties: {
            [paramName]: {
              type: "string",
              title: opts?.title ?? paramName,
              description: message,
            },
          },
          required: [paramName],
        },
      });
      if (res.action === "accept") {
        const value = res.content?.[paramName];
        if (typeof value === "string" && value.trim() !== "") {
          return { resolved: true, value: value.trim() };
        }
      }
    } catch {
      // fall through to the silent no-op below
    }
  }
  return { resolved: false, result: null };
}
