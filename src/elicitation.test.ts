// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Unit tests for the native-vs-fallback elicitation helpers (elicitation.ts) —
 * PR #3 review. Verifies that:
 *   - with NO wired server (or a client without the elicitation capability) the
 *     helpers fall back to the agent-guided `needChoice` text — identical to the
 *     pre-native behavior — and never call `elicitInput`;
 *   - with a wired, capability-advertising client, `elicitChoice` issues a native
 *     `elicitInput` form request and resolves in-band on accept;
 *   - decline/cancel/invalid/throw all degrade safely.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  elicitChoice,
  elicitText,
  wireElicitation,
  resetElicitationForTests,
  type Choice,
  type ElicitInputResult,
  type ElicitationCapableServer,
} from "./elicitation.js";

const OPTIONS: Choice[] = [
  { label: "Reuse", value: "reuse", description: "the remembered app" },
  { label: "Use a different app", value: "new" },
];

type ElicitInputParams = { mode: "form"; message: string; requestedSchema: Record<string, unknown> };

/** Build a lightweight fake MCP server with a spied `elicitInput`. */
function fakeServer(opts: {
  capabilities: { elicitation?: unknown } | undefined;
  elicitInput?: (params: ElicitInputParams) => Promise<ElicitInputResult>;
}): ElicitationCapableServer & { elicitInput: ReturnType<typeof vi.fn> } {
  const impl = opts.elicitInput ?? (async () => ({ action: "accept", content: {} }) as ElicitInputResult);
  const elicitInput = vi.fn(impl);
  return {
    elicitInput,
    getClientCapabilities: () => opts.capabilities,
  } as ElicitationCapableServer & { elicitInput: ReturnType<typeof vi.fn> };
}

/** Read the `oneOf` const values off a captured requestedSchema. */
function oneOfConsts(params: ElicitInputParams, paramName: string): string[] {
  const props = (params.requestedSchema as { properties: Record<string, unknown> }).properties;
  const prop = props[paramName] as { oneOf?: Array<{ const: string }> };
  return (prop.oneOf ?? []).map((e) => e.const);
}

afterEach(() => {
  resetElicitationForTests();
  vi.restoreAllMocks();
});

describe("elicitChoice — fallback (no native elicitation)", () => {
  it("with NO wired server, resolves false with the agent-guided needChoice text", async () => {
    const r = await elicitChoice("Reuse or use a different app?", OPTIONS, "appSelection");

    expect(r.resolved).toBe(false);
    if (!r.resolved) {
      expect(r.result.isError).toBe(false);
      const text = r.result.content[0].text;
      // needChoice encodes the paramName and every value as `paramName=value`.
      expect(text).toContain("appSelection");
      expect(text).toContain("appSelection=reuse");
      expect(text).toContain("appSelection=new");
    }
  });

  it("when the client does NOT advertise elicitation, falls back WITHOUT calling elicitInput", async () => {
    const server = fakeServer({
      capabilities: {}, // no `elicitation` key
      elicitInput: async () => ({ action: "accept", content: { appSelection: "reuse" } }),
    });
    wireElicitation(server);

    const r = await elicitChoice("q", OPTIONS, "appSelection");

    expect(server.elicitInput).not.toHaveBeenCalled();
    expect(r.resolved).toBe(false);
    if (!r.resolved) expect(r.result.content[0].text).toContain("appSelection=reuse");
  });

  it("when getClientCapabilities() returns undefined, falls back WITHOUT calling elicitInput", async () => {
    const server = fakeServer({
      capabilities: undefined,
      elicitInput: async () => ({ action: "accept", content: { appSelection: "reuse" } }),
    });
    wireElicitation(server);

    const r = await elicitChoice("q", OPTIONS, "appSelection");

    expect(server.elicitInput).not.toHaveBeenCalled();
    expect(r.resolved).toBe(false);
  });
});

describe("elicitChoice — native elicitation", () => {
  it("on accept with a valid value, resolves in-band and calls elicitInput with a oneOf schema", async () => {
    const server = fakeServer({
      capabilities: { elicitation: {} },
      elicitInput: async () => ({ action: "accept", content: { appSelection: "new" } }),
    });
    wireElicitation(server);

    const r = await elicitChoice("Reuse or use a different app?", OPTIONS, "appSelection");

    expect(r).toEqual({ resolved: true, value: "new" });
    expect(server.elicitInput).toHaveBeenCalledTimes(1);
    const params = server.elicitInput.mock.calls[0][0] as ElicitInputParams;
    expect(params.mode).toBe("form");
    expect(params.message).toBe("Reuse or use a different app?");
    expect(oneOfConsts(params, "appSelection")).toEqual(["reuse", "new"]);
  });

  it("on accept with an UNKNOWN value, returns a friendly no-op (isError:false)", async () => {
    const server = fakeServer({
      capabilities: { elicitation: {} },
      elicitInput: async () => ({ action: "accept", content: { appSelection: "bogus" } }),
    });
    wireElicitation(server);

    const r = await elicitChoice("q", OPTIONS, "appSelection");

    expect(r.resolved).toBe(false);
    if (!r.resolved) {
      expect(r.result.isError).toBe(false);
      expect(r.result.content[0].text).toContain("No selection made");
    }
  });

  it("on decline, returns a friendly no-op (isError:false), NOT the needChoice text", async () => {
    const server = fakeServer({
      capabilities: { elicitation: {} },
      elicitInput: async () => ({ action: "decline" }),
    });
    wireElicitation(server);

    const r = await elicitChoice("q", OPTIONS, "appSelection");

    expect(r.resolved).toBe(false);
    if (!r.resolved) {
      expect(r.result.isError).toBe(false);
      expect(r.result.content[0].text).toContain("No selection made");
    }
  });

  it("on cancel, returns a friendly no-op (isError:false)", async () => {
    const server = fakeServer({
      capabilities: { elicitation: {} },
      elicitInput: async () => ({ action: "cancel" }),
    });
    wireElicitation(server);

    const r = await elicitChoice("q", OPTIONS, "appSelection");

    expect(r.resolved).toBe(false);
    if (!r.resolved) expect(r.result.content[0].text).toContain("No selection made");
  });

  it("when elicitInput THROWS, falls back to the agent-guided needChoice text", async () => {
    const server = fakeServer({
      capabilities: { elicitation: {} },
      elicitInput: async () => {
        throw new Error("Client does not support form elicitation.");
      },
    });
    wireElicitation(server);

    const r = await elicitChoice("q", OPTIONS, "appSelection");

    expect(r.resolved).toBe(false);
    if (!r.resolved) {
      // fallback needChoice text — encodes `paramName=value`
      expect(r.result.content[0].text).toContain("appSelection=reuse");
      expect(r.result.content[0].text).toContain("appSelection=new");
    }
  });
});

describe("elicitText", () => {
  it("on native accept with a non-empty string, resolves true (trimmed) and passes the title", async () => {
    const server = fakeServer({
      capabilities: { elicitation: {} },
      elicitInput: async () => ({ action: "accept", content: { displayName: "  My App  " } }),
    });
    wireElicitation(server);

    const r = await elicitText("Name for the new owning app?", "displayName", { title: "New app name" });

    expect(r).toEqual({ resolved: true, value: "My App" });
    const params = server.elicitInput.mock.calls[0][0] as ElicitInputParams;
    const props = (params.requestedSchema as { properties: Record<string, { title?: string }> }).properties;
    expect(props.displayName.title).toBe("New app name");
  });

  it("on decline, resolves false with a null result (caller keeps its default)", async () => {
    const server = fakeServer({
      capabilities: { elicitation: {} },
      elicitInput: async () => ({ action: "decline" }),
    });
    wireElicitation(server);

    const r = await elicitText("Name?", "displayName");

    expect(r).toEqual({ resolved: false, result: null });
  });

  it("on native accept with an EMPTY string, resolves false with a null result", async () => {
    const server = fakeServer({
      capabilities: { elicitation: {} },
      elicitInput: async () => ({ action: "accept", content: { displayName: "   " } }),
    });
    wireElicitation(server);

    const r = await elicitText("Name?", "displayName");

    expect(r).toEqual({ resolved: false, result: null });
  });

  it("with NO native capability, resolves false/null WITHOUT calling elicitInput (silent fallback)", async () => {
    const server = fakeServer({
      capabilities: {},
      elicitInput: async () => ({ action: "accept", content: { displayName: "X" } }),
    });
    wireElicitation(server);

    const r = await elicitText("Name?", "displayName");

    expect(server.elicitInput).not.toHaveBeenCalled();
    expect(r).toEqual({ resolved: false, result: null });
  });

  it("when elicitInput THROWS, resolves false with a null result (silent fallback)", async () => {
    const server = fakeServer({
      capabilities: { elicitation: {} },
      elicitInput: async () => {
        throw new Error("nope");
      },
    });
    wireElicitation(server);

    const r = await elicitText("Name?", "displayName");

    expect(r).toEqual({ resolved: false, result: null });
  });
});
