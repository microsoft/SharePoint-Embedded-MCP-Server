// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Unit tests for project_app_create (create-app.ts), focused on the reuse/attach
 * path SPA redirect-URI self-repair.
 *
 * Apps created before have no `spa` platform, so the generated browser
 * app's MSAL.js auth-code + PKCE sign-in fails with AADSTS9002326. The fresh-create
 * path sets `spa` via createApplication; the reuse path must self-repair an
 * existing app by calling addSpaRedirectUris(objectId, [LOCAL_SPA_REDIRECT_URI],
 * …, { bestEffort: true }) — idempotently and without failing the tool when the
 * PATCH lacks permission.
 *
 * Graph / bootstrap / auth / state are mocked so nothing hits the network.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { LOCAL_SPA_REDIRECT_URI } from "../constants.js";

const getSignedInIdentityMock = vi.fn();
const findApplicationByAppIdMock = vi.fn();
const findApplicationByNameMock = vi.fn();
const createApplicationMock = vi.fn();
const addSpePermissionsMock = vi.fn();
const addSpaRedirectUrisMock = vi.fn();
const setAuthConfigMock = vi.fn();
const readStateMock = vi.fn();
const writeStateMock = vi.fn();

vi.mock("../bootstrap.js", () => ({
  getSignedInIdentity: () => getSignedInIdentityMock(),
  bootstrapTokenProvider: vi.fn(async () => "boot-token"),
}));

vi.mock("../graph-client.js", () => ({
  addSpaRedirectUris: (...args: unknown[]) => addSpaRedirectUrisMock(...args),
  addSpePermissions: (...args: unknown[]) => addSpePermissionsMock(...args),
  createApplication: (...args: unknown[]) => createApplicationMock(...args),
  findApplicationByAppId: (...args: unknown[]) => findApplicationByAppIdMock(...args),
  findApplicationByName: (...args: unknown[]) => findApplicationByNameMock(...args),
}));

vi.mock("../auth.js", () => ({
  setAuthConfig: (...args: unknown[]) => setAuthConfigMock(...args),
}));

vi.mock("../state.js", () => ({
  readState: () => readStateMock(),
  writeState: (...args: unknown[]) => writeStateMock(...args),
}));

import { createAppTool } from "./create-app.js";
import { getSessionId } from "../session.js";
import {
  wireElicitation,
  resetElicitationForTests,
  type ElicitInputResult,
} from "../elicitation.js";

const EXISTING_APP = {
  appId: "cd7243b7-f00c-4aec-8a96-67e0a15ea5e6",
  objectId: "obj-existing-123",
  displayName: "SPE Builder App",
};

beforeEach(() => {
  vi.clearAllMocks();
  getSignedInIdentityMock.mockResolvedValue({ tenantId: "tenant-1" });
  readStateMock.mockReturnValue({});
  findApplicationByAppIdMock.mockResolvedValue(null);
  findApplicationByNameMock.mockResolvedValue(null);
  addSpePermissionsMock.mockResolvedValue(undefined);
  addSpaRedirectUrisMock.mockResolvedValue({ added: [], redirectUris: [LOCAL_SPA_REDIRECT_URI] });
});

describe("project_app_create — reuse/attach SPA self-repair", () => {
  it("calls addSpaRedirectUris with the existing app's objectId and {bestEffort:true} on reuse", async () => {
    findApplicationByNameMock.mockResolvedValue(EXISTING_APP);

    const r = await createAppTool.handler({});

    expect(r.isError).toBeUndefined();
    expect(addSpaRedirectUrisMock).toHaveBeenCalledTimes(1);
    const [objectId, origins, , options] = addSpaRedirectUrisMock.mock.calls[0];
    expect(objectId).toBe(EXISTING_APP.objectId);
    expect(origins).toEqual([LOCAL_SPA_REDIRECT_URI]);
    expect(options).toEqual({ bestEffort: true });
    // Must not double-apply via the fresh-create path.
    expect(createApplicationMock).not.toHaveBeenCalled();
  });

  it("resolves by persisted appId and self-repairs that app", async () => {
    readStateMock.mockReturnValue({ appId: EXISTING_APP.appId });
    findApplicationByAppIdMock.mockResolvedValue(EXISTING_APP);

    const r = await createAppTool.handler({ appSelection: "reuse" });

    expect(r.content[0].text).toContain("Owning App Found");
    expect(findApplicationByAppIdMock).toHaveBeenCalledWith(EXISTING_APP.appId, expect.anything());
    expect(addSpaRedirectUrisMock).toHaveBeenCalledTimes(1);
    expect(addSpaRedirectUrisMock.mock.calls[0][0]).toBe(EXISTING_APP.objectId);
  });

  it("is an idempotent no-op when the local origin is already registered (tool still succeeds)", async () => {
    findApplicationByNameMock.mockResolvedValue(EXISTING_APP);
    // Helper reports nothing added because the origin is already present.
    addSpaRedirectUrisMock.mockResolvedValue({ added: [], redirectUris: [LOCAL_SPA_REDIRECT_URI] });

    const r = await createAppTool.handler({});

    expect(r.isError).toBeUndefined();
    expect(addSpaRedirectUrisMock).toHaveBeenCalledTimes(1);
  });

  it("swallows a best-effort PATCH failure — the tool still succeeds", async () => {
    findApplicationByNameMock.mockResolvedValue(EXISTING_APP);
    // best-effort failure surfaces as undefined from the helper (it logs + swallows).
    addSpaRedirectUrisMock.mockResolvedValue(undefined);

    const r = await createAppTool.handler({});

    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toContain("Owning App Found");
  });

  it("does NOT self-repair on the fresh-create path (createApplication already sets spa)", async () => {
    findApplicationByNameMock.mockResolvedValue(null);
    createApplicationMock.mockResolvedValue({
      appId: "new-app",
      objectId: "obj-new",
      displayName: "SPE Builder App",
    });

    const r = await createAppTool.handler({});

    expect(r.content[0].text).toContain("Owning App Created");
    expect(createApplicationMock).toHaveBeenCalledTimes(1);
    expect(addSpaRedirectUrisMock).not.toHaveBeenCalled();
  });
});

describe("project_app_create — ask before reusing a remembered app (PM feedback)", () => {
  const REMEMBERED = { appId: "remembered-app-id", appDisplayName: "Contoso Docs App" };

  it("asks (does not silently reuse) when an app is remembered and no displayName/appSelection is given", async () => {
    readStateMock.mockReturnValue(REMEMBERED);

    const r = await createAppTool.handler({});

    // Returns an elicitation, not a resolved app.
    expect(r.isError).toBeFalsy();
    expect(r.content[0].text).toContain("Reuse");
    expect(r.content[0].text).toContain("different app");
    expect(r.content[0].text).toContain("appSelection=reuse");
    expect(r.content[0].text).toContain(REMEMBERED.appDisplayName);
    // Nothing resolved/created; auth not repointed; state untouched.
    expect(findApplicationByAppIdMock).not.toHaveBeenCalled();
    expect(findApplicationByNameMock).not.toHaveBeenCalled();
    expect(createApplicationMock).not.toHaveBeenCalled();
    expect(setAuthConfigMock).not.toHaveBeenCalled();
    expect(writeStateMock).not.toHaveBeenCalled();
  });

  it("reuses the remembered app when appSelection='reuse'", async () => {
    readStateMock.mockReturnValue(REMEMBERED);
    findApplicationByAppIdMock.mockResolvedValue({ ...EXISTING_APP, appId: REMEMBERED.appId });

    const r = await createAppTool.handler({ appSelection: "reuse" });

    expect(r.content[0].text).toContain("Owning App Found");
    expect(findApplicationByAppIdMock).toHaveBeenCalledWith(REMEMBERED.appId, expect.anything());
    expect(findApplicationByNameMock).not.toHaveBeenCalled();
  });

  it("does NOT reuse the remembered appId when appSelection='new' (resolves by name instead)", async () => {
    readStateMock.mockReturnValue(REMEMBERED);
    findApplicationByNameMock.mockResolvedValue(null);
    createApplicationMock.mockResolvedValue({ appId: "fresh-app", objectId: "obj-fresh", displayName: "SPE Builder App" });

    const r = await createAppTool.handler({ appSelection: "new" });

    expect(r.isError).toBeUndefined();
    // Must not resume the remembered id; name-based resolution + create instead.
    expect(findApplicationByAppIdMock).not.toHaveBeenCalled();
    expect(findApplicationByNameMock).toHaveBeenCalledWith("SPE Builder App", expect.anything());
    expect(createApplicationMock).toHaveBeenCalledTimes(1);
  });

  it("an explicit displayName still wins without prompting once the session is CONFIRMED", async () => {
    // r-appgate: an explicit displayName no longer bypasses the always-ask on an
    // UNconfirmed (freshly restarted) session — see the companion test below.
    // Once the context is confirmed under the current session, the explicit-name
    // fast path is restored (no friction mid-session).
    readStateMock.mockReturnValue({ ...REMEMBERED, confirmedSessionId: getSessionId() });
    findApplicationByNameMock.mockResolvedValue({ appId: "named-app", objectId: "obj-named", displayName: "Other App" });

    const r = await createAppTool.handler({ displayName: "Other App" });

    expect(r.content[0].text).toContain("Owning App Found");
    expect(findApplicationByNameMock).toHaveBeenCalledWith("Other App", expect.anything());
    expect(findApplicationByAppIdMock).not.toHaveBeenCalled();
  });

  it("PROMPTS even with an explicit displayName on a freshly restarted (unconfirmed) session", async () => {
    // r-appgate (critical always-ask): a restart is a new process with a new
    // session id, so a remembered app is unconfirmed and the new-vs-existing
    // choice must fire — appSelection (not a name) is the answer, so displayName
    // alone must NOT silently target an app.
    readStateMock.mockReturnValue(REMEMBERED);

    const r = await createAppTool.handler({ displayName: "Other App" });

    expect(r.isError).toBeFalsy();
    expect(r.content[0].text).toContain("appSelection=reuse");
    expect(findApplicationByNameMock).not.toHaveBeenCalled();
    expect(createApplicationMock).not.toHaveBeenCalled();
  });

  it("does NOT prompt on a first run when nothing is remembered", async () => {
    readStateMock.mockReturnValue({});
    findApplicationByNameMock.mockResolvedValue(null);
    createApplicationMock.mockResolvedValue({ appId: "first-app", objectId: "obj-first", displayName: "SPE Builder App" });

    const r = await createAppTool.handler({});

    expect(r.content[0].text).toContain("Owning App Created");
    expect(createApplicationMock).toHaveBeenCalledTimes(1);
  });
});

describe("project_app_create — native elicitation continues in-band (PR #3 review)", () => {
  const REMEMBERED = { appId: "remembered-app-id", appDisplayName: "Contoso Docs App" };

  // These tests wire a fake capability-advertising server so elicitChoice takes
  // the NATIVE path; reset after each so other suites keep the (unwired) fallback.
  afterEach(() => {
    resetElicitationForTests();
  });

  it("CONTINUES with the user's native pick (reuse) instead of returning the choice", async () => {
    readStateMock.mockReturnValue(REMEMBERED);
    findApplicationByAppIdMock.mockResolvedValue({ ...EXISTING_APP, appId: REMEMBERED.appId });

    const elicitInput = vi.fn(
      async (): Promise<ElicitInputResult> => ({ action: "accept", content: { appSelection: "reuse" } }),
    );
    wireElicitation({ elicitInput, getClientCapabilities: () => ({ elicitation: {} }) });

    // No appSelection arg: on a capable client the user is asked natively and we
    // proceed in-band with their answer — no re-invoke, no returned choice text.
    const r = await createAppTool.handler({});

    expect(elicitInput).toHaveBeenCalledTimes(1);
    expect(r.content[0].text).toContain("Owning App Found");
    expect(findApplicationByAppIdMock).toHaveBeenCalledWith(REMEMBERED.appId, expect.anything());
  });

  it("on native 'new' with no explicit name, elicits the new app name and uses it", async () => {
    readStateMock.mockReturnValue(REMEMBERED);
    findApplicationByNameMock.mockResolvedValue(null);
    createApplicationMock.mockResolvedValue({ appId: "fresh-app", objectId: "obj-fresh", displayName: "My New App" });

    // First elicit (appSelection) → "new"; second elicit (displayName) → a name.
    const elicitInput = vi
      .fn<(params: { requestedSchema: { properties: Record<string, unknown> } }) => Promise<ElicitInputResult>>()
      .mockResolvedValueOnce({ action: "accept", content: { appSelection: "new" } })
      .mockResolvedValueOnce({ action: "accept", content: { displayName: "My New App" } });
    wireElicitation({ elicitInput, getClientCapabilities: () => ({ elicitation: {} }) });

    const r = await createAppTool.handler({});

    expect(elicitInput).toHaveBeenCalledTimes(2);
    expect(r.isError).toBeUndefined();
    // The elicited name (not the "SPE Builder App" default) drives resolution.
    expect(findApplicationByNameMock).toHaveBeenCalledWith("My New App", expect.anything());
    expect(createApplicationMock).toHaveBeenCalledWith("My New App", expect.anything());
  });
});
