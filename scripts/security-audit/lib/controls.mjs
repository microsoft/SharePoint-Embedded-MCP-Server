/**
 * Reads the security control legend from `docs/SECURITY-CONTROLS.md` and exposes
 * the set of control codes that a model finding is allowed to anchor to.
 *
 * The legend is parsed at runtime rather than hard-coded so that adding a control
 * to the documentation automatically widens the accepted set, and removing one
 * automatically narrows it. A finding that cites a control which does not exist
 * is a strong signal of hallucination and is rejected.
 */

import { readFileSync } from 'node:fs';
import { CONTROL_LEGEND_PATH, UNMAPPED_CONTROL } from './constants.mjs';

/** Matches `SAFE-002` / `SEC-007` style codes. */
const CONTROL_CODE = /\b((?:SAFE|SEC)-\d{3})\b/g;

/**
 * Extracts every control code documented in the legend.
 *
 * @param {string} [legendPath] Path to the legend, relative to the repo root.
 * @returns {Set<string>} Control codes plus the `UNMAPPED` literal.
 */
export function loadControlCodes(legendPath = CONTROL_LEGEND_PATH) {
  let raw;
  try {
    raw = readFileSync(legendPath, 'utf8');
  } catch (error) {
    throw new Error(
      `Unable to read the control legend at ${legendPath}: ${error.message}. ` +
        'Findings cannot be validated without it.',
    );
  }

  const codes = new Set();
  for (const match of raw.matchAll(CONTROL_CODE)) {
    codes.add(match[1]);
  }

  if (codes.size === 0) {
    throw new Error(
      `No control codes found in ${legendPath}. Refusing to accept findings against an empty legend.`,
    );
  }

  codes.add(UNMAPPED_CONTROL);
  return codes;
}
