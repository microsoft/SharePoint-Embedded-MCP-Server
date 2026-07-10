// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, it, expect } from "vitest";
import {
  buildToolPolicy,
  isToolListed,
  checkToolCallAllowed,
  resolveToolAllowlist,
  TOOL_PROFILES,
} from "./policy.js";
import type { McpTool } from "./types.js";

function tool(name: string, annotations?: McpTool["annotations"]): McpTool {
  return {
    name,
    description: name,
    annotations,
    inputSchema: { type: "object", properties: {} },
    handler: async () => ({ content: [{ type: "text", text: "ok" }] }),
  };
}

const registry: McpTool[] = [
  tool("container_list", { readOnly: true }),
  tool("status", { readOnly: true }),
  tool("container_create", { destructive: true }),
  tool("container_delete", { destructive: true, plane: "control" }),
  tool("content_search", { readOnly: true, plane: "content", requiresConsent: true }),
  tool("content_access_grant"),
  tool("content_access_revoke"),
  tool("docs_search", { readOnly: true }),
  tool("docs_fetch", { readOnly: true }),
];

describe("read-only mode (SAFE-003 read-only tool policy)", () => {
  it("lists only read-only tools and rejects mutating calls", () => {
    const policy = buildToolPolicy(registry, true, undefined);

    expect(isToolListed(tool("container_list", { readOnly: true }), policy)).toBe(true);
    expect(isToolListed(tool("container_create", { destructive: true }), policy)).toBe(false);

    const denied = checkToolCallAllowed(tool("container_create", { destructive: true }), policy);
    expect(denied?.isError).toBe(true);
    expect(denied?.content[0].text).toContain("read-only");

    const allowed = checkToolCallAllowed(tool("container_list", { readOnly: true }), policy);
    expect(allowed).toBeNull();
  });
});

describe("tool profiles (SAFE-004 tool allowlist)", () => {
  it("docsOnly profile exposes only the docs tools", () => {
    const { allow, profile } = resolveToolAllowlist(registry, "docsOnly");
    expect(profile).toBe("docsOnly");
    expect([...allow].sort()).toEqual(["docs_fetch", "docs_search"]);
  });

  it("content profile includes content-plane tools plus grant/revoke", () => {
    const { allow } = resolveToolAllowlist(registry, "content");
    expect(allow.has("content_search")).toBe(true);
    expect(allow.has("content_access_grant")).toBe(true);
    expect(allow.has("content_access_revoke")).toBe(true);
    expect(allow.has("container_create")).toBe(false);
  });

  it("admin profile allows everything", () => {
    const { allow } = resolveToolAllowlist(registry, "admin");
    expect(allow.size).toBe(registry.length);
  });

  it("a CSV spec builds an explicit allowlist and rejects others at call time", () => {
    const policy = buildToolPolicy(registry, false, "status,container_list");
    expect(isToolListed(tool("status", { readOnly: true }), policy)).toBe(true);
    const denied = checkToolCallAllowed(tool("container_create", { destructive: true }), policy);
    expect(denied?.isError).toBe(true);
    expect(denied?.content[0].text).toContain("allowlist");
  });

  it("exposes the documented built-in profiles", () => {
    expect(Object.keys(TOOL_PROFILES).sort()).toEqual(
      ["admin", "content", "docsOnly", "provisioning", "readOnly"],
    );
  });

  it("no policy means every tool is listed and allowed", () => {
    expect(isToolListed(tool("container_create", { destructive: true }), null)).toBe(true);
    expect(checkToolCallAllowed(tool("container_create", { destructive: true }), null)).toBeNull();
  });

  it("inherited object keys are not treated as profiles (prototype-pollution / allowlist bypass)", () => {
    for (const reserved of ["toString", "hasOwnProperty", "constructor", "__proto__", "valueOf"]) {
      const { allow, profile } = resolveToolAllowlist(registry, reserved);
      // Must NOT resolve to a built-in profile...
      expect(profile).toBeUndefined();
      // ...must NOT expose all tools (bypass) and must NOT deny-all via an
      // inherited predicate: it is an unknown tool name, so the allowlist is
      // exactly that single (non-existent) name.
      expect([...allow]).toEqual([reserved]);
      expect(allow.size).toBe(1);
      expect(allow.has("container_create")).toBe(false);
    }
  });

  it("a reserved key as --tools rejects every real tool at call time", () => {
    // `toString` would previously map to Object.prototype.toString (truthy for
    // every tool) and expose the whole registry. It must now reject.
    const policy = buildToolPolicy(registry, false, "toString");
    expect(policy.profile).toBeUndefined();
    for (const t of registry) {
      const denied = checkToolCallAllowed(t, policy);
      expect(denied?.isError).toBe(true);
      expect(denied?.content[0].text).toContain("allowlist");
    }
  });
});
