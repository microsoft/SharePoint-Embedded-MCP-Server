// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Unit tests for owning-app permission handling in graph-client.ts
 * (addSpePermissions / addSpaRedirectUris / findApplicationByAppId /
 * updateContainerType).
 *
 * Each behavior under test is documented on its own describe/it block below, so
 * this header stays a short pointer rather than a per-test index that rots as
 * cases are added. The global fetch is mocked so these run fully offline.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  addSpePermissions,
  addSpaRedirectUris,
  createApplication,
  findApplicationByAppId,
  findApplicationByName,
  updateContainerType,
  registerContainerType,
  listContainerTypes,
  desiredGraphResourceAccess,
  LOCAL_SPA_REDIRECT_URI,
} from "./graph-client.js";

// updateContainerType uses the default getAccessToken (MSAL); mock it so the
// container-type update tests run fully offline. The other tests here pass an
// explicit getToken and are unaffected.
vi.mock("./auth.js", () => ({ getAccessToken: vi.fn(async () => "test-token") }));

// graph-client now imports readState/writeState (for the container-type
// staleness flag — PR #3 review). Mock ./state.js so listContainerTypes /
// registerContainerType never touch the real on-disk state file, and so we can
// assert the flag writes. `vi.hoisted` lets the mock factory share one in-memory
// store that the tests read/reset.
const { stateStore, readStateMock, writeStateMock } = vi.hoisted(() => {
  const store: Record<string, unknown> = {};
  return {
    stateStore: store,
    readStateMock: vi.fn(() => ({ ...store })),
    writeStateMock: vi.fn((patch: Record<string, unknown>) => {
      Object.assign(store, patch);
    }),
  };
});
vi.mock("./state.js", () => ({ readState: readStateMock, writeState: writeStateMock }));

const GRAPH_RESOURCE_APP_ID = "00000003-0000-0000-c000-000000000000";
const IDS = {
  fscManage: "527b6d64-cdf5-4b8b-b336-4aa0b8ca2ce5",
  fscSelected: "085ca537-6565-41c2-aca7-db852babc212",
  fsctManage: "8e6ec84c-5fcd-4cc7-ac8a-2296efc0ed9b",
  fsctrManage: "c319a7df-930e-44c0-a43b-7e5e9c7f4f24",
  fsctrSelected: "d1e4f63a-1569-475c-b9b2-bdc140405e38",
};
const DESIRED_IDS = [
  IDS.fscManage,
  IDS.fscSelected,
  IDS.fsctManage,
  IDS.fsctrManage,
  IDS.fsctrSelected,
];

const getToken = async () => "test-token";

interface ResourceAccess {
  id: string;
  type: string;
}
interface RequiredResourceAccess {
  resourceAppId: string;
  resourceAccess: ResourceAccess[];
}

function okResponse(body: unknown, status = 200): Response {
  return {
    ok: true,
    status,
    headers: { get: () => null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function errResponse(status: number, message: string): Response {
  return {
    ok: false,
    status,
    headers: { get: () => null },
    json: async () => ({ error: { message } }),
    text: async () => message,
  } as unknown as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;
// Capture the real global fetch so teardown can restore it. Assigning
// `globalThis.fetch` directly (below) is a raw property mutation that
// vi.restoreAllMocks() does NOT undo, so without this the mock would leak past
// this file. Request shape (method/URL/body) is asserted on fetchMock.mock.calls
// throughout the suite.
const realFetch = globalThis.fetch;

beforeEach(() => {
  fetchMock = vi.fn();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  // Silence (and allow assertions on) the [Graph] logger.
  vi.spyOn(console, "error").mockImplementation(() => {});
  // Reset the shared in-memory state store + its mocks between tests.
  for (const key of Object.keys(stateStore)) delete stateStore[key];
  readStateMock.mockClear();
  writeStateMock.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks(); // restores the console.error spy
  globalThis.fetch = realFetch; // restore the directly-mutated global fetch
});

/** Parse the requiredResourceAccess PATCH body from the Nth fetch call. */
function patchedRequiredResourceAccess(callIndex: number): RequiredResourceAccess[] {
  const call = fetchMock.mock.calls[callIndex];
  const init = call[1] as RequestInit;
  const parsed = JSON.parse(init.body as string) as {
    requiredResourceAccess: RequiredResourceAccess[];
  };
  return parsed.requiredResourceAccess;
}

function graphEntry(rra: RequiredResourceAccess[]): RequiredResourceAccess | undefined {
  return rra.find(
    (e) => e.resourceAppId.toLowerCase() === GRAPH_RESOURCE_APP_ID.toLowerCase(),
  );
}

describe("updateContainerType — supplies the required etag", () => {
  it("fetches the current etag via Get and includes it in the PATCH body", async () => {
    fetchMock
      .mockResolvedValueOnce(
        okResponse({ id: "ct-1", name: "Old Name", owningAppId: "app-1", etag: "ETAG-123" }),
      ) // GET (read current etag)
      .mockResolvedValueOnce(
        okResponse({ id: "ct-1", name: "New Name", owningAppId: "app-1", etag: "ETAG-124" }),
      ); // PATCH

    await updateContainerType("ct-1", { name: "New Name" });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [getUrl, getInit] = fetchMock.mock.calls[0];
    expect((getInit as RequestInit).method).toBe("GET");
    expect(getUrl).toContain("/storage/fileStorage/containerTypes/ct-1");
    const [patchUrl, patchInit] = fetchMock.mock.calls[1];
    expect((patchInit as RequestInit).method).toBe("PATCH");
    expect(patchUrl).toContain("/storage/fileStorage/containerTypes/ct-1");
    // The required etag (read from the Get) is merged into the update body.
    expect(JSON.parse((patchInit as RequestInit).body as string)).toEqual({
      name: "New Name",
      etag: "ETAG-123",
    });
  });

  it("IGNORES a caller-supplied etag and overwrites it with the fresh server etag (WI-08 hardening)", async () => {
    fetchMock
      .mockResolvedValueOnce(
        okResponse({ id: "ct-1", name: "Old Name", owningAppId: "app-1", etag: "ETAG-123" }),
      ) // GET (read current etag — always performed)
      .mockResolvedValueOnce(
        okResponse({ id: "ct-1", name: "New Name", owningAppId: "app-1", etag: "ETAG-124" }),
      ); // PATCH

    // Caller passes a (potentially stale) etag; it must be dropped, and a fresh
    // GET must still happen so the PATCH carries the current server etag.
    await updateContainerType("ct-1", { name: "New Name", etag: "CALLER-STALE-ETAG" });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [getUrl, getInit] = fetchMock.mock.calls[0];
    expect((getInit as RequestInit).method).toBe("GET");
    expect(getUrl).toContain("/storage/fileStorage/containerTypes/ct-1");
    const [, patchInit] = fetchMock.mock.calls[1];
    expect((patchInit as RequestInit).method).toBe("PATCH");
    const patchBody = JSON.parse((patchInit as RequestInit).body as string);
    // The caller etag is discarded; the server etag from the GET wins.
    expect(patchBody).toEqual({ name: "New Name", etag: "ETAG-123" });
    expect(patchBody.etag).not.toBe("CALLER-STALE-ETAG");
  });

  it("normalizes a 204 No Content PATCH response to a populated container type", async () => {
    fetchMock
      .mockResolvedValueOnce(
        okResponse({ id: "ct-1", name: "Old Name", owningAppId: "app-1", etag: "ETAG-123" }),
      ) // GET
      .mockResolvedValueOnce(okResponse(null, 204)); // PATCH → 204 No Content

    const result = await updateContainerType("ct-1", { name: "New Name" });
    // Should not throw; normalizeContainerType({}) yields a defined object.
    expect(result).toBeDefined();
  });
});

describe("addSpePermissions — G1 merge (non-destructive)", () => {
  it("preserves an unrelated permission and a pre-existing SPE subset, adds the rest exactly once", async () => {
    const existing: RequiredResourceAccess[] = [
      // (a) unrelated resourceApp permission that must survive.
      {
        resourceAppId: "11111111-2222-3333-4444-555555555555",
        resourceAccess: [{ id: "aaaaaaaa-0000-0000-0000-000000000000", type: "Role" }],
      },
      // (b) a subset of the SPE scopes already present.
      {
        resourceAppId: GRAPH_RESOURCE_APP_ID,
        resourceAccess: [{ id: IDS.fscManage, type: "Scope" }],
      },
    ];

    fetchMock
      .mockResolvedValueOnce(okResponse({ requiredResourceAccess: existing })) // GET
      .mockResolvedValueOnce(okResponse({}, 204)); // PATCH

    await addSpePermissions("obj-1", getToken);

    // GET then PATCH.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [getUrl, getInit] = fetchMock.mock.calls[0];
    expect(getInit.method).toBe("GET");
    expect(getUrl).toContain("/applications/obj-1");
    expect(getUrl).toContain("$select=requiredResourceAccess");
    expect(fetchMock.mock.calls[1][1].method).toBe("PATCH");

    const patched = patchedRequiredResourceAccess(1);

    // Unrelated permission preserved.
    const unrelated = patched.find(
      (e) => e.resourceAppId === "11111111-2222-3333-4444-555555555555",
    );
    expect(unrelated).toBeDefined();
    expect(unrelated!.resourceAccess).toEqual([
      { id: "aaaaaaaa-0000-0000-0000-000000000000", type: "Role" },
    ]);

    // All desired SPE scopes present exactly once on the Graph entry.
    const graph = graphEntry(patched)!;
    expect(graph).toBeDefined();
    const graphIds = graph.resourceAccess.map((a) => a.id);
    for (const id of DESIRED_IDS) {
      expect(graphIds.filter((g) => g === id)).toHaveLength(1);
    }
    // No duplicates overall.
    expect(new Set(graphIds).size).toBe(graphIds.length);
    // FSCTR.Selected (G2) is included.
    expect(graphIds).toContain(IDS.fsctrSelected);
  });

  it("adds a Graph resourceApp entry when the app has none", async () => {
    fetchMock
      .mockResolvedValueOnce(okResponse({ requiredResourceAccess: [] }))
      .mockResolvedValueOnce(okResponse({}, 204));

    await addSpePermissions("obj-2", getToken);

    const graph = graphEntry(patchedRequiredResourceAccess(1))!;
    expect(graph.resourceAccess.map((a) => a.id).sort()).toEqual([...DESIRED_IDS].sort());
    expect(graph.resourceAccess.every((a) => a.type === "Scope")).toBe(true);
  });

  it("is idempotent — re-applying when all scopes already exist adds no duplicates", async () => {
    const existing: RequiredResourceAccess[] = [
      {
        resourceAppId: GRAPH_RESOURCE_APP_ID,
        resourceAccess: DESIRED_IDS.map((id) => ({ id, type: "Scope" })),
      },
    ];

    fetchMock
      .mockResolvedValueOnce(okResponse({ requiredResourceAccess: existing }))
      .mockResolvedValueOnce(okResponse({}, 204));

    await addSpePermissions("obj-3", getToken);

    const graph = graphEntry(patchedRequiredResourceAccess(1))!;
    expect(graph.resourceAccess).toHaveLength(DESIRED_IDS.length);
    expect(new Set(graph.resourceAccess.map((a) => a.id)).size).toBe(DESIRED_IDS.length);
  });

  it("handles an app with no requiredResourceAccess field at all", async () => {
    fetchMock
      .mockResolvedValueOnce(okResponse({})) // no requiredResourceAccess key
      .mockResolvedValueOnce(okResponse({}, 204));

    await addSpePermissions("obj-4", getToken);

    const graph = graphEntry(patchedRequiredResourceAccess(1))!;
    expect(graph.resourceAccess.map((a) => a.id).sort()).toEqual([...DESIRED_IDS].sort());
  });
});

describe("addSpePermissions — G2 scope parity (intent-based least privilege)", () => {
  // The scope set is now a function of the captured owner intent (PR #3 review):
  // "manage-all" requests the broad .Manage.All set; "selected" requests only the
  // least-privilege .Selected pair (+ the delegated-only ContainerType.Manage.All,
  // which has no .Selected/app-only form and is required to create/enumerate CTs).

  it("manage-all keeps the broad .Manage.All scopes plus FileStorageContainerTypeReg.Selected", async () => {
    fetchMock
      .mockResolvedValueOnce(okResponse({ requiredResourceAccess: [] }))
      .mockResolvedValueOnce(okResponse({}, 204));

    await addSpePermissions("obj-5", getToken, { ownerScope: "manage-all" });

    const graphIds = graphEntry(patchedRequiredResourceAccess(1))!.resourceAccess.map(
      (a) => a.id,
    );
    expect(graphIds).toContain(IDS.fsctrSelected); // parity scope
    expect(graphIds).toContain(IDS.fscManage); // .Manage.All retained
    expect(graphIds).toContain(IDS.fsctManage);
    expect(graphIds).toContain(IDS.fsctrManage);
    expect(graphIds.map((id) => id).sort()).toEqual([...DESIRED_IDS].sort());
  });

  it("defaults to the broad manage-all set when no ownerScope is passed (back-compat)", async () => {
    fetchMock
      .mockResolvedValueOnce(okResponse({ requiredResourceAccess: [] }))
      .mockResolvedValueOnce(okResponse({}, 204));

    await addSpePermissions("obj-5d", getToken);

    const graphIds = graphEntry(patchedRequiredResourceAccess(1))!.resourceAccess.map(
      (a) => a.id,
    );
    expect(graphIds.sort()).toEqual([...DESIRED_IDS].sort());
  });

  it("selected requests only the least-privilege scopes and OMITS the broad Container/Reg .Manage.All scopes", async () => {
    fetchMock
      .mockResolvedValueOnce(okResponse({ requiredResourceAccess: [] }))
      .mockResolvedValueOnce(okResponse({}, 204));

    await addSpePermissions("obj-5s", getToken, { ownerScope: "selected" });

    const graphIds = graphEntry(patchedRequiredResourceAccess(1))!.resourceAccess.map(
      (a) => a.id,
    );
    // Least-privilege trio present…
    expect(graphIds).toContain(IDS.fscSelected);
    expect(graphIds).toContain(IDS.fsctrSelected);
    // …including the unavoidable delegated-only ContainerType.Manage.All (no
    // .Selected/app-only counterpart; required for CT create/enumerate).
    expect(graphIds).toContain(IDS.fsctManage);
    // Broad Container/Reg .Manage.All scopes are NOT requested.
    expect(graphIds).not.toContain(IDS.fscManage);
    expect(graphIds).not.toContain(IDS.fsctrManage);
    expect(graphIds.sort()).toEqual(
      [IDS.fscSelected, IDS.fsctManage, IDS.fsctrSelected].sort(),
    );
  });

  it("merge stays non-destructive for a reused broad app even when ownerScope is selected (never downgrades)", async () => {
    // A pre-existing app already holding the broad .Manage.All scopes must NOT be
    // stripped down when a later selected-intent run merges — merge only ADDS.
    const existing: RequiredResourceAccess[] = [
      {
        resourceAppId: GRAPH_RESOURCE_APP_ID,
        resourceAccess: DESIRED_IDS.map((id) => ({ id, type: "Scope" })),
      },
    ];
    fetchMock
      .mockResolvedValueOnce(okResponse({ requiredResourceAccess: existing }))
      .mockResolvedValueOnce(okResponse({}, 204));

    await addSpePermissions("obj-5m", getToken, { ownerScope: "selected" });

    const graphIds = graphEntry(patchedRequiredResourceAccess(1))!.resourceAccess.map(
      (a) => a.id,
    );
    // Still holds every broad scope — nothing was removed.
    expect(graphIds.sort()).toEqual([...DESIRED_IDS].sort());
  });
});

describe("desiredGraphResourceAccess — intent → scope mapping (PR #3 review)", () => {
  it("selected → least-privilege trio, keeps ContainerType.Manage.All, omits broad Container/Reg .Manage.All", () => {
    const ids = desiredGraphResourceAccess("selected").map((a) => a.id);
    expect(ids.sort()).toEqual([IDS.fscSelected, IDS.fsctManage, IDS.fsctrSelected].sort());
    expect(ids).toContain(IDS.fsctManage);
    expect(ids).not.toContain(IDS.fscManage);
    expect(ids).not.toContain(IDS.fsctrManage);
  });

  it("manage-all → the full broad scope set", () => {
    const ids = desiredGraphResourceAccess("manage-all").map((a) => a.id);
    expect(ids.sort()).toEqual([...DESIRED_IDS].sort());
  });

  it("every entry is a delegated Scope (never an app-only Role)", () => {
    for (const scope of ["selected", "manage-all"] as const) {
      expect(desiredGraphResourceAccess(scope).every((a) => a.type === "Scope")).toBe(true);
    }
  });
});

describe("registerContainerType — app-only default ['none'] + re-grant preservation (PR #3 review)", () => {
  // The full-setup path uses ONLY delegated tokens (no app-only token path), so
  // the owning app needs no app-only grant. app-only permissions default to
  // ["none"] and are opt-in. The registration PUT REPLACES the whole
  // applicationPermissionGrants collection, so when the caller omits app-only
  // perms we read-merge any grant the app already holds rather than revoke it.

  /** Parse the PUT registration body from the Nth fetch call. */
  function putGrant(callIndex: number) {
    const init = fetchMock.mock.calls[callIndex][1] as RequestInit;
    const parsed = JSON.parse(init.body as string) as {
      applicationPermissionGrants: {
        appId: string;
        delegatedPermissions: string[];
        applicationPermissions: string[];
      }[];
    };
    return parsed.applicationPermissionGrants[0];
  }

  it("defaults application permissions to ['none'] (delegated stays ['full'])", async () => {
    fetchMock
      // GET existing grants (read-merge lookup) → none yet.
      .mockResolvedValueOnce(okResponse({ value: [] }))
      // PUT registration.
      .mockResolvedValueOnce(okResponse({}, 204));

    await registerContainerType("ct-1", "app-1");

    // GET (grants) then PUT (registration).
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [putUrl, putInit] = fetchMock.mock.calls[1];
    expect((putInit as RequestInit).method).toBe("PUT");
    expect(putUrl).toContain("/storage/fileStorage/containerTypeRegistrations/ct-1");
    const grant = putGrant(1);
    expect(grant.appId).toBe("app-1");
    expect(grant.delegatedPermissions).toEqual(["full"]);
    expect(grant.applicationPermissions).toEqual(["none"]);
  });

  it("opt-in ['full'] writes an app-only grant and skips the read-merge lookup", async () => {
    // Explicit app-only perms → single PUT, no preceding GET.
    fetchMock.mockResolvedValueOnce(okResponse({}, 204));

    await registerContainerType("ct-1", "app-1", ["full"], ["full"]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const grant = putGrant(0);
    expect(grant.applicationPermissions).toEqual(["full"]);
    expect(grant.delegatedPermissions).toEqual(["full"]);
  });

  it("re-register preserves an existing app-only grant when the caller omits applicationPermissions", async () => {
    // The app already holds an app-only ['full'] grant from a prior daemon setup.
    fetchMock
      .mockResolvedValueOnce(
        okResponse({
          value: [
            { appId: "APP-1", delegatedPermissions: ["full"], applicationPermissions: ["full"] },
          ],
        }),
      )
      .mockResolvedValueOnce(okResponse({}, 204));

    // Caller omits app-only perms → must NOT silently revoke the prior grant.
    await registerContainerType("ct-1", "app-1");

    const grant = putGrant(1);
    expect(grant.applicationPermissions).toEqual(["full"]); // preserved, case-insensitive appId match
  });

  it("keeps ['none'] when the read-merge lookup fails (e.g., first registration / 404)", async () => {
    fetchMock
      .mockResolvedValueOnce(errResponse(404, "no registration yet")) // GET grants → 404
      .mockResolvedValueOnce(okResponse({}, 204)); // PUT

    await registerContainerType("ct-1", "app-1");

    expect(putGrant(1).applicationPermissions).toEqual(["none"]);
  });
});

describe("listContainerTypes — runtime staleness-flag self-heal (PR #3 review)", () => {
  it("records owningAppManagesAllContainerTypes=true on a successful enumerate", async () => {
    fetchMock.mockResolvedValueOnce(
      okResponse({ value: [{ id: "ct-1", name: "CT One", owningAppId: "app-1" }] }),
    );

    const result = await listContainerTypes();

    expect(result).toHaveLength(1);
    expect(writeStateMock).toHaveBeenCalledWith({ owningAppManagesAllContainerTypes: true });
    expect(stateStore.owningAppManagesAllContainerTypes).toBe(true);
  });

  it("records owningAppManagesAllContainerTypes=false on a 403 and rethrows the original error", async () => {
    fetchMock.mockResolvedValueOnce(errResponse(403, "insufficient privileges"));

    await expect(listContainerTypes()).rejects.toThrow(/Access denied/);

    expect(writeStateMock).toHaveBeenCalledWith({ owningAppManagesAllContainerTypes: false });
    expect(stateStore.owningAppManagesAllContainerTypes).toBe(false);
  });

  it("does not re-write the flag when it already matches (no churn)", async () => {
    stateStore.owningAppManagesAllContainerTypes = true;
    fetchMock.mockResolvedValueOnce(okResponse({ value: [] }));

    await listContainerTypes();

    expect(writeStateMock).not.toHaveBeenCalled();
  });
});

describe("addSpePermissions — G3 best-effort attach path", () => {
  // bestEffort use case: when reusing an ALREADY-provisioned owning app, the
  // signed-in user may not have rights to edit that app's API permissions.
  // Syncing permissions is a nice-to-have on that path, not a gate — so
  // bestEffort=true makes addSpePermissions swallow + log a Graph failure instead
  // of aborting provisioning. On the create path bestEffort is omitted, so the
  // same failures surface (see the "propagates … when bestEffort is not set" tests).
  it("swallows a PATCH failure and logs when bestEffort=true (attach/reuse path)", async () => {
    fetchMock
      .mockResolvedValueOnce(okResponse({ requiredResourceAccess: [] })) // GET ok
      .mockResolvedValueOnce(errResponse(403, "Insufficient privileges")); // PATCH fails

    await expect(
      addSpePermissions("obj-6", getToken, { bestEffort: true }),
    ).resolves.toBeUndefined();

    const logged = (console.error as unknown as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => c.join(" "))
      .join("\n");
    expect(logged).toContain("best-effort");
  });

  it("swallows a GET failure too when bestEffort=true", async () => {
    fetchMock.mockResolvedValueOnce(errResponse(403, "Insufficient privileges"));

    await expect(
      addSpePermissions("obj-7", getToken, { bestEffort: true }),
    ).resolves.toBeUndefined();
  });

  it("propagates a PATCH failure on the strict (create-new) path", async () => {
    fetchMock
      .mockResolvedValueOnce(okResponse({ requiredResourceAccess: [] }))
      .mockResolvedValueOnce(errResponse(403, "Insufficient privileges"));

    await expect(addSpePermissions("obj-8", getToken)).rejects.toThrow(/Access denied/);
  });
});

describe("findApplicationByAppId — G3 appId resolution", () => {
  it("resolves an app by appId and maps it to the OwningApp shape", async () => {
    fetchMock.mockResolvedValueOnce(
      okResponse({
        value: [{ id: "obj-9", appId: "app-9", displayName: "Existing App" }],
      }),
    );

    const app = await findApplicationByAppId("app-9", getToken);

    expect(app).toEqual({ objectId: "obj-9", appId: "app-9", displayName: "Existing App" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(init.method).toBe("GET");
    // Filters on appId, not displayName.
    expect(decodeURIComponent(url as string)).toContain("appId eq 'app-9'");
  });

  it("returns null when no app matches the appId", async () => {
    fetchMock.mockResolvedValueOnce(okResponse({ value: [] }));
    expect(await findApplicationByAppId("missing", getToken)).toBeNull();
  });

  it("findApplicationByName still filters on displayName (regression)", async () => {
    fetchMock.mockResolvedValueOnce(okResponse({ value: [] }));
    await findApplicationByName("My App", getToken);
    const url = fetchMock.mock.calls[0][0] as string;
    expect(decodeURIComponent(url)).toContain("displayName eq 'My App'");
  });
});

/** Parse the JSON request body of the Nth fetch call. */
function requestBody<T>(callIndex: number): T {
  const init = fetchMock.mock.calls[callIndex][1] as RequestInit;
  return JSON.parse(init.body as string) as T;
}

describe("createApplication — SPA platform", () => {
  interface CreateBody {
    displayName: string;
    signInAudience: string;
    isFallbackPublicClient?: boolean;
    publicClient?: { redirectUris?: string[] };
    spa?: { redirectUris?: string[] };
  }

  it("registers a `spa` platform with the local Vite origin (fixes AADSTS9002326)", async () => {
    fetchMock.mockResolvedValueOnce(
      okResponse({ id: "obj-new", appId: "app-new", displayName: "SPE Builder App" }),
    );

    const app = await createApplication("SPE Builder App", getToken);
    expect(app).toEqual({ objectId: "obj-new", appId: "app-new", displayName: "SPE Builder App" });

    const [url, init] = fetchMock.mock.calls[0];
    expect(init.method).toBe("POST");
    expect(url).toContain("/applications");

    const body = requestBody<CreateBody>(0);
    // The browser SPA's MSAL.js auth-code + PKCE redirect origin.
    expect(body.spa?.redirectUris).toContain("http://localhost:5173");
    expect(body.spa?.redirectUris).toContain(LOCAL_SPA_REDIRECT_URI);
  });

  it("is ADDITIVE — preserves publicClient loopback and isFallbackPublicClient for the CLI flow", async () => {
    fetchMock.mockResolvedValueOnce(
      okResponse({ id: "obj-new2", appId: "app-new2", displayName: "SPE Builder App" }),
    );

    await createApplication("SPE Builder App", getToken);

    const body = requestBody<CreateBody>(0);
    // publicClient loopback (MCP CLI desktop public-client flow) must remain.
    expect(body.publicClient?.redirectUris).toEqual(["http://localhost"]);
    expect(body.isFallbackPublicClient).toBe(true);
    expect(body.signInAudience).toBe("AzureADMyOrg");
    // Both platforms coexist — neither replaces the other.
    expect(body.publicClient?.redirectUris).not.toContain("http://localhost:5173");
    expect(body.spa?.redirectUris).not.toContain("http://localhost");
  });
});

describe("addSpaRedirectUris — deployed-origin patch", () => {
  const DEPLOYED = "https://delightful-coast-0ac296a1e.7.azurestaticapps.net";

  it("appends a deployed origin without dropping the existing local SPA redirect URI", async () => {
    fetchMock
      .mockResolvedValueOnce(okResponse({ spa: { redirectUris: ["http://localhost:5173"] } })) // GET
      .mockResolvedValueOnce(okResponse({}, 204)); // PATCH

    const result = await addSpaRedirectUris("obj-spa", [DEPLOYED], getToken);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][1].method).toBe("GET");
    expect(fetchMock.mock.calls[0][0]).toContain("$select=spa");
    expect(fetchMock.mock.calls[1][1].method).toBe("PATCH");

    const body = requestBody<{ spa: { redirectUris: string[] } }>(1);
    // Existing local dev origin preserved; deployed origin appended.
    expect(body.spa.redirectUris).toEqual(["http://localhost:5173", DEPLOYED]);
    expect(result).toEqual({
      added: [DEPLOYED],
      redirectUris: ["http://localhost:5173", DEPLOYED],
    });
  });

  it("is idempotent — re-adding an already-registered origin issues no PATCH and drops nothing", async () => {
    fetchMock.mockResolvedValueOnce(
      okResponse({ spa: { redirectUris: ["http://localhost:5173", DEPLOYED] } }), // GET only
    );

    const result = await addSpaRedirectUris("obj-spa", [DEPLOYED], getToken);

    // GET only — no PATCH when nothing changes.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1].method).toBe("GET");
    expect(result).toEqual({
      added: [],
      redirectUris: ["http://localhost:5173", DEPLOYED],
    });
  });

  it("dedupes case- and trailing-slash-insensitively (no duplicate redirect URIs)", async () => {
    fetchMock.mockResolvedValueOnce(
      okResponse({ spa: { redirectUris: [`${DEPLOYED}/`] } }), // stored with trailing slash
    );

    const result = await addSpaRedirectUris("obj-spa", [DEPLOYED], getToken);

    // Same origin modulo trailing slash → treated as present, no PATCH.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result?.added).toEqual([]);
  });

  it("handles an app with no spa platform yet (adds the origin)", async () => {
    fetchMock
      .mockResolvedValueOnce(okResponse({})) // no spa key
      .mockResolvedValueOnce(okResponse({}, 204));

    const result = await addSpaRedirectUris("obj-spa", [DEPLOYED], getToken);

    const body = requestBody<{ spa: { redirectUris: string[] } }>(1);
    expect(body.spa.redirectUris).toEqual([DEPLOYED]);
    expect(result?.added).toEqual([DEPLOYED]);
  });

  it("swallows a PATCH failure when bestEffort=true (non-blocking deploy path)", async () => {
    // bestEffort use case here: registering a deployed SPA redirect URI is a
    // convenience during provisioning. If the caller can't PATCH the app (e.g.
    // insufficient privileges on a reused app), that must not fail the deploy — so
    // bestEffort=true swallows the Graph error and resolves undefined.
    fetchMock
      .mockResolvedValueOnce(okResponse({ spa: { redirectUris: [] } }))
      .mockResolvedValueOnce(errResponse(403, "Insufficient privileges"));

    await expect(
      addSpaRedirectUris("obj-spa", [DEPLOYED], getToken, { bestEffort: true }),
    ).resolves.toBeUndefined();
  });

  it("propagates a PATCH failure when bestEffort is not set", async () => {
    fetchMock
      .mockResolvedValueOnce(okResponse({ spa: { redirectUris: [] } }))
      .mockResolvedValueOnce(errResponse(403, "Insufficient privileges"));

    await expect(addSpaRedirectUris("obj-spa", [DEPLOYED], getToken)).rejects.toThrow(/Access denied/);
  });
});
