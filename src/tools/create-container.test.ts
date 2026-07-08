// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Unit tests for the container_create tool's registration precheck (WI-08 part
 * b, reviewer r3531125394).
 *
 * Standalone container_create must GET the container-type registration BEFORE
 * entering the ~150s propagation backoff loop:
 *   • registration ABSENT (404)        → fail fast, never call createContainer;
 *   • registration PRESENT             → proceed into the create loop;
 *   • precheck INCONCLUSIVE (5xx/429)  → do not block a valid create; proceed.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../graph-client.js", () => ({
  getContainerTypeRegistration: vi.fn(),
  createContainer: vi.fn(),
  activateContainer: vi.fn(),
}));
// Default the containerTypeId from mocked state so the test never reads the
// developer's real ~/.spe-mcp/state.json.
vi.mock("../state.js", () => ({
  readState: vi.fn(() => ({ containerTypeId: "ct-registered" })),
  writeState: vi.fn(),
}));

import * as graph from "../graph-client.js";
import { AppError } from "../errors.js";
import { createContainerTool } from "./create-container.js";

const activeContainer = {
  id: "c-1",
  displayName: "My First Container",
  containerTypeId: "ct-registered",
  status: "active",
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("container_create — registration precheck (WI-08)", () => {
  it("fails fast without any backoff when the container type is NOT registered (404)", async () => {
    vi.mocked(graph.getContainerTypeRegistration).mockRejectedValue(
      new AppError("NOT_FOUND", "Resource not found", { status: 404 }),
    );

    const result = await createContainerTool.handler({ containerTypeId: "ct-missing" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/not registered/i);
    // Never entered the create/backoff loop → createContainer must not run.
    expect(graph.createContainer).not.toHaveBeenCalled();
  });

  it("proceeds into the create loop when the registration is present", async () => {
    vi.mocked(graph.getContainerTypeRegistration).mockResolvedValue(
      { containerTypeId: "ct-registered" } as never,
    );
    vi.mocked(graph.createContainer).mockResolvedValue(activeContainer);

    const result = await createContainerTool.handler({ containerTypeId: "ct-registered" });

    expect(result.isError).toBeUndefined();
    expect(graph.createContainer).toHaveBeenCalledWith("ct-registered", "My First Container");
  });

  it("treats an inconclusive precheck (transient 5xx) as unknown and still creates", async () => {
    vi.mocked(graph.getContainerTypeRegistration).mockRejectedValue(
      new AppError("UPSTREAM", "Service unavailable", { status: 503 }),
    );
    vi.mocked(graph.createContainer).mockResolvedValue(activeContainer);

    const result = await createContainerTool.handler({ containerTypeId: "ct-registered" });

    // A flaky read must not block a valid create.
    expect(result.isError).toBeUndefined();
    expect(graph.createContainer).toHaveBeenCalledWith("ct-registered", "My First Container");
  });
});
