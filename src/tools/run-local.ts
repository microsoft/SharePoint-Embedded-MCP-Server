// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Tool: project_run_local
 *
 * Installs dependencies and starts the scaffolded reference app locally, then
 * reports the local URL(s). Detects the project type (Node vs .NET) and derives
 * the correct dev-server port from the project (e.g. Vite serves 5173, not 3000).
 * Ports EVAL.md `run-local`.
 *
 * The dev server is started detached so the MCP server stays responsive. The
 * tool waits for the immediate spawn outcome so a failed launch (e.g. a missing
 * toolchain / ENOENT) is reflected as an error instead of a false "running"
 * success, and then probes the derived port for readiness (a bounded TCP
 * connect poll) so the URL is only returned once the server is actually
 * accepting connections — never a URL that refuses.
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { LOCAL_DEV_PORT } from "../constants.js";
import { waitForServerReady } from "../server-readiness.js";
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
 * Derive the dev-server port a Node project actually serves on, instead of
 * assuming 3000. An explicit `--port N` in the dev/start script wins; otherwise
 * a Vite project serves 5173 by default and other Node servers fall back to 3000.
 */
function detectNodePort(dir: string): number {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    const scripts = pkg.scripts ?? {};
    const dev = String(scripts.dev ?? "");
    const start = String(scripts.start ?? "");
    const combined = `${dev} ${start}`;

    // Explicit port flag in the script (e.g. "vite --port 4280") takes priority.
    const portFlag = combined.match(/--port[=\s]+(\d{2,5})/);
    if (portFlag) return Number(portFlag[1]);

    // Vite's dev server port — our scaffold pins it to LOCAL_DEV_PORT in
    // vite.config.
    if (/\bvite\b/.test(combined)) return LOCAL_DEV_PORT;
    // create-react-app / Next.js default to 3000.
    if (/\b(react-scripts|next)\b/.test(combined)) return 3000;
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
 * OR if it exits with a non-zero code within the grace window (the win32
 * `shell:true` case, where a missing toolchain spawns cmd.exe and only the shell
 * exit code reveals the failure); `ok:true` once it has spawned and survived the
 * grace window without an early non-zero exit. Resolves optimistically after the
 * short grace period so we never block the MCP server.
 *
 * Note: we deliberately do NOT resolve success on `'spawn'` alone — `'spawn'`
 * only means the OS created the process (or the shell), not that the underlying
 * command exists. We wait out the grace window so an early non-zero exit can
 * still flip the outcome to failure.
 */
function startDetached(command: string, args: string[], cwd: string): Promise<SpawnOutcome> {
  return new Promise((resolveOutcome) => {
    let settled = false;
    const finish = (outcome: SpawnOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(grace);
      resolveOutcome(outcome);
    };

    let child;
    try {
      child = spawn(command, args, {
        cwd,
        detached: true,
        stdio: "ignore",
        shell: process.platform === "win32",
      });
    } catch (error) {
      finish({ ok: false, error: error instanceof Error ? error.message : String(error) });
      return;
    }

    const detachedChild = child;
    const grace = setTimeout(() => {
      // Survived the grace window with no error or early non-zero exit — treat
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

    // A non-zero exit/close within the grace window means the launch failed
    // (the primary win32 shell:true false-success path). A clean (code 0) or
    // signal-terminated early exit is unusual for a dev server but not an error
    // we can attribute, so we let the grace timer resolve optimistically.
    const onEarlyExit = (code: number | null): void => {
      if (typeof code === "number" && code !== 0) {
        finish({ ok: false, error: `process exited with code ${code} before startup completed` });
      }
    };
    child.once("exit", onEarlyExit);
    child.once("close", onEarlyExit);

    child.once("spawn", () => {
      // Detach early so a successful server is unref'd, but do NOT resolve here:
      // wait for the grace window so an early non-zero exit can still win.
      try {
        detachedChild.unref();
      } catch {
        /* noop */
      }
    });
  });
}

export const runLocalTool: McpTool = {
  name: "project_run_local",
  description:
    "Install dependencies and start the scaffolded SharePoint Embedded app locally, returning the " +
    "local URL. Detects Node (npm) or .NET (dotnet) projects and reports the actual dev-server port " +
    "(e.g. Vite's 5173). Run after scaffolding and hydrating config.",
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
      if (project.kind === "node") {
        // Install dependencies (best-effort), then start the dev server and
        // reflect the dev server's launch outcome.
        await startDetached("npm", ["install"], dir);
        outcome = await startDetached("npm", ["run", "dev"], dir);
      } else {
        outcome = await startDetached("dotnet", ["run"], dir);
      }

      if (!outcome.ok) {
        const cmd = project.kind === "node" ? "npm run dev" : "dotnet run";
        return {
          content: [{
            type: "text" as const,
            text:
              `Error: failed to start the ${project.kind === "node" ? "Node" : ".NET"} app in \`${dir}\`.\n\n` +
              `\`${cmd}\` could not be launched: ${outcome.error ?? "unknown error"}.\n\n` +
              `> Ensure the required toolchain (${project.kind === "node" ? "Node.js / npm" : ".NET SDK"}) is installed and on PATH, then retry.`,
          }],
          isError: true,
        };
      }

      // The process launched and survived the spawn grace window, but that does
      // NOT mean it is accepting connections yet (or that it won't crash during
      // startup). Probe the derived port for readiness before handing back a URL
      // so we never report a URL that refuses connections.
      const ready = await waitForServerReady(project.port);
      if (!ready) {
        const cmd = project.kind === "node" ? "npm run dev" : "dotnet run";
        return {
          content: [{
            type: "text" as const,
            text:
              `Error: the ${project.kind === "node" ? "Node" : ".NET"} app in \`${dir}\` launched but never became ready on ${project.url}.\n\n` +
              `\`${cmd}\` did not start accepting connections in time.\n\n` +
              `> Check the dev server output for a startup error (e.g. a missing dependency or a port conflict), then retry.`,
          }],
          isError: true,
        };
      }

      const output =
        "## App Running Locally 🚀\n\n" +
        `The ${project.kind === "node" ? "Node" : ".NET"} app in \`${dir}\` is up and accepting connections.\n\n` +
        `→ ${project.url}\n\n` +
        "> The dev server is running in the background. Open the URL above.\n\n" +
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
