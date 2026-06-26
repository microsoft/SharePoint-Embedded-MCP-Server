// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import type { McpToolResult } from "./types.js";

export function ok<T>(data: T, summary = "OK"): McpToolResult {
  const structuredContent = { ok: true, data };
  return {
    content: [
      { type: "text" as const, text: summary },
      { type: "text" as const, text: JSON.stringify(structuredContent, null, 2) },
    ],
    structuredContent,
  };
}

export function fail(code: string, message: string, suggestion?: string): McpToolResult {
  const structuredContent = {
    ok: false,
    error: {
      code,
      message,
      ...(suggestion ? { suggestion } : {}),
    },
  };
  return {
    content: [
      { type: "text" as const, text: `Error: ${message}${suggestion ? `\nSuggestion: ${suggestion}` : ""}` },
      { type: "text" as const, text: JSON.stringify(structuredContent, null, 2) },
    ],
    structuredContent,
    isError: true,
  };
}

