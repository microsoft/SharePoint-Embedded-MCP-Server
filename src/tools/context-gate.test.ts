// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Unit tests for the restart confirmation gate (context-gate.ts) — PR #3
 * review: r-appgate. Verifies that control-plane mutation handlers are asked to confirm
 * the remembered owning app / container type on a fresh (unconfirmed) session,
 * that confirmation clears the gate for the rest of the process, and that the
 * staleness warning fires when the owning app cannot enumerate all CTs.
 *
 * state.js is mocked with an in-memory store shared by session.js (imported
 * transitively) so stampContextConfirmed round-trips without disk I/O.
 * elicitation.js is REAL so we assert on the actual agent-guided choice text.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ProvisioningState } from "../state.js";

let stateStore: ProvisioningState;

vi.mock("../state.js", () => ({
  readState: () => ({ ...stateStore }),
  writeState: (patch: Partial<ProvisioningState>) => {
    stateStore = { ...stateStore, ...patch };
    return { ...stateStore };
  },
}));

import { getSessionId } from "../session.js";
import { requireConfirmedContext, resolveContextGate } from "./context-gate.js";

beforeEach(() => {
  stateStore = {};
});

describe("requireConfirmedContext", () => {
  it("returns null when there is nothing remembered to confirm", async () => {
    expect(await requireConfirmedContext()).toBeNull();
  });

  it("returns a confirm/switch choice when an owning app is remembered but unconfirmed", async () => {
    stateStore = { appId: "app-1", appDisplayName: "Contoso Docs App", containerTypeName: "Docs CT" };

    const r = await requireConfirmedContext();

    expect(r).not.toBeNull();
    expect(r?.isError).toBe(false);
    const text = r?.content[0].text ?? "";
    expect(text).toContain("Confirm the active");
    expect(text).toContain("Contoso Docs App");
    expect(text).toContain("Docs CT");
    expect(text).toContain("contextChoice=confirm");
    expect(text).toContain("contextChoice=switch");
  });

  it("also fires when only a container type is remembered (no owning app)", async () => {
    stateStore = { containerTypeId: "ct-1" };
    expect(await requireConfirmedContext()).not.toBeNull();
  });

  it("returns null once the context is confirmed under the current session", async () => {
    stateStore = { appId: "app-1", confirmedSessionId: getSessionId() };
    expect(await requireConfirmedContext()).toBeNull();
  });

  it("notes a prior session when contextConfirmedAt was set by an earlier process", async () => {
    stateStore = {
      appId: "app-1",
      contextConfirmedAt: "2024-01-01T00:00:00.000Z",
      confirmedSessionId: "some-old-session",
    };

    const text = (await requireConfirmedContext())?.content[0].text ?? "";
    expect(text).toContain("prior session");
  });

  it("appends a staleness warning only when owningAppManagesAllContainerTypes === false", async () => {
    stateStore = { appId: "app-1", owningAppManagesAllContainerTypes: false };
    expect((await requireConfirmedContext())?.content[0].text).toContain("stale");

    stateStore = { appId: "app-1", owningAppManagesAllContainerTypes: true };
    expect((await requireConfirmedContext())?.content[0].text).not.toContain("stale");

    stateStore = { appId: "app-1" }; // undefined => unknown => no warning
    expect((await requireConfirmedContext())?.content[0].text).not.toContain("stale");
  });
});

describe("resolveContextGate", () => {
  it("stamps the session confirmed and returns null on 'confirm'", async () => {
    stateStore = { appId: "app-1" };

    const r = await resolveContextGate("confirm");

    expect(r).toBeNull();
    expect(stateStore.confirmedSessionId).toBe(getSessionId());
    expect(stateStore.contextConfirmedAt).toBeTruthy();
  });

  it("directs the user to re-provision on 'switch' (without stamping)", async () => {
    stateStore = { appId: "app-1" };

    const r = await resolveContextGate("switch");

    expect(r).not.toBeNull();
    expect(r?.isError).toBe(false);
    expect(r?.content[0].text).toContain("project_provision");
    expect(stateStore.confirmedSessionId).toBeUndefined();
  });

  it("returns the confirmation choice when no contextChoice is supplied (unconfirmed)", async () => {
    stateStore = { appId: "app-1" };
    expect(await resolveContextGate(undefined)).not.toBeNull();
  });

  it("returns null when no contextChoice is supplied but the session is already confirmed", async () => {
    stateStore = { appId: "app-1", confirmedSessionId: getSessionId() };
    expect(await resolveContextGate(undefined)).toBeNull();
  });
});
