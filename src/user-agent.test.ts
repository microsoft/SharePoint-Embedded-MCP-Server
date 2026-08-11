// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { afterEach, describe, expect, it } from "vitest";
import {
  USER_AGENT,
  __testing,
  appendUserAgent,
  classifyAgentHost,
  configureAzureUserAgentEnvironment,
  getUserAgent,
  resolveAgentHostAttribution,
  resolveInstallAttribution,
  setAgentHostAttribution,
  setInstallAttribution,
} from "./user-agent.js";

describe("install attribution User-Agent", () => {
  afterEach(() => {
    __testing.reset();
  });

  it("keeps the historical product-only value when attribution is absent", () => {
    expect(resolveInstallAttribution({})).toBeUndefined();
    expect(getUserAgent()).toBe(USER_AGENT);
  });

  it("adds bounded source, content, and campaign tokens", () => {
    const attribution = resolveInstallAttribution({
      source: "microsoft-learn",
      content: "sharepoint-embedded-mcp-server",
      campaign: "docs-install-buttons",
    });

    setInstallAttribution(attribution);

    expect(getUserAgent()).toBe(
      `${USER_AGENT} spe-install-source/microsoft-learn ` +
        "spe-install-content/sharepoint-embedded-mcp-server " +
        "spe-install-campaign/docs-install-buttons",
    );
  });

  it.each([
    ["Visual Studio Code", "vscode"],
    ["Visual Studio Code - Insiders", "vscode"],
    ["Code - OSS", "vscode"],
    ["Code - OSS Dev", "vscode"],
    ["Cursor", "cursor"],
    ["claude-code", "claude-code"],
    ["Claude Code", "claude-code"],
    ["Claude", "claude-desktop"],
    ["Claude Desktop", "claude-desktop"],
    ["claude-ai", "claude-desktop"],
    ["local-agent-mode-spe", "claude-desktop"],
    ["OpenAI Codex CLI", "codex"],
    ["GitHub Copilot CLI", "github-copilot-cli"],
    ["copilot-cli", "github-copilot-cli"],
    ["github-copilot-developer", "github-copilot-cli"],
    ["Microsoft Visual Studio", "visual-studio"],
    ["Azure AI Foundry", "azure-ai-foundry"],
    ["mcp", "unknown"],
    ["", "unknown"],
    ["Future MCP Host", "other"],
  ])("classifies MCP clientInfo name %j as %s", (clientName, expected) => {
    expect(classifyAgentHost(clientName)).toBe(expected);
  });

  it("adds only the bounded host classification, not raw clientInfo", () => {
    setAgentHostAttribution(classifyAgentHost("Future MCP Host with user text"));
    expect(getUserAgent()).toBe(`${USER_AGENT} spe-agent-host/other`);
    expect(getUserAgent()).not.toContain("future");
  });

  it("omits agent-host attribution when attribution is disabled", () => {
    expect(resolveAgentHostAttribution("Visual Studio Code", false)).toBeUndefined();
  });

  it("normalizes identifiers and rejects unbounded or unsupported values", () => {
    expect(
      resolveInstallAttribution({
        source: " Microsoft-Learn ",
        content: " QuickStart-VSCode ",
      }),
    ).toEqual({ source: "microsoft-learn", content: "quickstart-vscode" });
    expect(() => resolveInstallAttribution({ source: "reddit" })).toThrow(
      /must be one of/i,
    );
    expect(() =>
      resolveInstallAttribution({ source: "microsoft-learn", content: "contains spaces" }),
    ).toThrow(/1-64 character/i);
    expect(() =>
      resolveInstallAttribution({ source: "microsoft-learn", content: "unpublished-doc" }),
    ).toThrow(/must be one of/i);
    expect(() =>
      resolveInstallAttribution({
        source: "microsoft-learn",
        campaign: "unreviewed-campaign",
      }),
    ).toThrow(/must be one of/i);
    expect(() => resolveInstallAttribution({ content: "mcp-server" })).toThrow(
      /require --install-source/i,
    );
  });

  it("honors the explicit opt-out before validating configured values", () => {
    expect(
      resolveInstallAttribution({
        source: "not-supported",
        content: "contains spaces",
        enabled: false,
      }),
    ).toBeUndefined();
  });

  it("preserves an existing Azure CLI User-Agent while avoiding duplicates", () => {
    expect(appendUserAgent(undefined, USER_AGENT)).toBe(USER_AGENT);
    expect(appendUserAgent("caller/1.0", USER_AGENT)).toBe(`caller/1.0 ${USER_AGENT}`);
    expect(appendUserAgent(`caller/1.0 ${USER_AGENT}`, USER_AGENT)).toBe(
      `caller/1.0 ${USER_AGENT}`,
    );
    expect(
      appendUserAgent(
        `caller/1.0 ${USER_AGENT} spe-install-source/microsoft-learn`,
        `${USER_AGENT} spe-install-source/github-readme`,
      ),
    ).toBe(`caller/1.0 ${USER_AGENT} spe-install-source/github-readme`);
  });

  it("configures both az and azd User-Agent environment variables", () => {
    setInstallAttribution(
      resolveInstallAttribution({
        source: "github-readme",
        content: "readme-install",
        campaign: "docs-install-buttons",
      }),
    );
    setAgentHostAttribution("vscode");
    const env: NodeJS.ProcessEnv = {
      AZURE_HTTP_USER_AGENT: "existing-az/1.0",
      AZURE_DEV_USER_AGENT: "existing-azd/1.0",
    };

    configureAzureUserAgentEnvironment(env);

    expect(env.AZURE_HTTP_USER_AGENT).toMatch(
      /^existing-az\/1\.0 spe-mcp-server\/\S+ spe-install-source\/github-readme.*spe-agent-host\/vscode/,
    );
    expect(env.AZURE_DEV_USER_AGENT).toMatch(
      /^existing-azd\/1\.0 spe-mcp-server\/\S+ spe-install-source\/github-readme.*spe-agent-host\/vscode/,
    );
  });
});
