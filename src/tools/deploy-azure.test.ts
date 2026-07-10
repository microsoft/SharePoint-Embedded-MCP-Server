// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Unit tests for project_deploy (deploy-azure.ts).
 *
 * The C# arch deploys the ODSP security-approved azd template, which is
 * subscription-scoped and reads env name / location / subscription / SPE
 * container type from azd environment variables. These assert the tool:
 *   - errors clearly when there is no azure.yaml or no region,
 *   - drives `azd up --no-prompt` with those values wired from state,
 *   - extracts the live endpoint and reports the managed-identity infra,
 *   - surfaces a friendly message when `azd` is not installed.
 *
 * node:child_process, node:fs and state are mocked so nothing actually runs.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

let azureYamlExists = true;
type ExecCb = (err: (Error & { code?: string }) | null, stdout: string, stderr: string) => void;
let execImpl: (cmd: string, args: string[], opts: { env?: NodeJS.ProcessEnv }, cb: ExecCb) => void;

vi.mock("node:fs", () => ({
  existsSync: vi.fn((p: string) => (String(p).endsWith("azure.yaml") ? azureYamlExists : true)),
}));

vi.mock("node:child_process", () => ({
  execFile: vi.fn((cmd: string, args: string[], opts: { env?: NodeJS.ProcessEnv }, cb: ExecCb) =>
    execImpl(cmd, args, opts, cb),
  ),
}));

const stateStore: Record<string, unknown> = {};
vi.mock("../state.js", () => ({
  readState: vi.fn(() => ({ ...stateStore })),
}));

const addSpaRedirectUrisMock = vi.fn();
vi.mock("../graph-client.js", () => ({
  addSpaRedirectUris: (...args: unknown[]) => addSpaRedirectUrisMock(...args),
}));
vi.mock("../bootstrap.js", () => ({
  bootstrapTokenProvider: vi.fn(async () => "boot-token"),
}));

import { execFile } from "node:child_process";
import { deployAzureTool } from "../tools/deploy-azure.js";

beforeEach(() => {
  vi.clearAllMocks();
  azureYamlExists = true;
  for (const k of Object.keys(stateStore)) delete stateStore[k];
  // Default: a successful azd up that prints a live endpoint.
  execImpl = (_cmd, _args, _opts, cb) =>
    cb(null, "Deploying service web\n  - Endpoint: https://demo.happyrock-1.eastus.azurecontainerapps.io/\n", "");
  // Default SPA patch: origin newly added.
  addSpaRedirectUrisMock.mockResolvedValue({ added: ["x"], redirectUris: ["x"] });
});

describe("project_deploy", () => {
  it("errors when there is no azure.yaml to deploy", async () => {
    azureYamlExists = false;
    const r = await deployAzureTool.handler({ projectDir: "/proj", location: "eastus" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("no `azure.yaml`");
    expect(execFile).not.toHaveBeenCalled();
  });

  it("errors when no region is supplied (subscription-scoped template needs one)", async () => {
    delete process.env.AZURE_LOCATION;
    const r = await deployAzureTool.handler({ projectDir: "/proj" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("no Azure region");
    expect(execFile).not.toHaveBeenCalled();
  });

  it("runs azd up --no-prompt with env wired from state and returns the endpoint", async () => {
    stateStore.azureSubscriptionId = "sub-123";
    stateStore.containerTypeId = "ct-456";

    const r = await deployAzureTool.handler({ projectDir: "/proj", environmentName: "spe-demo", location: "eastus" });

    expect(r.isError).toBeFalsy();
    expect(execFile).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = vi.mocked(execFile).mock.calls[0] as unknown as [
      string,
      string[],
      { env?: NodeJS.ProcessEnv },
    ];
    expect(cmd).toBe("azd");
    expect(args).toEqual(["up", "--no-prompt", "--environment", "spe-demo"]);
    expect(opts.env?.AZURE_ENV_NAME).toBe("spe-demo");
    expect(opts.env?.AZURE_LOCATION).toBe("eastus");
    expect(opts.env?.AZURE_SUBSCRIPTION_ID).toBe("sub-123");
    expect(opts.env?.SPE_CONTAINER_TYPE_ID).toBe("ct-456");

    expect(r.content[0].text).toContain("https://demo.happyrock-1.eastus.azurecontainerapps.io/");
    expect(r.content[0].text).toContain("subscription-scoped");
  });

  it("retries the deploy alone when azd up loses the Resource Graph indexing race", async () => {
    vi.useFakeTimers();
    execImpl = (_cmd, args, _opts, cb) => {
      if (args[0] === "up") {
        // Provisioned, but the publish step could not find the freshly-created
        // resource by its azd-service-name tag yet (ARG indexing lag).
        cb(
          new Error("exit status 1"),
          "(done) Static Web App\nERROR: publishing service web: getting target resource: resource not found: unable to find a resource tagged with 'azd-service-name: web'",
          "",
        );
      } else {
        // azd deploy retry succeeds once ARG has caught up.
        cb(null, "web: Done\n- Endpoint: https://retried-app.7.azurestaticapps.net/\n", "");
      }
    };

    const pending = deployAzureTool.handler({ projectDir: "/proj", location: "eastus" });
    await vi.runAllTimersAsync();
    const r = await pending;
    vi.useRealTimers();

    expect(r.isError).toBeFalsy();
    expect(r.content[0].text).toContain("https://retried-app.7.azurestaticapps.net/");
    const calls = vi.mocked(execFile).mock.calls as unknown as [string, string[]][];
    expect(calls.some((c) => c[1][0] === "up")).toBe(true);
    expect(calls.some((c) => c[1][0] === "deploy")).toBe(true);
  });

  it("does not retry (and surfaces the error) when azd up fails for a non-indexing reason", async () => {
    execImpl = (_cmd, args, _opts, cb) => {
      if (args[0] === "up") {
        cb(new Error("exit status 1"), "ERROR: deployment failed: InvalidTemplate — bad bicep", "");
      } else {
        cb(null, "should not be called", "");
      }
    };
    const r = await deployAzureTool.handler({ projectDir: "/proj", location: "eastus" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("InvalidTemplate");
    const calls = vi.mocked(execFile).mock.calls as unknown as [string, string[]][];
    expect(calls.some((c) => c[1][0] === "deploy")).toBe(false);
  });

  it("reports a friendly message when azd is not installed", async () => {
    execImpl = (_cmd, _args, _opts, cb) =>
      cb(Object.assign(new Error("spawn azd ENOENT"), { code: "ENOENT" }), "", "");
    const r = await deployAzureTool.handler({ projectDir: "/proj", location: "eastus" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("Azure Developer CLI (`azd`) is not installed");
  });

  it("auto-registers the deployed origin as a SPA redirect URI on the owning app", async () => {
    stateStore.appObjectId = "obj-owning";
    stateStore.appId = "app-owning";
    execImpl = (_cmd, _args, _opts, cb) =>
      cb(null, "web\n  - Endpoint: https://my-spa-123.7.azurestaticapps.net/\n", "");

    const r = await deployAzureTool.handler({ projectDir: "/proj", location: "eastus" });

    expect(r.isError).toBeFalsy();
    expect(addSpaRedirectUrisMock).toHaveBeenCalledTimes(1);
    const [objectId, origins, , options] = addSpaRedirectUrisMock.mock.calls[0];
    expect(objectId).toBe("obj-owning");
    // The scheme+host origin only (no trailing slash / path).
    expect(origins).toEqual(["https://my-spa-123.7.azurestaticapps.net"]);
    expect(options).toEqual({ bestEffort: true });
    expect(r.content[0].text).toContain("https://my-spa-123.7.azurestaticapps.net");
    expect(r.content[0].text).toContain("SPA");
  });

  it("emits manual SPA-redirect guidance when no owning app is recorded in state", async () => {
    // No appObjectId in state → cannot auto-patch.
    execImpl = (_cmd, _args, _opts, cb) =>
      cb(null, "web\n  - Endpoint: https://no-owner.7.azurestaticapps.net/\n", "");

    const r = await deployAzureTool.handler({ projectDir: "/proj", location: "eastus" });

    expect(addSpaRedirectUrisMock).not.toHaveBeenCalled();
    expect(r.content[0].text).toContain("https://no-owner.7.azurestaticapps.net");
    expect(r.content[0].text).toContain("SPA");
  });

  it("falls back to manual guidance when the best-effort SPA patch fails", async () => {
    stateStore.appObjectId = "obj-owning";
    stateStore.appId = "app-owning";
    addSpaRedirectUrisMock.mockResolvedValue(undefined); // best-effort failure
    execImpl = (_cmd, _args, _opts, cb) =>
      cb(null, "web\n  - Endpoint: https://patch-fail.7.azurestaticapps.net/\n", "");

    const r = await deployAzureTool.handler({ projectDir: "/proj", location: "eastus" });

    expect(r.isError).toBeFalsy();
    expect(r.content[0].text).toContain("could not auto-update");
    expect(r.content[0].text).toContain("https://patch-fail.7.azurestaticapps.net");
    expect(r.content[0].text).toContain("app-owning");
  });
});
