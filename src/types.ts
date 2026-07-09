// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Shared type definitions for the SPE MCP Server.
 */

// Types-only import (zero runtime cost). `@microsoft/microsoft-graph-types` is
// a pure `.d.ts` package pinned in devDependencies — nothing here emits JS.
import type {
  DriveItem as GraphDriveItem,
  FileStorageContainer,
  Permission as GraphPermission,
} from "@microsoft/microsoft-graph-types";

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

// ─── Graph OData envelopes ────────────────────────────────────────────────────

/**
 * A Microsoft Graph OData collection envelope: the `value` array of results plus
 * the optional `@odata.nextLink` continuation URL. Replaces the ad-hoc
 * `{ value: T[] }` inline shapes previously spread across the Graph client
 * (per PR #3 review feedback).
 */
export interface GraphCollection<T> {
  value: T[];
  "@odata.nextLink"?: string;
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

/**
 * The owning app's intended container-type authority, captured up front so the
 * requested Graph scopes / app-permission grants can be least-privilege by
 * default (PR #3 review). Two intents:
 *   - "manage-all": an admin/console app that manages ALL container types in the
 *     tenant (broad `.Manage.All` scopes).
 *   - "selected":   a standard ISV/LOB app that only needs its own container
 *     type (the least-privilege `.Selected` scopes). This is the default.
 * The single source of truth for the union — the tool input enum and persisted
 * state both reference it so the allowed values can't drift apart.
 */
export type OwnerScope = "manage-all" | "selected";

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

/**
 * A permission on an SPE container — a Microsoft Graph `permission` resource.
 * `id`/`roles` derive from the official Graph `Permission` type; `roles` is
 * `NonNullable` because we always read it (e.g. `roles.join(...)`).
 *
 * `grantedToV2` is kept as a narrowed local shape rather than the official
 * `sharePointIdentitySet`: the official `identity` type does not surface
 * `userPrincipalName`, which we render for container members
 * (per PR #3 review feedback).
 */
export type ContainerPermission = Pick<GraphPermission, "id"> & {
  roles: NonNullable<GraphPermission["roles"]>;
  // official `Identity` omits `userPrincipalName`; retain a
  // narrowed local shape for just the member fields we actually read/render.
  grantedToV2?: {
    user?: { userPrincipalName: string; displayName?: string };
  };
};

// ─── Graph API Types: Drive / Content ────────────────────────────────────────

export interface Drive {
  id: string;
  webUrl?: string;
  quota?: {
    used: number;
    total: number;
  };
}

/**
 * A file or folder in a container's drive — a Microsoft Graph `driveItem`.
 * Derived from the official `DriveItem`, keeping only the subset of fields we
 * consume. `id`/`name` stay non-null (our code always reads them); the remaining
 * fields keep the official optional/nullable shape and are only ever read
 * null-tolerantly (per PR #3 review feedback).
 */
export type DriveItem = Required<Pick<GraphDriveItem, "id">> & {
  name: NonNullable<GraphDriveItem["name"]>;
} & Pick<GraphDriveItem, "size" | "webUrl" | "lastModifiedDateTime" | "folder" | "file">;

export interface UploadSession {
  uploadUrl: string;
  expirationDateTime: string;
}

/**
 * A sharing link on a drive item. NOTE: in Microsoft Graph this is a
 * `permission` resource that *carries* a `link` (the official `sharingLink`
 * sub-object); our reads use the permission `id` plus `link.{type,scope,webUrl}`,
 * so we derive from the official `Permission` type — the nested `link` is then
 * the official `sharingLink` automatically (per PR #3 review feedback).
 */
export type SharingLink = Required<Pick<GraphPermission, "id">> & Pick<GraphPermission, "link">;

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
