// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Unit tests for azure_subscriptions_list not-signed-in detection.
 *
 * The bug: `az account list` returns [] with exit 0 when the user is NOT signed
 * in, so the tool falsely reported "No enabled Azure subscriptions found for the
 * signed-in user" with no `az login` guidance. These assert the tool now probes
 * sign-in state and gives the right message for each case. The Azure CLI layer
 * is mocked so the tests run offline.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../azure-cli.js", () => ({
  listSubscriptions: vi.fn(),
  isSignedIn: vi.fn(),
  listResourceGroups: vi.fn(),
}));

import * as azureCli from "../azure-cli.js";
import { listSubscriptionsTool } from "../tools/list-azure.js";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("azure_subscriptions_list", () => {
  it("returns actionable az login guidance when NOT signed in (empty list + no session)", async () => {
    vi.mocked(azureCli.listSubscriptions).mockResolvedValue([]);
    vi.mocked(azureCli.isSignedIn).mockResolvedValue(false);

    const result = await listSubscriptionsTool.handler({});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not signed in");
    expect(result.content[0].text).toContain("az login");
    // Must NOT claim there are simply no subscriptions for the signed-in user.
    expect(result.content[0].text).not.toContain("for the signed-in user");
  });

  it("reports an empty list ONLY when genuinely signed in with zero subscriptions", async () => {
    vi.mocked(azureCli.listSubscriptions).mockResolvedValue([]);
    vi.mocked(azureCli.isSignedIn).mockResolvedValue(true);

    const result = await listSubscriptionsTool.handler({});

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("No enabled Azure subscriptions found for the signed-in user");
  });

  it("lists subscriptions when signed in with subscriptions (no sign-in probe needed)", async () => {
    vi.mocked(azureCli.listSubscriptions).mockResolvedValue([
      { id: "sub-1", name: "Contoso Prod", state: "Enabled", isDefault: true },
      { id: "sub-2", name: "Contoso Dev", state: "Enabled", isDefault: false },
    ]);

    const result = await listSubscriptionsTool.handler({});

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("Azure Subscriptions (2)");
    expect(result.content[0].text).toContain("Contoso Prod");
    expect(result.content[0].text).toContain("sub-2");
    expect(azureCli.isSignedIn).not.toHaveBeenCalled();
  });

  it("surfaces a clean error when the Azure CLI call fails", async () => {
    vi.mocked(azureCli.listSubscriptions).mockRejectedValue(new Error("az not installed"));

    const result = await listSubscriptionsTool.handler({});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("az not installed");
  });
});
