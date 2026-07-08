// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Version single-source-of-truth regression tests (WI-04).
 *
 * package.json's `version` field is the ONE place the version is declared;
 * `PACKAGE_VERSION`, `USER_AGENT`, and the server `version` must all DERIVE
 * from it. These assertions encode that acceptance criterion so a future
 * hand-edited literal (the drift that motivated this fix) fails CI.
 *
 * Note the assertions compare against the value read from package.json at
 * runtime — they do NOT re-introduce a hard-coded version literal.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PACKAGE_VERSION } from "./version.js";
import { USER_AGENT } from "./user-agent.js";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkgVersion = (
  JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8")) as { version: string }
).version;

describe("version: single source of truth", () => {
  it("sources PACKAGE_VERSION from package.json", () => {
    expect(PACKAGE_VERSION).toBe(pkgVersion);
  });

  it("derives USER_AGENT from package.json in the spe-mcp-server/<version> format", () => {
    expect(USER_AGENT).toBe(`spe-mcp-server/${pkgVersion}`);
  });
});
