// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Agent Plugins 1.0 packaging and launch-contract tests.
 *
 * Schema assertions use deterministic vendored 1.0.0 schemas. The protocol
 * regression intentionally exercises the exact immutable npm pin from the
 * manifest, with bounded fetch and startup timeouts.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Ajv2020 from "ajv/dist/2020.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
const MCP_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";

interface PluginManifest {
  [key: string]: unknown;
  $schema: string;
  name: string;
  version: string;
  author: Record<string, string>;
}

interface StdioServerConfig {
  [key: string]: unknown;
  type: string;
  command: string;
  args: string[];
  cwd: string;
}

interface McpManifest {
  [key: string]: unknown;
  $schema: string;
  mcpServers: Record<string, StdioServerConfig>;
}

interface PackageManifest {
  version: string;
  files: string[];
}

interface PackageLock {
  version: string;
  packages: Record<string, { version: string }>;
}

function readJson<T>(relativePath: string): T {
  return JSON.parse(readFileSync(join(REPO_ROOT, relativePath), "utf8")) as T;
}

async function removeDirectoryAfterProcessExit(path: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      rmSync(path, { recursive: true, force: true });
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EPERM" || attempt === 19) {
        throw error;
      }
      // On Windows, npm's grandchild can briefly retain its cwd after the MCP
      // transport closes. Wait for that bounded shutdown before removing state.
      await delay(250);
    }
  }
}

const plugin = readJson<PluginManifest>("plugin.json");
const mcp = readJson<McpManifest>("mcp.json");
const pkg = readJson<PackageManifest>("package.json");
const lock = readJson<PackageLock>("package-lock.json");
const server = mcp.mcpServers?.["sharepoint-embedded"];
const pinnedPackage = `@microsoft/spe-mcp@${pkg.version}`;

describe("Agent Plugins 1.0 manifest schema", () => {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const pluginSchema = readJson<Record<string, unknown>>(
    "schemas/agent-plugins/1.0.0/plugin.schema.json",
  );
  const mcpSchema = readJson<Record<string, unknown>>(
    "schemas/agent-plugins/1.0.0/mcp.schema.json",
  );
  const validatePlugin = ajv.compile(pluginSchema);
  const validateMcp = ajv.compile(mcpSchema);

  it("validates plugin.json against the vendored authoritative schema", () => {
    expect(plugin.$schema).toBe(PLUGIN_SCHEMA);
    expect(validatePlugin(plugin), JSON.stringify(validatePlugin.errors)).toBe(true);
  });

  it("validates mcp.json against the vendored authoritative schema", () => {
    expect(mcp.$schema).toBe(MCP_SCHEMA);
    expect(validateMcp(mcp), JSON.stringify(validateMcp.errors)).toBe(true);
  });

  it("uses the authoritative closed-schema behavior", () => {
    const invalidPlugin = { ...plugin, unsupported: true };
    const invalidMcp = { ...mcp, unsupported: true };
    expect(validatePlugin(invalidPlugin)).toBe(false);
    expect(validateMcp(invalidMcp)).toBe(false);
  });
});

describe("Agent Plugins 1.0 packaging contract", () => {
  it("ships both manifests and the dedicated documentation", () => {
    for (const file of ["plugin.json", "mcp.json", "docs/AGENT-PLUGIN.md"]) {
      expect(pkg.files).toContain(file);
      expect(existsSync(join(REPO_ROOT, file))).toBe(true);
    }
  });

  it("pins the verified published server version without a range or tag", () => {
    expect(server.args).toEqual([
      "-y",
      pinnedPackage,
      "start",
      "--read-only",
      "--data-dir",
      "${PLUGIN_DATA}",
    ]);
    expect(server.args.filter((arg) => arg === pinnedPackage)).toHaveLength(1);
    expect(lock.version).toBe(pkg.version);
    expect(lock.packages[""].version).toBe(pkg.version);
  });

  it("is MCP-only with a read-only local stdio default and persistent state", () => {
    expect(Object.keys(mcp.mcpServers)).toEqual(["sharepoint-embedded"]);
    expect(server.type).toBe("stdio");
    expect(server.command).toBe("npx");
    expect(server).not.toHaveProperty("url");
    expect(server).not.toHaveProperty("headers");
    expect(server.args).toContain("--read-only");
    expect(server.cwd).toBe("${PLUGIN_DATA}");
    expect(server.args.slice(server.args.indexOf("--data-dir"))).toEqual([
      "--data-dir",
      "${PLUGIN_DATA}",
    ]);
    expect(plugin).not.toHaveProperty("skills");
    expect(plugin).not.toHaveProperty("agents");
    expect(plugin).not.toHaveProperty("hooks");
    expect(plugin).not.toHaveProperty("oauth");
  });

  it("documents a branch-aware pilot install without claiming main is ready", () => {
    const docs = readFileSync(join(REPO_ROOT, "docs", "AGENT-PLUGIN.md"), "utf8");
    const futureHeading = docs.indexOf("## Install from the repository after merge to main");
    const sourceCommand = docs.indexOf("Chat: Install Plugin From");

    expect(docs).toContain("git fetch origin pull/82/head:pilot/agent-plugin");
    expect(docs).toContain("git switch pilot/agent-plugin");
    expect(docs).toContain("chat.pluginLocations");
    expect(docs).toContain("MCP: List Servers");
    expect(futureHeading).toBeGreaterThan(0);
    expect(sourceCommand).toBeGreaterThan(futureHeading);
    expect(docs).toContain("do not use until the plugin manifests reach the default");
  });
});

describe("Agent Plugins 1.0 exact manifest stdio launch", () => {
  let client: Client;
  let transport: StdioClientTransport;
  let pluginData: string;

  beforeAll(async () => {
    // Vitest starts in the plugin root, reproducing the package-self-resolution
    // condition that fails on Windows when cwd is omitted. A conforming client
    // creates PLUGIN_DATA, expands cwd/args, and launches the exact manifest
    // command from that non-package directory.
    expect(process.cwd()).toBe(REPO_ROOT);
    pluginData = mkdtempSync(join(tmpdir(), "spe-agent-plugin-data-"));
    const launchArgs = server.args.map((arg: string) =>
      arg.replaceAll("${PLUGIN_DATA}", pluginData),
    );
    const launchCwd = server.cwd.replaceAll("${PLUGIN_DATA}", pluginData);
    expect(launchCwd).toBe(pluginData);
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
    env.PLUGIN_ROOT = REPO_ROOT;
    env.PLUGIN_DATA = pluginData;
    env.npm_config_audit = "false";
    env.npm_config_fetch_retries = "0";
    env.npm_config_fetch_timeout = "15000";
    env.npm_config_fund = "false";
    env.npm_config_update_notifier = "false";

    transport = new StdioClientTransport({
      command: server.command,
      args: launchArgs,
      cwd: launchCwd,
      env,
      stderr: "ignore",
    });
    client = new Client({ name: "spe-agent-plugin-contract", version: "1.0.0" }, {});
    await client.connect(transport);
  }, 90000);

  afterAll(async () => {
    await client?.close().catch(() => undefined);
    await transport?.close().catch(() => undefined);
    if (pluginData) {
      await removeDirectoryAfterProcessExit(pluginData);
    }
  });

  it("starts the exact pinned npx command and advertises only read-only tools", async () => {
    expect(client.getServerVersion()?.name).toBe("spe-mcp-server");
    const { tools } = await client.listTools(undefined, { timeout: 8000 });
    expect(tools.length).toBeGreaterThan(0);
    expect(tools.every((tool) => tool.annotations?.readOnlyHint === true)).toBe(true);
    expect(tools.map((tool) => tool.name)).not.toContain("container_delete");
  });
});
