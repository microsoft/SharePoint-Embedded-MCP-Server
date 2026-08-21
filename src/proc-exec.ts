// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Shared, shell-free child-process launcher.
 *
 * Every `az` / `azd` / dev-server invocation in this codebase goes through this
 * module so process spawning is centralised on ONE hardened seam:
 *
 *  - We NEVER pass `shell: true`. On Windows, `az`/`azd`/`npm`/`func` are `.cmd`
 *    batch shims; letting a shell resolve them routes arguments through
 *    `cmd.exe`, so any user-influenced argument becomes a metacharacter /
 *    command-injection vector. `cross-spawn` resolves `.cmd`/`.bat` shims via
 *    `PATHEXT` itself and passes arguments to the child process literally — no
 *    shell, no metacharacter interpretation.
 *  - Centralising here also gives tests a single module to mock
 *    (`vi.mock("../proc-exec.js", …)`) instead of stubbing `node:child_process`.
 *
 * The error shape mirrors Node's `execFile` rejection (`.stdout` / `.stderr` /
 * `.code`, with stderr appended to `.message`) so existing error classifiers
 * keep working unchanged.
 */

import type { ChildProcess, SpawnOptions } from "node:child_process";
import spawn from "cross-spawn";

export interface RunCommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Kill the child and reject once this many milliseconds have elapsed. */
  timeout?: number;
}

export interface RunCommandResult {
  stdout: string;
  stderr: string;
}

/**
 * Error thrown by {@link runCommand} when the child exits non-zero, cannot be
 * spawned, or times out. Shaped like Node's `execFile` rejection so callers that
 * read `.stdout` / `.stderr` / `.code` or match `.message` keep working.
 */
export interface RunCommandError extends Error {
  stdout: string;
  stderr: string;
  code?: number | string;
}

/**
 * Run a command to completion and buffer its output. Never uses a shell; on
 * Windows, `cross-spawn` resolves `.cmd`/`.bat` shims without `cmd.exe`, so
 * arguments are passed to the child literally.
 */
export function runCommand(
  command: string,
  args: readonly string[] = [],
  options: RunCommandOptions = {},
): Promise<RunCommandResult> {
  return new Promise<RunCommandResult>((resolvePromise, reject) => {
    // shell:false is the entire point — cross-spawn resolves Windows .cmd shims
    // itself, so we must never delegate to a shell.
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn();
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("error", (err: NodeJS.ErrnoException) => {
      // Spawn failures land here — notably ENOENT for a missing command.
      // Preserve the original message text (callers match "ENOENT" / "not
      // recognized") and surface `.code` so `e.code === "ENOENT"` checks work.
      finish(() => {
        const e = err as RunCommandError;
        e.stdout = stdout;
        e.stderr = stderr;
        if (err.code !== undefined) e.code = err.code;
        reject(e);
      });
    });

    child.on("close", (exitCode) => {
      finish(() => {
        if (exitCode === 0) {
          resolvePromise({ stdout, stderr });
          return;
        }
        // Append stderr to the message (as Node's execFile does) so classifiers
        // that inspect `error.message` (AADSTS / "az login" / "not recognized")
        // still see the underlying CLI output.
        const suffix = stderr.trim().length > 0 ? `\n${stderr}` : "";
        const e = new Error(
          `Command failed: ${command} (exit code ${exitCode ?? "unknown"})${suffix}`,
        ) as RunCommandError;
        e.stdout = stdout;
        e.stderr = stderr;
        if (exitCode !== null) e.code = exitCode;
        reject(e);
      });
    });

    if (options.timeout && options.timeout > 0) {
      timer = setTimeout(() => {
        finish(() => {
          child.kill();
          const e = new Error(
            `Command timed out after ${options.timeout}ms: ${command}`,
          ) as RunCommandError;
          e.stdout = stdout;
          e.stderr = stderr;
          e.code = "ETIMEDOUT";
          reject(e);
        });
      }, options.timeout);
      if (typeof timer.unref === "function") timer.unref();
    }
  });
}

/**
 * Spawn a streaming child process without a shell. Thin `cross-spawn`
 * passthrough for callers that need the live `ChildProcess` (detached
 * dev-servers, custom stdio, event handling). `shell` is always forced off.
 */
export function spawnProcess(
  command: string,
  args: readonly string[] = [],
  options: SpawnOptions = {},
): ChildProcess {
  return spawn(command, [...args], { ...options, shell: false });
}
