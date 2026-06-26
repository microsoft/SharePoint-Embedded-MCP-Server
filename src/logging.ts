// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

const SENSITIVE_KEY_RE = /token|secret|password|authorization|auth|code|content|bytes|upn|email|userprincipalname|displayname/i;
const MAX_STRING_LENGTH = 160;
const MAX_ARRAY_ITEMS = 5;
const MAX_OBJECT_KEYS = 20;
const MAX_DEPTH = 4;

function truncateString(value: string): string {
  if (value.length <= MAX_STRING_LENGTH) return value;
  return `${value.slice(0, MAX_STRING_LENGTH)}…[truncated ${value.length - MAX_STRING_LENGTH} chars]`;
}

function redactValue(value: unknown, depth: number): unknown {
  if (typeof value === "string") return truncateString(value);
  if (typeof value !== "object" || value === null) return value;
  if (depth >= MAX_DEPTH) return "[truncated]";

  if (Array.isArray(value)) {
    const preview = value.slice(0, MAX_ARRAY_ITEMS).map((item) => redactValue(item, depth + 1));
    if (value.length > MAX_ARRAY_ITEMS) preview.push(`[+${value.length - MAX_ARRAY_ITEMS} more]`);
    return preview;
  }

  const output: Record<string, unknown> = {};
  const entries = Object.entries(value as Record<string, unknown>);
  for (const [key, child] of entries.slice(0, MAX_OBJECT_KEYS)) {
    output[key] = SENSITIVE_KEY_RE.test(key) ? "[redacted]" : redactValue(child, depth + 1);
  }
  if (entries.length > MAX_OBJECT_KEYS) {
    output.__truncatedKeys = entries.length - MAX_OBJECT_KEYS;
  }
  return output;
}

export function redact(value: unknown): { keys: string[]; preview: unknown } {
  const keys = value && typeof value === "object" && !Array.isArray(value)
    ? Object.keys(value as Record<string, unknown>)
    : [];
  return { keys, preview: redactValue(value, 0) };
}

