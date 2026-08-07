// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_NAME = "@microsoft/spe-mcp";

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function serialized(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function expectedPackageSpec(version) {
  return `${PACKAGE_NAME}@${version}`;
}

export function synchronizePluginVersion(root, { check = false } = {}) {
  const packagePath = resolve(root, "package.json");
  const lockPath = resolve(root, "package-lock.json");
  const pluginPath = resolve(root, "plugin.json");
  const mcpPath = resolve(root, "mcp.json");
  const serverPath = resolve(root, "server.json");
  const pkg = readJson(packagePath);
  const lock = readJson(lockPath);
  const plugin = readJson(pluginPath);
  const mcp = readJson(mcpPath);
  const registry = readJson(serverPath);
  const server = mcp.mcpServers?.["sharepoint-embedded"];

  if (typeof pkg.version !== "string" || pkg.version.length === 0) {
    throw new Error("package.json must contain a non-empty version");
  }
  if (!server || !Array.isArray(server.args)) {
    throw new Error("mcp.json must define mcpServers.sharepoint-embedded.args");
  }

  const packageIndexes = server.args
    .map((arg, index) => ({ arg, index }))
    .filter(({ arg }) => typeof arg === "string" && arg.startsWith(`${PACKAGE_NAME}@`))
    .map(({ index }) => index);
  if (packageIndexes.length !== 1) {
    throw new Error(`mcp.json must contain exactly one exact ${PACKAGE_NAME}@<version> argument`);
  }

  const packageSpec = expectedPackageSpec(pkg.version);
  const synchronized =
    lock.version === pkg.version &&
    lock.packages?.[""]?.version === pkg.version &&
    plugin.version === pkg.version &&
    registry.version === pkg.version &&
    registry.packages?.every((entry) => entry.version === pkg.version) &&
    server.args[packageIndexes[0]] === packageSpec;

  if (check) {
    if (!synchronized) {
      throw new Error(
        `Plugin version drift: expected package-lock.json, plugin.json, and server.json ${pkg.version}, and mcp.json ${packageSpec}`,
      );
    }
    return false;
  }

  lock.version = pkg.version;
  if (!lock.packages?.[""]) {
    throw new Error('package-lock.json must define packages[""]');
  }
  lock.packages[""].version = pkg.version;
  plugin.version = pkg.version;
  registry.version = pkg.version;
  for (const entry of registry.packages ?? []) entry.version = pkg.version;
  server.args[packageIndexes[0]] = packageSpec;
  writeFileSync(lockPath, serialized(lock), "utf8");
  writeFileSync(pluginPath, serialized(plugin), "utf8");
  writeFileSync(mcpPath, serialized(mcp), "utf8");
  writeFileSync(serverPath, serialized(registry), "utf8");
  return !synchronized;
}

function parseArgs(argv) {
  let root = process.cwd();
  let check = false;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--check") {
      check = true;
    } else if (argv[index] === "--root") {
      root = argv[index + 1];
      if (!root) throw new Error("--root requires a path");
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${argv[index]}`);
    }
  }
  return { root, check };
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  const { root, check } = parseArgs(process.argv.slice(2));
  synchronizePluginVersion(root, { check });
}
