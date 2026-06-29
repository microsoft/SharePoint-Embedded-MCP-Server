// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

export interface SafeError {
  code: string;
  message: string;
  suggestion?: string;
  correlationId: string;
}

export interface AppErrorOptions {
  suggestion?: string;
  status?: number;
  retryAfter?: string | null;
  safeMessage?: string;
}

export class AppError extends Error {
  readonly code: string;
  readonly suggestion?: string;
  readonly status?: number;
  readonly retryAfter?: string | null;
  readonly safeMessage?: string;

  constructor(code: string, message: string, options: AppErrorOptions = {}) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.suggestion = options.suggestion;
    this.status = options.status;
    this.retryAfter = options.retryAfter;
    this.safeMessage = options.safeMessage;
  }
}

export class ValidationError extends AppError {
  constructor(message: string, suggestion?: string) {
    super("INVALID_ARGS", message, { suggestion, safeMessage: message });
    this.name = "ValidationError";
  }
}

function correlationId(): string {
  return Math.random().toString(36).slice(2, 10);
}

export function toSafeError(error: unknown): SafeError {
  const id = correlationId();
  if (error instanceof AppError) {
    const retrySuggestion = error.retryAfter
      ? `Retry after ${error.retryAfter} second(s).`
      : undefined;
    return {
      code: error.code,
      message: error.safeMessage ?? error.message,
      suggestion: error.suggestion ?? retrySuggestion,
      correlationId: id,
    };
  }

  return {
    code: "INTERNAL_ERROR",
    message: "The tool failed. See server logs for details.",
    suggestion: `Share this correlation ID with the server operator: ${id}.`,
    correlationId: id,
  };
}

/**
 * Client-safe message for tool-local `catch` blocks (SEC-002 consistency).
 *
 * For an `AppError` (e.g. a Graph failure mapped by graph-client) this returns
 * the sanitized `safeMessage` so the raw Graph/az response body is never echoed
 * to the MCP client. For any other error it returns the plain message, which —
 * for our own thrown errors and network/library errors — carries useful local
 * diagnostics without leaking upstream payloads.
 */
export function clientSafeMessage(error: unknown): string {
  if (error instanceof AppError) return error.safeMessage ?? error.message;
  return error instanceof Error ? error.message : String(error);
}
