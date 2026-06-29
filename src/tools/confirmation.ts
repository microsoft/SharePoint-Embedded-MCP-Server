// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Reusable confirmation gate for destructive / irreversible tool operations
 * (SAFE-002).
 *
 * Mirrors the `withContentAccess` wrapper pattern in `content-access.ts`: it
 * spreads the wrapped tool (preserving name/description/inputSchema/annotations
 * so ListTools + the registry are unaffected) and only wraps the handler. The
 * enforcement therefore lives in exactly one place and cannot drift per-handler.
 *
 * When confirmation is required and the caller did not pass `confirm: true`, the
 * wrapped handler returns a `CONFIRMATION_REQUIRED` failure WITHOUT invoking the
 * inner handler — so no Graph / Azure mutation occurs.
 *
 * Tools that already implement their own rich preview/confirm UX
 * (`container_type_delete`, `project_cleanup`, `billing_setup`) are intentionally
 * NOT wrapped — see index.ts.
 */

import { fail } from "../responses.js";
import type { McpTool } from "../types.js";

export interface ConfirmationOptions {
  /** Name of the argument holding the action/sub-command. Default: `"action"`. */
  actionArg?: string;
  /**
   * When provided, confirmation is only required if `args[actionArg]` is one of
   * these values (e.g. only the `permanent-delete` action of a multi-mode tool).
   * When omitted, EVERY call to the tool requires confirmation.
   */
  actions?: string[];
  /** Name of the boolean confirmation argument. Default: `"confirm"`. */
  confirmArg?: string;
}

/**
 * Decide whether the current invocation requires confirmation, given the tool's
 * arguments and the configured options.
 */
export function requiresConfirmation(
  args: Record<string, unknown>,
  options: ConfirmationOptions = {},
): boolean {
  const { actionArg = "action", actions } = options;
  if (!actions || actions.length === 0) return true;
  const action = args[actionArg];
  return typeof action === "string" && actions.includes(action);
}

/**
 * Wrap a tool so destructive actions fail closed unless `confirm: true` is
 * supplied. Applied at registration (see index.ts).
 */
export function withConfirmation(tool: McpTool, options: ConfirmationOptions = {}): McpTool {
  const { confirmArg = "confirm" } = options;
  return {
    ...tool,
    handler: async (args) => {
      if (requiresConfirmation(args, options) && args[confirmArg] !== true) {
        return fail(
          "CONFIRMATION_REQUIRED",
          `This is a destructive, irreversible operation. Re-run with ${confirmArg}=true to proceed.`,
          `Pass ${confirmArg}: true once you have verified the target is correct.`,
        );
      }
      return tool.handler(args);
    },
  };
}
