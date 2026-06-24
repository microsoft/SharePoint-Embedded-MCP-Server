// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Unit tests for owning-app permission handling in graph-client.ts.
 *
 * Covers the SPAC owning-app delegated-scope parity gaps:
 *   G1 — addSpePermissions MERGES into existing requiredResourceAccess instead
 *        of replacing it (preserves unrelated permissions; idempotent).
 *   G2 — the desired scope set includes FileStorageContainerTypeReg.Selected.
 *   G3 — findApplicationByAppId resolves apps by appId, and the attach/reuse
 *        path adds permissions best-effort (non-blocking on failure).
 *
 * The global fetch is mocked so these run fully offline.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  addSpePermissions,
  addSpaRedirectUris,
  createApplication,
  findApplicationByAppId,
  findApplicationByName,
  LOCAL_SPA_REDIRECT_URI,
} from "./graph-client.js";

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

beforeEach(() => {
  fetchMock = vi.fn();
  global.fetch = fetchMock as unknown as typeof fetch;
  // Silence (and allow assertions on) the [Graph] logger.
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
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

describe("addSpePermissions — G2 scope parity", () => {
  it("includes FileStorageContainerTypeReg.Selected without removing the .Manage.All scopes", async () => {
    fetchMock
      .mockResolvedValueOnce(okResponse({ requiredResourceAccess: [] }))
      .mockResolvedValueOnce(okResponse({}, 204));

    await addSpePermissions("obj-5", getToken);

    const graphIds = graphEntry(patchedRequiredResourceAccess(1))!.resourceAccess.map(
      (a) => a.id,
    );
    expect(graphIds).toContain(IDS.fsctrSelected); // newly added
    expect(graphIds).toContain(IDS.fscManage); // .Manage.All retained
    expect(graphIds).toContain(IDS.fsctManage);
    expect(graphIds).toContain(IDS.fsctrManage);
  });
});

describe("addSpePermissions — G3 best-effort attach path", () => {
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
