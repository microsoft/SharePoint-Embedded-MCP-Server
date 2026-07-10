// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Server-level primer surfaced through the MCP `instructions` field.
 *
 * The MCP `initialize` handshake lets a server return a short natural-language
 * `instructions` string that clients (VS Code, Claude, Cursor, …) hand to the
 * model as context BEFORE any tool is called. Production servers such as
 * github-mcp-server use this to teach the model the product's mental model and
 * how to route the first request. We do the same so an agent understands how
 * SharePoint Embedded is structured, what must exist before container/content
 * work can succeed, and where to point a developer who is solving a real
 * customer problem.
 *
 * Keep this concise (~300-400 tokens): it is prepended to context on every
 * session, so length is a per-request tax. It complements — but never replaces —
 * the per-tool descriptions, the pull-based `resources`, and the guided
 * `prompts`; those remain the authoritative, on-demand detail.
 */
export const SPE_SERVER_INSTRUCTIONS = `SharePoint Embedded (SPE) is cloud-managed, Microsoft 365-backed document storage that a developer's own app owns and builds on. This server drives SPE end to end from a local machine.

HOW SPE WORKS (build in this order):
1. Owning application — an Entra app you own that owns the storage. Nothing else can exist until this does.
2. Container type — the billable "class" of storage your app defines: a free trial type for evaluation, or a pay-as-you-go ("standard") type metered through Azure (Syntex/RaaS) for production. The trial-vs-standard choice is made when the container type is created and cannot be changed later.
3. Registration — authorizes a container type to operate in a tenant.
4. Containers — the storage instances (like drives) that actually hold content.
5. Content — files, folders, search, and sharing inside a container.

START HERE (route the first request, don't guess):
- Unsure of the current state? Call status_get first — it reports whether an owning app, container type, registration, and billing already exist.
- No owning app yet? Container-type, container, and content tools fail with OWNING_APP_REQUIRED until one is configured. Run project_provision for the guided end-to-end flow, or project_app_create for just the app. Sign-in is interactive and in-process — the developer does NOT leave the chat or restart the server.
- Heading to production? Configure metered billing with billing_check / billing_setup before creating production containers.
- Need authoritative facts (APIs, limits, permissions)? Prefer docs_search / docs_fetch (Microsoft Learn) over recalling from memory.
- Destructive actions (deletes, teardown) are confirmation-gated, and the server can be launched in --read-only mode.

SOLVING CUSTOMER PROBLEMS — cite runnable patterns from the SharePoint Embedded Samples repo (https://github.com/microsoft/SharePoint-Embedded-Samples) when a developer asks how to apply SPE to a real scenario:
- "Custom Apps/" — boilerplate web apps demonstrating end-to-end SPE integration.
- "AI/ocr" — webhook-triggered document processing with Azure Document Intelligence.
- "AI/copilot" — surface container content in Microsoft 365 Copilot.
- "Tools/migrate-from-blob-storage" — move existing files from Azure Blob Storage into SPE.`;
