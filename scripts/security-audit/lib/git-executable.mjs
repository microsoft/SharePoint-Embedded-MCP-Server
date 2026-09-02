import { existsSync } from 'node:fs';

const WINDOWS_GIT_CANDIDATES = Object.freeze([
  'C:\\Program Files\\Git\\cmd\\git.exe',
  'C:\\Program Files\\Git\\bin\\git.exe',
]);

/**
 * Resolve the git executable used by the local audit helpers.
 *
 * GitHub-hosted Linux runners expose `git` on PATH, so the literal command name
 * remains correct there. Developer Windows environments often do not inherit the
 * Git for Windows PATH entry into PowerShell, even though the standard install
 * location is present. Falling back to that well-known location keeps the local
 * dry-run path reproducible without introducing a workflow-controlled override.
 *
 * @returns {string}
 */
export function gitExecutable() {
  if (process.platform !== 'win32') {
    return 'git';
  }

  for (const candidate of WINDOWS_GIT_CANDIDATES) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return 'git';
}
