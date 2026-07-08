// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * WI-07: argument-validation coverage for the tools migrated onto `defineTool`
 * (content_file_upload, content_folder_create, content_search).
 *
 * Focus areas:
 *   - table-driven rejection of non-string / missing / empty / whitespace-only
 *     arguments with the standard INVALID_ARGS envelope (no `as string` TypeError);
 *   - the create-folder empty-segment fix (`"/"`, `"///"`, `"a//b"`, `"  "`), and
 *     the guarantee that `createFolder` is never called with a blank name;
 *   - preservation of the search pagination aliases (`maxResults`, `limit`,
 *     `skip`, `continuationToken`, `nextToken`);
 *   - acceptance of an empty-string upload (an empty file is valid).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../graph-client.js", () => ({
  getContainerDrive: vi.fn(),
  uploadSmallFile: vi.fn(),
  createFolder: vi.fn(),
  listDriveChildren: vi.fn(),
  searchContent: vi.fn(),
}));

// Content-plane tools are gated by the content-access opt-in; grant it so
// validation runs to completion and valid args reach the (mocked) Graph layer.
const stateStore: Record<string, unknown> = { contentAccessGranted: true };
vi.mock("../state.js", () => ({
  readState: vi.fn(() => ({ ...stateStore })),
  writeState: vi.fn((p: Record<string, unknown>) => { Object.assign(stateStore, p); return { ...stateStore }; }),
  clearState: vi.fn(() => { for (const k of Object.keys(stateStore)) delete stateStore[k]; }),
}));

import * as graph from "../graph-client.js";
import { uploadFileTool } from "./upload-file.js";
import { createFolderTool } from "./create-folder.js";
import { searchContentTool } from "./search-content.js";

type Result = { isError?: boolean; content: Array<{ text: string }>; structuredContent?: unknown };

function errorCode(r: Result): string | undefined {
  const sc = r.structuredContent as { error?: { code?: string } } | undefined;
  return sc?.error?.code;
}

/** Assert an INVALID_ARGS-class validation envelope (isError + code). */
function expectInvalidArgs(r: Result): void {
  expect(r.isError).toBe(true);
  expect(r.content[0].text.startsWith("Error:")).toBe(true);
  expect(errorCode(r)).toBe("INVALID_ARGS");
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of Object.keys(stateStore)) delete stateStore[k];
  stateStore.contentAccessGranted = true;
});

// ─── content_file_upload ──────────────────────────────────────────────────────

describe("content_file_upload argument validation", () => {
  const invalid: Array<[string, Record<string, unknown>]> = [
    ["containerId non-string (number)", { containerId: 123, fileName: "f.txt", content: "x" }],
    ["containerId missing", { fileName: "f.txt", content: "x" }],
    ["containerId empty", { containerId: "", fileName: "f.txt", content: "x" }],
    ["containerId whitespace-only", { containerId: "   ", fileName: "f.txt", content: "x" }],
    ["fileName non-string (object)", { containerId: "c1", fileName: {}, content: "x" }],
    ["fileName non-string (array)", { containerId: "c1", fileName: [], content: "x" }],
    ["fileName missing", { containerId: "c1", content: "x" }],
    ["fileName whitespace-only", { containerId: "c1", fileName: " ", content: "x" }],
    ["content non-string (number)", { containerId: "c1", fileName: "f.txt", content: 123 }],
    ["content non-string (null)", { containerId: "c1", fileName: "f.txt", content: null }],
    ["content missing", { containerId: "c1", fileName: "f.txt" }],
    ["folderPath non-string", { containerId: "c1", fileName: "f.txt", content: "x", folderPath: 5 }],
  ];

  it.each(invalid)("rejects %s", async (_label, args) => {
    const r = await uploadFileTool.handler(args);
    expectInvalidArgs(r);
    expect(graph.getContainerDrive).not.toHaveBeenCalled();
  });

  it("accepts empty-string content (an empty file is valid)", async () => {
    vi.mocked(graph.getContainerDrive).mockResolvedValue({ id: "d1" });
    vi.mocked(graph.uploadSmallFile).mockResolvedValue({ id: "i1", name: "empty.txt", size: 0 });

    const r = await uploadFileTool.handler({ containerId: "c1", fileName: "empty.txt", content: "" });
    expect(r.isError).toBeFalsy();
    expect(graph.uploadSmallFile).toHaveBeenCalledWith("d1", "/empty.txt", "");
  });
});

// ─── content_folder_create ────────────────────────────────────────────────────

describe("content_folder_create argument validation", () => {
  const invalid: Array<[string, Record<string, unknown>]> = [
    ["containerId non-string (number)", { containerId: 1, folderPath: "Docs" }],
    ["containerId missing", { folderPath: "Docs" }],
    ["containerId empty", { containerId: "", folderPath: "Docs" }],
    ["containerId whitespace-only", { containerId: "  ", folderPath: "Docs" }],
    ["folderPath non-string (number)", { containerId: "c1", folderPath: 5 }],
    ["folderPath non-string (object)", { containerId: "c1", folderPath: {} }],
    ["folderPath non-string (array)", { containerId: "c1", folderPath: [] }],
    ["folderPath non-string (null)", { containerId: "c1", folderPath: null }],
    ["folderPath missing", { containerId: "c1" }],
    ["folderPath empty string", { containerId: "c1", folderPath: "" }],
    ["folderPath slash-only", { containerId: "c1", folderPath: "/" }],
    ["folderPath multi-slash", { containerId: "c1", folderPath: "///" }],
    ["folderPath whitespace-only", { containerId: "c1", folderPath: "  " }],
  ];

  it.each(invalid)("rejects %s", async (_label, args) => {
    const r = await createFolderTool.handler(args);
    expectInvalidArgs(r);
    // The empty-segment bug fix: a blank / zero-segment path must never reach Graph.
    expect(graph.createFolder).not.toHaveBeenCalled();
  });

  it("drops empty segments from 'a//b' and never calls createFolder with a blank name", async () => {
    vi.mocked(graph.getContainerDrive).mockResolvedValue({ id: "d1" });
    vi.mocked(graph.createFolder)
      .mockResolvedValueOnce({ id: "f1", name: "a" })
      .mockResolvedValueOnce({ id: "f2", name: "b" });

    const r = await createFolderTool.handler({ containerId: "c1", folderPath: "a//b" });
    expect(r.isError).toBeFalsy();
    expect(graph.createFolder).toHaveBeenCalledTimes(2);
    expect(graph.createFolder).toHaveBeenNthCalledWith(1, "d1", "root", "a");
    expect(graph.createFolder).toHaveBeenNthCalledWith(2, "d1", "f1", "b");
    // No invocation ever passed a blank folder name.
    for (const call of vi.mocked(graph.createFolder).mock.calls) {
      expect(call[2]).not.toBe("");
    }
  });

  it("creates each non-empty segment of 'Docs/Reports/Q1'", async () => {
    vi.mocked(graph.getContainerDrive).mockResolvedValue({ id: "d1" });
    vi.mocked(graph.createFolder)
      .mockResolvedValueOnce({ id: "f1", name: "Docs" })
      .mockResolvedValueOnce({ id: "f2", name: "Reports" })
      .mockResolvedValueOnce({ id: "f3", name: "Q1" });

    const r = await createFolderTool.handler({ containerId: "c1", folderPath: "Docs/Reports/Q1" });
    expect(r.isError).toBeFalsy();
    expect(graph.createFolder).toHaveBeenNthCalledWith(1, "d1", "root", "Docs");
    expect(graph.createFolder).toHaveBeenNthCalledWith(2, "d1", "f1", "Reports");
    expect(graph.createFolder).toHaveBeenNthCalledWith(3, "d1", "f2", "Q1");
  });
});

// ─── content_search ────────────────────────────────────────────────────────────

describe("content_search argument validation", () => {
  const invalid: Array<[string, Record<string, unknown>]> = [
    ["query non-string (number)", { query: 123 }],
    ["query non-string (object)", { query: {} }],
    ["query non-string (array)", { query: [] }],
    ["query non-string (null)", { query: null }],
    ["query missing", {}],
    ["query empty", { query: "" }],
    ["query whitespace-only", { query: "   " }],
  ];

  it.each(invalid)("rejects %s", async (_label, args) => {
    const r = await searchContentTool.handler(args);
    expectInvalidArgs(r);
    expect(graph.searchContent).not.toHaveBeenCalled();
  });
});

describe("content_search preserves pagination aliases", () => {
  beforeEach(() => {
    vi.mocked(graph.searchContent).mockResolvedValue({
      value: [{ hitsContainers: [{ total: 0, hits: [] }] }],
    });
  });

  // defaultTop for content_search is 25; MAX_TOP is 200.
  const cases: Array<[string, Record<string, unknown>, number, number]> = [
    ["top", { query: "q", top: 3 }, 3, 0],
    ["limit alias -> top", { query: "q", limit: 7 }, 7, 0],
    ["maxResults alias -> top", { query: "q", maxResults: 5 }, 5, 0],
    ["skip", { query: "q", skip: 10 }, 25, 10],
    ["continuationToken alias -> skip", { query: "q", continuationToken: "15" }, 25, 15],
    ["nextToken alias -> skip", { query: "q", nextToken: "20" }, 25, 20],
  ];

  it.each(cases)("honors %s", async (_label, args, expectedTop, expectedSkip) => {
    const r = await searchContentTool.handler(args);
    expect(r.isError).toBeFalsy();
    expect(graph.searchContent).toHaveBeenCalledWith("q", expectedTop, expectedSkip);
  });
});
