// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Tool: project_deploy
 *
 * Deploys the scaffolded reference app to Azure with the Azure Developer CLI
 * (`azd up`), then returns the live endpoint. Ports EVAL.md `deploy-to-azure`.
 *
 * Requires the Azure Developer CLI (`azd`) and a signed-in Azure session. The
 * scaffolded project includes `azure.yaml` + `infra/main.bicep`. The C# arch
 * uses the ODSP security-approved azd template (subscription-scoped Bicep that
 * provisions its own resource group), so `azd up --no-prompt` needs the env
 * name, location and subscription supplied non-interactively — we set those (and
 * the SPE container type id) from the recorded provisioning state.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { bootstrapTokenProvider } from "../bootstrap.js";
import { addSpaRedirectUris } from "../graph-client.js";
import { readState } from "../state.js";
import type { McpTool } from "../types.js";

interface DeployArgs {
  projectDir?: string;
  environmentName?: string;
  location?: string;
}

const AZD_TIMEOUT_MS = 15 * 60_000; // azd up can take several minutes

/**
 * `azd` resolves the service resource to publish by querying Azure Resource
 * Graph for the `azd-service-name` tag. ARG is eventually-consistent, so a
 * fast-provisioning resource (notably a Static Web App, which is ready in a
 * second or two) may not be indexed yet when the publish step runs — `azd up`
 * then fails the deploy step even though provisioning succeeded. We detect that
 * specific race and retry the deploy alone (provisioning is already done) until
 * ARG catches up.
 */
const ARG_LAG_PATTERN = /unable to find a resource tagged/i;
const DEPLOY_RETRY_ATTEMPTS = 4;
const DEPLOY_RETRY_DELAY_MS = 15_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve_) => setTimeout(resolve_, ms));
}

function execFileAsync(
  cmd: string,
  args: string[],
  opts: { timeout: number; cwd: string; shell?: boolean; env?: NodeJS.ProcessEnv },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve_, reject) => {
    execFile(cmd, args, opts, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stdout, stderr }));
      else resolve_({ stdout, stderr });
    });
  });
}

/** Extract the deployed app endpoint azd prints. */
function extractEndpoint(output: string): string | null {
  // Prefer azd's explicit "Endpoint:" line — that is the deployed app URL.
  const labeled = output.match(/Endpoint:\s*(https:\/\/[^\s)"']+)/i);
  if (labeled) return labeled[1];
  // Otherwise the first https URL that is not the Azure Portal deep-link azd
  // prints for deployment progress.
  const all = output.match(/https:\/\/[^\s)"']+/g) ?? [];
  return all.find((u) => !/portal\.azure\.com/i.test(u)) ?? all[0] ?? null;
}

/** The scheme+host origin of a URL (no path/trailing slash), or null if unparseable. */
function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * Best-effort: register the freshly deployed origin as a SPA redirect URI on the
 * owning Entra app so the generated browser app can sign in (MSAL.js auth-code +
 * PKCE) without AADSTS9002326. Read-modify-write and idempotent — existing URIs
 * (including the local http://localhost:5173 dev origin) are preserved. Returns a
 * markdown note describing the outcome to append to the deploy report.
 *
 * Only acts when the owning app's object id is recorded in state (i.e. the app
 * was created by project_app_create). For the C# arch — which provisions its own
 * Entra app in Bicep with a `web` redirect — there is no owning-app SPA to patch,
 * so this is skipped and the caller's manual-add hint still applies.
 */
async function addDeployedOriginToOwningApp(endpoint: string | null): Promise<string> {
  if (!endpoint) return "";
  const origin = originOf(endpoint);
  if (!origin) return "";

  const state = readState();
  if (!state.appObjectId) {
    // No owning app recorded — fall back to a precise manual instruction.
    return (
      `\n\n> **Sign-in:** add \`${origin}\` as a **SPA** redirect URI on your owning ` +
      `Entra app (Authentication → Single-page application) so browser sign-in works.`
    );
  }

  const result = await addSpaRedirectUris(
    state.appObjectId,
    [origin],
    bootstrapTokenProvider,
    { bestEffort: true },
  );

  if (result && result.added.length > 0) {
    return `\n\nAdded \`${origin}\` to the owning app's **SPA** redirect URIs — browser sign-in is ready.`;
  }
  if (result) {
    return `\n\n\`${origin}\` is already a **SPA** redirect URI on the owning app — browser sign-in is ready.`;
  }
  // best-effort PATCH failed — tell the user exactly what to add manually.
  return (
    `\n\n> **Sign-in:** could not auto-update the owning app${state.appId ? ` (\`${state.appId}\`)` : ""}. ` +
    `Add \`${origin}\` as a **SPA** redirect URI (Authentication → Single-page application), then retry sign-in.`
  );
}

/**
 * Run `azd up`; if its publish step loses the Resource Graph indexing race
 * (provisioning succeeded but the service resource is not tagged-and-indexed
 * yet), retry `azd deploy` alone — provisioning is already done — until ARG
 * catches up or the attempts are exhausted. Any other failure is rethrown
 * immediately so the caller surfaces the real error.
 */
async function deployWithArgLagRetry(
  environmentName: string,
  dir: string,
  env: NodeJS.ProcessEnv,
): Promise<{ stdout: string; stderr: string }> {
  const opts = { timeout: AZD_TIMEOUT_MS, cwd: dir, shell: process.platform === "win32", env };
  const argLag = (err: { stdout?: string; stderr?: string }) =>
    ARG_LAG_PATTERN.test([err.stdout, err.stderr].filter(Boolean).join("\n"));
  try {
    return await execFileAsync("azd", ["up", "--no-prompt", "--environment", environmentName], opts);
  } catch (error) {
    if (!argLag(error as { stdout?: string; stderr?: string })) throw error;
    let lastError: unknown = error;
    for (let attempt = 1; attempt <= DEPLOY_RETRY_ATTEMPTS; attempt++) {
      await sleep(DEPLOY_RETRY_DELAY_MS);
      try {
        return await execFileAsync("azd", ["deploy", "--no-prompt", "--environment", environmentName], opts);
      } catch (retryError) {
        lastError = retryError;
        // A different failure means retrying will not help — surface it now.
        if (!argLag(retryError as { stdout?: string; stderr?: string })) throw retryError;
      }
    }
    throw lastError;
  }
}

export const deployAzureTool: McpTool = {
  name: "project_deploy",
  description:
    "Deploy the scaffolded SharePoint Embedded app to Azure using the Azure Developer CLI " +
    "(`azd up`) and return the live URL. Requires `azd` installed and an Azure login. Provisions " +
    "the security-approved infrastructure in the project's infra/ Bicep (managed identity, ACR, " +
    "Container Apps) and deploys the app.",
  inputSchema: {
    type: "object" as const,
    properties: {
      projectDir: { type: "string", description: "The scaffolded project directory. Default: current directory." },
      environmentName: { type: "string", description: "azd environment name. Default: 'spe-dev'." },
      location: {
        type: "string",
        description:
          "Azure region for the deployment (e.g., 'eastus'). Required by the subscription-scoped " +
          "template for non-interactive `azd up`; falls back to the AZURE_LOCATION environment variable.",
      },
    },
  },
  handler: async (args) => {
    const { projectDir = process.cwd(), environmentName = "spe-dev", location } = args as DeployArgs;
    const dir = resolve(projectDir);

    if (!existsSync(join(dir, "azure.yaml"))) {
      return {
        content: [{ type: "text" as const, text: `Error: no \`azure.yaml\` in \`${dir}\`. Scaffold a reference architecture first.` }],
        isError: true,
      };
    }

    // The approved template is subscription-scoped and declarative: it reads the
    // environment name, location, subscription and SPE container type id from azd
    // environment variables. Supply them from state so `--no-prompt` succeeds.
    const state = readState();
    const childEnv: NodeJS.ProcessEnv = { ...process.env, AZURE_ENV_NAME: environmentName };
    if (location) childEnv.AZURE_LOCATION = location;
    if (state.containerTypeId) childEnv.SPE_CONTAINER_TYPE_ID = state.containerTypeId;

    if (!childEnv.AZURE_LOCATION) {
      return {
        content: [{
          type: "text" as const,
          text:
            "Error: no Azure region specified. The security-approved template provisions its own " +
            "resource group, so `azd up --no-prompt` needs a location. Pass `location` (e.g., 'eastus') " +
            "or set the AZURE_LOCATION environment variable, then retry.",
        }],
        isError: true,
      };
    }

    // Subscription: prefer recorded provisioning state; otherwise fall back to the
    // Azure CLI's active subscription. The trial flow records no subscription, so
    // without this `azd up --no-prompt` would have none and fail. (After the
    // region check so the no-region path makes no exec calls.)
    let subscriptionId = state.azureSubscriptionId;
    if (!subscriptionId) {
      try {
        const { stdout } = await execFileAsync("az", ["account", "show", "--query", "id", "--output", "tsv"], {
          timeout: 30_000,
          cwd: dir,
          shell: process.platform === "win32",
          env: childEnv,
        });
        subscriptionId = stdout.trim() || undefined;
      } catch {
        /* leave undefined — azd may still resolve it from its own environment */
      }
    }
    if (subscriptionId) childEnv.AZURE_SUBSCRIPTION_ID = subscriptionId;

    try {
      const { stdout, stderr } = await deployWithArgLagRetry(environmentName, dir, childEnv);
      const endpoint = extractEndpoint(`${stdout}\n${stderr}`);

      // Auto-register the deployed origin as a SPA redirect URI on the owning app
      // (idempotent, best-effort) so the generated browser app can sign in.
      const spaNote = await addDeployedOriginToOwningApp(endpoint);

      const output =
        "## Deployed to Azure 🌐\n\n" +
        (endpoint ? `Your app is live:\n\n→ ${endpoint}\n\n` : "Deployment completed.\n\n") +
        "Provisioned and deployed via `azd up` using the project's subscription-scoped " +
        "infrastructure (which creates its own resource group)." +
        spaNote;
      return { content: [{ type: "text" as const, text: output }] };
    } catch (error) {
      const e = error as Error & { stdout?: string; stderr?: string; code?: string; message: string };
      // azd writes its version warning to stderr and the ACTIONABLE error to
      // stdout, so reading stderr-first masked the real failure. Combine both and
      // surface the TAIL (azd prints the actual error at the end of its output).
      const combined = [e.stdout, e.stderr].filter(Boolean).join("\n").trim() || (e.message ?? "");
      const detail = combined.length > 1500 ? "…" + combined.slice(-1500) : combined;
      // Only a genuine spawn failure means azd is missing — many real azd errors
      // legitimately contain "not found" (e.g. ARG resource lookups), so do not
      // match on that phrase alone.
      if (e.code === "ENOENT" || /not recognized as an internal or external command/i.test(detail)) {
        return {
          content: [{ type: "text" as const, text: "Error: the Azure Developer CLI (`azd`) is not installed. Install it from https://aka.ms/azd-install, then retry." }],
          isError: true,
        };
      }
      return { content: [{ type: "text" as const, text: `Error deploying to Azure:\n\n${detail}` }], isError: true };
    }
  },
};
