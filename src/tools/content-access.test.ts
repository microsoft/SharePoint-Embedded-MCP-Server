// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Unit tests for content-plane access enforcement.
 *
 * The bug: `isContentAccessGranted()` existed but no content handler called it,
 * so content-plane tools (upload/search/preview/...) ran even when the user
 * never opted in. These assert the gate now fails closed and that wrapping a
 * real content tool blocks it until access is granted.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mutable mocked state store (mirrors the provisioning test pattern).
const stateStore: Record<string, unknown> = {};
vi.mock("../state.js", () => ({
  readState: vi.fn(() => ({ ...stateStore })),
  writeState: vi.fn((patch: Record<string, unknown>) => {
    Object.assign(stateStore, patch);
    return { ...stateStore };
  }),
}));

// Mock the graph client so wrapping a real content tool doesn't hit the network.
vi.mock("../graph-client.js", () => ({
  getContainerDrive: vi.fn(),
  uploadSmallFile: vi.fn(),
}));

import * as graph from "../graph-client.js";
import {
  isContentAccessGranted,
  requireContentAccess,
  withContentAccess,
} from "../tools/content-access.js";
import { uploadFileTool } from "../tools/upload-file.js";
import type { McpTool } from "../types.js";

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of Object.keys(stateStore)) delete stateStore[k];
});

describe("requireContentAccess gate", () => {
  it("denies (fails closed) when content access is NOT granted", () => {
    const denied = requireContentAccess();
    expect(denied).not.toBeNull();
    expect(denied?.isError).toBe(true);
    expect(denied?.content[0].text).toContain("Content access not enabled");
    expect(denied?.content[0].text).toContain("content_access_grant");
  });

  it("allows (returns null) once content access is granted", () => {
    stateStore.contentAccessGranted = true;
    expect(isContentAccessGranted()).toBe(true);
    expect(requireContentAccess()).toBeNull();
  });
});

describe("withContentAccess wrapper", () => {
  const stub: McpTool = {
    name: "content_stub",
    description: "stub",
    inputSchema: { type: "object", properties: {} },
    handler: vi.fn(async () => ({ content: [{ type: "text" as const, text: "ran" }] })),
  };

  it("blocks the inner handler when ungated", async () => {
    const wrapped = withContentAccess(stub);
    const result = await wrapped.handler({});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Content access not enabled");
    expect(stub.handler).not.toHaveBeenCalled();
  });

  it("runs the inner handler when access is granted", async () => {
    stateStore.contentAccessGranted = true;
    const wrapped = withContentAccess(stub);
    const result = await wrapped.handler({ a: 1 });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toBe("ran");
    expect(stub.handler).toHaveBeenCalledWith({ a: 1 });
  });

  it("preserves tool metadata (name/description/schema)", () => {
    const wrapped = withContentAccess(stub);
    expect(wrapped.name).toBe(stub.name);
    expect(wrapped.description).toBe(stub.description);
    expect(wrapped.inputSchema).toBe(stub.inputSchema);
  });
});

describe("real content tool enforcement (upload)", () => {
  it("ungated: fails closed and never touches Graph", async () => {
    const wrapped = withContentAccess(uploadFileTool);
    const result = await wrapped.handler({ containerId: "c1", fileName: "a.txt", content: "hi" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("content_access_grant");
    expect(graph.getContainerDrive).not.toHaveBeenCalled();
  });

  it("gated: proceeds to the real handler once granted", async () => {
    stateStore.contentAccessGranted = true;
    vi.mocked(graph.getContainerDrive).mockResolvedValue({ id: "d1" });
    vi.mocked(graph.uploadSmallFile).mockResolvedValue({ id: "i1", name: "a.txt", size: 2 });

    const wrapped = withContentAccess(uploadFileTool);
    const result = await wrapped.handler({ containerId: "c1", fileName: "a.txt", content: "hi" });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("File Uploaded");
    expect(graph.getContainerDrive).toHaveBeenCalledWith("c1");
  });
});
