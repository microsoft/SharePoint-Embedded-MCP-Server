// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Shared type definitions for the SPE MCP Server.
 */

// ─── MCP Tool ───────────────────────────────────────────────────────────────

export interface McpToolResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
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
}

// ─── Graph API Types: Container Types ────────────────────────────────────────

export interface ContainerType {
  containerTypeId: string;
  owningAppId: string;
  displayName: string;
  description?: string;
  azureSubscriptionId?: string;
  createdDateTime?: string;
  expirationDateTime?: string;
  billingClassification?: "trial" | "standard" | "directToCustomer";
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
