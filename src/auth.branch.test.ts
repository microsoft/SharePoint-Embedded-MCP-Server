// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InteractionRequiredAuthError, type AccountInfo, type Configuration } from "@azure/msal-node";

const mocks = vi.hoisted(() => ({
  constructor: vi.fn(),
  accounts: vi.fn(),
  silent: vi.fn(),
  interactive: vi.fn(),
  device: vi.fn(),
  removeAccount: vi.fn(),
  readState: vi.fn(),
  exists: vi.fn(),
  unlink: vi.fn(),
  open: vi.fn(),
}));
vi.mock("@azure/msal-node", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@azure/msal-node")>();
  return { ...actual, PublicClientApplication: mocks.constructor };
});
vi.mock("./state.js", () => ({ readState: mocks.readState }));
vi.mock("./paths.js", () => ({
  getCacheDir: () => "/synthetic-cache",
  getCacheFile: (tenant: string, client: string) => `/synthetic-cache/${tenant}.${client}.json`,
  getLegacyCacheFile: () => "/synthetic-cache/token-cache.json",
}));
vi.mock("node:fs", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:fs")>(),
  existsSync: mocks.exists,
  unlinkSync: mocks.unlink,
}));
vi.mock("open", () => ({ default: mocks.open }));

const config = {
  clientId: "11111111-2222-3333-4444-555555555555",
  tenantId: "99999999-9999-9999-9999-999999999999",
};
const account: AccountInfo = {
  homeAccountId: `user.${config.tenantId}`,
  localAccountId: "user", environment: "login.microsoftonline.com",
  tenantId: config.tenantId, username: "user@example.test",
};
const result = { accessToken: "synthetic-token", tenantId: config.tenantId, account };
let auth: typeof import("./auth.js");
let configurations: Configuration[];
const ttyDescriptor = Object.getOwnPropertyDescriptor(process.stderr, "isTTY");

beforeEach(async () => {
  vi.resetModules();
  vi.resetAllMocks();
  vi.stubEnv("SPE_INTERACTIVE", "");
  vi.stubEnv("SPE_NON_INTERACTIVE", "1");
  vi.stubEnv("CI", "true");
  Object.defineProperty(process.stderr, "isTTY", { configurable: true, get: () => false });
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  configurations = [];
  mocks.constructor.mockImplementation(function (value: Configuration) {
    configurations.push(value);
    return {
      getTokenCache: () => ({ getAllAccounts: mocks.accounts, removeAccount: mocks.removeAccount }),
      acquireTokenSilent: mocks.silent,
      acquireTokenInteractive: mocks.interactive,
      acquireTokenByDeviceCode: mocks.device,
    };
  });
  mocks.readState.mockReturnValue({});
  mocks.accounts.mockResolvedValue([account]);
  mocks.silent.mockResolvedValue(result);
  mocks.interactive.mockResolvedValue(result);
  mocks.device.mockResolvedValue(result);
  auth = await import("./auth.js");
  auth.setAuthConfig(config);
});

afterEach(() => {
  auth?.__testing.reset();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  if (ttyDescriptor) Object.defineProperty(process.stderr, "isTTY", ttyDescriptor);
  else Reflect.deleteProperty(process.stderr, "isTTY");
});

describe("owning-app auth initialization", () => {
  it("initializes once and obtains a silent token with configured scopes", async () => {
    auth.setAuthConfig({ ...config, scopes: ["synthetic.scope"] });
    await auth.initializeAuth();
    await auth.initializeAuth();
    expect(await auth.getAccessToken()).toBe("synthetic-token");
    expect(mocks.constructor).toHaveBeenCalledTimes(1);
    expect(configurations[0].auth).toEqual({
      clientId: config.clientId,
      authority: `https://login.microsoftonline.com/${config.tenantId}`,
    });
    expect(mocks.silent).toHaveBeenCalledWith({ scopes: ["synthetic.scope"], account });
    expect(mocks.interactive).not.toHaveBeenCalled();
  });

  it("constructs on demand and uses the existing default SPE scopes", async () => {
    expect(await auth.getAccessToken()).toBe("synthetic-token");
    expect(mocks.silent.mock.calls[0][0].scopes).toEqual(expect.arrayContaining([
      "https://graph.microsoft.com/FileStorageContainerType.Manage.All",
      "https://graph.microsoft.com/FileStorageContainer.Selected",
    ]));
    expect(configurations[0].system?.loggerOptions?.piiLoggingEnabled).toBe(false);
  });

  it("coalesces initialization and makes token requests wait for readiness", async () => {
    let release!: (accounts: AccountInfo[]) => void;
    mocks.accounts.mockReturnValueOnce(new Promise<AccountInfo[]>((resolve) => { release = resolve; }));
    const first = auth.initializeAuth();
    const second = auth.initializeAuth();
    const token = auth.getAccessToken();
    expect(mocks.silent).not.toHaveBeenCalled();
    release([account]);
    await Promise.all([first, second]);
    expect(await token).toBe("synthetic-token");
    expect(mocks.constructor).toHaveBeenCalledTimes(1);
  });

  it("clears rejected readiness and can retry initialization", async () => {
    mocks.accounts.mockResolvedValueOnce([]);
    await expect(auth.initializeAuth()).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
    expect(auth.__testing.getAuthReadyPromise()).toBeNull();
    await expect(auth.initializeAuth()).resolves.toBeUndefined();
    expect(mocks.constructor).toHaveBeenCalledTimes(2);
  });

  it("lets a waiting token call recover after initialization rejects", async () => {
    let reject!: (error: Error) => void;
    mocks.accounts.mockReturnValueOnce(new Promise<AccountInfo[]>((_resolve, fail) => { reject = fail; }));
    const init = auth.initializeAuth();
    const failed = expect(init).rejects.toThrow("cache unavailable");
    const token = auth.getAccessToken();
    reject(new Error("cache unavailable"));
    await failed;
    expect(await token).toBe("synthetic-token");
  });

  it.each([new Error("MSAL failed"), "MSAL failed"])("preserves unexpected silent failures (%p)", async (error) => {
    mocks.silent.mockRejectedValueOnce(error);
    await expect(auth.getAccessToken()).rejects.toThrow("MSAL failed");
    expect(mocks.interactive).not.toHaveBeenCalled();
  });

  it.each([config.tenantId, "88888888-8888-8888-8888-888888888888"])(
    "falls through on interaction-required errors for home tenant %s", async (homeTenant) => {
      mocks.accounts.mockResolvedValue([{ ...account, homeAccountId: `user.${homeTenant}` }]);
      mocks.silent.mockRejectedValueOnce(new InteractionRequiredAuthError(
        "interaction_required", "Synthetic interaction is required",
      ));
      await expect(auth.getAccessToken()).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
      expect(mocks.interactive).not.toHaveBeenCalled();
    },
  );

  it("rejects a silent token issued by a different tenant before the interactive fallback", async () => {
    mocks.silent.mockResolvedValueOnce({ ...result, tenantId: "other-tenant" });
    auth.setInteractiveMode();
    expect(await auth.getAccessToken()).toBe("synthetic-token");
    expect(mocks.interactive).toHaveBeenCalledTimes(1);
  });

  it.each([{}, { appId: config.clientId }, { tenantId: config.tenantId }, { appId: config.clientId, tenantId: config.tenantId }])(
    "requires both persisted identifiers when auth is not configured (%p)", (state) => {
      auth.__testing.reset();
      mocks.readState.mockReturnValue(state);
      expect(auth.isOwningAppConfigured()).toBe(Boolean("appId" in state && "tenantId" in state));
    },
  );

  it("reports an uninitialized PCA rather than reading a real cache", async () => {
    await expect(auth.getCachedAccount()).rejects.toThrow("PublicClientApplication not initialized");
  });
});

describe("offline interactive waterfall", () => {
  it("passes browser callbacks and success/error templates to MSAL", async () => {
    mocks.accounts.mockResolvedValue([]);
    mocks.interactive.mockImplementationOnce(async (request) => {
      await request.openBrowser("https://example.test/synthetic-login");
      expect(request.successTemplate).toContain(config.clientId);
      expect(request.errorTemplate).toContain("Sign-in didn't complete");
      return result;
    });
    auth.setInteractiveMode();
    expect(await auth.getAccessToken()).toBe("synthetic-token");
    expect(mocks.open).toHaveBeenCalledWith("https://example.test/synthetic-login");
    expect(mocks.device).not.toHaveBeenCalled();
  });

  it.each([null, new Error("declined"), "declined"])("fails fast without a visible device-code prompt (%p)", async (failure) => {
    mocks.accounts.mockResolvedValue([]);
    if (failure === null) mocks.interactive.mockResolvedValueOnce(null);
    else mocks.interactive.mockRejectedValueOnce(failure);
    auth.setInteractiveMode();
    await expect(auth.getAccessToken()).rejects.toMatchObject({ code: "AUTH_FAILED" });
    expect(mocks.device).not.toHaveBeenCalled();
  });

  it("uses the device-code fallback only when its prompt is visible", async () => {
    vi.spyOn(process.stderr, "isTTY", "get").mockReturnValue(true);
    mocks.accounts.mockResolvedValue([]);
    mocks.interactive.mockRejectedValueOnce(new Error("no browser"));
    auth.setInteractiveMode();
    expect(await auth.getAccessToken()).toBe("synthetic-token");
    expect(mocks.device).toHaveBeenCalledWith(expect.objectContaining({ cancel: false, timeout: 900 }));
  });

  it("reports exhausted methods and cleans up the device timer on a null result", async () => {
    vi.useFakeTimers();
    vi.spyOn(process.stderr, "isTTY", "get").mockReturnValue(true);
    mocks.accounts.mockResolvedValue([]);
    mocks.interactive.mockRejectedValueOnce(new Error("no browser"));
    mocks.device.mockResolvedValueOnce(null);
    auth.setInteractiveMode();
    await expect(auth.getAccessToken()).rejects.toMatchObject({ code: "AUTH_FAILED" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reports cached CLI sign-in without opening a browser", async () => {
    await auth.authenticateInteractively();
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("Already signed in"));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining(account.username));
    expect(mocks.interactive).not.toHaveBeenCalled();
  });

  it("reports newly completed CLI sign-in even without an account in the result", async () => {
    mocks.accounts.mockResolvedValue([]);
    mocks.interactive.mockResolvedValueOnce({ ...result, account: null });
    auth.setInteractiveMode();
    await auth.authenticateInteractively();
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("Logged into your owning SPE app successfully"));
    expect(console.log).not.toHaveBeenCalledWith(expect.stringContaining("Account:"));
  });

  it.each([
    ["1", "", "true", "" , true],
    ["", "true", "false", ":0", false],
    ["", "", "true", ":0", false],
    ["", "", "false", ":0", true],
    ["", "", "false", "", false],
  ] as const)("respects interactive/headless env %p %p %p %p", async (interactive, nonInteractive, ci, display, enabled) => {
    auth.__testing.reset();
    vi.resetModules();
    vi.stubEnv("SPE_INTERACTIVE", interactive);
    vi.stubEnv("SPE_NON_INTERACTIVE", nonInteractive);
    vi.stubEnv("CI", ci);
    vi.stubEnv("DISPLAY", display);
    vi.stubEnv("WAYLAND_DISPLAY", "");
    auth = await import("./auth.js");
    auth.setAuthConfig(config);
    mocks.accounts.mockResolvedValue([]);
    if (enabled || (process.platform !== "linux" && !ci.includes("true") && !nonInteractive)) {
      expect(await auth.getAccessToken()).toBe("synthetic-token");
      expect(mocks.interactive).toHaveBeenCalledTimes(1);
    } else {
      await expect(auth.getAccessToken()).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
      expect(mocks.interactive).not.toHaveBeenCalled();
    }
  });
});

describe("cached-token logout", () => {
  it("removes partitioned and legacy files and evicts every cached account", async () => {
    await auth.initializeAuth();
    const second = { ...account, localAccountId: "second" };
    mocks.accounts.mockResolvedValue([account, second]);
    mocks.exists.mockReturnValue(true);
    await auth.clearCachedToken();
    expect(mocks.unlink.mock.calls.map(([path]) => path)).toEqual([
      `/synthetic-cache/${config.tenantId}.${config.clientId}.json`,
      "/synthetic-cache/token-cache.json",
    ]);
    expect(mocks.removeAccount).toHaveBeenNthCalledWith(1, account);
    expect(mocks.removeAccount).toHaveBeenNthCalledWith(2, second);
  });

  it("tolerates missing files and a missing PCA", async () => {
    mocks.exists.mockReturnValue(false);
    await auth.clearCachedToken();
    expect(mocks.unlink).not.toHaveBeenCalled();
    expect(mocks.accounts).not.toHaveBeenCalled();
  });

  it("continues clearing accounts when a cache file cannot be removed", async () => {
    await auth.initializeAuth();
    mocks.exists.mockReturnValue(true);
    mocks.unlink.mockImplementationOnce(() => { throw new Error("read only"); });
    await auth.clearCachedToken();
    expect(mocks.unlink).toHaveBeenCalledTimes(2);
    expect(mocks.removeAccount).toHaveBeenCalledWith(account);
  });

  it("propagates cache eviction failures", async () => {
    await auth.initializeAuth();
    mocks.removeAccount.mockRejectedValueOnce(new Error("cache failure"));
    await expect(auth.clearCachedToken()).rejects.toThrow("cache failure");
  });
});
