// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as graph from "./graph-client.js";

const mocks = vi.hoisted(() => ({
  token: vi.fn(),
  readState: vi.fn(),
  writeState: vi.fn(),
}));
vi.mock("./auth.js", () => ({ getAccessToken: mocks.token }));
vi.mock("./state.js", () => ({ readState: mocks.readState, writeState: mocks.writeState }));

const fetchMock = vi.fn<typeof fetch>();
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "error").mockImplementation(() => {});
  mocks.token.mockResolvedValue("synthetic-token");
  mocks.readState.mockReturnValue({});
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function response(body: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), { status, headers });
}

describe("Graph response errors and retries", () => {
  it.each([
    [400, "UPSTREAM"], [401, "UNAUTHORIZED"], [403, "FORBIDDEN"],
    [404, "NOT_FOUND"], [409, "CONFLICT"],
  ])("maps HTTP %s to %s without retrying", async (status, code) => {
    fetchMock.mockResolvedValue(response({ error: { message: "Graph rejected this request" } }, status));
    await expect(graph.getContainer("ct")).rejects.toMatchObject({ code, status });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mocks.token).toHaveBeenCalledTimes(1);
  });

  it.each([
    [429, "2", "RATE_LIMITED", "Retry after 2 second(s)."],
    [429, null, "RATE_LIMITED", "Wait and retry the request."],
    [503, null, "UPSTREAM", "Retry later."],
  ] as const)("exhausts HTTP %s retries with Retry-After %p", async (status, retryAfter, code, suggestion) => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(async () => response(
      { error: { message: "temporarily unavailable" } }, status,
      retryAfter ? { "Retry-After": retryAfter } : undefined,
    ));
    const request = graph.getContainer("ct");
    const assertion = expect(request).rejects.toMatchObject({
      code, status, suggestion: expect.stringContaining(suggestion),
    });
    await vi.runAllTimersAsync();
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(mocks.token).toHaveBeenCalledTimes(4);
  });

  it("uses Retry-After before falling back to exponential delays", async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(response({}, 429, { "Retry-After": "1" }))
      .mockResolvedValueOnce(response({}, 503))
      .mockResolvedValueOnce(response({ id: "ct" }));
    const request = graph.getContainer("ct");
    await vi.advanceTimersByTimeAsync(999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(3999);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(await request).toEqual({ id: "ct" });
  });

  it("retries network failures with 2/4/8 second backoff and preserves a successful result", async () => {
    vi.useFakeTimers();
    fetchMock.mockRejectedValueOnce(new Error("offline"))
      .mockRejectedValueOnce("offline")
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(response({ id: "recovered" }));
    const request = graph.getContainer("ct");
    for (const [delay, calls] of [[2000, 2], [4000, 3], [8000, 4]]) {
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(fetchMock).toHaveBeenCalledTimes(calls - 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(fetchMock).toHaveBeenCalledTimes(calls);
    }
    expect(await request).toEqual({ id: "recovered" });
  });

  it.each([new Error("offline"), "offline"])("reports exhausted network failures (%p)", async (error) => {
    vi.useFakeTimers();
    fetchMock.mockRejectedValue(error);
    const assertion = expect(graph.getContainer("ct")).rejects.toMatchObject({
      code: "UPSTREAM", message: "Network error calling Graph API: offline",
      safeMessage: "Network error calling Microsoft Graph.",
    });
    await vi.runAllTimersAsync();
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("does not fetch or retry when token acquisition fails", async () => {
    const failure = new Error("no credentials");
    mocks.token.mockRejectedValueOnce(failure);
    await expect(graph.getContainer("ct")).rejects.toBe(failure);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([{ detail: "not nested" }, null])("serializes nonstandard JSON error bodies (%p)", async (body) => {
    fetchMock.mockResolvedValue(response(body, 400));
    await expect(graph.getContainer("ct")).rejects.toMatchObject({
      message: `Graph API error (400): ${JSON.stringify(body)}`,
    });
  });

  it("uses plain text when JSON decoding fails", async () => {
    const errorResponse = response({}, 400);
    vi.spyOn(errorResponse, "json").mockRejectedValue(new Error("not JSON"));
    vi.spyOn(errorResponse, "text").mockResolvedValue("plain error");
    fetchMock.mockResolvedValue(errorResponse);
    await expect(graph.getContainer("ct")).rejects.toMatchObject({
      message: "Graph API error (400): plain error",
    });
  });

  it("uses the existing unknown-error message if neither body decoder succeeds", async () => {
    const errorResponse = response({}, 400);
    vi.spyOn(errorResponse, "json").mockRejectedValue(new Error("not JSON"));
    vi.spyOn(errorResponse, "text").mockRejectedValue(new Error("unreadable"));
    fetchMock.mockResolvedValue(errorResponse);
    await expect(graph.getContainer("ct")).rejects.toMatchObject({
      message: "Graph API error (400): Unknown error",
    });
  });
});

describe("Graph collection unwrapping", () => {
  const collections = [
    ["containers", () => graph.listContainers("type"), "/storage/fileStorage/containers?$filter=containerTypeId eq type"],
    ["deleted containers", () => graph.listDeletedContainers(), "/storage/fileStorage/deletedContainers"],
    ["container permissions", () => graph.listContainerPermissions("ct"), "/storage/fileStorage/containers/ct/permissions"],
    ["drive children", () => graph.listDriveChildren("drive"), "/drives/drive/root/children"],
    ["drive permissions", () => graph.listDriveItemPermissions("drive", "item"), "/drives/drive/items/item/permissions"],
    ["type permissions", () => graph.listContainerTypePermissions("type"), "/storage/fileStorage/containerTypes/type/permissions"],
    ["registrations", () => graph.listContainerTypeRegistrations(), "/storage/fileStorage/containerTypeRegistrations"],
    ["app grants", () => graph.listContainerTypeAppPermissions("type"), "/storage/fileStorage/containerTypeRegistrations/type/applicationPermissionGrants"],
  ] as const;
  it.each(collections)("unwraps %s and defaults a missing value to an empty list", async (_name, call, path) => {
    fetchMock.mockResolvedValueOnce(response({ value: [{ id: "entry" }] }))
      .mockResolvedValueOnce(response({}));
    expect(await call()).toEqual([{ id: "entry" }]);
    expect(await call()).toEqual([]);
    expect(fetchMock.mock.calls[0][0]).toBe(
      `https://graph.microsoft.com/${_name === "type permissions" ? "beta" : "v1.0"}${path}`,
    );
    expect(fetchMock.mock.calls[0][1]?.method).toBe("GET");
  });

  it("selects filtered recycle-bin and nested-folder endpoints", async () => {
    fetchMock.mockImplementation(async () => response({ value: [] }));
    await graph.listDeletedContainers("type");
    await graph.listDriveChildren("drive", "folder");
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "https://graph.microsoft.com/v1.0/storage/fileStorage/deletedContainers?$filter=containerTypeId eq type",
      "https://graph.microsoft.com/v1.0/drives/drive/items/folder/children",
    ]);
  });
});

describe("Graph request bodies and normalization", () => {
  it.each([
    [{ id: "id", name: "name", owningAppId: "owner" }, { containerTypeId: "id", displayName: "name", owningAppId: "owner" }],
    [{ id: "id", name: "name", containerTypeId: "preferred", displayName: "preferred name" },
      { containerTypeId: "preferred", displayName: "preferred name", owningAppId: "" }],
    [{}, { containerTypeId: "", displayName: "", owningAppId: "" }],
  ])("normalizes container-type payload %p", async (raw, expected) => {
    fetchMock.mockResolvedValueOnce(response(raw));
    expect(await graph.getContainerType("type")).toMatchObject(expected);
  });

  it.each([undefined, "trial", "standard", "directToCustomer"] as const)(
    "creates container types with optional billing classification %p", async (billingClassification) => {
      fetchMock.mockResolvedValueOnce(response({ id: "created", name: "Type" }));
      const created = await graph.createContainerType({
        displayName: "Type", owningAppId: "owner", billingClassification,
        azureSubscriptionId: "not-sent", resourceGroup: "not-sent", region: "not-sent",
      });
      expect(created.containerTypeId).toBe("created");
      expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
        name: "Type", owningAppId: "owner", ...(billingClassification ? { billingClassification } : {}),
      });
      expect(fetchMock.mock.calls[0][0]).toBe("https://graph.microsoft.com/beta/storage/fileStorage/containerTypes");
    },
  );

  it.each([
    [{}, {}],
    [{ displayName: "" }, { displayName: "" }],
    [{ description: "" }, { description: "" }],
    [{ displayName: "Renamed", description: "Updated" }, { displayName: "Renamed", description: "Updated" }],
  ])("sends only explicitly supplied container fields (%p)", async (patch, expected) => {
    fetchMock.mockResolvedValueOnce(response({ id: "ct", ...expected }));
    expect(await graph.updateContainer("ct", patch)).toEqual({ id: "ct", ...expected });
    expect(fetchMock.mock.calls[0][1]?.method).toBe("PATCH");
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual(expected);
  });

  it.each(["root", "nested"])("creates folders under %s with conflict behavior intact", async (parent) => {
    fetchMock.mockResolvedValueOnce(response({ id: "folder" }));
    expect(await graph.createFolder("drive", parent, "New Folder")).toEqual({ id: "folder" });
    expect(fetchMock.mock.calls[0][0]).toBe(`https://graph.microsoft.com/v1.0/drives/drive/${
      parent === "root" ? "root" : "items/nested"
    }/children`);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
      name: "New Folder", folder: {}, "@microsoft.graph.conflictBehavior": "fail",
    });
  });

  it("preserves raw upload content and the caller's content type", async () => {
    fetchMock.mockResolvedValueOnce(response({ id: "file" }));
    expect(await graph.uploadSmallFile("drive", "/file.txt", "raw text")).toEqual({ id: "file" });
    const options = fetchMock.mock.calls[0][1];
    expect(options?.body).toBe("raw text");
    expect(new Headers(options?.headers).get("Content-Type")).toBe("text/plain");
    expect(new Headers(options?.headers).get("Authorization")).toBe("Bearer synthetic-token");
  });

  it("does not parse a 204 delete response", async () => {
    const empty = response(null, 204);
    const json = vi.spyOn(empty, "json");
    fetchMock.mockResolvedValueOnce(empty);
    await expect(graph.deleteContainer("ct")).resolves.toBeUndefined();
    expect(json).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls[0][1]?.method).toBe("DELETE");
  });

  it("supplies the default search window and respects explicit pagination", async () => {
    fetchMock.mockImplementation(async () => response({ value: [] }));
    await graph.searchContent("SPE");
    await graph.searchContent("SPE", 10, 20);
    const requests = fetchMock.mock.calls.map(([, options]) =>
      JSON.parse(String(options?.body)).requests[0]);
    expect(requests).toEqual([
      { entityTypes: ["driveItem"], query: { queryString: "SPE", includeHiddenContent: true }, from: 0, size: 25 },
      { entityTypes: ["driveItem"], query: { queryString: "SPE", includeHiddenContent: true }, from: 20, size: 10 },
    ]);
  });

  it("preserves list results when persisting enumeration capability fails", async () => {
    mocks.writeState.mockImplementationOnce(() => { throw new Error("read only"); });
    fetchMock.mockResolvedValueOnce(response({ value: [{ id: "type", name: "Type" }] }));
    expect(await graph.listContainerTypes()).toEqual([
      { id: "type", name: "Type", containerTypeId: "type", displayName: "Type", owningAppId: "" },
    ]);
    expect(mocks.writeState).toHaveBeenCalledWith({ owningAppManagesAllContainerTypes: true });
  });
});
