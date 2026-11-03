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

  /**
   * Consistency guard: the checked-in notices file must match the *locked*
   * production tree, not a historical one. `npm run notices` emits one numbered
   * entry per package as `N. <name> <version> (<license>)`; this compares the
   * version in that entry against the version `package-lock.json` resolves for
   * the same direct dependency. It is offline and deterministic (it never runs
   * the generator), so a stale THIRD-PARTY-NOTICES fails CI instead of shipping.
   */
  it("records the locked version of every direct production dependency", () => {
    const notices = readFileSync(noticesPath, "utf8");
    const lock = readJson("package-lock.json");
    const packages = (lock.packages ?? {}) as Record<string, { version?: string }>;

    const mismatches: string[] = [];
    for (const dep of Object.keys(pkg.dependencies ?? {})) {
      const locked = packages[`node_modules/${dep}`]?.version;
      expect(locked, `no lockfile entry for ${dep}`).toBeTruthy();

      const escaped = dep.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
      const entry = new RegExp(`^\\d+\\. ${escaped} (\\S+) \\(`, "m").exec(notices);
      if (!entry) {
        mismatches.push(`${dep}: no numbered notices entry`);
        continue;
      }
      if (entry[1] !== locked) {
        mismatches.push(`${dep}: notices ${entry[1]} != lockfile ${locked}`);
      }
    }

    expect(
      mismatches,
      `THIRD-PARTY-NOTICES is stale; run \`npm run notices\`: ${mismatches.join("; ")}`,
    ).toHaveLength(0);
  });
});

/**
 * B3 (OSS review): the published tarball must carry the disclosure documents the
 * README links to. README ships in the package and links to PRIVACY.md,
 * docs/DATA-FLOW.md, docs/SECURITY-CONTROLS.md and friends with *relative*
 * links, so omitting them from `files` leaves an installed copy with dead links
 * and no on-disk privacy/security disclosure.
 */
describe("packaging: disclosure documents are published", () => {
  const DISCLOSURE_DOCS = [
    "CHANGELOG.md",
    "CONTRIBUTING.md",
    "NOTICE.md",
    "PRIVACY.md",
    "README.md",
    "SECURITY.md",
    "SUPPORT.md",
    "docs/DATA-FLOW.md",
    "docs/SECURITY-CONTROLS.md",
    "docs/TROUBLESHOOTING.md",
  ];

  it("lists every disclosure document in the published files allow-list", () => {
    const files = (pkg.files ?? []) as string[];
    for (const doc of DISCLOSURE_DOCS) {
      expect(files, `${doc} must be published`).toContain(doc);
    }
  });

  it("has every listed disclosure document on disk", () => {
    for (const doc of DISCLOSURE_DOCS) {
      expect(existsSync(join(pkgRoot, doc)), `${doc} is missing from the repo`).toBe(true);
    }
  });

  it("ships no .npmignore that could override the files allow-list", () => {
    // `.npmignore` takes precedence over `files` for directory contents; its
    // absence is what makes the allow-list above authoritative.
    expect(existsSync(join(pkgRoot, ".npmignore"))).toBe(false);
  });

  /**
   * The README ships in the tarball and links to CONTRIBUTING.md with a *relative*
   * link, so the doc has to be published for that link to resolve in an installed
   * copy. This test pins the link target and the allow-list entry together so a
   * rename of either side fails loudly instead of silently breaking the link.
   */
  it("publishes every root document the README links to relatively", () => {
    const readme = readFileSync(join(pkgRoot, "README.md"), "utf8");
    const files = (pkg.files ?? []) as string[];

    const linked = new Set<string>();
    for (const match of readme.matchAll(/\]\(\.?\/?([A-Z][A-Z0-9._-]*\.md)\)/g)) {
      linked.add(match[1]!);
    }

    expect(linked, "README should link to CONTRIBUTING.md").toContain("CONTRIBUTING.md");
    for (const doc of linked) {
      expect(files, `README links to ${doc}; it must be published`).toContain(doc);
      expect(existsSync(join(pkgRoot, doc)), `${doc} is missing from the repo`).toBe(true);
    }
  });

  /**
   * CELA B2: NOTICE.md is the canonical legal notice file and must both ship in
   * the tarball and carry the third-party-services disclosure for the default-on
   * update check. README and PRIVACY.md deep-link to that anchor, so silently
   * dropping the section would leave dangling links in an installed copy.
   */
  it("packs NOTICE.md with the third-party services disclosure", () => {
    expect((pkg.files ?? []) as string[]).toContain("NOTICE.md");

    const notice = readFileSync(join(pkgRoot, "NOTICE.md"), "utf8");
    // The anchor README.md and PRIVACY.md link to.
    expect(notice).toMatch(/^##\s+Third-party services contacted\s*$/m);
    // Endpoint and operator.
    expect(notice).toContain("registry.npmjs.org");
    expect(notice).toMatch(/npm, Inc/i);
    // Boundary language required by CELA/Privacy review.
    expect(notice).toMatch(/not\s+(a\s+)?Microsoft 365 or Azure Online Service/i);
    expect(notice).toMatch(/EU Data Boundary/i);
    expect(notice).toMatch(/Product Terms/i);
    // No identifiers, no auto-update, and an opt-out must all be stated.
    expect(notice).toMatch(/unauthenticated and carries no user identifier/i);
    expect(notice).toMatch(/never downloads, installs, executes, or self-updates/i);
    expect(notice).toContain("SPE_MCP_UPDATE_CHECK=false");
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

/**
 * SEC-008 (update awareness) supply-chain guard.
 *
 * The npm update check is deliberately implemented with the platform `fetch`
 * and an in-repo SemVer parser so it adds ZERO runtime dependencies. A package
 * that ships to developers' machines pays for every transitive dependency in
 * audit surface, so the runtime dependency set is pinned here: adding one must
 * be a conscious, reviewed decision that updates this test.
 */
describe("dependency hygiene: runtime dependency budget", () => {
  const EXPECTED_RUNTIME_DEPENDENCIES = [
    "@azure/msal-node",
    "@modelcontextprotocol/sdk",
    "commander",
    "cross-spawn",
    "open",
    "zod",
    "zod-to-json-schema",
  ];

  it("ships exactly the approved runtime dependencies", () => {
    const actual = Object.keys(pkg.dependencies ?? {}).sort();
    expect(actual).toEqual([...EXPECTED_RUNTIME_DEPENDENCIES].sort());
  });

  it("keeps the runtime dependency count at 7", () => {
    expect(Object.keys(pkg.dependencies ?? {})).toHaveLength(7);
  });

  it("adds no update-check or semver dependency", () => {
    // The update check must not reintroduce `semver`, `node-fetch`, `axios`,
    // `update-notifier`, `boxen`, or similar — all are covered in-repo.
    const banned = [
      "semver",
      "node-fetch",
      "axios",
      "got",
      "undici",
      "update-notifier",
      "latest-version",
      "package-json",
      "boxen",
    ];
    const deps = Object.keys(pkg.dependencies ?? {});
    for (const name of banned) {
      expect(deps, `${name} must not be a runtime dependency`).not.toContain(name);
    }
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
