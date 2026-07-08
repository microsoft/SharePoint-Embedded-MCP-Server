// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Provisioning state persistence.
 *
 * The SPE Builder flow spans multiple tool calls (create app → CT → register →
 * container). We persist the resulting IDs to `~/.spe-mcp/state.json` so the
 * flow is resumable/idempotent and `status_get` can report what exists. This is
 * the MCP analogue of the full-setup skill's `.env.spe`.
 *
 * Cross-platform: there are no shell-command invocations here; every path is
 * built with `node:path.join` + `os.homedir()`, so it resolves correctly on
 * Windows (`%USERPROFILE%\.spe-mcp`) and POSIX (`~/.spe-mcp`) alike.
 */

import { existsSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ensureSecureDir, writeSecureFile } from "./secure-fs.js";

const STATE_DIR = join(homedir(), ".spe-mcp");
const STATE_FILE = join(STATE_DIR, "state.json");

export interface ProvisioningState {
  tenantId?: string;
  /** Owning Entra app client (application) ID. */
  appId?: string;
  /** Owning Entra app object ID. */
  appObjectId?: string;
  appDisplayName?: string;
  containerTypeId?: string;
  containerTypeName?: string;
  billingClassification?: string;
  azureSubscriptionId?: string;
  resourceGroup?: string;
  /** ARM resource id of the Microsoft.Syntex/accounts (RaaS) billing account. */
  syntexAccountResourceId?: string;
  containerId?: string;
  containerName?: string;
  /** Whether content-plane (file read/manage) access has been granted. */
  contentAccessGranted?: boolean;
  /** Reference architecture id last scaffolded (e.g., 'react-spa-functions', 'csharp-web'). */
  scaffoldArchitecture?: string;
  /** Project name used by the last scaffold (drives azure.yaml service name on hydrate). */
  projectName?: string;
}

export function readState(): ProvisioningState {
  try {
    if (existsSync(STATE_FILE)) {
      return JSON.parse(readFileSync(STATE_FILE, "utf-8")) as ProvisioningState;
    }
  } catch {
    /* ignore corrupt state — treat as empty */
  }
  return {};
}

export function writeState(patch: Partial<ProvisioningState>): ProvisioningState {
  const next = { ...readState(), ...patch };
  ensureSecureDir(STATE_DIR);
  // SEC-003: state can hold tenant/app/subscription IDs — owner-only (0o600).
  writeSecureFile(STATE_FILE, JSON.stringify(next, null, 2));
  return next;
}

/** Delete the persisted provisioning state (used by cleanup). */
export function clearState(): void {
  try {
    if (existsSync(STATE_FILE)) {
      rmSync(STATE_FILE);
    }
  } catch {
    /* ignore */
  }
}
