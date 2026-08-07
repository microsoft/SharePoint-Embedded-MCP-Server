// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(REPO_ROOT, "scripts", "sync-plugin-version.mjs");
const tempRoots: string[] = [];

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "spe-plugin-version-"));
  tempRoots.push(root);
  for (const file of ["package.json", "plugin.json", "mcp.json", "server.json"]) {
    cpSync(join(REPO_ROOT, file), join(root, file));
  }
  writeFileSync(
    join(root, "package-lock.json"),
    `${JSON.stringify({
      name: "@microsoft/spe-mcp",
      version: "0.2.0-alpha.1",
      lockfileVersion: 3,
      packages: {
        "": { name: "@microsoft/spe-mcp", version: "0.2.0-alpha.1" },
      },
    }, null, 2)}\n`,
  );
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("plugin release version synchronization", () => {
  it("stages every manifest changed by the npm version lifecycle", () => {
    const pkg = readJson<{ scripts: { version: string } }>(join(REPO_ROOT, "package.json"));
    for (const file of ["plugin.json", "mcp.json", "server.json", "package-lock.json"]) {
      expect(pkg.scripts.version.split(/\s+/)).toContain(file);
    }
  });

  it("keeps the checked-in package and plugin versions synchronized", () => {
    execFileSync(process.execPath, [SCRIPT, "--check"], { cwd: REPO_ROOT });
  });

  it("stamps plugin.json and the exact MCP package pin from package.json", () => {
    const root = fixture();
    const packagePath = join(root, "package.json");
    const pkg = readJson<Record<string, unknown>>(packagePath);
    pkg.version = "9.8.7-alpha.6";
    writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);

    execFileSync(process.execPath, [SCRIPT, "--root", root]);

    const plugin = readJson<{ version: string }>(join(root, "plugin.json"));
    const lock = readJson<{
      version: string;
      packages: { "": { version: string } };
    }>(join(root, "package-lock.json"));
    const mcp = readJson<{
      mcpServers: { "sharepoint-embedded": { args: string[] } };
    }>(join(root, "mcp.json"));
    const registry = readJson<{
      version: string;
      packages: Array<{ version: string }>;
    }>(join(root, "server.json"));
    expect(plugin.version).toBe("9.8.7-alpha.6");
    expect(lock.version).toBe("9.8.7-alpha.6");
    expect(lock.packages[""].version).toBe("9.8.7-alpha.6");
    expect(mcp.mcpServers["sharepoint-embedded"].args).toContain(
      "@microsoft/spe-mcp@9.8.7-alpha.6",
    );
    expect(registry.version).toBe("9.8.7-alpha.6");
    expect(registry.packages.every((entry) => entry.version === "9.8.7-alpha.6")).toBe(true);
  });

  it("fails the prepack check when any plugin version drifts", () => {
    const root = fixture();
    const pluginPath = join(root, "plugin.json");
    const plugin = readJson<Record<string, unknown>>(pluginPath);
    plugin.version = "0.0.0";
    writeFileSync(pluginPath, `${JSON.stringify(plugin, null, 2)}\n`);

    const result = spawnSync(process.execPath, [SCRIPT, "--root", root, "--check"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr.toString()).toContain("Plugin version drift");
  });

  it("fails the prepack check when either package-lock version drifts", () => {
    const root = fixture();
    const lockPath = join(root, "package-lock.json");
    const lock = readJson<{
      version: string;
      packages: { "": { version: string } };
    }>(lockPath);
    lock.packages[""].version = "0.0.0";
    writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);

    const result = spawnSync(process.execPath, [SCRIPT, "--root", root, "--check"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr.toString()).toContain("package-lock.json");
  });
});
