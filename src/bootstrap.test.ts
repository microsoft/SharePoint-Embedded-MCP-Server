// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Unit tests for the Azure CLI bootstrap module.
 * The shared shell-free launcher (`./proc-exec.js` `runCommand`) is mocked so
 * these run offline.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./proc-exec.js", () => ({ runCommand: vi.fn() }));

import { runCommand } from "./proc-exec.js";
import { assertAzCli, getSignedInIdentity, getBootstrapToken } from "./bootstrap.js";

function mockExec(result: { stdout?: string; error?: Error }): void {
  vi.mocked(runCommand).mockImplementation(async () => {
    if (result.error) throw result.error;
    return { stdout: result.stdout ?? "", stderr: "" };
  });
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

describe("shell-free az invocation", () => {
  // `az` is a native binary on macOS/Linux but a `.cmd` shim on Windows. It is
  // launched through the shared shell-free launcher (`./proc-exec.js`), which
  // never routes arguments through a shell on any platform — so shell
  // metacharacters in values are passed through literally, not interpreted.
  it("invokes az through the launcher without any shell option", async () => {
    mockExec({ stdout: '{"azure-cli":"2.60.0"}' });
    await assertAzCli();

    const call = vi.mocked(runCommand).mock.calls[0] as unknown as [string, string[], Record<string, unknown>?];
    const opts = call[2] ?? {};
    // The launcher takes no `shell` option — args are never shell-interpreted.
    expect(opts).not.toHaveProperty("shell");
  });

  // Regardless of platform, args are passed as an array (never a concatenated
  // shell string), so paths/values with spaces aren't word-split by the shell.
  it("invokes az with an argv array, not a concatenated command string", async () => {
    mockExec({ stdout: '{"azure-cli":"2.60.0"}' });
    await assertAzCli();

    const [cmd, args] = vi.mocked(runCommand).mock.calls[0] as unknown as [string, string[]];
    expect(cmd).toBe("az");
    expect(Array.isArray(args)).toBe(true);
    expect(args).toContain("version");
  });
});
