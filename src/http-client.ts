// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { USER_AGENT } from "./user-agent.js";

export interface HttpClientOptions {
  fetchImpl?: typeof fetch;
  userAgent?: string;
  correlationId?: string;
}

export interface RetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  onRetry?: (statusOrError: number | string, delayMs: number) => void;
}

export function parseRetryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number.parseInt(value, 10);
  if (Number.isFinite(seconds)) return seconds * 1000;
  const dateMs = Date.parse(value);
  if (!Number.isFinite(dateMs)) return undefined;
  return Math.max(0, dateMs - Date.now());
}

export async function fetchWithRetry(
  url: string,
  init: RequestInit = {},
  client: HttpClientOptions = {},
  retry: RetryOptions = {},
): Promise<Response> {
  const fetchImpl = client.fetchImpl ?? fetch;
  const maxRetries = retry.maxRetries ?? 0;
  const baseDelayMs = retry.baseDelayMs ?? 1_000;
  const sleep = retry.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const headers = new Headers(init.headers);
  if (!headers.has("User-Agent")) headers.set("User-Agent", client.userAgent ?? USER_AGENT);
  if (client.correlationId && !headers.has("x-ms-client-request-id")) {
    headers.set("x-ms-client-request-id", client.correlationId);
  }

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetchImpl(url, { ...init, headers });
      if ((response.status === 429 || response.status >= 500) && attempt < maxRetries) {
        const delayMs = parseRetryAfterMs(response.headers.get("Retry-After")) ?? baseDelayMs * Math.pow(2, attempt);
        retry.onRetry?.(response.status, delayMs);
        await sleep(delayMs);
        continue;
      }
      return response;
    } catch (error) {
      if (attempt >= maxRetries) throw error;
      const delayMs = baseDelayMs * Math.pow(2, attempt);
      retry.onRetry?.(error instanceof Error ? error.message : String(error), delayMs);
      await sleep(delayMs);
    }
  }

  throw new Error("HTTP retry loop exhausted");
}

