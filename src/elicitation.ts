// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Elicitation helper — portable across all MCP harnesses.
 *
 * Native MCP elicitation (server→client structured prompts) is only supported
 * by some hosts. To work everywhere (VS Code Copilot, Claude, Cursor, Codex),
 * the SPE Builder uses **agent-guided elicitation**: tools return a structured
 * "choice needed" message and the orchestrating agent (driven by the
 * `provision_spe_app` MCP Prompt) presents the options to the user in chat and
 * calls back with the selection. This requires no host elicitation capability.
 *
 * `needChoice` formats that consistent "I need you to choose" payload.
 */

import type { McpToolResult } from "./types.js";

export interface Choice {
  label: string;
  value: string;
  description?: string;
}

/**
 * Build a tool result that asks the user to choose among options. The agent
 * relays this to the user and re-invokes the tool with the chosen value.
 */
export function needChoice(question: string, options: Choice[], paramName: string): McpToolResult {
  let text = `### ${question}\n\n`;
  for (const o of options) {
    text += `- **${o.label}** — \`${paramName}=${o.value}\`${o.description ? ` · ${o.description}` : ""}\n`;
  }
  text += `\n> Choose one and re-run with \`${paramName}\` set to the selected value.`;
  return { content: [{ type: "text", text }], isError: false };
}
