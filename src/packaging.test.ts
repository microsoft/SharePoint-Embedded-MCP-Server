// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Packaging / OSS-compliance regression tests.
 *
 * Each assertion below encodes an OSS pre-publish acceptance criterion:
 *   - MIT LICENSE present and shipped
 *   - publish intent decided (publishConfig.access)
 *   - THIRD-PARTY-NOTICES generated and shipped
 *   - complete package metadata (repository/bugs/homepage/author/keywords)
 *   - no deprecated uuid@8 in the resolved tree (overrides pin >= 11)
 *
 * These are intentionally filesystem/manifest assertions (not unit logic) so a
 * regression that drops the LICENSE, weakens metadata, or reintroduces uuid@8
 * fails CI.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function readJson(rel: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(pkgRoot, rel), "utf8"));
}

const pkg = readJson("package.json");

describe("packaging: MIT LICENSE", () => {
  it("declares the MIT license", () => {
    expect(pkg.license).toBe("MIT");
  });

  it("ships a LICENSE file with Microsoft copyright", () => {
    const licensePath = join(pkgRoot, "LICENSE");
    expect(existsSync(licensePath)).toBe(true);
    const text = readFileSync(licensePath, "utf8");
    expect(text).toContain("MIT License");
    expect(text).toContain("Microsoft Corporation");
  });

  it("includes LICENSE in the published files allow-list", () => {
    expect(pkg.files).toContain("LICENSE");
  });
});

describe("packaging: publish intent decided", () => {
  it("declares an explicit public publish access", () => {
    expect(pkg.publishConfig).toBeDefined();
    expect(pkg.publishConfig.access).toBe("public");
  });
});

describe("packaging: THIRD-PARTY-NOTICES", () => {
  const noticesPath = join(pkgRoot, "THIRD-PARTY-NOTICES");

  it("exists and is non-trivial", () => {
    expect(existsSync(noticesPath)).toBe(true);
    expect(readFileSync(noticesPath, "utf8").length).toBeGreaterThan(200);
  });

  it("is included in the published files allow-list", () => {
    expect(pkg.files).toContain("THIRD-PARTY-NOTICES");
  });

  it("attributes every direct production dependency", () => {
    const notices = readFileSync(noticesPath, "utf8");
    for (const dep of Object.keys(pkg.dependencies ?? {})) {
      expect(notices, `missing attribution for ${dep}`).toContain(dep);
    }
  });
});

describe("packaging: complete metadata", () => {
  it("has repository with url", () => {
    expect(pkg.repository).toBeDefined();
    expect(typeof pkg.repository.url).toBe("string");
    expect(pkg.repository.url.length).toBeGreaterThan(0);
  });

  it("has bugs, homepage and author", () => {
    expect(pkg.bugs?.url ?? pkg.bugs).toBeTruthy();
    expect(pkg.homepage).toBeTruthy();
    expect(pkg.author).toBeTruthy();
  });

  it("has meaningful keywords", () => {
    expect(Array.isArray(pkg.keywords)).toBe(true);
    expect(pkg.keywords.length).toBeGreaterThanOrEqual(3);
  });
});

describe("dependency hygiene: no deprecated uuid@8", () => {
  const major = (v: string): number => {
    const m = String(v).match(/\d+/);
    return m ? parseInt(m[0], 10) : NaN;
  };

  it("pins a supported uuid (>= 11) via overrides under @azure/msal-node", () => {
    const override = pkg.overrides?.["@azure/msal-node"]?.uuid ?? pkg.overrides?.uuid;
    expect(override, "expected an overrides pin for uuid").toBeTruthy();
    expect(major(override)).toBeGreaterThanOrEqual(11);
  });

  it("resolves no uuid@8.x anywhere in the lockfile", () => {
    const lock = readJson("package-lock.json");
    const offenders: string[] = [];
    for (const [path, meta] of Object.entries<{ version?: string }>(lock.packages ?? {})) {
      if (/(^|\/)node_modules\/uuid$/.test(path) && meta?.version) {
        if (major(meta.version) < 11) offenders.push(`${path}@${meta.version}`);
      }
    }
    expect(offenders, `deprecated uuid found: ${offenders.join(", ")}`).toHaveLength(0);
  });
});
