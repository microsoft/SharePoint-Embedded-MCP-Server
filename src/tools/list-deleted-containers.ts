// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Tool: container_deleted_list
 *
 * List soft-deleted containers in the tenant recycle bin (Microsoft Graph v1.0:
 * GET /storage/fileStorage/deletedContainers), optionally filtered by container
 * type. Soft-deleted containers stay recoverable for 93 days and remain
 * "blockers": a container type registration cannot be deleted while any deleted
 * container still exists. This tool makes the recycle bin visible so those
 * blockers can be found and permanently purged (container_delete →
 * permanent-delete) or restored (container_archive_restore / restore).
 */

import { setAuthConfig } from "../auth.js";
import { listDeletedContainers } from "../graph-client.js";
import { ok, fail } from "../responses.js";
import { clientSafeMessage } from "../errors.js";
import { paginate, pageFooter, parsePageArgs } from "./pagination.js";
import { readState } from "../state.js";
import type { McpTool } from "../types.js";

export const listDeletedContainersTool: McpTool = {
  name: "container_deleted_list",
  annotations: { readOnly: true },
  description:
    "List soft-deleted SharePoint Embedded containers in the tenant recycle bin (recoverable for 93 days). " +
    "Use this when a container type or its registration can't be deleted due to recycle-bin containers, or to " +
    "find a soft-deleted container to restore or permanently purge. Optionally filter by container type. " +
    "Supports pagination via `top` and `skip`.",
  inputSchema: {
    type: "object" as const,
    properties: {
      containerTypeId: {
        type: "string",
        description: "Filter to deleted containers of this container type. Default: the provisioned container type, or all if none.",
      },
      allContainerTypes: {
        type: "boolean",
        description: "List deleted containers across ALL container types (ignore the provisioned default). Default: false.",
      },
      top: { type: "number", description: "Maximum results to return in this page (default 50, max 200)." },
      skip: { type: "number", description: "Number of results to skip (offset)." },
    },
  },
  handler: async (args) => {
    const state = readState();
    if (state.appId && state.tenantId) {
      setAuthConfig({ clientId: state.appId, tenantId: state.tenantId });
    }

    const filterCt =
      args.allContainerTypes === true
        ? undefined
        : (args.containerTypeId as string) || state.containerTypeId;

    let deleted;
    try {
      deleted = await listDeletedContainers(filterCt);
    } catch (e) {
      return fail("UPSTREAM", `listing deleted containers: ${clientSafeMessage(e)}`);
    }

    if (deleted.length === 0) {
      const scope = filterCt ? ` for container type \`${filterCt}\`` : "";
      return ok(
        { items: [], totalCount: 0, hasMore: false, containerTypeId: filterCt },
        `No soft-deleted containers in the recycle bin${scope}.`,
      );
    }

    const pageArgs = parsePageArgs(args);
    const page = paginate(deleted, pageArgs);

    let output = `## Deleted Containers (recycle bin) — ${page.items.length}\n\n`;
    output += `| Container ID | Display Name | Container Type | Deleted |\n`;
    output += `|-------------|-------------|----------------|----------|\n`;
    for (const c of page.items) {
      output += `| \`${c.id}\` | ${c.displayName ?? "—"} | \`${c.containerTypeId ?? "—"}\` | ${c.createdDateTime ?? "—"} |\n`;
    }
    output += pageFooter(page, pageArgs.skip);
    output +=
      "\n\n> Permanently purge a blocker with `container_delete` (action `permanent-delete`, `confirm=true`), " +
      "or recover it with `container_delete` (action `restore`).";

    return ok({ ...page, containerTypeId: filterCt }, output);
  },
};
