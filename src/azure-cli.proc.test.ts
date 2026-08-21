// Process-invocation contract for the Azure CLI helpers.
//
// These tests pin two boundary guarantees at the `az` process seam, independent
// of the higher-level tool handlers:
//   1. Reject-before-spawn: a malformed, externally influenced identifier is
//      refused BEFORE any child process is launched (the proc-exec seam is never
//      reached).
//   2. Discrete argv: a valid — but shell-sensitive — identifier that legitimately
//      reaches `az` is passed as ONE discrete argv element, and the options bag
//      never requests a shell.
//
// The launcher (`proc-exec`) is mocked so the argv/opts that each helper builds
// are observable without shelling out.

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("./proc-exec.js", () => ({
  runCommand: vi.fn(),
}));

import { runCommand } from "./proc-exec.js";
import {
  listResourceGroups,
  resourceGroupExists,
  showSyntexProvider,
  registerSyntexProvider,
} from "./azure-cli.js";

const run = vi.mocked(runCommand);

// A canonical valid subscription id (strict GUID) and a valid resource-group
// name that nonetheless contains shell-significant punctuation `.()` — a good
// "legal but shell-sensitive" argument.
const VALID_SUBSCRIPTION_ID = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
const VALID_RESOURCE_GROUP = "rg-spe-demo_01.(prod)";

// Subscription ids are validated as strict GUIDs, so ANY non-GUID string is
// rejected — including plain words and shell metacharacter payloads.
const MALFORMED_SUBSCRIPTION_IDS = [
  "not-a-guid",
  "--query",
  "a b",
  "3fa85f64-5717-4562-b3fc-2c963f66afa6 &",
  "$()",
  "``",
  "sub |",
  "sub ;",
];

// Resource-group names accept letters/digits/`_.()-`, so a plain word like
// "not-a-guid" is VALID and must NOT appear here — only names that fail the
// allowlist (whitespace, shell metacharacters, path traversal, flag-lookalikes).
const MALFORMED_RESOURCE_GROUP_NAMES = [
  "rg &",
  "rg |",
  "rg $()",
  "``",
  "--query",
  "a b",
  "rg/../",
  "rg ;",
];

beforeEach(() => {
  vi.clearAllMocks();
});

describe("azure-cli process seam — reject before spawn", () => {
  it.each(MALFORMED_SUBSCRIPTION_IDS)(
    "listResourceGroups rejects a malformed subscription id (%j) before spawning",
    async (badId) => {
      await expect(listResourceGroups(badId)).rejects.toThrow();
      expect(run).not.toHaveBeenCalled();
    },
  );

  it.each(MALFORMED_SUBSCRIPTION_IDS)(
    "showSyntexProvider rejects a malformed subscription id (%j) before spawning",
    async (badId) => {
      await expect(showSyntexProvider(badId)).rejects.toThrow();
      expect(run).not.toHaveBeenCalled();
    },
  );

  it.each(MALFORMED_SUBSCRIPTION_IDS)(
    "registerSyntexProvider rejects a malformed subscription id (%j) before spawning",
    async (badId) => {
      await expect(registerSyntexProvider(badId)).rejects.toThrow();
      expect(run).not.toHaveBeenCalled();
    },
  );

  it.each(MALFORMED_RESOURCE_GROUP_NAMES)(
    "resourceGroupExists refuses a malformed group name (%j) without spawning",
    async (badName) => {
      // Non-throwing probe: an invalid input resolves to `undefined` (indeterminate)
      // and must never reach the process seam.
      await expect(resourceGroupExists(badName, VALID_SUBSCRIPTION_ID)).resolves.toBeUndefined();
      expect(run).not.toHaveBeenCalled();
    },
  );

  it.each(MALFORMED_SUBSCRIPTION_IDS)(
    "resourceGroupExists refuses a malformed subscription id (%j) without spawning",
    async (badId) => {
      await expect(resourceGroupExists(VALID_RESOURCE_GROUP, badId)).resolves.toBeUndefined();
      expect(run).not.toHaveBeenCalled();
    },
  );
});

describe("azure-cli process seam — discrete argv, no shell", () => {
  it("passes a valid subscription id to az as one discrete argv element", async () => {
    run.mockResolvedValue({ stdout: "[]", stderr: "" });

    await listResourceGroups(VALID_SUBSCRIPTION_ID);

    expect(run).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = run.mock.calls[0] as unknown as [
      string,
      string[],
      Record<string, unknown>,
    ];
    expect(cmd).toBe("az");
    expect(args).toEqual([
      "group",
      "list",
      "--subscription",
      VALID_SUBSCRIPTION_ID,
      "--output",
      "json",
    ]);
    // The id is exactly one element — never concatenated into a shell string.
    expect(args[3]).toBe(VALID_SUBSCRIPTION_ID);
    expect(opts).not.toHaveProperty("shell");
  });

  it("passes a punctuation-bearing resource-group name to az as one discrete argv element", async () => {
    run.mockResolvedValue({ stdout: "{}", stderr: "" });

    const exists = await resourceGroupExists(VALID_RESOURCE_GROUP, VALID_SUBSCRIPTION_ID);

    expect(exists).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = run.mock.calls[0] as unknown as [
      string,
      string[],
      Record<string, unknown>,
    ];
    expect(cmd).toBe("az");
    expect(args).toEqual([
      "group",
      "show",
      "--name",
      VALID_RESOURCE_GROUP,
      "--subscription",
      VALID_SUBSCRIPTION_ID,
      "--output",
      "json",
    ]);
    // The `.()`-bearing name stays a single argv element.
    expect(args[3]).toBe(VALID_RESOURCE_GROUP);
    expect(opts).not.toHaveProperty("shell");
  });
});
