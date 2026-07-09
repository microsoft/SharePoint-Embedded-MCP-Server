// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Shared stderr logger for the SPE MCP Server.
 *
 * ALL diagnostics MUST go to **stderr** (never stdout): a stdio MCP server keeps
 * stdout reserved for the JSON-RPC message stream, so any stray stdout write
 * would corrupt the protocol channel. `console.error` (stderr) is therefore the
 * intentional sink for every log line.
 *
 * This factory consolidates the two previously-duplicated `log()` helpers (auth
 * and index) while preserving each caller's exact output format byte-for-byte:
 *
 *   - index (`createLogger("MCP", { stringifyData: true })`):
 *       `[<iso>] [MCP] <message>`  (+ `JSON.stringify(data)` as a second arg)
 *   - auth  (`createLogger("Auth", { severity: true })`):
 *       `[<iso>] [Auth] [<level>] <message>`  (+ raw `data` as a second arg)
 */

/** Log severity, ordered from most to least verbose. */
export type LogSeverity = "debug" | "info" | "warn" | "error";

export interface LoggerOptions {
  /**
   * Emit an explicit `[<level>]` tag after the prefix (auth-style). When false
   * (the default) the level is omitted from the line entirely, matching the
   * plain index-style format.
   */
  severity?: boolean;
  /**
   * `JSON.stringify` the optional `data` argument before handing it to
   * `console.error` (index-style). When false (the default) `data` is passed
   * through unchanged (auth-style), letting the console format objects itself.
   */
  stringifyData?: boolean;
}

export interface Logger {
  /** Emit a line at an explicit severity. */
  emit(level: LogSeverity, message: string, data?: unknown): void;
  /** Default-severity (info) line. */
  log(message: string, data?: unknown): void;
  /** Expected, handled flow — not actionable. */
  debug(message: string, data?: unknown): void;
  /** Handled but noteworthy. */
  warn(message: string, data?: unknown): void;
  /** Genuine, unexpected failure. */
  error(message: string, data?: unknown): void;
}

/**
 * Create a stderr logger with a fixed `prefix` (e.g. `"MCP"`, `"Auth"`).
 *
 * The emitted line is `[<iso-timestamp>] <tag> <message>`, where `<tag>` is
 * `[<prefix>]` by default or `[<prefix>] [<level>]` when `severity` is enabled.
 * When a `data` argument is provided it is passed as `console.error`'s second
 * argument — either `JSON.stringify(data)` (`stringifyData`) or the raw value.
 */
export function createLogger(prefix: string, options: LoggerOptions = {}): Logger {
  const { severity = false, stringifyData = false } = options;

  function emit(level: LogSeverity, message: string, data?: unknown): void {
    const timestamp = new Date().toISOString();
    const tag = severity ? `[${prefix}] [${level}]` : `[${prefix}]`;
    const line = `[${timestamp}] ${tag} ${message}`;
    if (data !== undefined) {
      console.error(line, stringifyData ? JSON.stringify(data) : data);
    } else {
      console.error(line);
    }
  }

  return {
    emit,
    log: (message, data) => emit("info", message, data),
    debug: (message, data) => emit("debug", message, data),
    warn: (message, data) => emit("warn", message, data),
    error: (message, data) => emit("error", message, data),
  };
}
