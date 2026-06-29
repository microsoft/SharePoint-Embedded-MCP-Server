// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, it, expect, vi } from "vitest";
import { withConfirmation, requiresConfirmation } from "./confirmation.js";
import type { McpTool } from "../types.js";

function makeTool(handler = vi.fn(async () => ({ content: [{ type: "text" as const, text: "ok" }] }))): McpTool {
  return {
    name: "demo_tool",
    description: "demo tool for confirmation tests",
    inputSchema: { type: "object", properties: {} },
    handler,
  };
}

describe("requiresConfirmation", () => {
  it("always requires confirmation when no actions filter is given", () => {
    expect(requiresConfirmation({})).toBe(true);
    expect(requiresConfirmation({ action: "anything" })).toBe(true);
  });

  it("only requires confirmation for listed actions", () => {
    const opts = { actions: ["revoke"] };
    expect(requiresConfirmation({ action: "revoke" }, opts)).toBe(true);
    expect(requiresConfirmation({ action: "grant" }, opts)).toBe(false);
    expect(requiresConfirmation({}, opts)).toBe(false);
  });

  it("honors a custom actionArg", () => {
    expect(requiresConfirmation({ op: "wipe" }, { actionArg: "op", actions: ["wipe"] })).toBe(true);
  });
});

describe("withConfirmation", () => {
  it("blocks a destructive call without confirm and does not invoke the handler", async () => {
    const handler = vi.fn(async () => ({ content: [{ type: "text" as const, text: "ran" }] }));
    const wrapped = withConfirmation(makeTool(handler));
    const result = await wrapped.handler({});
    expect(result.isError).toBe(true);
    expect((result.structuredContent as { error?: { code?: string } }).error?.code).toBe("CONFIRMATION_REQUIRED");
    expect(handler).not.toHaveBeenCalled();
  });

  it("proceeds when confirm=true", async () => {
    const handler = vi.fn(async () => ({ content: [{ type: "text" as const, text: "ran" }] }));
    const wrapped = withConfirmation(makeTool(handler));
    const result = await wrapped.handler({ confirm: true });
    expect(result.content[0].text).toBe("ran");
    expect(handler).toHaveBeenCalledOnce();
  });

  it("only gates the configured actions", async () => {
    const handler = vi.fn(async () => ({ content: [{ type: "text" as const, text: "ran" }] }));
    const wrapped = withConfirmation(makeTool(handler), { actions: ["revoke"] });

    // non-gated action passes through untouched
    await wrapped.handler({ action: "grant" });
    expect(handler).toHaveBeenCalledOnce();

    handler.mockClear();
    // gated action requires confirm
    const blocked = await wrapped.handler({ action: "revoke" });
    expect(blocked.isError).toBe(true);
    expect(handler).not.toHaveBeenCalled();

    const allowed = await wrapped.handler({ action: "revoke", confirm: true });
    expect(allowed.content[0].text).toBe("ran");
    expect(handler).toHaveBeenCalledOnce();
  });

  it("preserves tool metadata (name/description/inputSchema/annotations)", () => {
    const tool = { ...makeTool(), annotations: { destructive: true } };
    const wrapped = withConfirmation(tool);
    expect(wrapped.name).toBe(tool.name);
    expect(wrapped.description).toBe(tool.description);
    expect(wrapped.inputSchema).toBe(tool.inputSchema);
    expect(wrapped.annotations).toEqual({ destructive: true });
  });
});
