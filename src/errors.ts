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
