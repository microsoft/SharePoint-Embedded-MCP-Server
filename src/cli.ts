#!/usr/bin/env node
// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.


/**
 * SPE MCP Server CLI.
 *
 * Commands:
 *   spe-mcp start   — Start the MCP server (stdio transport)
 *   spe-mcp auth    — Authenticate interactively (pre-cache tokens; --reset clears first)
 *   spe-mcp logout  — Clear cached tokens
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const packageJson = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf-8"));

const program = new Command();

program
  .name("spe-mcp")
  .description("SharePoint Embedded MCP Server — manage SPE resources via any MCP client")
  .version(packageJson.version);

program
  .command("start")
  .description("Start the SPE MCP server")
  .option(
    "--client-id <id>",
    "Owning Entra app Client ID (OPTIONAL). Omit to run in bootstrap mode (Azure CLI control plane). Can also be set via SPE_CLIENT_ID.",
  )
  .option(
    "--tenant-id <id>",
    "Entra ID Tenant ID (OPTIONAL). Discovered from the Azure CLI when omitted. Can also be set via SPE_TENANT_ID.",
  )
  .action(async (options: { clientId?: string; tenantId?: string }) => {
    try {
      const clientId = options.clientId || process.env.SPE_CLIENT_ID;
      const tenantId = options.tenantId || process.env.SPE_TENANT_ID;

      // Both are optional. With no client-id the server runs in bootstrap mode:
      // the Azure CLI provides the control-plane token and the owning app is
      // provisioned on demand.
      const { startServer } = await import("./index.js");
      await startServer({ clientId, tenantId });
    } catch (error) {
      console.error("Failed to start SPE MCP server:");
      if (error instanceof Error) {
        console.error(error.stack ?? error.message);
      } else {
        console.error(error);
      }
      process.exitCode = 1;
    }
  });

program
  .command("auth")
  .description("Authenticate with Microsoft Graph interactively (pre-cache tokens for headless use)")
  .option("--client-id <id>", "Entra ID Application (Client) ID. Can also be set via SPE_CLIENT_ID env var.")
  .option("--tenant-id <id>", "Entra ID Tenant ID. Can also be set via SPE_TENANT_ID env var.")
  .option("--reset", "Clear any cached tokens for this tenant before authenticating (useful when switching tenants).")
  .action(async (options: { clientId?: string; tenantId?: string; reset?: boolean }) => {
    try {
      const clientId = options.clientId || process.env.SPE_CLIENT_ID;
      const tenantId = options.tenantId || process.env.SPE_TENANT_ID;

      if (!clientId || !tenantId) {
        console.error("Error: --client-id and --tenant-id are required");
        process.exitCode = 1;
        return;
      }

      const { setAuthConfig, setInteractiveMode, authenticateInteractively, clearCachedToken } =
        await import("./auth.js");
      setAuthConfig({ clientId, tenantId });
      setInteractiveMode();
      if (options.reset) {
        await clearCachedToken();
        console.log("Cleared cached tokens before authenticating.");
      }
      await authenticateInteractively();
      console.log("Authenticated successfully. You can now start the MCP server.");
    } catch (error) {
      console.error("Authentication failed:");
      if (error instanceof Error) {
        console.error(error.stack ?? error.message);
      } else {
        console.error(error);
      }
      process.exitCode = 1;
    }
  });

program
  .command("logout")
  .description("Clear cached authentication tokens")
  .action(async () => {
    try {
      const { clearCachedToken } = await import("./auth.js");
      await clearCachedToken();
      console.log("Logged out. Cached tokens have been cleared.");
    } catch (error) {
      console.error("Failed to clear cached tokens:");
      if (error instanceof Error) {
        console.error(error.stack ?? error.message);
      } else {
        console.error(error);
      }
      process.exitCode = 1;
    }
  });

program.parse();
