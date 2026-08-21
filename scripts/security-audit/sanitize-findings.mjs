#!/usr/bin/env node
/**
 * Reduces raw scanner output to counts only.
 *
 * Rationale: `npm audit --json` embeds dependency graph detail and advisory
 * URLs, and a Gitleaks report embeds the matched secret material itself.
 * Neither may be retained as a build artifact, echoed to a public log or
 * rendered into a job summary on a public repository. This script converts
 * either into a counts-only summary, and the raw report is discarded by the
 * caller.
 *
 * Neither sanitiser emits an identifier that can be resolved to a specific
 * weakness: no advisory URL, no GHSA or CVE identifier, no package name, no
 * rule identifier and no file path. Counts alone let a maintainer judge blast
 * radius; reproduction happens locally against a private checkout, as
 * documented in `docs/SECURITY-AUDIT.md`.
 *
 * Usage:
 *   node scripts/security-audit/sanitize-findings.mjs \
 *     --kind npm-audit|gitleaks --in <file> --out <file>
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/**
 * @param {string[]} argv
 * @returns {Record<string, string>}
 */
function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      args[key] = 'true';
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

/**
 * Reduces an `npm audit` report to severity counts only.
 *
 * Advisory URLs, GHSA/CVE identifiers, package names and dependency paths are
 * deliberately dropped. A single advisory URL names the vulnerable package and
 * the vulnerable version range, which on a public repository tells an observer
 * exactly which unpatched weakness this repository currently ships. Counts
 * convey blast radius without naming the weakness; maintainers reproduce the
 * detail locally with `npm audit --audit-level=high`.
 *
 * @param {unknown} raw Parsed `npm audit --json` output.
 */
export function sanitizeNpmAudit(raw) {
  const metadata = raw?.metadata?.vulnerabilities ?? {};

  return {
    kind: 'npm-audit',
    counts: {
      critical: Number(metadata.critical ?? 0),
      high: Number(metadata.high ?? 0),
      moderate: Number(metadata.moderate ?? 0),
      low: Number(metadata.low ?? 0),
      info: Number(metadata.info ?? 0),
    },
  };
}

/**
 * Reduces a Gitleaks report to counts only.
 *
 * Nothing that locates a finding survives this function: not the matched
 * secret, not its surrounding context, not the commit author or message, and
 * — deliberately — not the rule identifier or the file path either. A rule
 * identifier plus a file path is enough to tell an observer which file holds
 * which class of credential before the credential can be rotated, so that
 * pairing is withheld rather than published.
 *
 * `ruleCount` and `fileCount` are cardinalities, not identities: they let a
 * reader judge blast radius ("14 findings across 2 rules in 9 files") without
 * disclosing where to look. This summary is consumed only by the fail gate;
 * it is not written to a job summary, not uploaded and not echoed. Triage
 * happens locally against a private checkout.
 *
 * @param {unknown} raw Parsed Gitleaks JSON report.
 */
export function sanitizeGitleaks(raw) {
  const entries = Array.isArray(raw) ? raw : [];
  const rules = new Set();
  const files = new Set();

  for (const entry of entries) {
    rules.add(String(entry?.RuleID ?? entry?.ruleID ?? 'unknown'));
    const file = entry?.File ?? entry?.file;
    if (file) files.add(String(file));
  }

  return {
    kind: 'gitleaks',
    total: entries.length,
    ruleCount: rules.size,
    fileCount: files.size,
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const { kind } = args;
  if (!kind || !args.in || !args.out) {
    process.stderr.write(
      'usage: sanitize-findings.mjs --kind npm-audit|gitleaks --in <file> --out <file>\n',
    );
    process.exit(1);
  }

  let raw;
  try {
    const text = readFileSync(args.in, 'utf8').trim();
    raw = text === '' ? null : JSON.parse(text);
  } catch (error) {
    process.stderr.write(`security-audit: unable to parse ${args.in}: ${error.message}\n`);
    process.exit(1);
  }

  let summary;
  if (kind === 'npm-audit') summary = sanitizeNpmAudit(raw ?? {});
  else if (kind === 'gitleaks') summary = sanitizeGitleaks(raw ?? []);
  else {
    process.stderr.write(`security-audit: unknown kind ${JSON.stringify(kind)}\n`);
    process.exit(1);
  }

  writeFileSync(args.out, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  process.stdout.write(`security-audit: sanitized ${kind} summary written to ${args.out}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
