// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Product and optional install-attribution identifiers stamped on outbound
 * Microsoft Graph and Azure CLI (`az` / `azd`) requests.
 *
 * The install fields are deliberately bounded, non-personal labels supplied by
 * the MCP client configuration. They open no separate telemetry channel and ride
 * only on API calls the tool already makes on the user's behalf. Omitting the
 * install arguments keeps the historical product/version-only User-Agent.
 */
import { ValidationError } from "./errors.js";
import { PACKAGE_VERSION } from "./version.js";

export const USER_AGENT = `spe-mcp-server/${PACKAGE_VERSION}`;

export const INSTALL_SOURCES = [
  "microsoft-learn",
  "github-readme",
  "github-release",
  "mcp-registry",
  "npm",
  "other",
] as const;

export type InstallSource = (typeof INSTALL_SOURCES)[number];

export const INSTALL_CONTENTS = [
  "readme-install",
  "sharepoint-embedded-mcp-server",
  "quickstart-vscode",
  "create-container-type",
  "create-manage-containers",
] as const;

export const INSTALL_CAMPAIGNS = ["docs-install-buttons"] as const;

export const AGENT_HOSTS = [
  "vscode",
  "visual-studio",
  "cursor",
  "claude-code",
  "claude-desktop",
  "codex",
  "github-copilot-cli",
  "azure-ai-foundry",
  "other",
  "unknown",
] as const;

export type AgentHost = (typeof AGENT_HOSTS)[number];

export interface InstallAttribution {
  source: InstallSource;
  content?: (typeof INSTALL_CONTENTS)[number];
  campaign?: (typeof INSTALL_CAMPAIGNS)[number];
}

export interface InstallAttributionInput {
  source?: string;
  content?: string;
  campaign?: string;
  enabled?: boolean;
}

const ATTRIBUTION_ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;
let activeAttribution: InstallAttribution | undefined;
let activeAgentHost: AgentHost | undefined;

function normalizeOptionalId(value: string | undefined, field: string): string | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return undefined;
  if (!ATTRIBUTION_ID_PATTERN.test(normalized)) {
    throw new ValidationError(
      `${field} must be a 1-64 character lowercase identifier using only letters, numbers, '.', '_' or '-'.`,
    );
  }
  return normalized;
}

export function resolveInstallAttribution(
  input: InstallAttributionInput,
): InstallAttribution | undefined {
  if (input.enabled === false) return undefined;

  const source = normalizeOptionalId(input.source, "install source");
  const content = normalizeOptionalId(input.content, "install content");
  const campaign = normalizeOptionalId(input.campaign, "install campaign");

  if (!source) {
    if (content || campaign) {
      throw new ValidationError(
        "--install-content and --install-campaign require --install-source.",
      );
    }
    return undefined;
  }

  if (!INSTALL_SOURCES.includes(source as InstallSource)) {
    throw new ValidationError(
      `install source must be one of: ${INSTALL_SOURCES.join(", ")}.`,
    );
  }
  if (
    content &&
    !INSTALL_CONTENTS.includes(content as (typeof INSTALL_CONTENTS)[number])
  ) {
    throw new ValidationError(
      `install content must be one of: ${INSTALL_CONTENTS.join(", ")}.`,
    );
  }
  if (
    campaign &&
    !INSTALL_CAMPAIGNS.includes(campaign as (typeof INSTALL_CAMPAIGNS)[number])
  ) {
    throw new ValidationError(
      `install campaign must be one of: ${INSTALL_CAMPAIGNS.join(", ")}.`,
    );
  }

  return {
    source: source as InstallSource,
    ...(content
      ? { content: content as (typeof INSTALL_CONTENTS)[number] }
      : {}),
    ...(campaign
      ? { campaign: campaign as (typeof INSTALL_CAMPAIGNS)[number] }
      : {}),
  };
}

export function setInstallAttribution(attribution: InstallAttribution | undefined): void {
  activeAttribution = attribution;
}

/**
 * Classify the self-reported MCP `initialize.params.clientInfo.name` into a
 * bounded analytics dimension. This is advisory attribution only, never a
 * security signal. Unknown raw values are not transmitted.
 */
export function classifyAgentHost(clientName: string | undefined): AgentHost {
  const name = clientName?.trim().toLowerCase() ?? "";
  if (!name || name === "mcp") return "unknown";
  if (
    name.includes("visual studio code") ||
    name.startsWith("code - oss")
  ) {
    return "vscode";
  }
  if (name.includes("cursor")) return "cursor";
  if (name === "claude-code" || name.includes("claude code")) {
    return "claude-code";
  }
  if (
    name === "claude" ||
    name === "claude-ai" ||
    name.includes("claude desktop") ||
    name.startsWith("local-agent-mode-")
  ) {
    return "claude-desktop";
  }
  if (
    name.includes("github copilot cli") ||
    name.includes("copilot-cli") ||
    name === "github-copilot-developer"
  ) {
    return "github-copilot-cli";
  }
  if (name.includes("codex")) return "codex";
  if (name.includes("visual studio")) return "visual-studio";
  if (name.includes("foundry")) return "azure-ai-foundry";
  return "other";
}

export function resolveAgentHostAttribution(
  clientName: string | undefined,
  enabled: boolean,
): AgentHost | undefined {
  return enabled ? classifyAgentHost(clientName) : undefined;
}

export function setAgentHostAttribution(agentHost: AgentHost | undefined): void {
  activeAgentHost = agentHost;
}

export function getUserAgent(): string {
  const tokens: string[] = [];
  if (activeAttribution) {
    tokens.push(`spe-install-source/${activeAttribution.source}`);
    if (activeAttribution.content) {
      tokens.push(`spe-install-content/${activeAttribution.content}`);
    }
    if (activeAttribution.campaign) {
      tokens.push(`spe-install-campaign/${activeAttribution.campaign}`);
    }
  }
  if (activeAgentHost) {
    tokens.push(`spe-agent-host/${activeAgentHost}`);
  }
  return tokens.length > 0 ? `${USER_AGENT} ${tokens.join(" ")}` : USER_AGENT;
}

export function appendUserAgent(existing: string | undefined, value: string): string {
  const currentTokens = existing?.trim().split(/\s+/).filter(Boolean) ?? [];
  const preserved = currentTokens.filter(
    (token) =>
      !token.startsWith("spe-mcp-server/") &&
      !token.startsWith("spe-install-source/") &&
      !token.startsWith("spe-install-content/") &&
      !token.startsWith("spe-install-campaign/") &&
      !token.startsWith("spe-agent-host/"),
  );
  return [...preserved, value].join(" ");
}

export function configureAzureUserAgentEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): void {
  const userAgent = getUserAgent();
  env.AZURE_HTTP_USER_AGENT = appendUserAgent(
    env.AZURE_HTTP_USER_AGENT,
    userAgent,
  );
  env.AZURE_DEV_USER_AGENT = appendUserAgent(
    env.AZURE_DEV_USER_AGENT,
    userAgent,
  );
}

export const __testing = {
  reset(): void {
    activeAttribution = undefined;
    activeAgentHost = undefined;
  },
};
