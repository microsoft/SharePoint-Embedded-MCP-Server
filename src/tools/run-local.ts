// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Tool: project_run_local
 *
 * Installs dependencies and starts the scaffolded reference app locally, then
 * reports a candidate local URL. Detects the project type (Node vs .NET) and
 * derives a likely dev-server port (e.g. Vite serves 5173, not 3000).
 * Ports EVAL.md `run-local`.
 *
 * The dev server is started detached so the MCP server stays responsive. The
 * tool waits for the immediate spawn outcome so a failed launch (e.g. a missing
 * toolchain / ENOENT) is reflected as an error instead of a false "running"
 * success, and then probes the derived port with a bounded TCP connect poll.
 * A listener may belong to another process, so startup remains explicitly
 * unverified rather than claiming the launched app owns that URL.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { LOCAL_DEV_PORT } from "../constants.js";
import { waitForServerReady } from "../server-readiness.js";
import { spawnProcess } from "../proc-exec.js";
import type { McpTool } from "../types.js";

interface RunLocalArgs {
  projectDir?: string;
}

interface DetectedProject {
  kind: "node" | "dotnet";
  port: number;
  url: string;
}

/**
 * Derive a candidate dev-server port instead of assuming 3000.
 * An explicit `--port N` in the dev script wins; otherwise
 * a Vite project serves 5173 by default and other Node servers fall back to 3000.
 */
function detectNodePort(dir: string): number {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    const scripts = pkg.scripts ?? {};
    const dev = String(scripts.dev ?? "");

    // Explicit port flag in the script (e.g. "vite --port 4280") takes priority.
    const portFlag = dev.match(/--port[=\s]+(\d{2,5})/);
    if (portFlag) return Number(portFlag[1]);

    // Vite's dev server port — our scaffold pins it to LOCAL_DEV_PORT in
    // vite.config.
    if (/\bvite\b/.test(dev)) return LOCAL_DEV_PORT;
    // create-react-app / Next.js default to 3000.
    if (/\b(react-scripts|next)\b/.test(dev)) return 3000;
  } catch {
    // Fall through to the generic Node default on any parse/read failure.
  }
  return 3000;
}

function detectProject(dir: string): DetectedProject | null {
  if (existsSync(join(dir, "package.json"))) {
    const port = detectNodePort(dir);
    return { kind: "node", port, url: `http://localhost:${port}` };
  }
  // any .csproj or Program.cs implies a .NET project
  if (existsSync(join(dir, "Program.cs"))) {
    return { kind: "dotnet", port: 5000, url: "http://localhost:5000" };
  }
  return null;
}

interface SpawnOutcome {
  ok: boolean;
  error?: string;
}

/**
 * Spawn a detached process and resolve with its immediate launch outcome:
 * `ok:false` if the OS could not start it (e.g. ENOENT for a missing command)
 * OR if it exits within the grace window (a missing
 * toolchain can surface only via an early non-zero exit code); `ok:true` once it
 * has survived the grace window without an early exit.
 * Resolves optimistically after the short grace period so we never block the MCP
 * server.
 *
 * Note: we deliberately do NOT resolve success on `'spawn'` alone — `'spawn'`
 * only means the OS created the process, not that the underlying command
 * exists. Later errors/exits continue updating the outcome while the caller
 * checks readiness.
 */
function startDetached(command: string, args: string[], cwd: string): Promise<SpawnOutcome> {
  return new Promise((resolveOutcome) => {
    let settled = false;
    const result: SpawnOutcome = { ok: true };
    let grace: NodeJS.Timeout | undefined;
    const finish = (outcome: SpawnOutcome): void => {
      if (!outcome.ok) {
        result.ok = false;
        result.error = outcome.error;
      }
      if (settled) return;
      settled = true;
      if (grace) clearTimeout(grace);
      resolveOutcome(result);
    };

    let child;
    try {
      child = spawnProcess(command, args, {
        cwd,
        detached: true,
        stdio: "ignore",
      });
    } catch (error) {
      finish({ ok: false, error: error instanceof Error ? error.message : String(error) });
      return;
    }

    const detachedChild = child;
    grace = setTimeout(() => {
      // Survived the grace window with no error or early exit — treat
      // as launched and detach so it outlives this process.
      try {
        detachedChild.unref();
      } catch {
        /* noop */
      }
      finish({ ok: true });
    }, 400);
    if (typeof grace.unref === "function") grace.unref();

    child.once("error", (error: Error) => {
      finish({ ok: false, error: error.message });
    });

    const onEarlyExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      const reason = signal ? `signal ${signal}` : `code ${code ?? "unknown"}`;
      finish({ ok: false, error: `process exited with ${reason} before startup completed` });
    };
    child.once("exit", onEarlyExit);
    child.once("close", onEarlyExit);

    child.once("spawn", () => {
      // Detach early so a successful server is unref'd, but do NOT resolve here:
      // wait for the grace window so an early exit can still win.
      try {
        detachedChild.unref();
      } catch {
        /* noop */
      }
    });
  });
}

/**
 * Run a command to COMPLETION (resolve on exit/close, not after a grace window).
 *
 * Used for `npm install`: the dependency install MUST finish before the dev
 * server starts. Starting `npm run dev` while `npm install` is still writing to
 * `node_modules` (e.g. Vite's `node_modules/.vite` dependency-optimization
 * cache) makes the dev server re-optimize/stall and never bind its port — a
 * fresh scaffold then fails readiness even though the toolchain is fine. Running
 * install first eliminates that race. A failed or interrupted installation
 * must be reported before attempting to launch the dev server.
 */
function runToCompletion(command: string, args: string[], cwd: string): Promise<SpawnOutcome> {
  return new Promise((resolveOutcome) => {
    let settled = false;
    const finish = (outcome: SpawnOutcome): void => {
      if (settled) return;
      settled = true;
      resolveOutcome(outcome);
    };

    let child;
    try {
      child = spawnProcess(command, args, {
        cwd,
        stdio: "ignore",
      });
    } catch (error) {
      finish({ ok: false, error: error instanceof Error ? error.message : String(error) });
      return;
    }

    child.once("error", (error: Error) => finish({ ok: false, error: error.message }));
    const onDone = (code: number | null, signal: NodeJS.Signals | null): void => {
      finish(code === 0 && !signal
        ? { ok: true }
        : { ok: false, error: `process exited with ${signal ? `signal ${signal}` : `code ${code ?? "unknown"}`}` });
    };
    child.once("exit", onDone);
    child.once("close", onDone);
  });
}

export const runLocalTool: McpTool = {
  name: "project_run_local",
  annotations: { localRequired: true },
  description:
    "Install dependencies and start the scaffolded SharePoint Embedded app locally, returning the " +
    "candidate local URL. Detects Node (npm) or .NET (dotnet) projects and probes the expected port " +
    "(e.g. Vite's 5173). Startup is unverified because a TCP listener may belong to another app. " +
    "Run after scaffolding and hydrating config.",
  inputSchema: {
    type: "object" as const,
    properties: {
      projectDir: { type: "string", description: "The scaffolded project directory. Default: current directory." },
    },
  },
  handler: async (args) => {
    const { projectDir = process.cwd() } = args as RunLocalArgs;
    const dir = resolve(projectDir);

    const project = detectProject(dir);
    if (!project) {
      return {
        content: [{ type: "text" as const, text: `Error: no runnable project found in \`${dir}\` (expected package.json or Program.cs). Scaffold first.` }],
        isError: true,
      };
    }

    try {
      let outcome: SpawnOutcome;
      let cmd: string;
      if (project.kind === "node") {
        cmd = "npm install";
        outcome = await runToCompletion("npm", ["install"], dir);
        if (outcome.ok) {
          cmd = "npm run dev";
          outcome = await startDetached("npm", ["run", "dev"], dir);
        }
      } else {
        cmd = "dotnet run";
        outcome = await startDetached("dotnet", ["run"], dir);
      }

      const ready = outcome.ok ? await waitForServerReady(project.port) : false;
      if (!outcome.ok) {
        return {
          content: [{
            type: "text" as const,
            text:
              `Error: failed to start the ${project.kind === "node" ? "Node" : ".NET"} app in \`${dir}\`.\n\n` +
              `\`${cmd}\` failed: ${outcome.error ?? "unknown error"}.\n\n` +
              `> Ensure the required toolchain (${project.kind === "node" ? "Node.js / npm" : ".NET SDK"}) is installed and on PATH, then retry.`,
          }],
          isError: true,
        };
      }

      if (!ready) {
        return {
          content: [{
            type: "text" as const,
            text:
              `Error: startup is unverified for the ${project.kind === "node" ? "Node" : ".NET"} app in \`${dir}\`; the expected endpoint never became ready on ${project.url}.\n\n` +
              `No TCP listener was detected at the candidate URL in time after \`${cmd}\`.\n\n` +
              `> Check the dev server output for startup errors and the actual listening URL; configuration or launch settings may select a different port.`,
          }],
          isError: true,
        };
      }

      const output =
        "## Local Startup Attempted\n\n" +
        `The ${project.kind === "node" ? "Node" : ".NET"} launch command in \`${dir}\` survived the initial startup checks.\n\n` +
        `Candidate URL: ${project.url}\n\n` +
        "> Startup is unverified: a TCP listener was detected at this candidate port, but it may belong to another process. " +
        "Configuration, port fallback, or .NET launch settings may select a different URL. Confirm the app and actual listening URL before using it.\n\n" +
        "> Sign-in note: if sign-in fails with `AADSTS9002326` (cross-origin SPA token " +
        "redemption) or `AADSTS50011` (redirect URI mismatch), that is a **server-side " +
        "Entra app-registration** change — the owning app must list this origin as a " +
        "Single-page application (SPA) redirect URI. Re-provision/redeploy (`project_deploy`) " +
        "to apply it; app-registration changes are **not** picked up by client hot-reload.";
      return { content: [{ type: "text" as const, text: output }] };
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      return { content: [{ type: "text" as const, text: `Error starting app: ${msg}` }], isError: true };
    }
  },
};
