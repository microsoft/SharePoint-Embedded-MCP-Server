// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Bootstrap (control-plane) authentication via the Azure CLI.
 *
 * This is the FIRST token in the SPE Builder two-token model. The developer is
 * already signed into `az`, whose first-party CLI app carries
 * `Application.ReadWrite.All` + Graph basics. We use that token to bootstrap —
 * create the owning Entra app, read `/me`, etc. — WITHOUT requiring any
 * Microsoft-owned first-party app or pre-authorization.
 *
 * The SECOND token (SPE-scoped, acquired via MSAL device-code AS the
 * newly-created owning app) lives in auth.ts and is wired in Phase 1.
 *
 * Cross-platform: shells out to `az`, which is available on Windows/macOS/Linux.
 */

import { execFile } from "node:child_process";
import {
  isConditionalAccessOrClaimsError,
  asConditionalAccessError,
} from "./az-errors.js";

const GRAPH_RESOURCE = "https://graph.microsoft.com";
const AZ_TIMEOUT_MS = 20_000;

function log(message: string, data?: unknown): void {
  const timestamp = new Date().toISOString();
  if (data !== undefined) {
    console.error(`[${timestamp}] [Bootstrap] ${message}`, typeof data === "string" ? data : JSON.stringify(data));
  } else {
    console.error(`[${timestamp}] [Bootstrap] ${message}`);
  }
}

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

/** True on Windows, where `az` is a `.cmd` shim that needs a shell to resolve. */
function azNeedsShell(): boolean {
  return process.platform === "win32";
}

function isNotInstalledError(message: string): boolean {
  return (
    message.includes("ENOENT") ||
    message.includes("not found") ||
    message.includes("not recognized") ||
    message.includes("is not recognized")
  );
}

function isNotLoggedInError(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes("az login") ||
    m.includes("please run") ||
    m.includes("no subscription") ||
    m.includes("not logged in") ||
    m.includes("aadsts")
  );
}

const NOT_INSTALLED_MSG =
  "Azure CLI ('az') is not installed. Install it from https://aka.ms/install-azure-cli, then run `az login --allow-no-subscriptions`.";
const NOT_LOGGED_IN_MSG =
  "Azure CLI is not signed in. Run `az login --allow-no-subscriptions` (the `--allow-no-subscriptions` flag is required for M365-only tenants with no Azure subscription).";

export interface SignedInIdentity {
  tenantId: string;
  username: string;
}

export interface BootstrapToken {
  accessToken: string;
  expiresOn: Date | null;
  tenantId: string;
}

/**
 * Verify the Azure CLI is installed. Throws a friendly, actionable error if not.
 */
export async function assertAzCli(): Promise<void> {
  try {
    await execFileAsync("az", ["version", "--output", "json"], {
      timeout: AZ_TIMEOUT_MS,
      shell: azNeedsShell(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isNotInstalledError(message)) {
      throw new Error(NOT_INSTALLED_MSG);
    }
    throw new Error(`Failed to invoke Azure CLI: ${message}`, { cause: error });
  }
}

/**
 * Get the currently signed-in `az` identity (tenant + user), or `null` if the
 * CLI is installed but not signed in.
 */
export async function getSignedInIdentity(): Promise<SignedInIdentity | null> {
  try {
    // NOTE: do NOT use `--query` here. On Windows `az` is a `.cmd` shim that
    // requires shell:true, and a `--query` value containing spaces/braces gets
    // word-split by the shell. Fetch the full JSON and parse it in JS instead.
    const { stdout } = await execFileAsync("az", ["account", "show", "--output", "json"], {
      timeout: AZ_TIMEOUT_MS,
      shell: azNeedsShell(),
    });
    const parsed = JSON.parse(stdout) as {
      tenantId?: string;
      user?: { name?: string };
    };
    if (!parsed.tenantId) return null;
    return { tenantId: parsed.tenantId, username: parsed.user?.name ?? "unknown" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isNotInstalledError(message)) {
      throw new Error(NOT_INSTALLED_MSG);
    }
    // `az account show` exits non-zero when not logged in — treat as "no identity".
    log("No signed-in az identity found");
    return null;
  }
}

/**
 * Best-effort tenant id from the current `az` sign-in, or `undefined`. Used to
 * interpolate the exact re-auth command into Conditional Access guidance; never
 * throws (a missing tenant just yields a placeholder in the remediation text).
 */
async function resolveTenantIdBestEffort(): Promise<string | undefined> {
  try {
    const identity = await getSignedInIdentity();
    return identity?.tenantId;
  } catch {
    return undefined;
  }
}

/**
 * Acquire a bootstrap access token for the given resource (default: Microsoft
 * Graph) from the Azure CLI. Throws friendly errors for not-installed /
 * not-signed-in.
 */
export async function getBootstrapToken(resource: string = GRAPH_RESOURCE): Promise<BootstrapToken> {
  log(`Acquiring bootstrap token for ${resource}`);
  try {
    const { stdout } = await execFileAsync(
      "az",
      ["account", "get-access-token", "--resource", resource, "--output", "json"],
      { timeout: AZ_TIMEOUT_MS, shell: azNeedsShell() },
    );
    const parsed = JSON.parse(stdout) as {
      accessToken?: string;
      expiresOn?: string;
      tenant?: string;
      tenantId?: string;
    };
    if (!parsed.accessToken) {
      throw new Error("Azure CLI returned no access token");
    }
    return {
      accessToken: parsed.accessToken,
      expiresOn: parsed.expiresOn ? new Date(parsed.expiresOn) : null,
      tenantId: parsed.tenantId ?? parsed.tenant ?? "",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isNotInstalledError(message)) {
      throw new Error(NOT_INSTALLED_MSG);
    }
    // Classify Conditional Access / claims step-up FIRST: it is a more specific
    // condition than plain "not logged in" (which would otherwise also match the
    // AADSTS signal). We resolve the tenant best-effort via `az account show`
    // (which does not require a step-up) to interpolate the exact remediation
    // command. Full claims-challenge automation is intentionally out of scope.
    if (isConditionalAccessOrClaimsError(message)) {
      const tenantId = await resolveTenantIdBestEffort();
      throw asConditionalAccessError(tenantId);
    }
    if (isNotLoggedInError(message)) {
      throw new Error(NOT_LOGGED_IN_MSG);
    }
    throw new Error(`Azure CLI bootstrap token acquisition failed: ${message}`, { cause: error });
  }
}

/**
 * Token-provider form of {@link getBootstrapToken} for passing to graph-client
 * functions that accept a `getToken` callback (e.g. owning-app creation).
 */
export async function bootstrapTokenProvider(): Promise<string> {
  const { accessToken } = await getBootstrapToken();
  return accessToken;
}
