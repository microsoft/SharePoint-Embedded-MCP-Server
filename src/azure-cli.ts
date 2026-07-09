// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Azure CLI helpers for control-plane operations that are not on Microsoft
 * Graph: listing subscriptions / resource groups and registering the
 * `Microsoft.Syntex` resource provider for SPE billing.
 *
 * All commands shell out to `az`, which is cross-platform (Windows/macOS/Linux)
 * and uses the developer's existing `az login` session — no Microsoft
 * first-party app or pre-authorization required.
 */

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSignedInIdentity } from "./bootstrap.js";
import {
  isConditionalAccessOrClaimsError,
  asConditionalAccessError,
  enrichConditionalAccess,
} from "./az-errors.js";

const AZ_TIMEOUT_MS = 30_000;

function azNeedsShell(): boolean {
  return process.platform === "win32";
}

/**
 * Best-effort tenant id from the current `az` sign-in, used to interpolate the
 * exact re-auth command into Conditional Access guidance. Never throws — a
 * missing tenant just yields a placeholder in the remediation text. `az account
 * show` reads the cached account and does not itself require a CA step-up.
 */
async function resolveTenantIdBestEffort(): Promise<string | undefined> {
  try {
    const identity = await getSignedInIdentity();
    return identity?.tenantId;
  } catch {
    return undefined;
  }
}

function isNotInstalled(message: string): boolean {
  return (
    message.includes("ENOENT") ||
    message.includes("not found") ||
    message.includes("not recognized") ||
    message.includes("is not recognized")
  );
}

const NOT_INSTALLED_MSG =
  "Azure CLI ('az') is not installed. Install it from https://aka.ms/install-azure-cli, then run `az login --allow-no-subscriptions`.";

function execFileAsync(
  cmd: string,
  args: string[],
  opts: { timeout: number; shell?: boolean },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, opts, (err, stdout, stderr) => {
      if (err) reject(err);
      else resolve({ stdout, stderr });
    });
  });
}

/** Run an `az` command with `--output json` appended and parse the result. */
export async function azJson<T>(args: string[]): Promise<T> {
  try {
    const { stdout } = await execFileAsync("az", [...args, "--output", "json"], {
      timeout: AZ_TIMEOUT_MS,
      shell: azNeedsShell(),
    });
    return JSON.parse(stdout) as T;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isNotInstalled(message)) {
      throw new Error(NOT_INSTALLED_MSG);
    }
    // Conditional Access / claims step-up: surface the actionable re-auth path
    // instead of a generic failure. Tenant id is enriched by the high-level ARM
    // helpers; here we emit the guidance with a placeholder. Out of scope: full
    // claims-challenge automation (the CLI cannot redeem it non-interactively).
    if (isConditionalAccessOrClaimsError(message)) {
      throw asConditionalAccessError();
    }
    throw new Error(`Azure CLI command failed (az ${args.join(" ")}): ${message}`, { cause: error });
  }
}

export interface AzureSubscription {
  id: string;
  name: string;
  state: string;
  tenantId?: string;
  isDefault?: boolean;
}

export interface AzureResourceGroup {
  name: string;
  location: string;
  id: string;
}

/** List Azure subscriptions the signed-in user can access. */
export async function listSubscriptions(): Promise<AzureSubscription[]> {
  const subs = await azJson<AzureSubscription[]>(["account", "list", "--all"]);
  return subs.filter((s) => s.state === "Enabled");
}

/**
 * Whether the Azure CLI currently has an active sign-in.
 *
 * `az account list` returns `[]` with exit code 0 when the user is NOT signed
 * in, which is indistinguishable from a signed-in user who genuinely has zero
 * subscriptions. Callers probe `az account show` (which fails when not signed
 * in) to tell the two apart and surface `az login` guidance.
 */
export async function isSignedIn(): Promise<boolean> {
  try {
    await execFileAsync("az", ["account", "show", "--output", "json"], {
      timeout: AZ_TIMEOUT_MS,
      shell: azNeedsShell(),
    });
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isNotInstalled(message)) {
      throw new Error(NOT_INSTALLED_MSG);
    }
    // Any other failure (e.g. "Please run 'az login' to setup account") means
    // there is no usable sign-in.
    return false;
  }
}

/** List resource groups in a subscription. */
export async function listResourceGroups(subscriptionId: string): Promise<AzureResourceGroup[]> {
  return azJson<AzureResourceGroup[]>(["group", "list", "--subscription", subscriptionId]);
}

export interface ProviderRegistration {
  namespace: string;
  registrationState: string;
}

const SYNTEX_NAMESPACE = "Microsoft.Syntex";

// Bound the registration wait the same way the VS Code extension does:
// poll every ~20s for up to 5 minutes (CreateStandardContainerType.ts uses a
// 30s interval / 5 min timeout). The official SPE docs likewise say to "wait
// 5–10 minutes ... until the cmdlet succeeds".
const SYNTEX_POLL_INTERVAL_MS = 20_000;
const SYNTEX_POLL_TIMEOUT_MS = 5 * 60 * 1000;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Read the current registration state of the Syntex RP (null if unavailable). */
export async function showSyntexProvider(
  subscriptionId: string,
): Promise<ProviderRegistration | null> {
  return azJson<ProviderRegistration>([
    "provider", "show", "--namespace", SYNTEX_NAMESPACE, "--subscription", subscriptionId,
  ]).catch(() => null);
}

/** Trigger registration of the Syntex RP (async on the Azure side). */
export async function registerSyntexProvider(subscriptionId: string): Promise<void> {
  try {
    await execFileAsync(
      "az",
      ["provider", "register", "--namespace", SYNTEX_NAMESPACE, "--subscription", subscriptionId],
      { timeout: AZ_TIMEOUT_MS, shell: azNeedsShell() },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isNotInstalled(message)) {
      throw new Error(NOT_INSTALLED_MSG);
    }
    if (isConditionalAccessOrClaimsError(message)) {
      throw asConditionalAccessError();
    }
    throw new Error(
      `Azure CLI command failed (az provider register --namespace ${SYNTEX_NAMESPACE}): ${message}`,
      { cause: error },
    );
  }
}

/** Injectable seams so the polling loop is unit-testable without shelling out. */
export interface EnsureSyntexRegisteredOptions {
  /** Total time to wait for `Registered` before failing. Default: 5 min. */
  timeoutMs?: number;
  /** Delay between status polls. Default: 20s. */
  intervalMs?: number;
  /** Override the sleep used between polls (tests inject a no-op). */
  sleep?: (ms: number) => Promise<void>;
  /** Monotonic clock source (tests inject a fake). */
  now?: () => number;
  /** Override the status read (tests inject a stub). */
  showProvider?: (subscriptionId: string) => Promise<ProviderRegistration | null>;
  /** Override the register trigger (tests inject a stub). */
  registerProvider?: (subscriptionId: string) => Promise<void>;
  /** Known tenant id, interpolated into Conditional Access step-up guidance. */
  tenantId?: string;
  /** Best-effort tenant resolver used for CA guidance (tests inject a stub). */
  resolveTenantId?: () => Promise<string | undefined>;
}

/**
 * Ensure the `Microsoft.Syntex` resource provider is **Registered** on the
 * subscription — the Azure-side prerequisite for SPE standard billing.
 *
 * Idempotent: returns immediately when already `Registered`. Otherwise it
 * triggers registration and POLLS until the provider reports `Registered`,
 * bounded by `timeoutMs`. If the timeout elapses while still `Registering`,
 * it throws an actionable error so callers do not race the billing PATCH
 * against an incomplete registration.
 */
export async function ensureSyntexProviderRegistered(
  subscriptionId: string,
  options: EnsureSyntexRegisteredOptions = {},
): Promise<ProviderRegistration> {
  const {
    timeoutMs = SYNTEX_POLL_TIMEOUT_MS,
    intervalMs = SYNTEX_POLL_INTERVAL_MS,
    sleep = defaultSleep,
    now = Date.now,
    showProvider = showSyntexProvider,
    registerProvider = registerSyntexProvider,
    tenantId,
    resolveTenantId = resolveTenantIdBestEffort,
  } = options;

  try {
    const current = await showProvider(subscriptionId);
    if (current?.registrationState === "Registered") {
      return current;
    }

    await registerProvider(subscriptionId);

    const deadline = now() + timeoutMs;
    let lastState = current?.registrationState ?? "NotRegistered";

    // Poll until Registered or the deadline passes. We sleep first because
    // registration was just (re)triggered and won't be instantaneous.
    while (now() < deadline) {
      await sleep(intervalMs);
      const latest = await showProvider(subscriptionId);
      if (latest?.registrationState) {
        lastState = latest.registrationState;
        if (lastState === "Registered") {
          return latest;
        }
      }
    }

    throw new Error(
      `Microsoft.Syntex resource provider did not finish registering on subscription ` +
        `${subscriptionId} within ${Math.round(timeoutMs / 1000)}s (last state: ${lastState}). ` +
        `Registration can take a few minutes — wait and retry, or run ` +
        `\`az provider register --namespace Microsoft.Syntex --subscription ${subscriptionId}\` ` +
        `and check \`az provider show --namespace Microsoft.Syntex\` until it reports Registered.`,
    );
  } catch (error) {
    // If the ARM write hit a Conditional Access step-up, re-throw the enriched
    // actionable error (with the resolved tenant id). Non-CA errors pass through
    // unchanged. Full claims-challenge automation is intentionally out of scope.
    throw await enrichConditionalAccess(error, async () => tenantId ?? (await resolveTenantId()));
  }
}

// ─── Microsoft.Syntex/accounts (RaaS) ARM billing account ───────────────────
//
// Standard SPE billing is attached by creating a `Microsoft.Syntex/accounts`
// ARM resource on the chosen subscription/RG (the RaaS billing account). The
// token plane is ARM (management.azure.com), which `az rest` provides from the
// existing `az login`. Mirrors the VS Code extension's ARMProvider exactly
// (api-version 2023-01-04-preview; assert provisioningState === "Succeeded").

const ARM_BASE = "https://management.azure.com";
const SYNTEX_ACCOUNT_API_VERSION = "2023-01-04-preview";
const SYNTEX_ACCOUNT_POLL_INTERVAL_MS = 10_000;
const SYNTEX_ACCOUNT_POLL_TIMEOUT_MS = 5 * 60 * 1000;

// Azure regions where Microsoft.Syntex/accounts (the RaaS billing account for
// SharePoint Embedded standard billing) can be provisioned. ARM rejects any
// other region with `LocationNotAvailableForResourceType` (e.g. westus2), so
// validate up front and fail with an actionable message instead of a raw ARM
// 400. Sourced from the ARM error's "List of available regions".
const SYNTEX_SUPPORTED_REGIONS = new Set<string>([
  "eastus", "eastus2", "centralus", "northcentralus", "southcentralus", "westcentralus",
  "westus", "canadacentral", "canadaeast", "brazilsouth", "northeurope", "westeurope",
  "norwayeast", "norwaywest", "francecentral", "francesouth", "switzerlandnorth",
  "switzerlandwest", "uksouth", "ukwest", "germanynorth", "australiaeast",
  "australiasoutheast", "centralindia", "southindia", "westindia", "japaneast",
  "eastasia", "southeastasia", "koreacentral", "uaenorth", "southafricanorth",
  "southafricawest",
]);

/** Normalize a region string the way ARM compares locations (lower-case, no spaces). */
function normalizeRegion(region: string): string {
  return region.trim().toLowerCase().replace(/\s+/g, "");
}

/** True if `region` can host a Microsoft.Syntex/accounts (SPE standard billing) account. */
export function isSyntexRegionSupported(region: string): boolean {
  return SYNTEX_SUPPORTED_REGIONS.has(normalizeRegion(region));
}

/**
 * Throw an actionable error if `region` cannot host a Microsoft.Syntex account.
 * Callers on the standard-billing path MUST run this BEFORE creating the
 * container type: a standard container type cannot be deleted (Graph 422
 * "Cannot delete container type for non trial"), so an invalid region caught
 * only at billing-account creation time leaves an un-rollback-able orphan CT.
 * Validating up front keeps the failure cost-free and reversible.
 */
export function assertSyntexRegionSupported(region: string): void {
  if (!isSyntexRegionSupported(region)) {
    throw new Error(
      `Azure region '${region}' is not available for Microsoft.Syntex/accounts ` +
        "(SharePoint Embedded standard billing). Choose a supported region, e.g. " +
        `eastus, westus, westeurope, uksouth. Full list: ${[...SYNTEX_SUPPORTED_REGIONS].join(", ")}.`,
    );
  }
}

interface SyntexAccountProperties {
  friendlyName?: string;
  service?: string;
  identityType?: string;
  identityId?: string;
  feature?: string;
  scope?: string;
  provisioningState?: string;
}

export interface SyntexAccount {
  id: string;
  name?: string;
  location?: string;
  properties?: SyntexAccountProperties;
}

interface SyntexAccountRequestBody {
  location: string;
  properties: {
    friendlyName: string;
    service: "SPO";
    identityType: "ContainerType";
    identityId: string;
    feature: "RaaS";
    scope: "Global";
  };
}

/** Run `az rest ... --output json` and parse the response body. */
async function azRestJson<T>(args: string[]): Promise<T> {
  try {
    const { stdout } = await execFileAsync("az", ["rest", ...args, "--output", "json"], {
      timeout: AZ_TIMEOUT_MS,
      shell: azNeedsShell(),
    });
    const out = stdout.trim();
    return (out ? JSON.parse(out) : {}) as T;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isNotInstalled(message)) {
      throw new Error(NOT_INSTALLED_MSG);
    }
    if (isConditionalAccessOrClaimsError(message)) {
      throw asConditionalAccessError();
    }
    throw new Error(`Azure CLI command failed (az rest ${args.join(" ")}): ${message}`, { cause: error });
  }
}

/**
 * Default PUT seam: writes the JSON body to an OS temp FILE (avoids shell
 * quoting of inline JSON) and PUTs the ARM account.
 */
async function putSyntexAccountViaAz(
  url: string,
  body: SyntexAccountRequestBody,
): Promise<SyntexAccount> {
  const dir = mkdtempSync(join(tmpdir(), "spe-syntex-"));
  const bodyFile = join(dir, "account.json");
  try {
    writeFileSync(bodyFile, JSON.stringify(body), "utf-8");
    const { stdout } = await execFileAsync(
      "az",
      [
        "rest",
        "--method", "put",
        "--url", url,
        "--headers", "Content-Type=application/json",
        "--body", `@${bodyFile}`,
        "--output", "json",
      ],
      { timeout: AZ_TIMEOUT_MS, shell: azNeedsShell() },
    );
    const out = stdout.trim();
    return (out ? JSON.parse(out) : { id: "" }) as SyntexAccount;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isNotInstalled(message)) {
      throw new Error(NOT_INSTALLED_MSG);
    }
    if (isConditionalAccessOrClaimsError(message)) {
      throw asConditionalAccessError();
    }
    throw new Error(`Azure CLI command failed (az rest put ${url}): ${message}`, { cause: error });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Default GET seam used to poll a single account by its ARM resource id. */
function showSyntexAccount(resourceId: string): Promise<SyntexAccount> {
  return azRestJson<SyntexAccount>([
    "--method", "get", "--url", `${ARM_BASE}${resourceId}?api-version=${SYNTEX_ACCOUNT_API_VERSION}`,
  ]);
}

/** List the Microsoft.Syntex accounts in a resource group (idempotency probe). */
export async function getSyntexAccounts(
  subscriptionId: string,
  resourceGroup: string,
): Promise<SyntexAccount[]> {
  const url =
    `${ARM_BASE}/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}` +
    `/providers/Microsoft.Syntex/accounts?api-version=${SYNTEX_ACCOUNT_API_VERSION}`;
  const result = await azRestJson<{ value?: SyntexAccount[] }>(["--method", "get", "--url", url]);
  return result.value ?? [];
}

/** Delete a Microsoft.Syntex account by its ARM resource id (partial-account cleanup). */
export async function deleteSyntexAccount(resourceId: string): Promise<void> {
  try {
    await execFileAsync(
      "az",
      ["rest", "--method", "delete", "--url", `${ARM_BASE}${resourceId}?api-version=${SYNTEX_ACCOUNT_API_VERSION}`],
      { timeout: AZ_TIMEOUT_MS, shell: azNeedsShell() },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isNotInstalled(message)) {
      throw new Error(NOT_INSTALLED_MSG);
    }
    if (isConditionalAccessOrClaimsError(message)) {
      throw asConditionalAccessError();
    }
    throw new Error(`Azure CLI command failed (az rest delete ${resourceId}): ${message}`, { cause: error });
  }
}

/** Injectable seams so the PUT + bounded poll are unit-testable without shelling out. */
export interface CreateSyntexAccountOptions {
  timeoutMs?: number;
  intervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Override the new account name/UUID (tests inject a deterministic value). */
  newAccountName?: () => string;
  /** Override the PUT (tests capture url + body here). */
  putAccount?: (url: string, body: SyntexAccountRequestBody) => Promise<SyntexAccount>;
  /** Override the polling GET (tests inject a stub). */
  getAccount?: (resourceId: string) => Promise<SyntexAccount>;
  /** Override the partial-account cleanup delete (tests inject a stub). */
  deleteAccount?: (resourceId: string) => Promise<void>;
  /** Known tenant id, interpolated into Conditional Access step-up guidance. */
  tenantId?: string;
  /** Best-effort tenant resolver used for CA guidance (tests inject a stub). */
  resolveTenantId?: () => Promise<string | undefined>;
}

/**
 * Create the `Microsoft.Syntex/accounts` (RaaS) ARM billing account for a
 * container type and assert it reaches `provisioningState === "Succeeded"`,
 * polling if the PUT returns a non-terminal state. Returns the ARM resource id.
 *
 * Transactional for the ARM account only: if provisioning ends Failed/Canceled
 * or times out, the partially-created account is deleted (best-effort) before
 * throwing. It NEVER touches the container type — create-time rollback of the
 * CT is the caller's responsibility.
 */
export async function createSyntexAccount(
  subscriptionId: string,
  resourceGroup: string,
  region: string,
  containerTypeId: string,
  options: CreateSyntexAccountOptions = {},
): Promise<string> {
  const {
    timeoutMs = SYNTEX_ACCOUNT_POLL_TIMEOUT_MS,
    intervalMs = SYNTEX_ACCOUNT_POLL_INTERVAL_MS,
    sleep = defaultSleep,
    now = Date.now,
    newAccountName = () => randomUUID(),
    putAccount = putSyntexAccountViaAz,
    getAccount = showSyntexAccount,
    deleteAccount = deleteSyntexAccount,
    tenantId,
    resolveTenantId = resolveTenantIdBestEffort,
  } = options;

  // Fail fast with an actionable message if the region can't host a Syntex
  // account, instead of surfacing a raw ARM `LocationNotAvailableForResourceType`.
  // NOTE: callers on the provisioning path validate this BEFORE creating the
  // container type (see assertSyntexRegionSupported) so a bad region never
  // orphans a non-deletable standard CT; this is the last-line guard.
  assertSyntexRegionSupported(region);
  const normalizedRegion = normalizeRegion(region);

  try {
    const accountName = newAccountName();
    const resourcePath =
      `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}` +
      `/providers/Microsoft.Syntex/accounts/${accountName}`;
    const url = `${ARM_BASE}${resourcePath}?api-version=${SYNTEX_ACCOUNT_API_VERSION}`;
    const body: SyntexAccountRequestBody = {
      location: normalizedRegion,
      properties: {
        friendlyName: `CT_${containerTypeId}`,
        service: "SPO",
        identityType: "ContainerType",
        identityId: containerTypeId,
        feature: "RaaS",
        scope: "Global",
      },
    };


    const created = await putAccount(url, body);
    const resourceId = created.id || resourcePath;

    if (created.properties?.provisioningState === "Succeeded") {
      return resourceId;
    }

    const deadline = now() + timeoutMs;
    let lastState = created.properties?.provisioningState ?? "unknown";
    while (now() < deadline) {
      await sleep(intervalMs);
      const latest = await getAccount(resourceId);
      lastState = latest.properties?.provisioningState ?? lastState;
      if (lastState === "Succeeded") {
        return resourceId;
      }
      if (lastState === "Failed" || lastState === "Canceled") {
        await deleteAccount(resourceId).catch(() => undefined);
        throw new Error(
          `Microsoft.Syntex billing account ${resourceId} provisioning ${lastState}; ` +
            `the partially-created account was cleaned up.`,
        );
      }
    }

    await deleteAccount(resourceId).catch(() => undefined);
    throw new Error(
      `Microsoft.Syntex billing account ${resourceId} did not reach 'Succeeded' within ` +
        `${Math.round(timeoutMs / 1000)}s (last state: ${lastState}); the partial account was cleaned up.`,
    );
  } catch (error) {
    // A Conditional Access step-up on the ARM PUT/GET surfaces as the enriched
    // actionable error (with the resolved tenant id); all other errors (Failed/
    // Canceled/timeout) pass through unchanged. Full claims-challenge automation
    // is intentionally out of scope.
    throw await enrichConditionalAccess(error, async () => tenantId ?? (await resolveTenantId()));
  }
}
