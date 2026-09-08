#!/usr/bin/env node
/**
 * Fail-closed validator for package manifests and lockfiles consumed by the
 * dependency-audit workflows.
 *
 * The workflows copy only `package.json` and `package-lock.json` from the
 * audited checkout into a runner-owned directory and run `npm audit
 * --package-lock-only` there. This validator executes first and rejects any
 * target-controlled source form that could steer npm away from the explicit
 * public registry or silently expand the audited dependency graph beyond the
 * copied files.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  NPM_AUDIT_ALLOWED_HOSTS,
  NPM_AUDIT_ALLOWED_PROTOCOL,
  NPM_AUDIT_DEPENDENCY_KEYS,
  NPM_AUDIT_FILES,
  NPM_AUDIT_REGISTRY,
  NPM_AUDIT_REWRITE_KEYS,
  NPM_AUDIT_UNSUPPORTED_KEYS,
} from './lib/constants.mjs';

const SOURCE_PROTOCOL_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/u;
const GIT_SSH_RE = /^git@/iu;
const GITHUB_SHORTHAND_RE = /^[^./\s][^\s]*\/[^\s]+(?:#.*)?$/u;
const PATH_SOURCE_RE = /^(?:\.{1,2}(?:[\\/]|$)|[\\/])/u;

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * @param {string} spec
 * @returns {boolean}
 */
function looksLikeUnsupportedSource(spec) {
  const trimmed = spec.trim();
  if (trimmed === '') return true;
  if (trimmed !== spec) return true;
  return (
    PATH_SOURCE_RE.test(trimmed) ||
    trimmed.includes('\\') ||
    GIT_SSH_RE.test(trimmed) ||
    SOURCE_PROTOCOL_RE.test(trimmed) ||
    GITHUB_SHORTHAND_RE.test(trimmed)
  );
}

/**
 * @param {unknown} spec
 * @param {string} context
 */
export function validateDependencySpec(spec, context) {
  if (typeof spec !== 'string') {
    throw new TypeError(`${context}: dependency source must be a string`);
  }
  if (looksLikeUnsupportedSource(spec)) {
    throw new Error(`${context}: unsupported dependency source`);
  }
}

/**
 * @param {unknown} value
 * @param {string} context
 */
function validateDependencyMap(value, context) {
  if (!isPlainObject(value)) {
    throw new TypeError(`${context}: expected a JSON object`);
  }
  for (const [name, spec] of Object.entries(value)) {
    validateDependencySpec(spec, `${context}.${name}`);
  }
}

/**
 * @param {unknown} value
 * @param {string} context
 */
function validateRewriteMap(value, context) {
  if (typeof value === 'string') {
    validateDependencySpec(value, context);
    return;
  }
  if (!isPlainObject(value)) {
    throw new TypeError(`${context}: expected a string or JSON object`);
  }
  for (const [key, nested] of Object.entries(value)) {
    validateRewriteMap(nested, `${context}.${key}`);
  }
}

/**
 * @param {unknown} raw
 * @param {string} file
 */
export function validateManifestObject(raw, file) {
  if (!isPlainObject(raw)) {
    throw new TypeError(`${file}: expected a JSON object`);
  }

  for (const key of NPM_AUDIT_UNSUPPORTED_KEYS) {
    if (Object.hasOwn(raw, key)) {
      throw new Error(`${file}: unsupported ${key} audit input`);
    }
  }

  for (const key of NPM_AUDIT_DEPENDENCY_KEYS) {
    if (Object.hasOwn(raw, key)) {
      validateDependencyMap(raw[key], `${file}.${key}`);
    }
  }

  for (const key of NPM_AUDIT_REWRITE_KEYS) {
    if (Object.hasOwn(raw, key)) {
      validateRewriteMap(raw[key], `${file}.${key}`);
    }
  }
}

/**
 * @param {string} value
 * @param {string} context
 */
function validateResolvedUrl(value, context) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${context}: invalid resolved URL`);
  }
  if (
    parsed.protocol !== NPM_AUDIT_ALLOWED_PROTOCOL ||
    !NPM_AUDIT_ALLOWED_HOSTS.includes(parsed.hostname) ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    throw new Error(`${context}: resolved URL must stay on ${NPM_AUDIT_REGISTRY}`);
  }
}

/**
 * @param {unknown} entry
 * @param {string} context
 */
function validateLockPackageEntry(entry, context) {
  if (!isPlainObject(entry)) {
    throw new TypeError(`${context}: expected a JSON object`);
  }
  if (entry.link === true) {
    throw new Error(`${context}: linked packages are not supported`);
  }
  if (typeof entry.version === 'string' && looksLikeUnsupportedSource(entry.version)) {
    throw new Error(`${context}.version: unsupported dependency source`);
  }
  if (Object.hasOwn(entry, 'resolved')) {
    if (typeof entry.resolved !== 'string') {
      throw new TypeError(`${context}.resolved: expected a string`);
    }
    validateResolvedUrl(entry.resolved, `${context}.resolved`);
    if (typeof entry.integrity !== 'string' || entry.integrity.trim() === '') {
      throw new Error(`${context}.integrity: resolved packages must carry integrity`);
    }
  }
  for (const key of NPM_AUDIT_DEPENDENCY_KEYS) {
    if (Object.hasOwn(entry, key)) {
      validateDependencyMap(entry[key], `${context}.${key}`);
    }
  }
  for (const key of NPM_AUDIT_REWRITE_KEYS) {
    if (Object.hasOwn(entry, key)) {
      validateRewriteMap(entry[key], `${context}.${key}`);
    }
  }
}

/**
 * @param {unknown} value
 * @param {string} context
 */
function validateLegacyLockDependencies(value, context) {
  if (!isPlainObject(value)) {
    throw new TypeError(`${context}: expected a JSON object`);
  }
  for (const [name, entry] of Object.entries(value)) {
    if (!isPlainObject(entry)) {
      throw new TypeError(`${context}.${name}: expected a JSON object`);
    }
    if (typeof entry.version === 'string' && looksLikeUnsupportedSource(entry.version)) {
      throw new Error(`${context}.${name}.version: unsupported dependency source`);
    }
    if (Object.hasOwn(entry, 'resolved')) {
      if (typeof entry.resolved !== 'string') {
        throw new TypeError(`${context}.${name}.resolved: expected a string`);
      }
      validateResolvedUrl(entry.resolved, `${context}.${name}.resolved`);
      if (typeof entry.integrity !== 'string' || entry.integrity.trim() === '') {
        throw new Error(`${context}.${name}.integrity: resolved packages must carry integrity`);
      }
    }
    if (Object.hasOwn(entry, 'requires')) {
      validateDependencyMap(entry.requires, `${context}.${name}.requires`);
    }
    if (Object.hasOwn(entry, 'dependencies')) {
      validateLegacyLockDependencies(entry.dependencies, `${context}.${name}.dependencies`);
    }
  }
}

/**
 * @param {unknown} raw
 * @param {string} file
 */
export function validateLockfileObject(raw, file) {
  if (!isPlainObject(raw)) {
    throw new TypeError(`${file}: expected a JSON object`);
  }

  if (raw.lockfileVersion !== 2 && raw.lockfileVersion !== 3) {
    throw new Error(`${file}: unsupported lockfileVersion`);
  }

  if (!isPlainObject(raw.packages)) {
    throw new Error(`${file}: packages must be a JSON object`);
  }

  for (const [packagePath, entry] of Object.entries(raw.packages)) {
    if (packagePath !== '' && (!packagePath.startsWith('node_modules/') || packagePath.includes('..'))) {
      throw new Error(`${file}.packages.${packagePath}: unsupported package path`);
    }
    validateLockPackageEntry(entry, `${file}.packages.${packagePath || '<root>'}`);
  }

  if (Object.hasOwn(raw, 'dependencies')) {
    validateLegacyLockDependencies(raw.dependencies, `${file}.dependencies`);
  }
}

/**
 * @param {string} file
 * @returns {unknown}
 */
function parseJsonFile(file) {
  let source;
  try {
    source = readFileSync(file, 'utf8');
  } catch (error) {
    throw new Error(`${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    return JSON.parse(source);
  } catch {
    throw new Error(`${file}: invalid JSON`);
  }
}

/**
 * @param {string} dir
 */
export function validateAuditInputs(dir = '.') {
  const manifestFile = resolve(dir, NPM_AUDIT_FILES.manifest);
  const lockfileFile = resolve(dir, NPM_AUDIT_FILES.lockfile);
  validateManifestObject(parseJsonFile(manifestFile), NPM_AUDIT_FILES.manifest);
  validateLockfileObject(parseJsonFile(lockfileFile), NPM_AUDIT_FILES.lockfile);
}

function main() {
  const argv = process.argv.slice(2);
  const dirIndex = argv.indexOf('--dir');
  const dir = dirIndex === -1 ? '.' : argv[dirIndex + 1];
  try {
    validateAuditInputs(dir);
  } catch (error) {
    process.stderr.write(
      `security-audit: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
