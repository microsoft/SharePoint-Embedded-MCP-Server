// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Shared type definitions for the SPE MCP Server.
 */

// Types-only import (zero runtime cost). `@microsoft/microsoft-graph-types` is
// a pure `.d.ts` package pinned in devDependencies — nothing here emits JS.
import type { FileStorageContainer } from "@microsoft/microsoft-graph-types";

// ─── Primitives ──────────────────────────────────────────────────────────────

/**
 * A globally-unique identifier (UUID) rendered as a string, e.g. an Entra
 * app/object id, a Microsoft Graph permission id, or an Azure subscription id.
 * This is a readability alias only — it is structurally identical to `string`
 * (no runtime validation), and simply documents that a value is expected to be
 * a GUID rather than free-form text.
 */
export type Guid = string;

// ─── MCP Tool ───────────────────────────────────────────────────────────────

export interface McpToolResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
  structuredContent?: unknown;
}

export interface McpToolAnnotations {
  readOnly?: boolean;
  destructive?: boolean;
  idempotent?: boolean;
  plane?: "control" | "content";
  requiresConsent?: boolean;
  localRequired?: boolean;
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
  annotations?: McpToolAnnotations;
  validateArgs?: (args: Record<string, unknown>) => Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<McpToolResult>;
}

// ─── Server Config ──────────────────────────────────────────────────────────

export interface ServerConfig {
  /**
   * Owning Entra app client ID. OPTIONAL. When provided, the server runs in
   * pre-provisioned-app mode and initializes MSAL for that app. When omitted,
   * the server runs in bootstrap mode (Azure CLI control plane) and provisions
   * the owning app on demand.
   */
  clientId?: string;
  /** Entra tenant ID. Optional; discovered from the Azure CLI when omitted. */
  tenantId?: string;
  /**
   * Read-only mode (SAFE-003). When true, only tools annotated `readOnly` are
   * advertised and any non-readOnly tool call is rejected. Also settable via
   * the `SPE_READ_ONLY` env var.
   */
  readOnly?: boolean;
  /**
   * Tool allowlist (SAFE-004): a built-in profile name (`readOnly`, `docsOnly`,
   * `provisioning`, `content`, `admin`) or a comma-separated list of tool names.
   * Tools outside the allowlist are hidden from ListTools and rejected at call
   * time. Also settable via the `SPE_TOOLS` env var.
   *
   * Surfaced to end users as the `--tools <profileOrCsv>` flag on the CLI —
   * run `spe-mcp start --help` (or `npx @microsoft/spe-mcp-server start --help`)
   * to see the profile list and description.
   */
  tools?: string;
}

// ─── Auth Config ─────────────────────────────────────────────────────────────

/**
 * Resolved authentication configuration for MSAL: the specific owning-app
 * client and tenant the token cache and Graph acquisition are bound to. Distinct
 * from {@link ServerConfig}, whose `clientId`/`tenantId` are optional startup
 * inputs — by the time an {@link AuthConfig} exists, both are known.
 */
export interface AuthConfig {
  clientId: string;
  tenantId: string;
  /** Override default Graph scopes */
  scopes?: string[];
}

// ─── Graph API Types: Container Types ────────────────────────────────────────

/**
 * The billing model a container type is created under. This is the single
 * source of truth for the classification across the codebase — the tool input
 * enum, persisted state, and Graph response mapping all reference this union so
 * the allowed values can't drift apart.
 */
export type BillingClassification = "trial" | "standard" | "directToCustomer";

export interface ContainerType {
  containerTypeId: string;
  owningAppId: string;
  displayName: string;
  description?: string;
  azureSubscriptionId?: string;
  createdDateTime?: string;
  expirationDateTime?: string;
  billingClassification?: BillingClassification;
  /**
   * Optimistic-concurrency tag. Read from a Create/Get response and **required**
   * in the body of an Update (PATCH) call — omitting it returns HTTP 400.
   */
  etag?: string;
}

/**
 * A permission entry in a fileStorageContainerType's `permissions` collection
 * (Microsoft Graph **beta**). Granting a USER the `owner` role lets them create
 * containers using a public client (PCA) — the v1.0 container endpoint rejects
 * container creation by public clients. Only the `owner` role and a user
 * identity are supported.
 */
export interface ContainerTypePermission {
  id?: string;
  roles: string[];
  grantedToV2?: {
    user?: { id?: string; displayName?: string; userPrincipalName?: string };
  };
}

export interface ContainerTypeRegistration {
  applicationPermissionGrants: ApplicationPermissionGrant[];
}

/**
 * A container type **registration record** (the tenant↔containerType binding),
 * as returned by GET/List on `…/containerTypeRegistrations`. Distinct from a
 * single app's {@link ApplicationPermissionGrant}. The v1.0 schema exposes
 * `owningAppId` (the SPE app the type is owned by) and `billingClassification`;
 * fields vary by API version, so this is kept permissive.
 */
export interface ContainerTypeRegistrationRecord {
  id?: string;
  owningAppId?: string;
  billingClassification?: BillingClassification;
  registeredDateTime?: string;
  applicationPermissionGrants?: ApplicationPermissionGrant[];
}

export interface ApplicationPermissionGrant {
  appId: string;
  delegatedPermissions: string[];
  applicationPermissions: string[];
}

// ─── Graph API Types: Containers ─────────────────────────────────────────────

/**
 * A SharePoint Embedded container (Microsoft Graph `fileStorageContainer`).
 *
 * **WI-22 Phase 0 POC** — this alias is derived from the official
 * `@microsoft/microsoft-graph-types` {@link FileStorageContainer} shape via a
 * `Pick` + curated-JSDoc wrapper, replacing the former hand-maintained
 * interface. The upstream package is **types-only** (lives in
 * `devDependencies`) and contributes **zero runtime JavaScript** — it compiles
 * away entirely. Field names already match the Graph resource 1:1, so the only
 * curation needed is (a) selecting the subset this server consumes and
 * (b) tightening always-present fields to non-optional for null-safety.
 *
 * Field selection rationale:
 *  - `Required<Pick<…>>` — `id`, `displayName`, `containerTypeId`, and `status`
 *    are returned by Graph for every live container and are dereferenced by
 *    call sites without a null guard (e.g. `activateContainer(container.id)`).
 *    Marking them non-optional preserves the previous interface's *optionality*
 *    guarantees. Caveat: `Required<T>` strips `?` but NOT `| null`, so the
 *    Graph `NullableOption` fields keep their `null` — here `status` widens to
 *    `"inactive" | "active" | "unknownFutureValue" | null` (the old field was a
 *    bare `string`). This is safe only because every consumer *compares* these
 *    fields (e.g. `=== "active"`) rather than passing them into a non-null
 *    `string` param. For richer types whose call sites dereference/pass
 *    `NullableOption` fields, wrap with `NonNullable<>` (or a guard) instead of
 *    a bare `Required<Pick<…>>`. `id`/`displayName`/`containerTypeId` are plain
 *    `string` upstream (non-nullable), so `Required` yields clean `string`.
 *  - `Pick<…>` — `createdDateTime`, `description`, and `lockState` are
 *    genuinely optional and are always accessed defensively (`?? …`).
 *
 * Semantics preserved from the original curated interface:
 *  - `displayName` is the human-visible name and is **not** the `id`. Address
 *    containers by `id` in Graph calls; surface `displayName` to users.
 *  - `status` is `inactive` at creation and must be activated before use
 *    (see `activateContainer`). Official union: `inactive | active`.
 *  - `lockState` drives archive/restore: `lockedReadOnly` == archived,
 *    `unlocked` == writable. An absent value is treated as `unlocked`.
 */
export type Container = Required<
  Pick<FileStorageContainer, "id" | "displayName" | "containerTypeId" | "status">
> &
  Pick<FileStorageContainer, "createdDateTime" | "description" | "lockState">;

export interface ContainerPermission {
  id?: string;
  roles: string[];
  grantedToV2?: {
    user?: { userPrincipalName: string; displayName?: string };
  };
}

// ─── Graph API Types: Drive / Content ────────────────────────────────────────

export interface Drive {
  id: string;
  webUrl?: string;
  quota?: {
    used: number;
    total: number;
  };
}

export interface DriveItem {
  id: string;
  name: string;
  size?: number;
  webUrl?: string;
  lastModifiedDateTime?: string;
  "@microsoft.graph.downloadUrl"?: string;
  folder?: Record<string, unknown>;
  file?: Record<string, unknown>;
}

export interface UploadSession {
  uploadUrl: string;
  expirationDateTime: string;
}

export interface SharingLink {
  id: string;
  link?: {
    type: string;
    scope: string;
    webUrl: string;
  };
}

export interface PreviewResult {
  getUrl: string;
}

export interface SearchHit {
  resource: {
    name: string;
    webUrl: string;
    size?: number;
    lastModifiedDateTime?: string;
  };
  summary?: string;
}

export interface SearchResponse {
  value: Array<{
    hitsContainers: Array<{
      total: number;
      hits: SearchHit[];
    }>;
  }>;
}

export interface CustomProperties {
  [key: string]: {
    value: string;
    isSearchable?: boolean;
  };
}
