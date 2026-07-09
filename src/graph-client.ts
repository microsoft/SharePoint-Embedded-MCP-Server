// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Microsoft Graph client for SPE operations.
 *
 * The client:
 *   - Auth interceptor injects Bearer token on every request
 *   - Centralized error handling with actionable messages
 *   - Retry logic for transient failures (429, 5xx)
 */

import { getAccessToken } from "./auth.js";
import { LOCAL_SPA_REDIRECT_URI } from "./constants.js";
import { AppError } from "./errors.js";
import { parseRetryAfterMs } from "./http-client.js";
import { readState, writeState } from "./state.js";
import { USER_AGENT } from "./user-agent.js";
import type {
  ApplicationPermissionGrant,
  Container,
  ContainerPermission,
  ContainerType,
  ContainerTypePermission,
  ContainerTypeRegistrationRecord,
  CustomProperties,
  Drive,
  DriveItem,
  GraphCollection,
  Guid,
  OwnerScope,
  PreviewResult,
  SearchResponse,
  SharingLink,
  UploadSession,
} from "./types.js";

import type {
  Application,
  RequiredResourceAccess as GraphRequiredResourceAccess,
  ResourceAccess as GraphResourceAccess,
} from "@microsoft/microsoft-graph-types";

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
// SPE container-type `permissions` (the `owner` role that lets a public client /
// PCA create containers) exist only under the beta endpoint. v1.0 stays the
// default base; specific container-type / permission / createContainer calls opt
// into beta via graphRequestBeta.
const GRAPH_BETA_BASE = "https://graph.microsoft.com/beta";

// Retry config for throttled/transient errors
const MAX_RETRIES = 3;
const BASE_RETRY_DELAY_MS = 2000;

function log(message: string, data?: unknown): void {
  const timestamp = new Date().toISOString();
  if (data !== undefined) {
    console.error(
      `[${timestamp}] [Graph] ${message}`,
      typeof data === "string" ? data : JSON.stringify(data),
    );
  } else {
    console.error(`[${timestamp}] [Graph] ${message}`);
  }
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function graphErrorForStatus(status: number, errorBody: string, retryAfter?: string | null): AppError {
  if (status === 401) {
    return new AppError(
      "UNAUTHORIZED",
      "Authentication failed. Token may have expired — try re-authenticating.",
      {
        status,
        safeMessage: "Authentication failed while calling Microsoft Graph.",
        suggestion: "Re-authenticate and retry.",
      },
    );
  }
  if (status === 403) {
    return new AppError("FORBIDDEN", `Access denied: ${errorBody}`, {
      status,
      safeMessage: "Access denied by Microsoft Graph.",
      suggestion: "Confirm the signed-in account, tenant, consent, and SharePoint Embedded permissions.",
    });
  }
  if (status === 404) {
    return new AppError("NOT_FOUND", `Resource not found: ${errorBody}`, {
      status,
      safeMessage: "Microsoft Graph resource was not found.",
      suggestion: "Verify identifiers such as containerTypeId, containerId, driveId, or itemId.",
    });
  }
  if (status === 409) {
    return new AppError("CONFLICT", `Graph API conflict (409): ${errorBody}`, {
      status,
      safeMessage: "Microsoft Graph reported a conflict.",
      suggestion: "Refresh the resource state and retry.",
    });
  }
  if (status === 429) {
    return new AppError("RATE_LIMITED", `Graph API throttled (429): ${errorBody}`, {
      status,
      retryAfter,
      safeMessage: "Microsoft Graph throttled the request.",
      suggestion: retryAfter ? `Retry after ${retryAfter} second(s).` : "Wait and retry the request.",
    });
  }
  if (status >= 500) {
    return new AppError("UPSTREAM", `Graph API upstream error (${status}): ${errorBody}`, {
      status,
      safeMessage: "Microsoft Graph returned an upstream service error.",
      suggestion: "Retry later. If the issue persists, check Microsoft Graph service health.",
    });
  }
  return new AppError("UPSTREAM", `Graph API error (${status}): ${errorBody}`, {
    status,
    safeMessage: "Microsoft Graph rejected the request.",
    suggestion: "Check the request arguments and current resource state.",
  });
}

/**
 * Make an authenticated request to Microsoft Graph with retry logic.
 *
 * By default the token comes from the MSAL provider (SPE owning-app token).
 * Pass `getToken` to use a different token source — e.g. the Azure CLI
 * bootstrap token for directory operations like creating the owning app.
 */
async function graphRequest<T>(
  method: string,
  path: string,
  body?: unknown,
  customHeaders?: Record<string, string>,
  getToken: () => Promise<string> = getAccessToken,
  baseUrl: string = GRAPH_BASE,
): Promise<T> {
  const url = `${baseUrl}${path}`;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const token = await getToken();

    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": USER_AGENT,
      ...customHeaders,
    };

    const options: RequestInit = { method, headers };
    if (body && (method === "POST" || method === "PUT" || method === "PATCH")) {
      options.body = typeof body === "string" ? body : JSON.stringify(body);
    }

    log(`${method} ${path} (attempt ${attempt + 1})`);

    let response: Response;
    try {
      response = await fetch(url, options);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (attempt < MAX_RETRIES) {
        const delay = BASE_RETRY_DELAY_MS * Math.pow(2, attempt);
        log(`Network error, retrying in ${delay}ms: ${msg}`);
        await sleep(delay);
        continue;
      }
      throw new AppError("UPSTREAM", `Network error calling Graph API: ${msg}`, {
        safeMessage: "Network error calling Microsoft Graph.",
        suggestion: "Check network connectivity and retry.",
      });
    }

    if (response.ok) {
      // 204 No Content
      if (response.status === 204) {
        return undefined as T;
      }
      return (await response.json()) as T;
    }

    // Retry on throttle or server error
    if ((response.status === 429 || response.status >= 500) && attempt < MAX_RETRIES) {
      const retryAfter = response.headers.get("Retry-After");
      const delay = parseRetryAfterMs(retryAfter) ?? BASE_RETRY_DELAY_MS * Math.pow(2, attempt);
      log(`${response.status} — retrying in ${delay}ms`);
      await sleep(delay);
      continue;
    }

    // Parse error response
    let errorBody: string;
    try {
      const errJson = await response.json();
      errorBody = errJson?.error?.message ?? JSON.stringify(errJson);
    } catch {
      errorBody = await response.text().catch(() => "Unknown error");
    }

    throw graphErrorForStatus(response.status, errorBody, response.headers.get("Retry-After"));
  }

  throw new AppError("UPSTREAM", "Max retries exceeded", {
    safeMessage: "Microsoft Graph request retry limit was exceeded.",
    suggestion: "Retry later.",
  });
}

/**
 * Convenience wrapper over {@link graphRequest} that targets the Microsoft Graph
 * **beta** endpoint. It does not duplicate any request logic — it simply calls
 * `graphRequest` with `baseUrl = GRAPH_BETA_BASE`, so retry/auth/error handling
 * stays in one place. It exists only so the many beta call sites (SPE
 * container-type management and the container-type `permissions`/owner
 * collection, which are beta-only) don't each have to repeat the base-URL
 * argument.
 */
function graphRequestBeta<T>(
  method: string,
  path: string,
  body?: unknown,
  customHeaders?: Record<string, string>,
  getToken: () => Promise<string> = getAccessToken,
): Promise<T> {
  return graphRequest<T>(method, path, body, customHeaders, getToken, GRAPH_BETA_BASE);
}

// ─── Owning App (created via Azure CLI bootstrap token) ─────────────────────

// Stable delegated permission GUIDs on Microsoft Graph. Include both
// FileStorageContainer.Manage.All and Selected so the owning app can read
// containers it creates and perform container-type operations.
const GRAPH_RESOURCE_APP_ID = "00000003-0000-0000-c000-000000000000";
const SPE_DELEGATED_PERMISSION_IDS = {
  FileStorageContainer_ManageAll: "527b6d64-cdf5-4b8b-b336-4aa0b8ca2ce5",
  FileStorageContainer_Selected: "085ca537-6565-41c2-aca7-db852babc212",
  FileStorageContainerType_ManageAll: "8e6ec84c-5fcd-4cc7-ac8a-2296efc0ed9b",
  FileStorageContainerTypeReg_ManageAll: "c319a7df-930e-44c0-a43b-7e5e9c7f4f24",
  // FileStorageContainerTypeReg.Selected — the .Selected counterpart used by
  // SPAC's selected-container model (PR 2159372). Added for scope-set parity.
  FileStorageContainerTypeReg_Selected: "d1e4f63a-1569-475c-b9b2-bdc140405e38",
} as const;

/**
 * The kind of a Microsoft Graph `requiredResourceAccess` entry: `"Scope"` for a
 * delegated permission (acting on behalf of a signed-in user) or `"Role"` for an
 * application permission (app-only). SPE's owning app requests delegated scopes,
 * so every entry we author uses `"Scope"`; `"Role"` is included for
 * completeness / round-tripping any pre-existing app-only grants we merge over.
 */
type GraphResourceAccessType = "Scope" | "Role";

/**
 * A single Microsoft Graph permission entry inside a
 * {@link RequiredResourceAccess} block — the `{ id, type }` shape Entra expects
 * under `application.requiredResourceAccess[].resourceAccess`. `id` is the
 * stable GUID of a delegated scope or app role on the target resource (for us,
 * the Microsoft Graph service principal); `type` distinguishes the two.
 */
type ResourceAccess = Required<Pick<GraphResourceAccess, "id">> & {
  type: GraphResourceAccessType;
};

/**
 * A Microsoft Graph `requiredResourceAccess` block: the set of {@link
 * ResourceAccess} permissions requested against one resource API, keyed by that
 * API's app id (`resourceAppId` — the Microsoft Graph service principal
 * `00000003-0000-0000-c000-000000000000` for the scopes we add).
 */
type RequiredResourceAccess = Required<Pick<GraphRequiredResourceAccess, "resourceAppId">> & {
  resourceAccess: ResourceAccess[];
};

// Desired delegated (type "Scope") Microsoft Graph permissions for the owning
// app, as a function of the captured owner intent (PR #3 review). The broad
// `.Manage.All` Container/Reg scopes are requested ONLY for an admin/console app
// that manages every container type ("manage-all"); a standard ISV/LOB app
// ("selected") gets the least-privilege `.Selected` pair instead. Note:
// FileStorageContainerType.Manage.All is KEPT in BOTH sets — it is delegated-only
// (there is no `.Selected` or app-only counterpart) and is REQUIRED to create /
// enumerate container types, so narrowing it is not possible.
export function desiredGraphResourceAccess(ownerScope: OwnerScope): ResourceAccess[] {
  if (ownerScope === "selected") {
    return [
      { id: SPE_DELEGATED_PERMISSION_IDS.FileStorageContainer_Selected, type: "Scope" },
      { id: SPE_DELEGATED_PERMISSION_IDS.FileStorageContainerType_ManageAll, type: "Scope" },
      { id: SPE_DELEGATED_PERMISSION_IDS.FileStorageContainerTypeReg_Selected, type: "Scope" },
    ];
  }
  return [
    { id: SPE_DELEGATED_PERMISSION_IDS.FileStorageContainer_ManageAll, type: "Scope" },
    { id: SPE_DELEGATED_PERMISSION_IDS.FileStorageContainer_Selected, type: "Scope" },
    { id: SPE_DELEGATED_PERMISSION_IDS.FileStorageContainerType_ManageAll, type: "Scope" },
    { id: SPE_DELEGATED_PERMISSION_IDS.FileStorageContainerTypeReg_ManageAll, type: "Scope" },
    { id: SPE_DELEGATED_PERMISSION_IDS.FileStorageContainerTypeReg_Selected, type: "Scope" },
  ];
}

/**
 * Non-destructively merge `desiredAccess` for `resourceAppId` into an app's
 * existing requiredResourceAccess. Preserves every pre-existing entry (including
 * unrelated resourceAppIds) and adds only the {id,type} pairs that are missing.
 * Dedupe is by resourceAppId + access id + type, so merging is idempotent.
 */
function mergeRequiredResourceAccess(
  existing: RequiredResourceAccess[],
  resourceAppId: string,
  desiredAccess: ResourceAccess[],
): RequiredResourceAccess[] {
  // Deep-clone so we never mutate the caller's/Graph's objects.
  const merged: RequiredResourceAccess[] = (existing ?? []).map((entry) => ({
    resourceAppId: entry.resourceAppId,
    resourceAccess: [...(entry.resourceAccess ?? [])],
  }));

  let target = merged.find(
    (e) => e.resourceAppId?.toLowerCase() === resourceAppId.toLowerCase(),
  );
  if (!target) {
    target = { resourceAppId, resourceAccess: [] };
    merged.push(target);
  }

  // Seed a Set of the target's existing `id|type` keys (id lower-cased so dedupe
  // is case-insensitive) so each membership check is O(1) instead of re-scanning
  // the array with `.some()`. Newly-added keys are recorded too, guarding against
  // duplicates within `desiredAccess` itself. Order is preserved (we still push
  // onto the array); the Set is only the presence index.
  const seen = new Set(
    target.resourceAccess.map((a) => `${a.id?.toLowerCase()}|${a.type}`),
  );
  for (const desired of desiredAccess) {
    const key = `${desired.id.toLowerCase()}|${desired.type}`;
    if (!seen.has(key)) {
      seen.add(key);
      target.resourceAccess.push({ id: desired.id, type: desired.type });
    }
  }

  return merged;
}

/** Strip a trailing slash and l-case so dedupe treats equivalent origins as one. */
function normalizeRedirectUri(uri: string): string {
  return uri.replace(/\/+$/, "").toLowerCase();
}

/**
 * Append `toAdd` redirect URIs to `existing`, skipping any already present
 * (case-insensitive, trailing-slash-insensitive). Existing URIs keep their
 * original order and casing; newly added URIs are appended in order. Idempotent.
 */
function mergeRedirectUris(existing: string[], toAdd: string[]): string[] {
  const seen = new Set(existing.map(normalizeRedirectUri));
  const merged = [...existing];
  for (const uri of toAdd) {
    const key = normalizeRedirectUri(uri);
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(uri);
    }
  }
  return merged;
}

export interface OwningApp {
  /** Application (client) id. */
  appId: NonNullable<Application["appId"]>;
  /** Directory object id. */
  objectId: NonNullable<Application["id"]>;
  displayName: NonNullable<Application["displayName"]>;
}

/**
 * The raw Microsoft Graph `application` payload as returned by the
 * `/applications` endpoints — a subset of the fields we actually consume. Note
 * Graph's naming: `id` is the directory **object id** and `appId` is the
 * **client id**; {@link toOwningApp} maps this into our {@link OwningApp} shape
 * (`objectId`/`appId`) so callers aren't exposed to the ambiguous `id` field.
 */
interface RawApplication {
  /** Directory object id (Graph `id`), surfaced as {@link OwningApp.objectId}. */
  id: NonNullable<Application["id"]>;
  /** Application (client) id, surfaced as {@link OwningApp.appId}. */
  appId: NonNullable<Application["appId"]>;
  displayName: NonNullable<Application["displayName"]>;
}

function toOwningApp(raw: RawApplication): OwningApp {
  return { appId: raw.appId, objectId: raw.id, displayName: raw.displayName };
}

/** Find an existing Entra app by display name (idempotent provisioning). */
export async function findApplicationByName(
  displayName: string,
  getToken: () => Promise<string>,
): Promise<OwningApp | null> {
  const filter = `displayName eq '${displayName.replace(/'/g, "''")}'`;
  const result = await graphRequest<GraphCollection<RawApplication>>(
    "GET",
    `/applications?$filter=${encodeURIComponent(filter)}`,
    undefined,
    undefined,
    getToken,
  );
  const app = result.value?.[0];
  return app ? toOwningApp(app) : null;
}

/**
 * Find an existing Entra app by its appId (client ID). Preferred over
 * display-name lookup when an appId is known — appId is the stable identity, so
 * attach/reuse resolves the correct object even if the display name changed or
 * collides. Mirrors SPAC's appId-based application resolution (PR 2159372).
 */
export async function findApplicationByAppId(
  appId: string,
  getToken: () => Promise<string>,
): Promise<OwningApp | null> {
  const filter = `appId eq '${appId.replace(/'/g, "''")}'`;
  const result = await graphRequest<GraphCollection<RawApplication>>(
    "GET",
    `/applications?$filter=${encodeURIComponent(filter)}`,
    undefined,
    undefined,
    getToken,
  );
  const app = result.value?.[0];
  return app ? toOwningApp(app) : null;
}

/**
 * Local origin of the scaffolded React SPA's Vite dev server. The generated app
 * (react-spa-template.ts emits `server: { port: LOCAL_DEV_PORT }`) authenticates
 * with MSAL.js using `redirectUri: window.location.origin`, i.e. the local Vite
 * origin during dev. MSAL.js uses the auth-code + PKCE flow, which Entra only
 * honours for a redirect URI registered under the app's `spa` platform — hence
 * this constant is added to `spa.redirectUris` at app create/reuse time (see
 * createApplication and the project_app_create reuse path).
 *
 * Defined in ./constants.ts
 * and re-exported here so existing importers keep their `./graph-client.js` path.
 */
export { LOCAL_SPA_REDIRECT_URI } from "./constants.js";

/**
 * Create a public-client Entra app to own a container type. Public client
 * (`isFallbackPublicClient: true`) so no secret is needed — auth is delegated
 * device-code/interactive as this app. Mirrors the full-setup skill `02-app.ps1`.
 *
 * The SAME app registration is used by two clients:
 *   1. the SPE MCP CLI desktop interactive/device-code flow — a *public client*
 *      redeeming on the loopback `http://localhost`; and
 *   2. the generated browser React SPA — a *single-page application* that uses
 *      MSAL.js (auth-code + PKCE) and redeems from its web origin.
 * Entra rejects cross-origin SPA code redemption unless the origin is registered
 * under the `spa` platform (AADSTS9002326). So we register BOTH platforms:
 * `publicClient` (loopback, for the CLI) AND `spa` (local Vite origin, for the
 * browser app). The two are additive — neither flow works if either is dropped.
 * The `spa` key is the Microsoft Graph v1.0 `application` resource's
 * single-page-application platform (siblings: `web`, `spa`, `publicClient`).
 */
export async function createApplication(
  displayName: string,
  getToken: () => Promise<string>,
): Promise<OwningApp> {
  const body = {
    displayName,
    signInAudience: "AzureADMyOrg",
    isFallbackPublicClient: true,
    // Loopback redirect for the MCP CLI desktop public-client flow.
    publicClient: { redirectUris: ["http://localhost"] },
    // SPA platform for the generated browser app's MSAL.js auth-code + PKCE flow.
    // Without this, browser code redemption from the Vite origin fails with
    // AADSTS9002326. Deployed origins are appended post-deploy (addSpaRedirectUris).
    spa: { redirectUris: [LOCAL_SPA_REDIRECT_URI] },
  };
  const raw = await graphRequest<RawApplication>(
    "POST",
    "/applications",
    body,
    undefined,
    getToken,
  );
  return toOwningApp(raw);
}

/**
 * Non-destructively add one or more redirect URIs to an app's `spa` platform.
 *
 * Read-modify-write: GETs the app's current
 * `spa.redirectUris`, appends only the origins that are not already present
 * (dedupe is case-insensitive and trailing-slash-insensitive), then PATCHes the
 * merged list back. This preserves existing SPA URIs — notably the local
 * http://localhost:5173 dev origin set at create time — and is idempotent:
 * re-running with an already-registered origin adds nothing and issues no PATCH.
 *
 * Used after a successful deploy to add the live Static Web App origin (e.g.
 * https://<name>.azurestaticapps.net) so browser sign-in works without a manual
 * portal edit.
 *
 * @param options.bestEffort When true, a failure to read or patch is logged and
 *   swallowed (returns undefined) so the caller — e.g. project_deploy — is not
 *   blocked by a missing Application.ReadWrite grant.
 * @returns `{ added, redirectUris }` describing what changed (`added` is empty
 *   when every origin was already registered), or undefined when a best-effort
 *   attempt failed.
 */
export async function addSpaRedirectUris(
  appObjectId: string,
  origins: string[],
  getToken: () => Promise<string>,
  options: { bestEffort?: boolean } = {},
): Promise<{ added: string[]; redirectUris: string[] } | undefined> {
  try {
    // 1. Read the app's current SPA redirect URIs so we extend, not replace.
    const existing = await graphRequest<{ spa?: { redirectUris?: string[] } }>(
      "GET",
      `/applications/${appObjectId}?$select=spa`,
      undefined,
      undefined,
      getToken,
    );
    const current = existing.spa?.redirectUris ?? [];

    // 2. Append only the origins not already registered (no duplicates).
    const merged = mergeRedirectUris(current, origins);
    const added = merged.slice(current.length);

    // 3. Nothing to do — skip the PATCH entirely so the call is a true no-op.
    if (added.length === 0) {
      return { added: [], redirectUris: current };
    }

    // 4. PATCH the merged list back (read-modify-write; existing URIs preserved).
    await graphRequest<void>(
      "PATCH",
      `/applications/${appObjectId}`,
      { spa: { redirectUris: merged } },
      undefined,
      getToken,
    );
    return { added, redirectUris: merged };
  } catch (error) {
    if (options.bestEffort) {
      const msg = error instanceof Error ? error.message : String(error);
      log(
        `addSpaRedirectUris (best-effort): could not add SPA redirect URIs to app ` +
          `${appObjectId}; continuing. Add them manually if needed. Reason: ${msg}`,
      );
      return undefined;
    }
    throw error;
  }
}

/**
 * Ensure the SPE delegated permissions are present on an app's
 * requiredResourceAccess.
 *
 * Non-destructive: GETs the app's current
 * requiredResourceAccess, MERGES in only the missing Microsoft Graph scope ids,
 * then PATCHes the merged array. This preserves any other API permissions
 * already on the app (which a wholesale REPLACE would silently wipe, since
 * spe_create_app reuses an existing app by identity) and is idempotent —
 * re-running adds nothing and creates no duplicates.
 *
 * @param options.bestEffort When true (the attach/reuse path), a failure to read
 *   or patch permissions is logged as a warning and swallowed so provisioning is
 *   non-blocking, mirroring SPAC. The create-new path leaves this false so errors
 *   propagate.
 * @param options.ownerScope The captured owner intent (PR #3 review) that selects
 *   the least-privilege scope set: "selected" (default here is "manage-all" for
 *   backward-compatible callers) requests only the `.Selected` scopes, while
 *   "manage-all" requests the broad `.Manage.All` set. The merge stays
 *   non-destructive either way, so an existing broad app is never downgraded —
 *   only a brand-new app gets the narrower set.
 */
export async function addSpePermissions(
  appObjectId: string,
  getToken: () => Promise<string>,
  options: { bestEffort?: boolean; ownerScope?: OwnerScope } = {},
): Promise<void> {
  try {
    // 1. Read the app's existing requiredResourceAccess so we can merge, not replace.
    const existing = await graphRequest<{ requiredResourceAccess?: RequiredResourceAccess[] }>(
      "GET",
      `/applications/${appObjectId}?$select=requiredResourceAccess`,
      undefined,
      undefined,
      getToken,
    );

    // 2. Merge in only the missing Graph scopes (dedupe by resourceAppId + id + type).
    //    An unspecified ownerScope defaults to "manage-all" so pre-existing
    //    callers keep the historical broad set; the intent-aware tools pass
    //    "selected" explicitly to request least privilege for new apps.
    const merged = mergeRequiredResourceAccess(
      existing.requiredResourceAccess ?? [],
      GRAPH_RESOURCE_APP_ID,
      desiredGraphResourceAccess(options.ownerScope ?? "manage-all"),
    );

    // 3. PATCH the merged array back.
    await graphRequest<void>(
      "PATCH",
      `/applications/${appObjectId}`,
      { requiredResourceAccess: merged },
      undefined,
      getToken,
    );
  } catch (error) {
    if (options.bestEffort) {
      const msg = error instanceof Error ? error.message : String(error);
      log(
        `addSpePermissions (best-effort): could not add SPE delegated permissions to ` +
          `app ${appObjectId}; continuing. Grant them manually if needed. Reason: ${msg}`,
      );
      return;
    }
    throw error;
  }
}

/**
 * Resolve the signed-in user's directory object id (and UPN). Used to default
 * the container-type `owner` grant to the current user. Pass the Azure CLI
 * bootstrap token provider — the az client has User.Read so `/me` succeeds.
 *
 * `userType` ("Member" | "Guest") is included so callers can surface a clear,
 * NON-BLOCKING message that a guest (B2B) user cannot be a container-type owner
 * (the Graph API rejects it) instead of a raw API error. (PR #3 review.)
 */
export async function getSignedInUser(
  azCliTokenProvider: () => Promise<string>,
): Promise<{ id: Guid; displayName?: string; userPrincipalName?: string; userType?: string }> {
  return graphRequest<{ id: Guid; displayName?: string; userPrincipalName?: string; userType?: string }>(
    "GET",
    "/me?$select=id,displayName,userPrincipalName,userType",
    undefined,
    undefined,
    azCliTokenProvider,
  );
}

// ─── Container Types ────────────────────────────────────────────────────────

interface ListContainerTypesResponse {
  value: RawContainerType[];
}

// Graph returns container types with `id` and `name`; our model uses
// `containerTypeId` and `displayName`. Normalize at the boundary so callers
// (and the 1:1 owning-app guard / auto-registration) read a populated id.
interface RawContainerType {
  id?: string;
  containerTypeId?: string;
  name?: string;
  displayName?: string;
  owningAppId?: string;
  billingClassification?: ContainerType["billingClassification"];
  azureSubscriptionId?: string;
  createdDateTime?: string;
  expirationDateTime?: string;
  etag?: string;
}

function normalizeContainerType(raw: RawContainerType): ContainerType {
  return {
    ...raw,
    containerTypeId: raw.containerTypeId ?? raw.id ?? "",
    displayName: raw.displayName ?? raw.name ?? "",
    owningAppId: raw.owningAppId ?? "",
  } as ContainerType;
}

/**
 * Record whether the owning app can enumerate ALL container types (i.e., holds
 * FileStorageContainerType.Manage.All) into persisted state (PR #3 review). This
 * lights up the context-gate staleness warning when the flag is `false`. It is
 * deliberately NON-THROWING and only writes on an actual change: a failed state
 * write must never mask the caller's list result or error semantics, and it must
 * not churn the state file on every read.
 */
function recordManagesAllContainerTypes(value: boolean): void {
  try {
    if (readState().owningAppManagesAllContainerTypes !== value) {
      writeState({ owningAppManagesAllContainerTypes: value });
    }
  } catch {
    /* best-effort flag write — swallow so the caller's semantics are unchanged */
  }
}

export async function listContainerTypes(): Promise<ContainerType[]> {
  try {
    const result = await graphRequestBeta<ListContainerTypesResponse>(
      "GET",
      "/storage/fileStorage/containerTypes",
    );
    // Success ⇒ this app can enumerate ALL container types (it holds
    // FileStorageContainerType.Manage.All). Self-heal the staleness flag to true;
    // this runtime signal wins over recorded intent for reused apps (PR #3 review).
    recordManagesAllContainerTypes(true);
    return (result.value ?? []).map(normalizeContainerType);
  } catch (error) {
    // A 403 (FORBIDDEN) means the app lacks FileStorageContainerType.Manage.All
    // and cannot enumerate all container types — record the flag false so the
    // context-gate staleness warning fires, then rethrow the original error
    // UNCHANGED so callers see the same failure semantics as before.
    if (error instanceof AppError && (error.status === 403 || error.code === "FORBIDDEN")) {
      recordManagesAllContainerTypes(false);
    }
    throw error;
  }
}

export async function createContainerType(params: {
  displayName: string;
  owningAppId: Guid;
  billingClassification?: "trial" | "standard" | "directToCustomer";
  // OPTIONAL by design: the Graph container-type *create* call does not take a
  // subscription (see the NOTE below). azureSubscriptionId/resourceGroup/region
  // are only required for the separate ARM billing-link step (standard billing);
  // they ride on this signature for call-site convenience but are consumed there,
  // not here. Trial container types need none of them.
  azureSubscriptionId?: Guid;
  resourceGroup?: string;
  region?: string;
}): Promise<ContainerType> {
  // IMPORTANT: the Graph create body field is `name`, NOT `displayName`
  // (verified by the live-tested full-setup skill — gotchas.md #2).
  const body: Record<string, unknown> = {
    name: params.displayName,
    owningAppId: params.owningAppId,
  };

  if (params.billingClassification) {
    body.billingClassification = params.billingClassification;
  }

  // NOTE: azureSubscriptionId/resourceGroup/region are intentionally NOT sent in
  // the Graph create body — the v1.0 fileStorageContainerType resource does not
  // accept them (the same field family the Update PATCH rejects with HTTP 400).
  // The Azure billing link is attached separately by creating a
  // Microsoft.Syntex/accounts (RaaS) ARM resource (see billing_setup →
  // createSyntexAccount). The sub/rg/region params remain on the signature for
  // call-site compatibility but are consumed by the ARM-account step, not here.

  // Response field is `id`, NOT `containerTypeId` — normalize so the id is usable.
  const raw = await graphRequestBeta<RawContainerType>("POST", "/storage/fileStorage/containerTypes", body);
  return normalizeContainerType(raw);
}

// ─── Container Type Registration ────────────────────────────────────────────

export async function registerContainerType(
  containerTypeId: string,
  appId: string,
  delegatedPermissions: string[] = ["full"],
  applicationPermissions?: string[],
): Promise<void> {
  // App-only (application) permissions default to ["none"] (PR #3 review). The
  // full-setup path uses ONLY delegated tokens (an Azure CLI bootstrap token and
  // an MSAL device-code token acquired AS the owning app); there is no app-only
  // token path, so the owning app needs no app-only grant. App-only permissions
  // are opt-in — for a separate daemon/app-only consumer — and passed explicitly.
  //
  // Re-grant safety: the registration PUT REPLACES the entire
  // applicationPermissionGrants collection, so a naive re-run that dropped a
  // pre-existing app-only grant would silently REVOKE it. When the caller does
  // not specify app-only permissions, read-merge any grant this app already holds
  // instead of clobbering it; an explicit value always wins.
  let effectiveAppPermissions: string[];
  if (applicationPermissions !== undefined) {
    effectiveAppPermissions = applicationPermissions;
  } else {
    effectiveAppPermissions = ["none"];
    try {
      const existingGrants = await listContainerTypeAppPermissions(containerTypeId);
      const priorGrant = existingGrants.find(
        (g) => g.appId?.toLowerCase() === appId.toLowerCase(),
      );
      if (priorGrant?.applicationPermissions && priorGrant.applicationPermissions.length > 0) {
        effectiveAppPermissions = priorGrant.applicationPermissions;
      }
    } catch (lookupError) {
      // Only a genuine "no existing registration/grant" (404 NOT_FOUND) is safe to
      // treat as an absent grant and keep the least-privilege ["none"] default. Any
      // OTHER failure (e.g. 403, or a transient error that exhausted retries) is
      // AMBIGUOUS: proceeding with the PUT would replace the whole grant collection
      // and could silently REVOKE an app-only grant we merely failed to read. Fail
      // closed by rethrowing rather than risk a silent downgrade (PR #3 review).
      if (
        !(lookupError instanceof AppError &&
          (lookupError.code === "NOT_FOUND" || lookupError.status === 404))
      ) {
        throw lookupError;
      }
    }
  }

  const body = {
    applicationPermissionGrants: [
      {
        appId,
        delegatedPermissions,
        applicationPermissions: effectiveAppPermissions,
      } satisfies ApplicationPermissionGrant,
    ],
  };

  // Tenant-level registration endpoint (verified by the live-tested skill
  // 04-container-type.ps1). MUST include a grant entry with sufficient
  // delegatedPermissions, or container creation later fails with
  // UnauthorizedAccessException — it is the DELEGATED grant that matters here.
  await graphRequest<void>(
    "PUT",
    `/storage/fileStorage/containerTypeRegistrations/${containerTypeId}`,
    body,
  );
}

// ─── Container Type Registration — application permission grants (v1.0) ──────
//
// The `applicationPermissionGrants` collection on a containerTypeRegistration
// authorizes individual consuming apps to act on the container type. The
// registration above (PUT on the registration) replaces the WHOLE collection;
// these helpers add / list / remove a SINGLE app's grant without disturbing the
// others — the supported way to authorize additional apps on an existing
// registration. The appId is part of the URL, never the body.

interface ApplicationPermissionGrantsResponse {
  value: ApplicationPermissionGrant[];
}

/**
 * Grant (create or replace) a single application's permission grant on a
 * container type registration (v1.0). Idempotent upsert via PUT — re-granting an
 * existing appId overwrites its permissions. The registration id is the
 * container type id in the tenant-local model used here.
 */
export async function grantContainerTypeAppPermission(
  containerTypeId: string,
  appId: string,
  delegatedPermissions: string[] = ["full"],
  applicationPermissions: string[] = ["full"],
): Promise<ApplicationPermissionGrant> {
  return graphRequest<ApplicationPermissionGrant>(
    "PUT",
    `/storage/fileStorage/containerTypeRegistrations/${containerTypeId}/applicationPermissionGrants/${appId}`,
    { delegatedPermissions, applicationPermissions },
  );
}

/** List the application permission grants on a container type registration (v1.0). */
export async function listContainerTypeAppPermissions(
  containerTypeId: string,
): Promise<ApplicationPermissionGrant[]> {
  const result = await graphRequest<ApplicationPermissionGrantsResponse>(
    "GET",
    `/storage/fileStorage/containerTypeRegistrations/${containerTypeId}/applicationPermissionGrants`,
  );
  return result.value ?? [];
}

// ─── Container Type Registrations — CRUDL on the registration RECORD ─────────
//
// A registration is the tenant↔containerType binding (distinct from a single
// app's permission grant). It must exist before containers can be created, and
// it MUST be deleted before the container type can be deleted. Per Graph, a
// registration can only be deleted once it has NO containers AND NO deleted
// (recycle-bin) containers.

// Microsoft Graph returns collections as an OData envelope — `{ value: [...] }`
// (plus optional paging fields) — never a bare JSON array. This interface types
// only that raw wire shape; the public helpers below unwrap `.value` and return
// a plain `ContainerTypeRegistrationRecord[]` so callers never see the envelope.
interface ContainerTypeRegistrationsListResponse {
  value: ContainerTypeRegistrationRecord[];
}

/** Read a single container type registration record (v1.0). */
export async function getContainerTypeRegistration(
  containerTypeId: string,
): Promise<ContainerTypeRegistrationRecord> {
  return graphRequest<ContainerTypeRegistrationRecord>(
    "GET",
    `/storage/fileStorage/containerTypeRegistrations/${containerTypeId}`,
  );
}

/**
 * List the container type registrations on the tenant (v1.0). Unwraps Graph's
 * OData `{ value: [...] }` envelope and returns the bare array.
 */
export async function listContainerTypeRegistrations(): Promise<ContainerTypeRegistrationRecord[]> {
  const result = await graphRequest<ContainerTypeRegistrationsListResponse>(
    "GET",
    "/storage/fileStorage/containerTypeRegistrations",
  );
  return result.value ?? [];
}

/**
 * Delete a container type registration record (v1.0). Graph:
 * DELETE /storage/fileStorage/containerTypeRegistrations/{id} → 204. Fails with
 * 409 if the registration still has containers or deleted (recycle-bin)
 * containers. This is the step that unblocks container type deletion.
 */
export async function deleteContainerTypeRegistration(containerTypeId: string): Promise<void> {
  await graphRequest<void>(
    "DELETE",
    `/storage/fileStorage/containerTypeRegistrations/${containerTypeId}`,
  );
}

/** Remove a single application's permission grant from a container type registration (v1.0). */
export async function revokeContainerTypeAppPermission(
  containerTypeId: string,
  appId: string,
): Promise<void> {
  await graphRequest<void>(
    "DELETE",
    `/storage/fileStorage/containerTypeRegistrations/${containerTypeId}/applicationPermissionGrants/${appId}`,
  );
}
// ─── Container Type Permissions (owner role — beta only) ─────────────────

interface ContainerTypePermissionsResponse {
  value: ContainerTypePermission[];
}

/**
 * Grant the `owner` role on a container type to a USER (beta). Owners can create
 * containers using a public client (PCA) / delegated token — v1.0 rejects
 * container creation by public clients. Only the `owner` role and a USER
 * identity are supported; max 3 permissions per container type (duplicates are
 * idempotent). The caller must already be an owner / SPE admin / Global admin.
 */
export async function grantContainerTypeOwner(
  containerTypeId: string,
  userId: string,
): Promise<ContainerTypePermission> {
  return graphRequestBeta<ContainerTypePermission>(
    "POST",
    `/storage/fileStorage/containerTypes/${containerTypeId}/permissions`,
    { roles: ["owner"], grantedToV2: { user: { id: userId } } },
  );
}

/** List the permission (owner) entries on a container type (beta). */
export async function listContainerTypePermissions(
  containerTypeId: string,
): Promise<ContainerTypePermission[]> {
  const result = await graphRequestBeta<ContainerTypePermissionsResponse>(
    "GET",
    `/storage/fileStorage/containerTypes/${containerTypeId}/permissions`,
  );
  return result.value ?? [];
}

/** Get a single container-type permission by id (beta). */
export async function getContainerTypePermission(
  containerTypeId: string,
  permissionId: string,
): Promise<ContainerTypePermission> {
  return graphRequestBeta<ContainerTypePermission>(
    "GET",
    `/storage/fileStorage/containerTypes/${containerTypeId}/permissions/${permissionId}`,
  );
}

/** Remove an owner permission from a container type (beta). */
export async function revokeContainerTypePermission(
  containerTypeId: string,
  permissionId: string,
): Promise<void> {
  await graphRequestBeta<void>(
    "DELETE",
    `/storage/fileStorage/containerTypes/${containerTypeId}/permissions/${permissionId}`,
  );
}
// ─── Containers ─────────────────────────────────────────────────────────────

export async function listContainers(containerTypeId: string): Promise<Container[]> {
  const result = await graphRequest<GraphCollection<Container>>(
    "GET",
    `/storage/fileStorage/containers?$filter=containerTypeId eq ${containerTypeId}`,
  );
  return result.value ?? [];
}

export async function createContainer(
  containerTypeId: string,
  displayName: string,
): Promise<Container> {
  return graphRequestBeta<Container>("POST", "/storage/fileStorage/containers", {
    displayName,
    containerTypeId,
  });
}

/**
 * Update (rename / edit) a container's editable properties (displayName,
 * description). Graph: PATCH /storage/fileStorage/containers/{id}. Only the
 * provided fields are sent. Returns the updated container.
 */
export async function updateContainer(
  containerId: string,
  patch: { displayName?: string; description?: string },
): Promise<Container> {
  const body: Record<string, unknown> = {};
  if (patch.displayName !== undefined) body.displayName = patch.displayName;
  if (patch.description !== undefined) body.description = patch.description;
  return graphRequest<Container>(
    "PATCH",
    `/storage/fileStorage/containers/${containerId}`,
    body,
  );
}

/**
 * List soft-deleted containers in the tenant recycle bin (optionally filtered by
 * container type). Graph: GET /storage/fileStorage/deletedContainers. These are
 * containers that have been soft-deleted but not yet permanently purged; a
 * container type registration cannot be deleted while any (live OR deleted)
 * container exists, so this is required to find recycle-bin blockers.
 */
export async function listDeletedContainers(containerTypeId?: string): Promise<Container[]> {
  const path = containerTypeId
    ? `/storage/fileStorage/deletedContainers?$filter=containerTypeId eq ${containerTypeId}`
    : "/storage/fileStorage/deletedContainers";
  const result = await graphRequest<GraphCollection<Container>>("GET", path);
  return result.value ?? [];
}

export async function activateContainer(containerId: string): Promise<void> {
  await graphRequest<void>(
    "POST",
    `/storage/fileStorage/containers/${containerId}/activate`,
  );
}

// ─── Container Permissions ──────────────────────────────────────────────────

export async function addContainerPermission(
  containerId: string,
  userPrincipalName: string,
  role: string,
): Promise<ContainerPermission> {
  return graphRequest<ContainerPermission>(
    "POST",
    `/storage/fileStorage/containers/${containerId}/permissions`,
    {
      roles: [role],
      grantedToV2: {
        user: { userPrincipalName },
      },
    },
  );
}

// ─── Container Details ──────────────────────────────────────────────────────

export async function getContainer(containerId: string): Promise<Container> {
  return graphRequest<Container>(
    "GET",
    `/storage/fileStorage/containers/${containerId}`,
  );
}

export async function deleteContainer(containerId: string): Promise<void> {
  await graphRequest<void>(
    "DELETE",
    `/storage/fileStorage/containers/${containerId}`,
  );
}

export async function permanentDeleteContainer(containerId: string): Promise<void> {
  await graphRequest<void>(
    "POST",
    `/storage/fileStorage/containers/${containerId}/permanentDelete`,
  );
}

export async function restoreDeletedContainer(containerId: string): Promise<void> {
  await graphRequest<void>(
    "POST",
    `/storage/fileStorage/deletedContainers/${containerId}/restore`,
  );
}

export async function lockContainer(containerId: string): Promise<void> {
  await graphRequest<void>(
    "POST",
    `/storage/fileStorage/containers/${containerId}/lock`,
  );
}

export async function unlockContainer(containerId: string): Promise<void> {
  await graphRequest<void>(
    "POST",
    `/storage/fileStorage/containers/${containerId}/unlock`,
  );
}

export async function listContainerPermissions(
  containerId: string,
): Promise<ContainerPermission[]> {
  const result = await graphRequest<GraphCollection<ContainerPermission>>(
    "GET",
    `/storage/fileStorage/containers/${containerId}/permissions`,
  );
  return result.value ?? [];
}

export async function updateContainerPermission(
  containerId: string,
  permissionId: string,
  role: string,
): Promise<void> {
  await graphRequest<void>(
    "PATCH",
    `/storage/fileStorage/containers/${containerId}/permissions/${permissionId}`,
    { roles: [role] },
  );
}

export async function removeContainerPermission(
  containerId: string,
  permissionId: string,
): Promise<void> {
  await graphRequest<void>(
    "DELETE",
    `/storage/fileStorage/containers/${containerId}/permissions/${permissionId}`,
  );
}

export async function getCustomProperties(
  containerId: string,
): Promise<CustomProperties> {
  return graphRequest<CustomProperties>(
    "GET",
    `/storage/fileStorage/containers/${containerId}/customProperties`,
  );
}

// ─── Drive / Content Operations ─────────────────────────────────────────────

export async function getContainerDrive(containerId: string): Promise<Drive> {
  return graphRequest<Drive>(
    "GET",
    `/storage/fileStorage/containers/${containerId}/drive`,
  );
}

export async function getDriveItem(
  driveId: string,
  itemPath: string,
): Promise<DriveItem> {
  return graphRequest<DriveItem>(
    "GET",
    `/drives/${driveId}/root:${itemPath}`,
  );
}

export async function listDriveChildren(
  driveId: string,
  folderId?: string,
): Promise<DriveItem[]> {
  const path = folderId
    ? `/drives/${driveId}/items/${folderId}/children`
    : `/drives/${driveId}/root/children`;
  const result = await graphRequest<GraphCollection<DriveItem>>("GET", path);
  return result.value ?? [];
}

export async function uploadSmallFile(
  driveId: string,
  targetPath: string,
  content: string,
): Promise<DriveItem> {
  return graphRequest<DriveItem>(
    "PUT",
    `/drives/${driveId}/root:${targetPath}:/content`,
    content,
    { "Content-Type": "text/plain" },
  );
}

export async function createUploadSession(
  driveId: string,
  targetPath: string,
  fileName: string,
): Promise<UploadSession> {
  return graphRequest<UploadSession>(
    "POST",
    `/drives/${driveId}/root:${targetPath}:/createUploadSession`,
    {
      item: {
        "@microsoft.graph.conflictBehavior": "rename",
        name: fileName,
      },
    },
  );
}

export async function createFolder(
  driveId: string,
  parentId: string,
  folderName: string,
): Promise<DriveItem> {
  const path = parentId === "root"
    ? `/drives/${driveId}/root/children`
    : `/drives/${driveId}/items/${parentId}/children`;
  return graphRequest<DriveItem>("POST", path, {
    name: folderName,
    folder: {},
    "@microsoft.graph.conflictBehavior": "fail",
  });
}

export async function previewDriveItem(
  driveId: string,
  itemId: string,
): Promise<PreviewResult> {
  return graphRequest<PreviewResult>(
    "POST",
    `/drives/${driveId}/items/${itemId}/preview`,
    {},
  );
}

export async function createSharingLink(
  driveId: string,
  itemId: string,
  type: string,
  scope: string,
): Promise<SharingLink> {
  return graphRequest<SharingLink>(
    "POST",
    `/drives/${driveId}/items/${itemId}/createLink`,
    { type, scope },
  );
}

export async function listDriveItemPermissions(
  driveId: string,
  itemId: string,
): Promise<SharingLink[]> {
  const result = await graphRequest<GraphCollection<SharingLink>>(
    "GET",
    `/drives/${driveId}/items/${itemId}/permissions`,
  );
  return result.value ?? [];
}

export async function revokeSharingLink(
  driveId: string,
  itemId: string,
  permissionId: string,
): Promise<void> {
  await graphRequest<void>(
    "DELETE",
    `/drives/${driveId}/items/${itemId}/permissions/${permissionId}`,
  );
}

export async function searchContent(
  query: string,
  maxResults: number = 25,
  from: number = 0,
): Promise<SearchResponse> {
  return graphRequest<SearchResponse>(
    "POST",
    "/search/query",
    {
      requests: [
        {
          entityTypes: ["driveItem"],
          query: { queryString: query, includeHiddenContent: true },
          from,
          size: maxResults,
        },
      ],
    },
  );
}

// ─── Container Type Config (get / update / delete) ──────────────────────────
// NOTE on billing: there are no billing *operations* in this module. SPE billing
// is an Azure Resource Manager concern — a Microsoft.Syntex/accounts (RaaS)
// resource linked to the container type — and lives in `azure-cli.ts`
// (ensureSyntexProviderRegistered / getSyntexAccounts / createSyntexAccount),
// orchestrated by `tools/provision.ts`. The functions below only read/mutate the
// container type's Graph configuration (which *carries* a billingClassification
// field); `billing_check` reads that field via getContainerType.

export async function getContainerType(
  containerTypeId: string,
): Promise<ContainerType> {
  // Graph beta returns `id`/`name`; normalize to containerTypeId/displayName so
  // callers (container_type_get, billing_check) read a populated id and name.
  const raw = await graphRequestBeta<RawContainerType>(
    "GET",
    `/storage/fileStorage/containerTypes/${containerTypeId}`,
  );
  return normalizeContainerType(raw);
}

export async function updateContainerType(
  containerTypeId: string,
  update: Record<string, unknown>,
): Promise<ContainerType> {
  // The beta Update fileStorageContainerType API accepts only name/settings/etag
  // (the display name field is `name`, NOT `displayName`), and **etag is REQUIRED**
  // for optimistic concurrency: it must equal the CURRENT server value from a
  // fresh Get/Create — it is an included concurrency token, NOT a client-set
  // field. Omitting it returns HTTP 400 "One of the provided arguments is not
  // acceptable" (see the docs' "Update without ETag" example). Defensive
  // hardening: always source the etag from a fresh Get and DROP any
  // caller-supplied `etag` (a stale value would cause a 412 / lost update).
  // Normalize the response (a PATCH may also return 204 No Content) so callers
  // read a populated id/name.
  const { etag: _ignoredCallerEtag, ...safeUpdate } = update;
  void _ignoredCallerEtag; // intentionally discarded: never trust a caller etag
  const body: Record<string, unknown> = { ...safeUpdate };
  const current = await getContainerType(containerTypeId);
  if (current.etag) body.etag = current.etag;
  const raw = await graphRequestBeta<RawContainerType>(
    "PATCH",
    `/storage/fileStorage/containerTypes/${containerTypeId}`,
    body,
  );
  return normalizeContainerType(raw ?? {});
}

/** Delete a container type (owning-app token). Used by cleanup. */
export async function deleteContainerType(containerTypeId: string): Promise<void> {
  await graphRequestBeta<void>(
    "DELETE",
    `/storage/fileStorage/containerTypes/${containerTypeId}`,
  );
}

/** Delete an Entra app registration (bootstrap token). Used by cleanup. */
export async function deleteApplication(
  appObjectId: string,
  getToken: () => Promise<string>,
): Promise<void> {
  await graphRequest<void>(
    "DELETE",
    `/applications/${appObjectId}`,
    undefined,
    undefined,
    getToken,
  );
}
