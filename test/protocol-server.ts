// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI_ENTRY = join(REPO_ROOT, "dist", "cli.js");
export const CALL_TIMEOUT_MS = 8000;

export interface StructuredError {
  ok?: boolean;
  error?: { code?: string; message?: string; suggestion?: string };
  durationMs?: number;
}

// Vitest calls this once, before starting any parallel test workers.
export default function setup(): void {
  if (!existsSync(CLI_ENTRY)) {
    execSync("npm run build", { cwd: REPO_ROOT, stdio: "inherit" });
  }
}

export async function startProtocolServer() {
  const started = performance.now();
  const isolatedHome = mkdtempSync(join(tmpdir(), "spe-mcp-e2e-home-"));
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") env[key] = value;
  }
  env.HOME = isolatedHome;
  env.USERPROFILE = isolatedHome;
  env.SPE_DATA_DIR = join(isolatedHome, "data");
  delete env.SPE_CLIENT_ID;
  delete env.SPE_TENANT_ID;
  delete env.SPE_READ_ONLY;
  delete env.SPE_TOOLS;

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [CLI_ENTRY, "start"],
    env,
    cwd: REPO_ROOT,
    stderr: "pipe",
  });
  let serverStderr = "";
  transport.stderr?.on("data", (chunk) => {
    serverStderr += String(chunk);
  });
  const client = new Client({ name: "Visual Studio Code", version: "0.0.0-test" }, {});
  const close = async () => {
    try {
      await client.close();
    } finally {
      try {
        await transport.close();
      } finally {
        rmSync(isolatedHome, { recursive: true, force: true });
      }
    }
  };
  try {
    await client.connect(transport);
  } catch (error) {
    try {
      await close();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Protocol startup and cleanup failed");
    }
    throw error;
  }
  const connected = performance.now();
  console.info(`[protocol] initialize connection: ${(connected - started).toFixed(1)}ms`);
  return {
    client,
    isolatedHome,
    get serverStderr() { return serverStderr; },
    async close() {
      await close();
      console.info(`[protocol] requests and cleanup: ${(performance.now() - connected).toFixed(1)}ms`);
    },
  };
}

export type ProtocolServer = Awaited<ReturnType<typeof startProtocolServer>>;
