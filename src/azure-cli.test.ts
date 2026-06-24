// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Unit tests for azure-cli helpers that expose injectable seams (no real shell).
 *
 * Covers two concerns, both exercised through the functions' injectable seams so
 * no `az` is shelled out and no real tenant is contacted:
 *   - createSyntexAccount region validation — Microsoft.Syntex/
 *     accounts can only be provisioned in a fixed set of regions; an unsupported
 *     region (e.g. westus2) must fail fast with an actionable message BEFORE any
 *     ARM PUT, rather than a raw `LocationNotAvailableForResourceType` 400.
 *   - Conditional Access / claims step-up handling in the ARM control-plane
 *     helpers.
 */

import { describe, it, expect, vi } from "vitest";
import {
  createSyntexAccount,
  ensureSyntexProviderRegistered,
  type CreateSyntexAccountOptions,
} from "./azure-cli.js";
import { ConditionalAccessError } from "./az-errors.js";

const noopSleep = async (): Promise<void> => undefined;

// A representative Conditional Access claims-challenge failure as `az` would
// surface it (matches the 2026-06-22 transcript: InteractionRequired + claims).
const CA_MESSAGE =
  "InteractionRequired: AADSTS50076: Due to a configuration change made by your administrator, " +
  "you must use multi-factor authentication. A claims challenge was returned by Conditional Access.";

describe("createSyntexAccount — region validation", () => {
  it("rejects a region that cannot host Microsoft.Syntex/accounts before any ARM PUT", async () => {
    const putAccount = vi.fn(async () => ({ id: "acc", properties: { provisioningState: "Succeeded" } }));

    await expect(
      createSyntexAccount("sub-1", "rg-1", "westus2", "ct-1", { putAccount } as CreateSyntexAccountOptions),
    ).rejects.toThrow(/not available for Microsoft\.Syntex/i);

    expect(putAccount).not.toHaveBeenCalled();
  });

  it("accepts a supported region (normalizing case + spaces) and proceeds to the PUT", async () => {
    const putAccount = vi.fn(async (_url: string, body: { location: string }) => {
      // Region is normalized to canonical lower/no-space form for ARM.
      expect(body.location).toBe("eastus");
      return {
        id: "/subscriptions/sub-1/resourceGroups/rg-1/providers/Microsoft.Syntex/accounts/acc-1",
        properties: { provisioningState: "Succeeded" },
      };
    });

    const id = await createSyntexAccount(
      "sub-1", "rg-1", "East US", "ct-1", { putAccount } as CreateSyntexAccountOptions,
    );

    expect(putAccount).toHaveBeenCalledTimes(1);
    expect(id).toContain("acc-1");
  });
});

describe("ensureSyntexProviderRegistered — Conditional Access", () => {
  it("throws an actionable CA step-up error (with tenant id) when registration hits a claims challenge", async () => {
    const err = await ensureSyntexProviderRegistered("sub-1", {
      sleep: noopSleep,
      showProvider: async () => ({ namespace: "Microsoft.Syntex", registrationState: "NotRegistered" }),
      registerProvider: async () => {
        throw new Error(CA_MESSAGE);
      },
      resolveTenantId: async () => "tenant-abc",
    }).catch((e: unknown) => e as Error);

    expect(err).toBeInstanceOf(ConditionalAccessError);
    expect(err.message).toMatch(/Conditional Access requires step-up authentication/i);
    expect(err.message).toContain(
      "az login --scope https://management.core.windows.net//.default --tenant tenant-abc",
    );
  });

  it("passes non-CA failures through unchanged (timeout guidance preserved)", async () => {
    const err = await ensureSyntexProviderRegistered("sub-1", {
      timeoutMs: 0, // force immediate timeout
      sleep: noopSleep,
      showProvider: async () => ({ namespace: "Microsoft.Syntex", registrationState: "Registering" }),
      registerProvider: async () => undefined,
      resolveTenantId: async () => "tenant-abc",
    }).catch((e: unknown) => e as Error);

    expect(err).not.toBeInstanceOf(ConditionalAccessError);
    expect(err.message).toMatch(/did not finish registering/i);
  });
});

describe("createSyntexAccount — Conditional Access", () => {
  it("throws an actionable CA step-up error including tenant id + remediation command", async () => {
    const err = await createSyntexAccount("sub-1", "rg-1", "eastus", "ct-1", {
      sleep: noopSleep,
      newAccountName: () => "11111111-1111-1111-1111-111111111111",
      putAccount: async () => {
        throw new Error(CA_MESSAGE);
      },
      resolveTenantId: async () => "tenant-abc",
    }).catch((e: unknown) => e as Error);

    expect(err).toBeInstanceOf(ConditionalAccessError);
    expect(err.message).toContain(
      "az login --scope https://management.core.windows.net//.default --tenant tenant-abc",
    );
    expect(err.message).toContain("SharePoint admin center");
    expect(err.message).toContain("out of scope");
  });

  it("prefers an explicitly-provided tenant id over the resolver", async () => {
    const err = await createSyntexAccount("sub-1", "rg-1", "eastus", "ct-1", {
      sleep: noopSleep,
      newAccountName: () => "11111111-1111-1111-1111-111111111111",
      putAccount: async () => {
        throw new Error(CA_MESSAGE);
      },
      tenantId: "explicit-tenant",
      resolveTenantId: async () => "should-not-be-used",
    }).catch((e: unknown) => e as Error);

    expect(err.message).toContain("--tenant explicit-tenant");
    expect(err.message).not.toContain("should-not-be-used");
  });

  it("passes a non-CA provisioning failure through unchanged", async () => {
    const err = await createSyntexAccount("sub-1", "rg-1", "eastus", "ct-1", {
      sleep: noopSleep,
      newAccountName: () => "11111111-1111-1111-1111-111111111111",
      putAccount: async () => ({
        id: "/subscriptions/sub-1/resourceGroups/rg-1/providers/Microsoft.Syntex/accounts/x",
        properties: { provisioningState: "Provisioning" },
      }),
      getAccount: async () => ({
        id: "/subscriptions/sub-1/resourceGroups/rg-1/providers/Microsoft.Syntex/accounts/x",
        properties: { provisioningState: "Failed" },
      }),
      deleteAccount: async () => undefined,
      resolveTenantId: async () => "tenant-abc",
    }).catch((e: unknown) => e as Error);

    expect(err).not.toBeInstanceOf(ConditionalAccessError);
    expect(err.message).toMatch(/provisioning Failed/i);
  });
});