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
 * Cross-platform: there are no shell-command invocations here; the data
 * directory and state-file paths come from the resolve-once seam in `paths.ts`
 * (built with `node:path` + `os.homedir()`), so they resolve correctly on
 * Windows (`%USERPROFILE%\.spe-mcp`) and POSIX (`~/.spe-mcp`) alike, and honor a
 * `--data-dir` / `SPE_DATA_DIR` override.
 */

import { existsSync, rmSync } from "node:fs";
import { getDataDir, getStateFile } from "./paths.js";
import { ensureSecureDir, readSecureFile, writeSecureFile } from "./secure-fs.js";
import type { BillingClassification, OwnerScope } from "./types.js";

export interface ProvisioningState {
  tenantId?: string;
  /** Owning Entra app client (application) ID. */
  appId?: string;
  /** Owning Entra app object ID. */
  appObjectId?: string;
  appDisplayName?: string;
  containerTypeId?: string;
  containerTypeName?: string;
  billingClassification?: BillingClassification;
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
  // ── Session confirmation (GitHub PR #3 review, r-appgate) ──────────────────
  /**
   * SESSION_ID (see session.ts) under which the user last confirmed the active
   * owning app + container type. Because each restart is a new process with a
   * new SESSION_ID, a value here that does NOT match the current session means
   * the remembered context is unconfirmed and must be re-asked.
   */
  confirmedSessionId?: string;
  /** ISO-8601 timestamp of that confirmation (may be from a prior session). */
  contextConfirmedAt?: string;
  /**
   * Whether the confirmed owning app holds `FileStorageContainerType.Manage.All`
   * (i.e., can enumerate ALL container types). When false/unknown, any cached
   * container-type context may be stale. Left undefined when it cannot be
   * cheaply inferred (undefined = "unknown", which suppresses the staleness
   * warning; only an explicit `false` triggers it).
   */
  owningAppManagesAllContainerTypes?: boolean;
  /**
   * The owning app's captured container-type authority intent (PR #3 review).
   * Drives the least-privilege Graph scope set requested at app-create /
   * provision time. Persisted so a resumed session reuses the same intent
   * without re-eliciting. Defaults to "selected" (least privilege) when unset.
   */
  ownerScope?: OwnerScope;
}

export function readState(): ProvisioningState {
  try {
    // O_NOFOLLOW + owner check (readSecureFile): a symlinked or foreign-owned
    // state.json is refused (throws → treated as empty) rather than followed,
    // consistent with the writeState hardening. Returns null when absent.
    const raw = readSecureFile(getStateFile());
    if (raw !== null) {
      return JSON.parse(raw) as ProvisioningState;
    }
  } catch {
    /* ignore corrupt or insecure state — treat as empty */
  }
  return {};
}

export function writeState(patch: Partial<ProvisioningState>): ProvisioningState {
  const next = { ...readState(), ...patch };
  ensureSecureDir(getDataDir());
  // SEC-003: state can hold tenant/app/subscription IDs — owner-only (0o600).
  writeSecureFile(getStateFile(), JSON.stringify(next, null, 2));
  return next;
}

/** Delete the persisted provisioning state (used by cleanup). */
export function clearState(): void {
  try {
    const stateFile = getStateFile();
    if (existsSync(stateFile)) {
      rmSync(stateFile);
    }
  } catch {
    /* ignore */
  }
}
