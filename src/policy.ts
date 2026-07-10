// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Runtime tool-exposure policy (SAFE-003 read-only mode + SAFE-004 profiles /
 * allowlist).
 *
 * Pure, side-effect-free helpers so the filter + reject behavior can be unit
 * tested without standing up the MCP server. index.ts wires these into the
 * ListTools filter and the CallTool dispatcher.
 *
 * Why restrict which tools are exposed? An MCP client — including an autonomous
 * "autopilot" agent — can only see and call the tools the server advertises, so
 * narrowing that surface is a safety / least-privilege control:
 *
 *  - Read-only mode (`--read-only` / `SPE_READ_ONLY`) hides and rejects every
 *    mutating tool, so an unattended or autopilot run can inspect and report but
 *    cannot create, delete, deploy, or otherwise make destructive changes.
 *  - Profiles / allowlist (`--tools <profile|csv>` / `SPE_TOOLS`) advertise only
 *    a curated subset. For example: `docsOnly` for a documentation-lookup
 *    assistant, `readOnly` for a status dashboard, `content` for file
 *    operations, or an explicit CSV such as `container_list,container_get` to
 *    scope a client to a single task.
 *
 * The two layers compose: to be listed or called, a tool must be in the
 * allowlist AND (when read-only mode is on) be annotated read-only.
 */

import type { McpTool, McpToolResult } from "./types.js";
import { fail } from "./responses.js";

/** A tool is read-only when explicitly annotated `readOnly: true`. */
export function isReadOnlyTool(tool: McpTool): boolean {
  return tool.annotations?.readOnly === true;
}

/** A tool is content-plane when annotated `plane: "content"`. */
function isContentPlane(tool: McpTool): boolean {
  return tool.annotations?.plane === "content";
}

/**
 * Built-in tool profiles for `--tools <profile>` / `SPE_TOOLS`. Each predicate
 * decides whether a given tool is included in the profile.
 */
export const TOOL_PROFILES: Record<string, (tool: McpTool) => boolean> = {
  /** Only read/list/get/search/status tools. */
  readOnly: (t) => isReadOnlyTool(t),
  /** Documentation lookup only. */
  docsOnly: (t) => t.name === "docs_search" || t.name === "docs_fetch",
  /** Control-plane provisioning + status (everything that is not content-plane). */
  provisioning: (t) => !isContentPlane(t),
  /** Content-plane file operations plus the content-access grant/revoke toggles. */
  content: (t) =>
    isContentPlane(t) || t.name === "content_access_grant" || t.name === "content_access_revoke",
  /** Everything (no restriction). */
  admin: () => true,
};

export const PROFILE_NAMES = Object.keys(TOOL_PROFILES);

export interface ResolvedToolPolicy {
  /** Reject any non-readOnly tool at call time + hide it from ListTools. */
  readOnly: boolean;
  /**
   * Allowed tool names. `undefined` means "no allowlist" (all tools allowed,
   * subject to readOnly). Built from a profile predicate or an explicit CSV.
   */
  allow?: Set<string>;
  /** The profile name, when a built-in profile was used (for logging). */
  profile?: string;
}

/**
 * Resolve a `--tools` / `SPE_TOOLS` spec (a built-in profile name or a CSV of
 * tool names) against the full tool registry into a concrete allowlist.
 */
export function resolveToolAllowlist(
  tools: McpTool[],
  spec: string,
): { allow: Set<string>; profile?: string } {
  const trimmed = spec.trim();
  // Only treat OWN, enumerable keys as profiles. Indexing the object literal
  // directly would resolve inherited Object.prototype members (e.g. `toString`,
  // `hasOwnProperty`, `constructor`, `__proto__`) to functions and let a crafted
  // `--tools` value bypass the SAFE-004 allowlist. Unknown names fall through to
  // the CSV tool-name path below.
  const predicate = Object.hasOwn(TOOL_PROFILES, trimmed) ? TOOL_PROFILES[trimmed] : undefined;
  if (predicate) {
    return { allow: new Set(tools.filter(predicate).map((t) => t.name)), profile: trimmed };
  }
  const names = trimmed
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return { allow: new Set(names) };
}

/**
 * Build the runtime policy from config/env values.
 *
 * @param tools     full tool registry (used to expand a profile into names)
 * @param readOnly  read-only flag (CLI flag OR truthy SPE_READ_ONLY)
 * @param toolsSpec optional profile name or CSV (CLI flag OR SPE_TOOLS)
 */
export function buildToolPolicy(
  tools: McpTool[],
  readOnly: boolean,
  toolsSpec: string | undefined,
): ResolvedToolPolicy {
  const policy: ResolvedToolPolicy = { readOnly };
  if (toolsSpec && toolsSpec.trim().length > 0) {
    const { allow, profile } = resolveToolAllowlist(tools, toolsSpec);
    policy.allow = allow;
    policy.profile = profile;
  }
  return policy;
}

/** Whether a tool should be advertised in ListTools under the given policy. */
export function isToolListed(tool: McpTool, policy: ResolvedToolPolicy | null): boolean {
  if (!policy) return true;
  if (policy.readOnly && !isReadOnlyTool(tool)) return false;
  if (policy.allow && !policy.allow.has(tool.name)) return false;
  return true;
}

/**
 * Check whether a tool call is permitted under the policy. Returns a `fail(...)`
 * result to short-circuit the dispatcher, or `null` when the call may proceed.
 */
export function checkToolCallAllowed(
  tool: McpTool,
  policy: ResolvedToolPolicy | null,
): McpToolResult | null {
  if (!policy) return null;
  if (policy.readOnly && !isReadOnlyTool(tool)) {
    return fail(
      "READ_ONLY_MODE",
      `Tool '${tool.name}' is not available: the server is running in read-only mode.`,
      "Restart without --read-only (or unset SPE_READ_ONLY) to allow mutating operations.",
    );
  }
  if (policy.allow && !policy.allow.has(tool.name)) {
    return fail(
      "TOOL_NOT_ALLOWED",
      `Tool '${tool.name}' is not in the active tool allowlist${policy.profile ? ` (profile '${policy.profile}')` : ""}.`,
      "Adjust --tools / SPE_TOOLS to include this tool, or use the 'admin' profile.",
    );
  }
  return null;
}
