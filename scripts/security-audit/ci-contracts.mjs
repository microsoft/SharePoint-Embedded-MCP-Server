#!/usr/bin/env node
/**
 * Runs the repository's security contract regressions without forwarding test
 * names, synthetic fixtures, policy diagnostics, or finding state to a public
 * CI log.
 */

import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

function fail() {
  process.stderr.write('Repository contract validation failed.\n');
  process.exit(1);
}

try {
  const root = resolve(import.meta.dirname, '..', '..');
  const testFiles = readdirSync(resolve(import.meta.dirname, 'tests'))
    .filter((name) => name.endsWith('.test.mjs'))
    .sort()
    .map((name) => resolve(import.meta.dirname, 'tests', name));

  const invocations = [
    ['--test', ...testFiles],
    [
      resolve(import.meta.dirname, 'check-action-pins.mjs'),
      '--dir',
      resolve(root, '.github', 'workflows'),
      '--root',
      root,
    ],
  ];

  let failed = false;
  for (const arguments_ of invocations) {
    const result = spawnSync(process.execPath, arguments_, {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, GITHUB_ACTIONS: 'true' },
      maxBuffer: 32 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    if (result.status !== 0) failed = true;
  }

  if (failed) fail();
} catch {
  fail();
}
