// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Unit tests for the status_get tool. Bootstrap and state are mocked.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../bootstrap.js", () => ({
  assertAzCli: vi.fn(),
  getSignedInIdentity: vi.fn(),
}));
// Mock provisioning state so the test is deterministic regardless of any real
// ~/.spe-mcp/state.json on the dev machine.
vi.mock("../state.js", () => ({ readState: vi.fn(() => ({})) }));

import * as bootstrap from "../bootstrap.js";
import { statusTool } from "../tools/status.js";
import * as updateCheck from "../update-check.js";
import { PACKAGE_VERSION } from "../version.js";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("status_get", () => {
  it("has correct metadata and no required params", () => {
    expect(statusTool.name).toBe("status_get");
    expect(statusTool.inputSchema.required ?? []).toHaveLength(0);
  });

  it("reports signed-in identity when az is ready", async () => {
    vi.mocked(bootstrap.assertAzCli).mockResolvedValue(undefined);
    vi.mocked(bootstrap.getSignedInIdentity).mockResolvedValue({
      tenantId: "tenant-123",
      username: "dev@contoso.com",
    });

    const result = await statusTool.handler({});

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("dev@contoso.com");
    expect(result.content[0].text).toContain("tenant-123");
    // No owning app in state → status guides the user to create one first.
    expect(result.content[0].text).toContain("project_app_create");
    expect(result.content[0].text).toMatch(/require an owning app first/i);
  });

  it("confirms readiness once an owning app is provisioned", async () => {
    vi.mocked(bootstrap.assertAzCli).mockResolvedValue(undefined);
    vi.mocked(bootstrap.getSignedInIdentity).mockResolvedValue({
      tenantId: "tenant-123",
      username: "dev@contoso.com",
    });
    const state = await import("../state.js");
    vi.mocked(state.readState).mockReturnValueOnce({
      appId: "app-abc",
      appDisplayName: "My SPE App",
      tenantId: "tenant-123",
    });

    const result = await statusTool.handler({});

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("app-abc");
    expect(result.content[0].text).toMatch(/Owning app ready/i);
  });

  it("prompts for login when az is installed but not signed in", async () => {
    vi.mocked(bootstrap.assertAzCli).mockResolvedValue(undefined);
    vi.mocked(bootstrap.getSignedInIdentity).mockResolvedValue(null);

    const result = await statusTool.handler({});

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("not signed in");
    expect(result.content[0].text).toContain("az login");
  });

  it("errors with guidance when az is not installed", async () => {
    vi.mocked(bootstrap.assertAzCli).mockRejectedValue(
      new Error("Azure CLI ('az') is not installed. Install it from https://aka.ms/install-azure-cli"),
    );

    const result = await statusTool.handler({});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not installed");
  });
});

/**
 * SEC-008 update awareness. `status_get` is the "what am I running / is there a
 * newer build?" surface, so the version row must appear on EVERY branch — even
 * the az-missing error branch, which is exactly when a user files a bug report.
 * These assertions read already-resolved in-memory state; they never trigger a
 * network call.
 */
describe("status_get: server version and update state", () => {
  beforeEach(() => {
    updateCheck.__testing.reset();
    vi.mocked(bootstrap.assertAzCli).mockResolvedValue(undefined);
    vi.mocked(bootstrap.getSignedInIdentity).mockResolvedValue({
      tenantId: "tenant-123",
      username: "dev@contoso.com",
    });
  });

  it("always reports the running server version", async () => {
    const result = await statusTool.handler({});
    expect(result.content[0].text).toContain("**Server version**");
    expect(result.content[0].text).toContain(PACKAGE_VERSION);
  });

  it("reports the version even when az is missing (bug-report path)", async () => {
    vi.mocked(bootstrap.assertAzCli).mockRejectedValue(new Error("Azure CLI ('az') is not installed."));

    const result = await statusTool.handler({});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("**Server version**");
    expect(result.content[0].text).toContain(PACKAGE_VERSION);
    expect(result.content[0].text).toContain("**Update check**");
  });

  it("reports the version when az is installed but not signed in", async () => {
    vi.mocked(bootstrap.getSignedInIdentity).mockResolvedValue(null);

    const result = await statusTool.handler({});

    expect(result.content[0].text).toContain("**Server version**");
    expect(result.content[0].text).toContain("**Update check**");
  });

  it("renders 'in progress' while the check is still pending", async () => {
    const result = await statusTool.handler({});
    expect(result.content[0].text).toMatch(/\*\*Update check\*\*\s*\|\s*in progress/);
  });

  it("renders the skip reason when the check is disabled", async () => {
    process.env.SPE_NO_UPDATE_CHECK = "1";
    try {
      updateCheck.startUpdateCheck({ enabled: true });
      await updateCheck.__testing.settle();
      const result = await statusTool.handler({});
      expect(result.content[0].text).toMatch(/\*\*Update check\*\*\s*\|\s*disabled/);
      expect(result.content[0].text).toContain("env-spe-no-update-check");
    } finally {
      delete process.env.SPE_NO_UPDATE_CHECK;
    }
  });

  it("renders the disabled state for the --no-update-check flag", async () => {
    updateCheck.startUpdateCheck({ enabled: false });
    await updateCheck.__testing.settle();

    const result = await statusTool.handler({});

    expect(result.content[0].text).toMatch(/\*\*Update check\*\*\s*\|\s*disabled/);
    expect(result.content[0].text).toContain("cli-flag");
    // A disabled check must never advertise an update.
    expect(result.content[0].text).not.toContain("available —");
  });
});
