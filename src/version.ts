// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Single source of truth for the product version.
 *
 * `package.json`'s `version` field is the ONE place the version is declared.
 * It is read here at runtime and re-exported as {@link PACKAGE_VERSION} so that
 * every other version consumer — `SERVER_VERSION` (index.ts) and `USER_AGENT`
 * (user-agent.ts) — derives from it and cannot drift out of sync.
 *
 * Reading package.json at runtime (rather than importing it) mirrors the
 * mechanism already used by cli.ts and keeps the file outside `rootDir`, so the
 * compiled `dist/` layout is unaffected. At runtime `dist/version.js` resolves
 * `../package.json` to the package root, both from a source checkout and from
 * the published npm package.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageJsonPath = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as { version: string };

/** The product version, sourced from `package.json`. */
export const PACKAGE_VERSION: string = packageJson.version;
