// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Static product identifier stamped on outbound Microsoft Graph and Azure CLI
 * (`az` / `azd`) requests for aggregate traffic attribution.
 *
 * This is a constant product/version token. It carries NO per-user, per-tenant,
 * or personal data, opens NO separate telemetry channel, and rides only on the
 * Graph/ARM calls the tool already makes on the user's behalf (e.g. creating a
 * container type). The SharePoint Embedded service can filter request logs on
 * this token to measure how much traffic this tool drives.
 *
 * The version segment is derived from package.json (the single source of truth)
 * via {@link PACKAGE_VERSION}, so it can never drift out of sync on release.
 */
import { PACKAGE_VERSION } from "./version.js";

export const USER_AGENT = `spe-mcp-server/${PACKAGE_VERSION}`;
