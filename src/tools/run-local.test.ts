// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Unit tests for project_run_local.
 *
 * Focus:
 *   - The reported URL/port is derived from the detected project type
 *     (Vite → 5173, not the old hardcoded 3000; Node default 3000; .NET 5000).
 *   - Failed installation or terminated launch is reflected as isError.
 *   - Installation must finish before launch; resolution failures and propagated
 *     policy denials must stop subsequent execution.
 *   - An open candidate port is not presented as verified application startup.
 *
 * ../proc-exec.js and node:fs are mocked so nothing actually spawns.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";

let files: Record<string, string> = {};
type SpawnBehavior = "spawn" | "error" | "exit-nonzero" | "exit-zero" | "signal" | "throw";
let spawnBehavior: SpawnBehavior = "spawn";
let installBehavior: SpawnBehavior = "spawn";
let devChild: EventEmitter | undefined;
const spawnError = "spawn npm ENOENT";

vi.mock("node:fs", () => ({
  existsSync: vi.fn((p: string) => Object.keys(files).some((f) => String(p).endsWith(f))),
  readFileSync: vi.fn((p: string) => {
    const key = Object.keys(files).find((f) => String(p).endsWith(f));
    if (key) return files[key];
    throw new Error("ENOENT");
  }),
}));

vi.mock("../proc-exec.js", () => ({
  spawnProcess: vi.fn((_command: string, args: string[]) => {
    const installing = args[0] === "install";
    const behavior = installing ? installBehavior : spawnBehavior;
    if (behavior === "throw") {
      throw Object.assign(new Error("untrusted executable resolution"), {
        code: "ERR_UNTRUSTED_EXECUTABLE",
      });
    }
    const child = new EventEmitter() as EventEmitter & { unref: () => void };
    child.unref = () => {};
    if (!installing) devChild = child;
    queueMicrotask(() => {
      if (behavior === "error") {
        child.emit("error", new Error(spawnError));
      } else if (behavior === "exit-nonzero") {
        // Early non-zero exit path: 'spawn' fires, then the child exits
        // non-zero because the toolchain is missing.
        child.emit("spawn");
        child.emit("exit", 1, null);
      } else if (behavior === "exit-zero" || behavior === "signal") {
        child.emit("spawn");
        child.emit("exit", behavior === "signal" ? null : 0, behavior === "signal" ? "SIGTERM" : null);
      } else {
        child.emit("spawn");
        if (installing) child.emit("close", 0, null);
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

import { spawnProcess } from "../proc-exec.js";
import { waitForServerReady } from "../server-readiness.js";
import { runLocalTool } from "../tools/run-local.js";

function pkg(scripts: Record<string, string>): string {
  return JSON.stringify({ name: "app", scripts });
}

beforeEach(() => {
  vi.clearAllMocks();
  files = {};
  spawnBehavior = "spawn";
  installBehavior = "spawn";
  devChild = undefined;
  serverReady = true;
  vi.mocked(waitForServerReady).mockImplementation(async () => serverReady);
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

  it("does not derive the dev port from an unrelated start script", async () => {
    files = { "package.json": pkg({ dev: "vite", start: "node server.js --port 8080" }) };

    const result = await runLocalTool.handler({ projectDir: "/proj" });

    expect(result.content[0].text).toContain("http://localhost:5173");
    expect(waitForServerReady).toHaveBeenCalledWith(5173);
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
    expect(spawnProcess).toHaveBeenCalledWith("dotnet", ["run"], expect.objectContaining({ detached: true }));
  });

  it("errors when no runnable project is present", async () => {
    files = {};
    const result = await runLocalTool.handler({ projectDir: "/proj" });
    expect(result.isError).toBe(true);
    expect(spawnProcess).not.toHaveBeenCalled();
  });
});

describe("project_run_local — start-outcome reflection", () => {
  it("waits for a successful dependency installation before launching dev", async () => {
    files = { "package.json": pkg({ dev: "vite" }) };
    const install = Object.assign(new EventEmitter(), { unref: () => {} });
    vi.mocked(spawnProcess).mockReturnValueOnce(install as ReturnType<typeof spawnProcess>);

    const pending = runLocalTool.handler({ projectDir: "/proj" });

    expect(spawnProcess).toHaveBeenCalledTimes(1);
    expect(spawnProcess).toHaveBeenCalledWith("npm", ["install"], {
      cwd: expect.stringMatching(/[/\\]proj$/),
      stdio: "ignore",
    });
    expect(waitForServerReady).not.toHaveBeenCalled();
    install.emit("spawn");
    await Promise.resolve();
    expect(spawnProcess).toHaveBeenCalledTimes(1);
    expect(waitForServerReady).not.toHaveBeenCalled();
    install.emit("close", 0, null);
    const result = await pending;

    expect(result.isError).toBeFalsy();
    expect(spawnProcess).toHaveBeenNthCalledWith(
      2, "npm", ["run", "dev"], expect.objectContaining({ detached: true }),
    );
    expect(spawnProcess).toHaveBeenCalledTimes(2);
    expect(waitForServerReady).toHaveBeenCalledWith(5173);
  });

  it.each(["install", "dev"] as const)(
    "surfaces Node executable-resolution failure during %s without later launch or readiness",
    async (stage) => {
      files = { "package.json": pkg({ dev: "vite" }) };
      if (stage === "install") installBehavior = "throw";
      else spawnBehavior = "throw";

      const result = await runLocalTool.handler({ projectDir: "/proj" });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("untrusted executable resolution");
      expect(result.content[0].text).toContain(stage === "install" ? "npm install" : "npm run dev");
      expect(spawnProcess).toHaveBeenCalledTimes(stage === "install" ? 1 : 2);
      expect(waitForServerReady).not.toHaveBeenCalled();
      expect(result.content[0].text).not.toContain("Candidate URL");
    },
  );

  it.each(["install", "dev", "dotnet"] as const)(
    "propagates process-policy denial during %s without retrying or probing readiness",
    async (stage) => {
      files = stage === "dotnet" ? { "Program.cs": "// app" } : { "package.json": pkg({ dev: "vite" }) };
      const deny = () => { throw new Error("Local execution denied by policy"); };
      const install = Object.assign(new EventEmitter(), { unref: () => {} });
      if (stage === "dev") {
        vi.mocked(spawnProcess).mockReturnValueOnce(install as ReturnType<typeof spawnProcess>);
      }
      vi.mocked(spawnProcess).mockImplementationOnce(deny);
      const pending = runLocalTool.handler({ projectDir: "/proj" });
      if (stage === "dev") install.emit("close", 0, null);
      const result = await pending;

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain(
        stage === "dev" ? "npm run dev" : stage === "install" ? "npm install" : "dotnet run",
      );
      expect(result.content[0].text).toContain("Local execution denied by policy");
      expect(result.content[0].text).not.toContain("Candidate URL");
      expect(spawnProcess).toHaveBeenCalledTimes(stage === "dev" ? 2 : 1);
      expect(waitForServerReady).not.toHaveBeenCalled();
    },
  );

  it.each<SpawnBehavior>(["error", "exit-nonzero", "signal", "throw"])(
    "stops before dev launch when dependency installation fails: %s",
    async (behavior) => {
      files = { "package.json": pkg({ dev: "vite" }) };
      installBehavior = behavior;

      const result = await runLocalTool.handler({ projectDir: "/proj" });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("npm install");
      expect(result.content[0].text).toContain("failed to start");
      expect(spawnProcess).toHaveBeenCalledTimes(1);
      expect(waitForServerReady).not.toHaveBeenCalled();
    },
  );

  it.each<SpawnBehavior>(["exit-zero", "signal"])(
    "does not report a terminated dev process as running: %s",
    async (behavior) => {
      files = { "package.json": pkg({ dev: "vite" }) };
      spawnBehavior = behavior;

      const result = await runLocalTool.handler({ projectDir: "/proj" });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("before startup completed");
      expect(waitForServerReady).not.toHaveBeenCalled();
    },
  );

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

  it("surfaces a non-zero early EXIT as isError (early-exit false-success path, Node)", async () => {
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

  it("surfaces a synchronous executable-resolution failure", async () => {
    files = { "Program.cs": "// app" };
    spawnBehavior = "throw";

    const result = await runLocalTool.handler({ projectDir: "/proj" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("untrusted executable resolution");
  });
});

describe("project_run_local — readiness verification", () => {
  it("discloses that an open candidate port does not verify application startup", async () => {
    files = { "package.json": pkg({ dev: "vite" }) };
    serverReady = true;

    const result = await runLocalTool.handler({ projectDir: "/proj" });

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("http://localhost:5173");
    expect(result.content[0].text).toContain("Startup is unverified");
    expect(result.content[0].text).toContain("Candidate URL");
    expect(result.content[0].text).not.toContain("App Running Locally");
    expect(result.content[0].text).not.toContain("is up and accepting connections");
    // Surfaces the server-side Entra app-registration sign-in note
    // so a SPA redirect-URI failure isn't mistaken for a stale dev server.
    expect(result.content[0].text).toContain("AADSTS9002326");
    expect(result.content[0].text).toContain("not** picked up by client hot-reload");
    // The probe is driven off the detected dev-server port (Vite → 5173).
    expect(waitForServerReady).toHaveBeenCalledWith(5173);
  });

  it.each([
    ["exit", 1, null],
    ["exit", 0, null],
    ["close", null, "SIGTERM"],
    ["error", null, null],
  ] as const)("rejects a process %s (%s, %s) during readiness even when another listener is reachable", async (event, code, signal) => {
    files = { "package.json": pkg({ dev: "vite" }) };
    vi.mocked(waitForServerReady).mockImplementationOnce(async () => {
      if (event === "error") devChild?.emit("error", new Error("late startup failure"));
      else devChild?.emit(event, code, signal);
      return true;
    });

    const result = await runLocalTool.handler({ projectDir: "/proj" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("failed to start");
    expect(result.content[0].text).not.toContain("Candidate URL");
  });

  it("returns a failure (no URL) when the server launches but never becomes ready", async () => {
    files = { "package.json": pkg({ dev: "vite" }) };
    serverReady = false;

    const result = await runLocalTool.handler({ projectDir: "/proj" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("never became ready");
    expect(result.content[0].text).not.toContain("App Running Locally");
  });

  it("probes the .NET fallback port without claiming it is the actual launch URL", async () => {
    files = { "Program.cs": "// app" };
    serverReady = true;

    const result = await runLocalTool.handler({ projectDir: "/proj" });

    expect(result.isError).toBeFalsy();
    expect(waitForServerReady).toHaveBeenCalledWith(5000);
    expect(result.content[0].text).toContain("http://localhost:5000");
    expect(result.content[0].text).toContain("Startup is unverified");
    expect(result.content[0].text).toContain("launch settings");
  });
});
