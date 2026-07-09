// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Unit tests for the status_get tool. Azure CLI token and state are mocked.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../azure-cli-token.js", () => ({
  assertAzCli: vi.fn(),
  getSignedInIdentity: vi.fn(),
}));
// Mock provisioning state so the test is deterministic regardless of any real
// ~/.spe-mcp/state.json on the dev machine.
vi.mock("../state.js", () => ({ readState: vi.fn(() => ({})) }));

import * as azureCliToken from "../azure-cli-token.js";
import { statusTool } from "../tools/status.js";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("status_get", () => {
  it("has correct metadata and no required params", () => {
    expect(statusTool.name).toBe("status_get");
    expect(statusTool.inputSchema.required ?? []).toHaveLength(0);
  });

  it("reports signed-in identity when az is ready", async () => {
    vi.mocked(azureCliToken.assertAzCli).mockResolvedValue(undefined);
    vi.mocked(azureCliToken.getSignedInIdentity).mockResolvedValue({
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
    vi.mocked(azureCliToken.assertAzCli).mockResolvedValue(undefined);
    vi.mocked(azureCliToken.getSignedInIdentity).mockResolvedValue({
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
    vi.mocked(azureCliToken.assertAzCli).mockResolvedValue(undefined);
    vi.mocked(azureCliToken.getSignedInIdentity).mockResolvedValue(null);

    const result = await statusTool.handler({});

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("not signed in");
    expect(result.content[0].text).toContain("az login");
  });

  it("errors with guidance when az is not installed", async () => {
    vi.mocked(azureCliToken.assertAzCli).mockRejectedValue(
      new Error("Azure CLI ('az') is not installed. Install it from https://aka.ms/install-azure-cli"),
    );

    const result = await statusTool.handler({});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not installed");
  });
});
