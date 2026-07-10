// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Microsoft Learn MCP client wrapper.
 *
 * The SPE MCP server proxies documentation queries to the official
 * **Microsoft Learn MCP server** (https://learn.microsoft.com/api/mcp) rather
 * than reimplementing doc search. This keeps answers grounded in current,
 * first-party SharePoint Embedded / Microsoft Graph documentation.
 *
 * Design notes:
 *   - Transport is Streamable HTTP, anonymous (no auth) — per Learn MCP docs.
 *   - The Learn MCP docs explicitly warn that tool input/output schemas may
 *     change over time, so we DISCOVER the tool list at connect time and build
 *     arguments from each tool's advertised inputSchema instead of hardcoding
 *     parameter names.
 *   - Endpoint is overridable via SPE_LEARN_MCP_URL (used by tests to
 *     point at a local mock).
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const DEFAULT_LEARN_MCP_URL = "https://learn.microsoft.com/api/mcp";
const ALLOWED_DOCS_HOST = "learn.microsoft.com";
const SEARCH_TOOL = "microsoft_docs_search";
const FETCH_TOOL = "microsoft_docs_fetch";
const CALL_TIMEOUT_MS = 25_000;

function isTruthyEnv(value: string | undefined): boolean {
  if (!value) return false;
  return /^(1|true|yes|on)$/i.test(value.trim());
}

/**
 * Resolve and validate the Learn MCP endpoint (SEC-007).
 *
 * The docs proxy defaults to the first-party Microsoft Learn MCP host. An
 * `SPE_LEARN_MCP_URL` override that points at any other host is refused unless
 * the operator explicitly opts in via `SPE_ALLOW_INSECURE_DOCS_ENDPOINT`, so a
 * stray/hostile env var cannot silently redirect documentation traffic
 * off-Microsoft.
 */
export function resolveDocsEndpoint(
  override: string | undefined = process.env.SPE_LEARN_MCP_URL,
  allowInsecure: boolean = isTruthyEnv(process.env.SPE_ALLOW_INSECURE_DOCS_ENDPOINT),
): string {
  const trimmed = override?.trim();
  if (!trimmed) return DEFAULT_LEARN_MCP_URL;

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(
      `SPE_LEARN_MCP_URL is not a valid URL: ${trimmed}. ` +
        `Provide a full URL such as ${DEFAULT_LEARN_MCP_URL}.`,
    );
  }
  const host = parsed.hostname.toLowerCase();

  const isAllowedHost = host === ALLOWED_DOCS_HOST || host.endsWith(`.${ALLOWED_DOCS_HOST}`);
  if (isAllowedHost) {
    // Allowed Microsoft Learn host must still be reached over https unless the
    // operator explicitly opts into an insecure endpoint (e.g. a local mock).
    if (parsed.protocol !== "https:" && !allowInsecure) {
      throw new Error(
        `Refusing to use SPE_LEARN_MCP_URL over ${parsed.protocol} — https is required for ${ALLOWED_DOCS_HOST}. ` +
          `Set SPE_ALLOW_INSECURE_DOCS_ENDPOINT=1 to override (use with caution).`,
      );
    }
    return trimmed;
  }
  if (allowInsecure) return trimmed;

  throw new Error(
    `Refusing to use SPE_LEARN_MCP_URL host "${host}": only ${ALLOWED_DOCS_HOST} is allowed by default. ` +
      `Set SPE_ALLOW_INSECURE_DOCS_ENDPOINT=1 to override (use with caution — this redirects documentation queries off Microsoft Learn).`,
  );
}

function log(message: string, data?: unknown): void {
  const timestamp = new Date().toISOString();
  if (data !== undefined) {
    console.error(`[${timestamp}] [LearnMCP] ${message}`, typeof data === "string" ? data : JSON.stringify(data));
  } else {
    console.error(`[${timestamp}] [LearnMCP] ${message}`);
  }
}

interface JsonSchemaLike {
  properties?: Record<string, { type?: string; description?: string }>;
  required?: string[];
}

interface DiscoveredTool {
  name: string;
  inputSchema?: JsonSchemaLike;
}

let client: Client | null = null;
let toolsByName: Map<string, DiscoveredTool> | null = null;
let connectPromise: Promise<void> | null = null;

function getEndpoint(): string {
  return resolveDocsEndpoint();
}

async function connect(): Promise<void> {
  if (client && toolsByName) return;
  if (connectPromise) return connectPromise;

  connectPromise = (async () => {
    const url = getEndpoint();
    log(`Connecting to Microsoft Learn MCP at ${url}`);
    const transport = new StreamableHTTPClientTransport(new URL(url));
    const c = new Client({ name: "spe-mcp-server", version: "0.1.0" });
    await c.connect(transport);

    const list = await c.listTools();
    const map = new Map<string, DiscoveredTool>();
    for (const t of list.tools) {
      map.set(t.name, { name: t.name, inputSchema: t.inputSchema as JsonSchemaLike });
    }
    client = c;
    toolsByName = map;
    log(`Connected. Discovered ${map.size} Learn tools: ${[...map.keys()].join(", ")}`);
  })();

  try {
    await connectPromise;
  } catch (error) {
    connectPromise = null;
    client = null;
    toolsByName = null;
    const msg = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to connect to Microsoft Learn MCP (${getEndpoint()}): ${msg}`);
  } finally {
    connectPromise = null;
  }
}

/**
 * Resolve a Learn tool by preferred name, with fallbacks for schema drift.
 */
function resolveTool(preferredName: string, fallbackSubstring: string): DiscoveredTool {
  if (!toolsByName) {
    throw new Error("Learn MCP tool list not initialized");
  }
  const exact = toolsByName.get(preferredName);
  if (exact) return exact;
  // Fallback: the Learn team may rename tools — match by substring.
  for (const tool of toolsByName.values()) {
    if (tool.name.toLowerCase().includes(fallbackSubstring)) return tool;
  }
  throw new Error(
    `Learn MCP does not expose a '${preferredName}' tool. Available: ${[...toolsByName.keys()].join(", ")}`,
  );
}

/**
 * Build a tool-call arguments object from the tool's advertised inputSchema,
 * placing `value` into the most likely parameter. Resilient to param renames.
 */
function buildArgs(tool: DiscoveredTool, value: string, preferredKeys: string[]): Record<string, unknown> {
  const schema = tool.inputSchema ?? {};
  const props = schema.properties ?? {};
  const required = schema.required ?? [];

  const firstRequiredString = required.find((k) => props[k]?.type === "string");
  const firstPreferredPresent = preferredKeys.find((k) => k in props);
  const key = firstRequiredString ?? firstPreferredPresent ?? required[0] ?? preferredKeys[0];

  return { [key]: value };
}

/**
 * Extract a plain-text payload from an MCP CallToolResult.
 */
function extractText(result: unknown): string {
  const content = (result as { content?: Array<{ type?: string; text?: string }> })?.content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((c) => c?.type === "text" && typeof c.text === "string")
    .map((c) => c.text as string)
    .join("\n\n")
    .trim();
}

/**
 * Search Microsoft Learn documentation. Returns the raw text payload from the
 * Learn MCP search tool (typically ranked excerpts with titles and URLs).
 */
export async function searchDocs(query: string): Promise<string> {
  await connect();
  const tool = resolveTool(SEARCH_TOOL, "search");
  const args = buildArgs(tool, query, ["question", "query", "search", "q"]);
  log(`Calling ${tool.name}`, args);
  const result = await client!.callTool({ name: tool.name, arguments: args }, undefined, {
    timeout: CALL_TIMEOUT_MS,
  });
  const text = extractText(result);
  if (!text) {
    throw new Error("Microsoft Learn search returned no text content");
  }
  return text;
}

/**
 * Fetch the full markdown content of a Microsoft Learn documentation page.
 */
export async function fetchDoc(url: string): Promise<string> {
  await connect();
  const tool = resolveTool(FETCH_TOOL, "fetch");
  const args = buildArgs(tool, url, ["url", "uri", "link"]);
  log(`Calling ${tool.name}`, args);
  const result = await client!.callTool({ name: tool.name, arguments: args }, undefined, {
    timeout: CALL_TIMEOUT_MS,
  });
  const text = extractText(result);
  if (!text) {
    throw new Error(`Microsoft Learn fetch returned no content for ${url}`);
  }
  return text;
}

/** Close the Learn MCP connection (used in tests / shutdown). */
export async function closeDocsClient(): Promise<void> {
  if (client) {
    try {
      await client.close();
    } catch {
      /* ignore */
    }
  }
  client = null;
  toolsByName = null;
  connectPromise = null;
}
