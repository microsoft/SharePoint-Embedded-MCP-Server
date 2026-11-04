// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CALL_TIMEOUT_MS, startProtocolServer, type ProtocolServer } from "../../test/protocol-server.js";

describe("container-type deletion over the MCP wire", () => {
  let server: ProtocolServer;
  beforeAll(async () => { server = await startProtocolServer(); }, 90000);
  afterAll(async () => { await server?.close(); });

  it("advertises container-type deletion safeguards and optional boolean controls over the wire", async () => {
    const { tools } = await server.client.listTools(undefined, { timeout: CALL_TIMEOUT_MS });
    const del = tools.find((tool) => tool.name === "container_type_delete");
    expect(del).toBeDefined();
    expect(del).not.toHaveProperty("handler");
    expect(del?.annotations?.destructiveHint).toBe(true);
    expect(del?.annotations?.readOnlyHint).not.toBe(true);
    expect(del?.description).toContain("Trial-only by default");
    expect(del?.description).toContain("direct-to-customer");
    expect(del?.description).toContain("PROTECTED");
    expect(del?.description).toContain("deleteStandard=true");
    expect(del?.description).toContain("Requires confirm=true");
    expect(del?.inputSchema.type).toBe("object");
    expect(del?.inputSchema.properties).toEqual({
      containerTypeId: {
        type: "string",
        description: expect.stringContaining("Default: the provisioned container type"),
      },
      confirm: {
        type: "boolean",
        description: expect.stringContaining("Must be true"),
      },
      deleteStandard: {
        type: "boolean",
        description: expect.stringContaining("Override to delete a STANDARD / direct-to-customer"),
      },
    });
    expect(del?.inputSchema.required ?? []).toEqual([]);
  });
});
