// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Unit tests for content operations tools.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../graph-client.js", () => ({
  getContainerDrive: vi.fn(),
  getDriveItem: vi.fn(),
  uploadSmallFile: vi.fn(),
  createFolder: vi.fn(),
  listDriveChildren: vi.fn(),
  searchContent: vi.fn(),
  previewDriveItem: vi.fn(),
  createSharingLink: vi.fn(),
  listDriveItemPermissions: vi.fn(),
  revokeSharingLink: vi.fn(),
}));

// Content-plane tools are gated by the content-access opt-in,
// which reads provisioning state. Mock state with a mutable store so tests can
// toggle the opt-in; default to granted so the happy-path tests below pass.
const stateStore: Record<string, unknown> = { contentAccessGranted: true };
vi.mock("../state.js", () => ({
  readState: vi.fn(() => ({ ...stateStore })),
  writeState: vi.fn((p: Record<string, unknown>) => { Object.assign(stateStore, p); return { ...stateStore }; }),
  clearState: vi.fn(() => { for (const k of Object.keys(stateStore)) delete stateStore[k]; }),
}));

import * as graph from "../graph-client.js";
import { uploadFileTool } from "../tools/upload-file.js";
import { createFolderTool } from "../tools/create-folder.js";
import { searchContentTool } from "../tools/search-content.js";
import { previewFileTool } from "../tools/preview-file.js";
import { manageSharingTool } from "../tools/manage-sharing.js";
import { seedSampleDataTool } from "../tools/seed-sample-data.js";

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of Object.keys(stateStore)) delete stateStore[k];
  stateStore.contentAccessGranted = true;
});

// ─── content_file_upload ────────────────────────────────────────────────────────

describe("content_file_upload", () => {
  it("uploads text content", async () => {
    vi.mocked(graph.getContainerDrive).mockResolvedValue({ id: "d1" });
    vi.mocked(graph.uploadSmallFile).mockResolvedValue({
      id: "item1", name: "test.txt", size: 100, webUrl: "https://example.com/test.txt",
    });

    const result = await uploadFileTool.handler({
      containerId: "c1", fileName: "test.txt", content: "hello world",
    });
    expect(result.content[0].text).toContain("File Uploaded");
    expect(result.content[0].text).toContain("test.txt");
    expect(graph.uploadSmallFile).toHaveBeenCalledWith("d1", "/test.txt", "hello world");
  });

  it("uploads to a folder path", async () => {
    vi.mocked(graph.getContainerDrive).mockResolvedValue({ id: "d1" });
    vi.mocked(graph.uploadSmallFile).mockResolvedValue({
      id: "item1", name: "test.txt", size: 100,
    });

    await uploadFileTool.handler({
      containerId: "c1", fileName: "test.txt", content: "data", folderPath: "Documents/Reports",
    });
    expect(graph.uploadSmallFile).toHaveBeenCalledWith("d1", "/Documents/Reports/test.txt", "data");
  });

  it("requires all parameters", async () => {
    const r = await uploadFileTool.handler({ containerId: "c1" });
    expect(r.isError).toBe(true);
  });
});

// ─── content_folder_create ──────────────────────────────────────────────────────

describe("content_folder_create", () => {
  it("creates nested folders", async () => {
    vi.mocked(graph.getContainerDrive).mockResolvedValue({ id: "d1" });
    vi.mocked(graph.createFolder)
      .mockResolvedValueOnce({ id: "f1", name: "Documents" })
      .mockResolvedValueOnce({ id: "f2", name: "Reports" });

    const result = await createFolderTool.handler({
      containerId: "c1", folderPath: "Documents/Reports",
    });
    expect(result.content[0].text).toContain("Documents");
    expect(result.content[0].text).toContain("Reports");
    expect(result.content[0].text).toContain("f2");
  });

  it("handles already-existing folders", async () => {
    vi.mocked(graph.getContainerDrive).mockResolvedValue({ id: "d1" });
    vi.mocked(graph.createFolder).mockRejectedValue(new Error("nameAlreadyExists"));
    vi.mocked(graph.listDriveChildren).mockResolvedValue([
      { id: "f1", name: "Docs", folder: {} },
    ]);

    const result = await createFolderTool.handler({
      containerId: "c1", folderPath: "Docs",
    });
    expect(result.content[0].text).toContain("exists");
  });
});

// ─── content_search ─────────────────────────────────────────────────────

describe("content_search", () => {
  it("returns search results", async () => {
    vi.mocked(graph.searchContent).mockResolvedValue({
      value: [{
        hitsContainers: [{
          total: 1,
          hits: [{
            resource: { name: "report.pdf", webUrl: "https://example.com/report.pdf", size: 5120 },
            summary: "Quarterly report",
          }],
        }],
      }],
    });

    const result = await searchContentTool.handler({ query: "quarterly report" });
    expect(result.content[0].text).toContain("report.pdf");
    expect(result.content[0].text).toContain("Search Results");
  });

  it("handles no results", async () => {
    vi.mocked(graph.searchContent).mockResolvedValue({
      value: [{ hitsContainers: [{ total: 0, hits: [] }] }],
    });

    const result = await searchContentTool.handler({ query: "nonexistent" });
    expect(result.content[0].text).toContain("No results found");
  });

  it("requires query parameter", async () => {
    const r = await searchContentTool.handler({});
    expect(r.isError).toBe(true);
  });
});

// ─── content_file_preview ───────────────────────────────────────────────────────

describe("content_file_preview", () => {
  it("generates preview URL", async () => {
    vi.mocked(graph.getContainerDrive).mockResolvedValue({ id: "d1" });
    vi.mocked(graph.getDriveItem).mockResolvedValue({
      id: "item1", name: "report.pdf", size: 2048,
    });
    vi.mocked(graph.previewDriveItem).mockResolvedValue({
      getUrl: "https://example.com/preview/report",
    });

    const result = await previewFileTool.handler({
      containerId: "c1", filePath: "report.pdf",
    });
    expect(result.content[0].text).toContain("Preview URL");
    expect(result.content[0].text).toContain("https://example.com/preview/report");
  });
});

// ─── content_sharing_manage ─────────────────────────────────────────────────────

describe("content_sharing_manage", () => {
  beforeEach(() => {
    vi.mocked(graph.getContainerDrive).mockResolvedValue({ id: "d1" });
    vi.mocked(graph.getDriveItem).mockResolvedValue({
      id: "item1", name: "report.pdf",
    });
  });

  it("creates a sharing link", async () => {
    vi.mocked(graph.createSharingLink).mockResolvedValue({
      id: "sl1",
      link: { type: "view", scope: "organization", webUrl: "https://share.example.com/link1" },
    });

    const result = await manageSharingTool.handler({
      containerId: "c1", filePath: "report.pdf", action: "create", linkType: "view",
    });
    expect(result.content[0].text).toContain("Sharing link created");
    expect(result.content[0].text).toContain("https://share.example.com/link1");
  });

  it("lists sharing links", async () => {
    vi.mocked(graph.listDriveItemPermissions).mockResolvedValue([
      { id: "sl1", link: { type: "view", scope: "organization", webUrl: "https://link1" } },
      { id: "sl2", link: { type: "edit", scope: "anonymous", webUrl: "https://link2" } },
    ]);

    const result = await manageSharingTool.handler({
      containerId: "c1", filePath: "report.pdf", action: "list",
    });
    expect(result.content[0].text).toContain("Sharing Links");
    expect(result.content[0].text).toContain("sl1");
    expect(result.content[0].text).toContain("sl2");
  });

  it("revokes a sharing link", async () => {
    vi.mocked(graph.revokeSharingLink).mockResolvedValue();
    const result = await manageSharingTool.handler({
      containerId: "c1", filePath: "report.pdf", action: "revoke", permissionId: "sl1",
    });
    expect(result.content[0].text).toContain("revoked");
  });

  it("requires permissionId for revoke", async () => {
    const r = await manageSharingTool.handler({
      containerId: "c1", filePath: "report.pdf", action: "revoke",
    });
    expect(r.isError).toBe(true);
  });
});

// ─── content-access opt-in gate ────────────────────────────────
//
// Regression: content-plane tools previously bypassed the content-access opt-in
// and called Graph even when access had NOT been granted. They must now fail
// CLOSED with actionable guidance when not opted-in, and only proceed once the
// developer has granted access.

describe("content-access opt-in gate", () => {
  const gatedTools: Array<{ name: string; call: () => Promise<{ isError?: boolean; content: Array<{ text: string }> }> }> = [
    { name: "content_file_upload", call: () => uploadFileTool.handler({ containerId: "c1", fileName: "f.txt", content: "x" }) },
    { name: "content_folder_create", call: () => createFolderTool.handler({ containerId: "c1", folderPath: "Docs" }) },
    { name: "content_search", call: () => searchContentTool.handler({ query: "report" }) },
    { name: "content_file_preview", call: () => previewFileTool.handler({ containerId: "c1", filePath: "f.txt" }) },
    { name: "content_sharing_manage", call: () => manageSharingTool.handler({ containerId: "c1", filePath: "f.txt", action: "list" }) },
    { name: "content_sample_seed", call: () => seedSampleDataTool.handler({ containerTypeId: "ct1" }) },
  ];

  describe("blocks when content access has NOT been granted", () => {
    beforeEach(() => {
      stateStore.contentAccessGranted = false;
    });

    for (const { name, call } of gatedTools) {
      it(`${name} fails closed with actionable guidance`, async () => {
        const r = await call();
        expect(r.isError).toBe(true);
        expect(r.content[0].text).toContain("Content access not enabled");
        expect(r.content[0].text).toContain("content_access_grant");
        // Must short-circuit before touching Graph.
        expect(graph.getContainerDrive).not.toHaveBeenCalled();
        expect(graph.searchContent).not.toHaveBeenCalled();
      });
    }

    it("does not treat a missing flag as granted (fail closed by default)", async () => {
      delete stateStore.contentAccessGranted;
      const r = await uploadFileTool.handler({ containerId: "c1", fileName: "f.txt", content: "x" });
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toContain("Content access not enabled");
    });
  });

  describe("allows when content access HAS been granted", () => {
    beforeEach(() => {
      stateStore.contentAccessGranted = true;
    });

    it("content_file_upload proceeds to Graph once opted-in", async () => {
      vi.mocked(graph.getContainerDrive).mockResolvedValue({ id: "d1" });
      vi.mocked(graph.uploadSmallFile).mockResolvedValue({ id: "i1", name: "f.txt", size: 1 });
      const r = await uploadFileTool.handler({ containerId: "c1", fileName: "f.txt", content: "x" });
      expect(r.isError).toBeFalsy();
      expect(r.content[0].text).toContain("File Uploaded");
      expect(graph.getContainerDrive).toHaveBeenCalled();
    });

    it("content_search proceeds to Graph once opted-in", async () => {
      vi.mocked(graph.searchContent).mockResolvedValue({
        value: [{ hitsContainers: [{ total: 0, hits: [] }] }],
      });
      const r = await searchContentTool.handler({ query: "anything" });
      expect(r.isError).toBeFalsy();
      expect(graph.searchContent).toHaveBeenCalled();
    });
  });
});
