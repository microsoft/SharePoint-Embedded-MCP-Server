// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Unit tests for the Azure CLI bootstrap module.
 * `node:child_process.execFile` is mocked so these run offline.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:child_process", () => ({ execFile: vi.fn() }));

import { execFile } from "node:child_process";
import { assertAzCli, getSignedInIdentity, getBootstrapToken } from "./bootstrap.js";

type ExecCb = (err: Error | null, stdout: string, stderr: string) => void;

function mockExec(result: { stdout?: string; error?: Error }): void {
  vi.mocked(execFile).mockImplementation(((
    _cmd: string,
    _args: string[],
    _opts: unknown,
    cb: ExecCb,
  ) => {
    if (result.error) cb(result.error, "", "");
    else cb(null, result.stdout ?? "", "");
    return {} as never;
  }) as never);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("assertAzCli", () => {
  it("resolves when az is installed", async () => {
    mockExec({ stdout: '{"azure-cli":"2.60.0"}' });
    await expect(assertAzCli()).resolves.toBeUndefined();
  });

  it("throws a friendly not-installed error on ENOENT", async () => {
    mockExec({ error: new Error("spawn az ENOENT") });
    await expect(assertAzCli()).rejects.toThrow(/not installed/i);
  });
});

describe("getSignedInIdentity", () => {
  it("returns tenant and user when signed in", async () => {
    mockExec({ stdout: JSON.stringify({ tenantId: "tenant-123", user: { name: "dev@contoso.com" } }) });
    const id = await getSignedInIdentity();
    expect(id).toEqual({ tenantId: "tenant-123", username: "dev@contoso.com" });
  });

  it("returns null when not signed in (az exits non-zero)", async () => {
    mockExec({ error: new Error("Please run 'az login' to setup account.") });
    const id = await getSignedInIdentity();
    expect(id).toBeNull();
  });

  it("throws not-installed error on ENOENT", async () => {
    mockExec({ error: new Error("'az' is not recognized") });
    await expect(getSignedInIdentity()).rejects.toThrow(/not installed/i);
  });
});

describe("getBootstrapToken", () => {
  it("returns an access token for Graph", async () => {
    mockExec({
      stdout: JSON.stringify({
        accessToken: "tok-abc",
        expiresOn: "2026-06-17 18:00:00.000000",
        tenantId: "tenant-123",
      }),
    });
    const token = await getBootstrapToken();
    expect(token.accessToken).toBe("tok-abc");
    expect(token.tenantId).toBe("tenant-123");
    expect(token.expiresOn).toBeInstanceOf(Date);
  });

  it("throws a friendly not-signed-in error", async () => {
    mockExec({ error: new Error("Please run 'az login' to setup account.") });
    await expect(getBootstrapToken()).rejects.toThrow(/not signed in/i);
  });

  it("throws an actionable Conditional Access step-up error (not the plain not-signed-in path)", async () => {
    // CA/claims is a MORE specific branch than not-logged-in and must win.
    mockExec({
      error: new Error(
        "AADSTS50076: Due to a configuration change made by your administrator, you must use " +
          "multi-factor authentication to access the resource. Trace ID: ...",
      ),
    });
    const err = await getBootstrapToken().catch((e: unknown) => e as Error);
    expect(err.message).toMatch(/Conditional Access requires step-up authentication/i);
    expect(err.message).toContain("az login --scope https://management.core.windows.net//.default --tenant");
    // tenant cannot be resolved under the simulated CA failure, so a placeholder is used.
    expect(err.message).toContain("<your-tenant-id>");
    expect(err.message).not.toMatch(/--allow-no-subscriptions/);
  });

  it("throws not-installed error on ENOENT", async () => {
    mockExec({ error: new Error("spawn az ENOENT") });
    await expect(getBootstrapToken()).rejects.toThrow(/not installed/i);
  });

  it("throws when az returns no token", async () => {
    mockExec({ stdout: JSON.stringify({ expiresOn: "x" }) });
    await expect(getBootstrapToken()).rejects.toThrow(/no access token/i);
  });
});

describe("cross-platform az invocation", () => {
  // `az` is a native binary on macOS/Linux but a `.cmd` shim on Windows that
  // must be resolved through a shell. bootstrap.ts sets `shell: true` only on
  // win32; this asserts the invocation adapts to the current platform so the
  // command works on both Windows and Linux.
  it("passes shell:true on Windows and falsy elsewhere", async () => {
    mockExec({ stdout: '{"azure-cli":"2.60.0"}' });
    await assertAzCli();

    const opts = vi.mocked(execFile).mock.calls[0]?.[2] as { shell?: boolean };
    if (process.platform === "win32") {
      expect(opts.shell).toBe(true);
    } else {
      expect(opts.shell).toBeFalsy();
    }
  });

  // Regardless of platform, args are passed as an array (never a concatenated
  // shell string), so paths/values with spaces aren't word-split by the shell.
  it("invokes az with an argv array, not a concatenated command string", async () => {
    mockExec({ stdout: '{"azure-cli":"2.60.0"}' });
    await assertAzCli();

    const [cmd, args] = vi.mocked(execFile).mock.calls[0] as unknown as [string, string[]];
    expect(cmd).toBe("az");
    expect(Array.isArray(args)).toBe(true);
    expect(args).toContain("version");
  });
});
