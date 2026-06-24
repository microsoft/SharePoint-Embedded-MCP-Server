// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Unit tests for project_run_local.
 *
 * Focus:
 *   - The reported URL/port is derived from the detected project type
 *     (Vite → 5173, not the old hardcoded 3000; Node default 3000; .NET 5000).
 *   - A failed process launch (spawn error / ENOENT) is reflected as isError
 *     instead of a false "running" success.
 *
 * node:child_process and node:fs are mocked so nothing actually spawns.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";

let files: Record<string, string> = {};
let spawnBehavior: "spawn" | "error" | "exit-nonzero" = "spawn";
const spawnError = "spawn npm ENOENT";

vi.mock("node:fs", () => ({
  existsSync: vi.fn((p: string) => Object.keys(files).some((f) => String(p).endsWith(f))),
  readFileSync: vi.fn((p: string) => {
    const key = Object.keys(files).find((f) => String(p).endsWith(f));
    if (key) return files[key];
    throw new Error("ENOENT");
  }),
}));

vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => {
    const child = new EventEmitter() as EventEmitter & { unref: () => void };
    child.unref = () => {};
    queueMicrotask(() => {
      if (spawnBehavior === "error") {
        child.emit("error", new Error(spawnError));
      } else if (spawnBehavior === "exit-nonzero") {
        // win32 shell:true false-success path: the OS spawns cmd.exe ('spawn'
        // fires), then the shell exits non-zero because the toolchain is missing.
        child.emit("spawn");
        child.emit("exit", 1, null);
      } else {
        child.emit("spawn");
      }
    });
    return child;
  }),
}));

// Readiness probe is mocked so tests never open real sockets; serverReady
// controls whether the launched server is reported as reachable.
let serverReady = true;
vi.mock("../server-readiness.js", () => ({
  waitForServerReady: vi.fn(async () => serverReady),
}));

import { spawn } from "node:child_process";
import { waitForServerReady } from "../server-readiness.js";
import { runLocalTool } from "../tools/run-local.js";

function pkg(scripts: Record<string, string>): string {
  return JSON.stringify({ name: "app", scripts });
}

beforeEach(() => {
  vi.clearAllMocks();
  files = {};
  spawnBehavior = "spawn";
  serverReady = true;
});

describe("project_run_local — URL/port detection", () => {
  it("reports Vite's 5173 (not the old hardcoded 3000) for a React/Vite project", async () => {
    files = { "package.json": pkg({ dev: "vite", build: "vite build" }) };

    const result = await runLocalTool.handler({ projectDir: "/proj" });

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("http://localhost:5173");
    expect(result.content[0].text).not.toContain("3000");
  });

  it("honors an explicit --port flag in the dev script", async () => {
    files = { "package.json": pkg({ dev: "vite --port 4280" }) };

    const result = await runLocalTool.handler({ projectDir: "/proj" });

    expect(result.content[0].text).toContain("http://localhost:4280");
  });

  it("falls back to 3000 for a generic Node dev server", async () => {
    files = { "package.json": pkg({ dev: "node server.js" }) };

    const result = await runLocalTool.handler({ projectDir: "/proj" });

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("http://localhost:3000");
  });

  it("detects a .NET project and reports 5000", async () => {
    files = { "Program.cs": "// app" };

    const result = await runLocalTool.handler({ projectDir: "/proj" });

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("http://localhost:5000");
    expect(spawn).toHaveBeenCalledWith("dotnet", ["run"], expect.objectContaining({ detached: true }));
  });

  it("errors when no runnable project is present", async () => {
    files = {};
    const result = await runLocalTool.handler({ projectDir: "/proj" });
    expect(result.isError).toBe(true);
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe("project_run_local — start-outcome reflection", () => {
  it("surfaces a spawn failure as isError instead of false success (Node)", async () => {
    files = { "package.json": pkg({ dev: "vite" }) };
    spawnBehavior = "error";

    const result = await runLocalTool.handler({ projectDir: "/proj" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("failed to start");
    expect(result.content[0].text).not.toContain("App Running Locally");
  });

  it("surfaces a spawn failure as isError instead of false success (.NET)", async () => {
    files = { "Program.cs": "// app" };
    spawnBehavior = "error";

    const result = await runLocalTool.handler({ projectDir: "/proj" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("failed to start");
  });

  it("surfaces a non-zero early EXIT as isError (win32 shell:true false-success path, Node)", async () => {
    files = { "package.json": pkg({ dev: "vite" }) };
    spawnBehavior = "exit-nonzero";

    const result = await runLocalTool.handler({ projectDir: "/proj" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("failed to start");
    expect(result.content[0].text).not.toContain("App Running Locally");
  });

  it("surfaces a non-zero early EXIT as isError (.NET)", async () => {
    files = { "Program.cs": "// app" };
    spawnBehavior = "exit-nonzero";

    const result = await runLocalTool.handler({ projectDir: "/proj" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("failed to start");
  });
});

describe("project_run_local — readiness verification", () => {
  it("returns the URL only after the server is verified ready", async () => {
    files = { "package.json": pkg({ dev: "vite" }) };
    serverReady = true;

    const result = await runLocalTool.handler({ projectDir: "/proj" });

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("http://localhost:5173");
    expect(result.content[0].text).toContain("accepting connections");
    // Surfaces the server-side Entra app-registration sign-in note
    // so a SPA redirect-URI failure isn't mistaken for a stale dev server.
    expect(result.content[0].text).toContain("AADSTS9002326");
    expect(result.content[0].text).toContain("not** picked up by client hot-reload");
    // The probe is driven off the detected dev-server port (Vite → 5173).
    expect(waitForServerReady).toHaveBeenCalledWith(5173);
  });

  it("returns a failure (no URL) when the server launches but never becomes ready", async () => {
    files = { "package.json": pkg({ dev: "vite" }) };
    serverReady = false;

    const result = await runLocalTool.handler({ projectDir: "/proj" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("never became ready");
    expect(result.content[0].text).not.toContain("App Running Locally");
  });

  it("probes the .NET port (5000) and returns the URL once ready", async () => {
    files = { "Program.cs": "// app" };
    serverReady = true;

    const result = await runLocalTool.handler({ projectDir: "/proj" });

    expect(result.isError).toBeFalsy();
    expect(waitForServerReady).toHaveBeenCalledWith(5000);
    expect(result.content[0].text).toContain("http://localhost:5000");
  });
});
