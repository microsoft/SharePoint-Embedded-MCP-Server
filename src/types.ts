// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Shared type definitions for the SPE MCP Server.
 */

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

export interface Container {
  id: string;
  displayName: string;
  containerTypeId: string;
  status: string;
  createdDateTime?: string;
  description?: string;
  lockState?: "unlocked" | "lockedReadOnly";
}

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
