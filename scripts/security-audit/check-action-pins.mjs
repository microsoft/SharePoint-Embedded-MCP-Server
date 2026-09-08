#!/usr/bin/env node
/**
 * Verifies that every external action reference is immutable and carries a
 * human-readable version comment. This covers `uses:` values, external
 * `runs.image: docker://...` values, workflow job/service container images,
 * and every external base/frontend image used by a Dockerfile-backed local
 * action.
 *
 * A floating tag (`@v4`) is mutable: whoever controls the tag controls what runs
 * inside the workflow, including in the job that holds the advisory credential
 * used to file a private vulnerability report.
 * Local (`./…`) `uses:` references are resolved from the repository root and
 * traversed recursively, even when they live in directories excluded from broad
 * discovery. Docker references must use an
 * immutable `sha256` digest. A local action that names a Dockerfile causes that
 * exact file to be parsed; dynamic, missing, escaping, or ambiguous image
 * references fail closed, and `ADD` sources must be provably literal local
 * paths.
 *
 * The check parses YAML before inspecting executable references. Unsupported
 * or ambiguous constructs fail closed rather than being ignored.
 *
 * Both surfaces are scanned:
 *   - every `*.yml` / `*.yaml` under the workflow directory, recursively; and
 *   - every local action (`action.yml` / `action.yaml`) anywhere under the
 *     repository root. Composite actions can contain nested `uses:` values, and
 *     Docker actions can name a registry image in `runs.image`; both execute with
 *     the calling workflow's trust and are invisible to a workflow-only scan.
 *
 * Usage:
 *   node scripts/security-audit/check-action-pins.mjs [--dir .github/workflows] [--root .]
 */

import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  LineCounter,
  isAlias,
  isMap,
  isPair,
  isScalar,
  isSeq,
  parseAllDocuments,
} from 'yaml';

const SHA_RE = /^[0-9a-f]{40}$/;
const STATIC_IMAGE_PREFIX = '[A-Za-z0-9][A-Za-z0-9._:/-]*';
const DOCKER_DIGEST_RE = new RegExp(
  `^docker://${STATIC_IMAGE_PREFIX}@sha256:[0-9a-fA-F]{64}$`,
);
const CONTAINER_IMAGE_DIGEST_RE = new RegExp(
  `^${STATIC_IMAGE_PREFIX}@sha256:[0-9a-fA-F]{64}$`,
);
const REMOTE_SOURCE_RE = /^(?:[A-Za-z][A-Za-z0-9+.-]*:|git@)/u;
const DYNAMIC_ADD_SOURCE_RE = /\$/u;
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage', '.security-audit']);
const ACTION_METADATA_NAMES = new Set(['action.yml', 'action.yaml']);

/**
 * Returns the YAML comment on a physical line, ignoring `#` characters inside
 * quoted scalars.
 *
 * @param {string} line
 * @returns {string}
 */
function lineComment(line) {
  let inSingle = false;
  let inDouble = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === "'" && !inDouble) {
      if (inSingle && line[index + 1] === "'") {
        index += 1;
        continue;
      }
      inSingle = !inSingle;
      continue;
    }
    if (character === '"' && !inSingle) {
      let escaped = false;
      for (let cursor = index - 1; cursor >= 0 && line[cursor] === '\\'; cursor -= 1) {
        escaped = !escaped;
      }
      if (!escaped) inDouble = !inDouble;
      continue;
    }
    if (
      character === '#' &&
      !inSingle &&
      !inDouble &&
      (index === 0 || /\s/u.test(line[index - 1]))
    ) {
      return line.slice(index + 1).trim();
    }
  }
  return '';
}

/**
 * Reads a scalar string pair and records its physical line and trailing comment.
 *
 * @param {import('yaml').Pair} pair
 * @param {string} keyName
 * @param {string} file
 * @param {LineCounter} lineCounter
 * @param {string[]} lines
 * @returns {{ line: number, value: string, comment: string }}
 */
function stringPairRecord(pair, keyName, file, lineCounter, lines) {
  if (
    !isScalar(pair.value) ||
    typeof pair.value.value !== 'string' ||
    !pair.key.range ||
    !pair.value.range
  ) {
    throw new Error(`${file}: every ${keyName} value must be a scalar string`);
  }

  const keyPosition = lineCounter.linePos(pair.key.range[0]);
  const valueStart = lineCounter.linePos(pair.value.range[0]);
  const valueEnd = lineCounter.linePos(pair.value.range[1]);
  if (keyPosition.line !== valueStart.line || valueStart.line !== valueEnd.line) {
    throw new Error(`${file}:${keyPosition.line}: multi-line ${keyName} values are not supported`);
  }

  return {
    line: keyPosition.line,
    value: pair.value.value,
    comment: lineComment(lines[keyPosition.line - 1] ?? ''),
  };
}

/**
 * Parses a workflow or local action and returns its document plus every `uses`
 * mapping.
 *
 * The traversal is intentionally schema-agnostic and conservative: a `uses`
 * key in any mapping is checked. Aliases, anchors, tags, merge keys, complex
 * keys, multi-document streams, and multi-line `uses` values are rejected
 * because they can make the executable reference ambiguous.
 *
 * @param {string} text
 * @param {string} file
 * @returns {{
 *   document: import('yaml').Document,
 *   lineCounter: LineCounter,
 *   lines: string[],
 *   references: Array<{ file: string, line: number, uses: string, comment: string }>
 * }}
 */
function parsePolicySource(text, file) {
  const lineCounter = new LineCounter();
  const documents = parseAllDocuments(text, {
    lineCounter,
    prettyErrors: false,
    strict: true,
    uniqueKeys: true,
  });

  if (documents.length !== 1) {
    throw new Error(`${file}: expected exactly one YAML document`);
  }

  const document = documents[0];
  const problems = [...document.errors, ...document.warnings];
  if (problems.length > 0) {
    throw new Error(`${file}: invalid YAML: ${problems[0].message}`);
  }

  const lines = text.split(/\r?\n/);
  /** @type {Array<{ file: string, line: number, uses: string, comment: string }>} */
  const references = [];

  /** @param {unknown} node */
  function walk(node) {
    if (node === null || node === undefined) return;
    if (isAlias(node)) {
      throw new Error(`${file}: YAML aliases are not supported by the pin policy`);
    }
    if (
      typeof node === 'object' &&
      node !== null &&
      ('anchor' in node || 'tag' in node) &&
      (node.anchor || node.tag)
    ) {
      throw new Error(`${file}: YAML anchors and tags are not supported by the pin policy`);
    }
    if (isSeq(node)) {
      for (const item of node.items) walk(item);
      return;
    }
    if (!isMap(node)) return;

    for (const pair of node.items) {
      if (!isPair(pair) || !isScalar(pair.key) || typeof pair.key.value !== 'string') {
        throw new Error(`${file}: complex YAML mapping keys are not supported by the pin policy`);
      }
      if (pair.key.value === '<<') {
        throw new Error(`${file}: YAML merge keys are not supported by the pin policy`);
      }

      if (pair.key.value === 'uses') {
        const record = stringPairRecord(pair, 'uses', file, lineCounter, lines);

        references.push({
          file,
          line: record.line,
          uses: record.value,
          comment: record.comment,
        });
      }

      walk(pair.value);
    }
  }

  walk(document.contents);
  return { document, lineCounter, lines, references };
}

/**
 * Parses a workflow or local action and returns every `uses` mapping.
 *
 * @param {string} text
 * @param {string} file
 * @returns {Array<{ file: string, line: number, uses: string, comment: string }>}
 */
export function extractUses(text, file) {
  return parsePolicySource(text, file).references;
}

/**
 * Returns the image declared by a local Docker action.
 *
 * Repository Dockerfiles are local code and therefore do not use the
 * `docker://` registry-reference form. External images do, and must pass the
 * same digest/comment policy as a Docker `uses:` value.
 *
 * @param {ReturnType<typeof parsePolicySource>} parsed
 * @param {string} file
 * @returns {{ file: string, line: number, uses: string, comment: string } | null}
 */
function extractLocalDockerImage(parsed, file) {
  const root = parsed.document.contents;
  if (!isMap(root)) return null;

  const runsPair = root.items.find(
    (pair) => isPair(pair) && isScalar(pair.key) && pair.key.value === 'runs',
  );
  if (!runsPair) return null;
  if (!isMap(runsPair.value)) {
    throw new Error(`${file}: runs must be a YAML mapping`);
  }

  const usingPair = runsPair.value.items.find(
    (pair) => isPair(pair) && isScalar(pair.key) && pair.key.value === 'using',
  );
  if (!usingPair) return null;
  const using = stringPairRecord(
    usingPair,
    'runs.using',
    file,
    parsed.lineCounter,
    parsed.lines,
  );
  if (using.value.toLowerCase() !== 'docker') return null;

  const imagePair = runsPair.value.items.find(
    (pair) => isPair(pair) && isScalar(pair.key) && pair.key.value === 'image',
  );
  if (!imagePair) {
    throw new Error(`${file}: a Docker action must declare runs.image`);
  }
  const image = stringPairRecord(
    imagePair,
    'runs.image',
    file,
    parsed.lineCounter,
    parsed.lines,
  );
  return {
    file,
    line: image.line,
    uses: image.value,
    comment: image.comment,
  };
}

/**
 * Returns every job-level and service container image in a workflow.
 *
 * GitHub accepts both `container: image` and `container: { image: image }`.
 * Service images use `services.<name>.image`. All execute registry content
 * before repository steps, so they use the same digest and version-comment
 * policy as `docker://` action references.
 *
 * @param {ReturnType<typeof parsePolicySource>} parsed
 * @param {string} file
 * @returns {Array<{ file: string, line: number, uses: string, comment: string }>}
 */
function extractWorkflowContainerImages(parsed, file) {
  const root = parsed.document.contents;
  if (!isMap(root)) return [];

  const jobsPair = root.items.find(
    (pair) => isPair(pair) && isScalar(pair.key) && pair.key.value === 'jobs',
  );
  if (!jobsPair) return [];
  if (!isMap(jobsPair.value)) {
    throw new Error(`${file}: jobs must be a YAML mapping`);
  }

  /** @type {Array<{ file: string, line: number, uses: string, comment: string }>} */
  const images = [];

  /**
   * @param {import('yaml').Pair} pair
   * @param {string} keyName
   */
  function addImage(pair, keyName) {
    const record = stringPairRecord(
      pair,
      keyName,
      file,
      parsed.lineCounter,
      parsed.lines,
    );
    images.push({
      file,
      line: record.line,
      uses: `docker://${record.value}`,
      comment: record.comment,
    });
  }

  for (const jobPair of jobsPair.value.items) {
    if (!isPair(jobPair) || !isScalar(jobPair.key) || typeof jobPair.key.value !== 'string') {
      throw new Error(`${file}: job names must be scalar strings`);
    }
    if (!isMap(jobPair.value)) {
      throw new Error(`${file}: jobs.${jobPair.key.value} must be a YAML mapping`);
    }

    const containerPair = jobPair.value.items.find(
      (pair) => isPair(pair) && isScalar(pair.key) && pair.key.value === 'container',
    );
    if (containerPair) {
      if (isScalar(containerPair.value)) {
        addImage(containerPair, `jobs.${jobPair.key.value}.container`);
      } else if (isMap(containerPair.value)) {
        const imagePair = containerPair.value.items.find(
          (pair) => isPair(pair) && isScalar(pair.key) && pair.key.value === 'image',
        );
        if (!imagePair) {
          throw new Error(`${file}: jobs.${jobPair.key.value}.container must declare image`);
        }
        addImage(imagePair, `jobs.${jobPair.key.value}.container.image`);
      } else {
        throw new Error(`${file}: jobs.${jobPair.key.value}.container is unsupported`);
      }
    }

    const servicesPair = jobPair.value.items.find(
      (pair) => isPair(pair) && isScalar(pair.key) && pair.key.value === 'services',
    );
    if (!servicesPair) continue;
    if (!isMap(servicesPair.value)) {
      throw new Error(`${file}: jobs.${jobPair.key.value}.services must be a YAML mapping`);
    }
    for (const servicePair of servicesPair.value.items) {
      if (
        !isPair(servicePair) ||
        !isScalar(servicePair.key) ||
        typeof servicePair.key.value !== 'string'
      ) {
        throw new Error(`${file}: service names must be scalar strings`);
      }
      if (!isMap(servicePair.value)) {
        throw new Error(
          `${file}: jobs.${jobPair.key.value}.services.${servicePair.key.value} must be a YAML mapping`,
        );
      }
      const imagePair = servicePair.value.items.find(
        (pair) => isPair(pair) && isScalar(pair.key) && pair.key.value === 'image',
      );
      if (!imagePair) {
        throw new Error(
          `${file}: jobs.${jobPair.key.value}.services.${servicePair.key.value} must declare image`,
        );
      }
      addImage(
        imagePair,
        `jobs.${jobPair.key.value}.services.${servicePair.key.value}.image`,
      );
    }
  }

  return images;
}

/**
 * Split an instruction shell fragment into tokens.
 *
 * Supports the quoting needed by the repository's Dockerfiles and rejects
 * unterminated quotes or dangling escapes fail-closed.
 *
 * @param {string} text
 * @param {string} file
 * @param {number} line
 * @returns {string[]}
 */
function splitShellWords(text, file, line) {
  /** @type {string[]} */
  const tokens = [];
  let current = '';
  let quote = '';
  let escaped = false;

  for (const character of text) {
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (quote === "'") {
      if (character === "'") {
        quote = '';
      } else {
        current += character;
      }
      continue;
    }
    if (quote === '"') {
      if (character === '"') {
        quote = '';
      } else if (character === '\\') {
        escaped = true;
      } else {
        current += character;
      }
      continue;
    }
    if (/\s/u.test(character)) {
      if (current !== '') {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === '\\') {
      escaped = true;
      continue;
    }
    current += character;
  }

  if (escaped || quote !== '') {
    throw new Error(`${file}:${line}: unsupported Dockerfile quoting or escaping`);
  }
  if (current !== '') tokens.push(current);
  return tokens;
}

/**
 * @param {string} text
 * @param {string} file
 * @param {number} line
 * @returns {{ options: string[], remainder: string }}
 */
function consumeInstructionOptions(text, file, line) {
  const options = [];
  let remainder = text.trim();
  while (remainder.startsWith('--')) {
    const match = /^(--[A-Za-z][A-Za-z0-9-]*(?:=[^\s]+)?)(?:\s+|$)/u.exec(remainder);
    if (!match) {
      throw new Error(`${file}:${line}: unsupported Dockerfile option syntax`);
    }
    options.push(match[1]);
    remainder = remainder.slice(match[0].length).trimStart();
  }
  return { options, remainder };
}

/**
 * @param {string} text
 * @param {string} file
 * @param {number} line
 * @param {string} instruction
 * @returns {string[]}
 */
function parseJsonStringArray(text, file, line, instruction) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${file}:${line}: unsupported ${instruction} JSON-array syntax`);
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length < 2 ||
    parsed.some((value) => typeof value !== 'string')
  ) {
    throw new Error(`${file}:${line}: unsupported ${instruction} JSON-array syntax`);
  }
  return parsed;
}

/**
 * @param {string} text
 * @param {string} file
 * @param {number} line
 * @param {'ADD' | 'COPY'} instruction
 * @returns {{ options: string[], sources: string[] }}
 */
function parseCopyLikeInstruction(text, file, line, instruction) {
  const { options, remainder } = consumeInstructionOptions(text, file, line);
  if (remainder === '') {
    throw new Error(`${file}:${line}: ${instruction} sources are missing`);
  }
  if (remainder.startsWith('[')) {
    const values = parseJsonStringArray(remainder, file, line, instruction);
    return { options, sources: values.slice(0, -1) };
  }

  const tokens = splitShellWords(remainder, file, line);
  if (tokens.length < 2) {
    throw new Error(`${file}:${line}: ${instruction} sources are missing`);
  }
  return { options, sources: tokens.slice(0, -1) };
}

/**
 * @param {string} option
 * @param {string} key
 * @returns {string | null}
 */
function optionValue(option, key) {
  return option.startsWith(`--${key}=`) ? option.slice(key.length + 3) : null;
}

/**
 * @param {string} value
 * @param {string} file
 * @param {number} line
 * @returns {Map<string, string>}
 */
function parseMountSpec(value, file, line) {
  const options = new Map();
  for (const fragment of value.split(',')) {
    if (fragment === '') {
      throw new Error(`${file}:${line}: unsupported Dockerfile mount syntax`);
    }
    const separator = fragment.indexOf('=');
    if (separator === -1) {
      options.set(fragment, '');
      continue;
    }
    const key = fragment.slice(0, separator);
    const setting = fragment.slice(separator + 1);
    if (key === '' || setting === '') {
      throw new Error(`${file}:${line}: unsupported Dockerfile mount syntax`);
    }
    options.set(key, setting);
  }
  return options;
}

/**
 * @param {string} reference
 * @param {string} file
 * @param {number} line
 * @param {Set<string>} stageAliases
 * @param {number} stageCount
 * @param {string} versionComment
 * @returns {Array<{ file: string, line: number, uses: string, reason: string }>}
 */
function validateDockerImageReference(
  reference,
  file,
  line,
  stageAliases,
  stageCount,
  versionComment,
) {
  const normalized = reference.toLowerCase();
  if (normalized === 'scratch') return [];
  if (/^\d+$/u.test(reference)) {
    if (Number(reference) >= stageCount) {
      throw new Error(`${file}:${line}: unsupported Docker stage reference`);
    }
    return [];
  }
  if (stageAliases.has(normalized)) return [];
  if (CONTAINER_IMAGE_DIGEST_RE.test(reference)) {
    return versionComment === ''
      ? [{ file, line, uses: reference, reason: 'missing-version-comment' }]
      : [];
  }
  return [{ file, line, uses: reference, reason: 'not-digest-pinned' }];
}

/**
 * `ADD` can import either local build-context paths or remote URLs. The pin
 * policy accepts only sources that remain provably local after this parser has
 * resolved quoting/JSON-array syntax; any `$`-driven interpolation is
 * unsupported because the parser cannot prove what concrete source Docker will
 * fetch after environment replacement.
 *
 * @param {string} source
 * @param {string} file
 * @param {number} line
 * @returns {{ file: string, line: number, uses: string, reason: string } | null}
 */
function validateAddSource(source, file, line) {
  if (DYNAMIC_ADD_SOURCE_RE.test(source)) {
    return { file, line, uses: source, reason: 'unsupported-dynamic-source' };
  }
  if (REMOTE_SOURCE_RE.test(source)) {
    return { file, line, uses: source, reason: 'unsupported-remote-source' };
  }
  return null;
}

/**
 * Parses a Dockerfile conservatively and checks every explicit external
 * frontend/image reference plus every Dockerfile construct that can import
 * external content declaratively (`ADD`, `COPY --from`, `RUN --mount=from`).
 * Local stage aliases, prior numeric stage indexes, and `scratch` are treated
 * as in-repository / in-file references rather than registry inputs. `ADD`
 * sources must stay literal local paths after parsing; remote or dynamic
 * sources are rejected.
 *
 * @param {string} text
 * @param {string} file
 * @returns {Array<{ file: string, line: number, uses: string, reason: string }>}
 */
export function checkDockerfileSource(text, file) {
  /** @type {Array<{ file: string, line: number, uses: string, reason: string }>} */
  const violations = [];
  /** @type {Array<{ line: number, value: string, versionComment: string }>} */
  const instructions = [];
  const stageAliases = new Set();
  let stageCount = 0;
  const lines = text.split(/\r?\n/);
  let pending = '';
  let pendingLine = 0;
  let pendingVersionComment = '';
  let instructionVersionComment = '';

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    const line = index + 1;

    if (pending === '' && /^\s*#\s*syntax\b/i.test(raw)) {
      const directive = /^\s*#\s*syntax\s*=\s*(\S+)\s*$/i.exec(raw);
      if (!directive) {
        throw new Error(`${file}:${line}: unsupported Dockerfile syntax directive`);
      }
      const image = directive[1];
      if (!CONTAINER_IMAGE_DIGEST_RE.test(image)) {
        violations.push({ file, line, uses: image, reason: 'not-digest-pinned' });
      } else {
        const version = /^\s*#\s*pin-version\s*:\s*(\S.*)\s*$/i.exec(lines[index + 1] ?? '');
        if (!version) {
          violations.push({ file, line, uses: image, reason: 'missing-version-comment' });
        } else {
          index += 1;
        }
      }
      continue;
    }

    if (pending === '' && /^\s*#\s*escape\b/i.test(raw)) {
      const directive = /^\s*#\s*escape\s*=\s*(\S+)\s*$/i.exec(raw);
      if (!directive || directive[1] !== '\\') {
        throw new Error(`${file}:${line}: unsupported Dockerfile escape directive`);
      }
      continue;
    }

    if (/^\s*$/.test(raw)) {
      if (pending !== '') {
        throw new Error(`${file}:${line}: comments inside continued instructions are not supported`);
      }
      pendingVersionComment = '';
      continue;
    }

    if (/^\s*#/.test(raw)) {
      if (pending !== '') {
        throw new Error(`${file}:${line}: comments inside continued instructions are not supported`);
      }
      const version = /^\s*#\s*pin-version\s*:\s*(\S.*)\s*$/i.exec(raw);
      pendingVersionComment = version ? version[1] : '';
      continue;
    }

    const trimmed = raw.trimEnd();
    const continues = /\\$/.test(trimmed);
    const fragment = continues ? trimmed.slice(0, -1) : trimmed;
    if (pending === '') {
      pendingLine = line;
      instructionVersionComment = pendingVersionComment;
      pendingVersionComment = '';
    }
    pending += `${fragment.trim()} `;
    if (continues) continue;

    instructions.push({
      line: pendingLine,
      value: pending.trim(),
      versionComment: instructionVersionComment,
    });
    pending = '';
    pendingLine = 0;
    instructionVersionComment = '';
  }

  if (pending !== '') {
    throw new Error(`${file}:${pendingLine}: unterminated Dockerfile line continuation`);
  }

  for (const instruction of instructions) {
    // Dockerfile heredocs introduce an embedded language whose body may contain
    // text that looks like a top-level FROM instruction. Until this parser tracks
    // heredoc delimiters explicitly, accepting one could let body text create a
    // fake stage alias that masks a later floating external image.
    if (/<<-?\s*['"]?[A-Za-z0-9_.-]+/.test(instruction.value)) {
      throw new Error(`${file}:${instruction.line}: Dockerfile heredocs are not supported`);
    }

    const match = /^([A-Za-z]+)\s+(.+)$/u.exec(instruction.value);
    if (!match) {
      throw new Error(`${file}:${instruction.line}: unsupported Dockerfile instruction`);
    }

    const keyword = match[1].toUpperCase();
    const body = match[2].trim();
    if (keyword === 'FROM') {
      const tokens = splitShellWords(body, file, instruction.line);
      while (tokens[0]?.startsWith('--')) {
        const option = tokens.shift();
        if (!/^--[A-Za-z][A-Za-z0-9-]*=\S+$/u.test(option)) {
          throw new Error(`${file}:${instruction.line}: unsupported Dockerfile FROM option`);
        }
      }
      const image = tokens.shift();
      if (!image) {
        throw new Error(`${file}:${instruction.line}: Dockerfile FROM image is missing`);
      }

      let alias = '';
      if (tokens.length > 0) {
        if (
          tokens.length !== 2 ||
          tokens[0].toLowerCase() !== 'as' ||
          !/^[A-Za-z0-9_.-]+$/u.test(tokens[1])
        ) {
          throw new Error(`${file}:${instruction.line}: unsupported Dockerfile FROM syntax`);
        }
        alias = tokens[1].toLowerCase();
      }

      violations.push(
        ...validateDockerImageReference(
          image,
          file,
          instruction.line,
          stageAliases,
          stageCount,
          instruction.versionComment,
        ),
      );

      if (alias !== '') stageAliases.add(alias);
      stageCount += 1;
      continue;
    }

    if (keyword === 'ADD' || keyword === 'COPY') {
      const parsed = parseCopyLikeInstruction(body, file, instruction.line, keyword);
      for (const option of parsed.options) {
        const from = optionValue(option, 'from');
        if (from !== null) {
          violations.push(
            ...validateDockerImageReference(
              from,
              file,
              instruction.line,
              stageAliases,
              stageCount,
              instruction.versionComment,
            ),
          );
        }
      }
      if (keyword === 'ADD') {
        for (const source of parsed.sources) {
          const violation = validateAddSource(source, file, instruction.line);
          if (violation) violations.push(violation);
        }
      }
      continue;
    }

    if (keyword === 'RUN') {
      const { options } = consumeInstructionOptions(body, file, instruction.line);
      for (const option of options) {
        const mount = optionValue(option, 'mount');
        if (mount === null) continue;
        const settings = parseMountSpec(mount, file, instruction.line);
        if (!settings.has('from')) continue;
        violations.push(
          ...validateDockerImageReference(
            settings.get('from'),
            file,
            instruction.line,
            stageAliases,
            stageCount,
            instruction.versionComment,
          ),
        );
      }
    }
  }

  return violations;
}

/**
 * Resolves and checks a Dockerfile referenced by local action metadata.
 *
 * @param {{ file: string, line: number, uses: string }} image
 * @param {string} rootReal
 * @returns {Array<{ file: string, line: number, uses: string, reason: string }>}
 */
function checkReferencedDockerfile(image, rootReal) {
  const reference = image.uses;
  if (
    reference === '' ||
    reference.trim() !== reference ||
    reference.includes('\\') ||
    reference.includes('\0') ||
    reference.includes('$') ||
    isAbsolute(reference)
  ) {
    throw new Error(`${image.file}:${image.line}: unprovable local Dockerfile reference`);
  }

  const absolute = resolve(dirname(image.file), reference);
  const lexical = relative(rootReal, absolute);
  if (lexical !== '' && (lexical.startsWith('..') || isAbsolute(lexical))) {
    throw new Error(`${image.file}:${image.line}: local Dockerfile escapes the scan root`);
  }

  const stats = inspectRepositoryPath(rootReal, absolute, image.file, image.line);
  if (!stats.isFile()) {
    throw new Error(`${image.file}:${image.line}: local Dockerfile is not a regular file`);
  }

  return checkDockerfileSource(
    readFileSync(absolute, 'utf8'),
    absolute.split('\\').join('/'),
  );
}

/**
 * @param {Array<{ file: string, line: number, uses: string, comment: string }>} references
 * @returns {Array<{ file: string, line: number, uses: string, reason: string }>}
 */
function checkReferences(references) {
  /** @type {Array<{ file: string, line: number, uses: string, reason: string }>} */
  const violations = [];

  for (const { file, line, uses: reference, comment } of references) {
    if (reference.startsWith('./')) continue;
    const at = reference.lastIndexOf('@');
    const record = { file, line, uses: reference };

    if (reference.startsWith('docker://')) {
      if (!DOCKER_DIGEST_RE.test(reference)) {
        violations.push({ ...record, reason: 'not-digest-pinned' });
        continue;
      }
      if (comment === '') {
        violations.push({ ...record, reason: 'missing-version-comment' });
      }
      continue;
    }

    if (at === -1) {
      violations.push({ ...record, reason: 'missing-ref' });
      continue;
    }

    const ref = reference.slice(at + 1);
    if (!SHA_RE.test(ref)) {
      violations.push({ ...record, reason: 'not-sha-pinned' });
      continue;
    }

    if (comment === '') {
      violations.push({ ...record, reason: 'missing-version-comment' });
    }
  }

  return violations;
}

/**
 * @param {string} text
 * @param {string} file
 * @returns {Array<{ file: string, line: number, uses: string, reason: string }>}
 */
export function checkWorkflowSource(text, file) {
  const parsed = parsePolicySource(text, file);
  return checkReferences([
    ...parsed.references,
    ...extractWorkflowContainerImages(parsed, file),
  ]);
}

/**
 * Checks nested `uses:` values and `runs.image` metadata in a local action.
 * Dockerfile-backed actions require `rootReal` so their external images cannot
 * hide behind an uninspected local path.
 *
 * @param {string} text
 * @param {string} file
 * @param {string} [rootReal]
 * @returns {Array<{ file: string, line: number, uses: string, reason: string }>}
 */
export function checkLocalActionSource(text, file, rootReal) {
  const parsed = parsePolicySource(text, file);
  const image = extractLocalDockerImage(parsed, file);
  const references = [
    ...parsed.references,
    ...(image?.uses.startsWith('docker://') ? [image] : []),
  ];
  const violations = checkReferences(references);

  if (image && !image.uses.startsWith('docker://')) {
    if (!rootReal) {
      throw new Error(`${file}:${image.line}: local Dockerfile requires filesystem context`);
    }
    violations.push(...checkReferencedDockerfile(image, rootReal));
  }

  return violations;
}

/**
 * Resolves `absolute` and asserts the real path stays inside `rootReal`.
 *
 * The walk refuses to follow symlinks, but a caller can still point `--root` or
 * `--dir` at a path whose *ancestors* are links. Re-checking containment on every
 * visited entry keeps the scan confined to a single real directory tree even when
 * the entry point itself was reached through a link.
 *
 * @param {string} rootReal Canonical (already realpath-resolved) scan root.
 * @param {string} absolute Path to verify.
 * @returns {string} The canonical path of `absolute`.
 */
function assertWithinRoot(rootReal, absolute) {
  let real;
  try {
    real = realpathSync.native(absolute);
  } catch (error) {
    throw new Error(
      `security-audit: cannot resolve ${absolute}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const rel = relative(rootReal, real);
  if (rel !== '' && (rel.startsWith('..') || isAbsolute(rel))) {
    throw new Error(`security-audit: path escapes the scan root: ${absolute} -> ${real}`);
  }
  return real;
}

/**
 * Checks every path component without following a symbolic link.
 *
 * `realpath` containment alone is insufficient for a reference such as
 * `./dist/action`: a link can remain inside the repository while still hiding
 * the reviewed action metadata behind different content.
 *
 * @param {string} rootReal
 * @param {string} absolute
 * @param {string} sourceFile
 * @param {number} sourceLine
 * @returns {import('node:fs').Stats}
 */
function inspectRepositoryPath(rootReal, absolute, sourceFile, sourceLine) {
  const lexical = relative(rootReal, absolute);
  if (lexical !== '' && (lexical.startsWith('..') || isAbsolute(lexical))) {
    throw new Error(`${sourceFile}:${sourceLine}: local reference escapes the scan root`);
  }

  let current = rootReal;
  let stats = lstatSync(rootReal);
  for (const segment of lexical.split(/[\\/]/u).filter(Boolean)) {
    current = join(current, segment);
    try {
      stats = lstatSync(current);
    } catch {
      throw new Error(`${sourceFile}:${sourceLine}: local reference could not be read`);
    }
    if (stats.isSymbolicLink()) {
      throw new Error(`${sourceFile}:${sourceLine}: local reference must not contain a symlink`);
    }
  }
  assertWithinRoot(rootReal, absolute);
  return stats;
}

/**
 * Resolves one repository-local `uses:` value to exact executable policy
 * metadata. Directories must contain exactly one action metadata file. Files
 * must be reusable-workflow YAML.
 *
 * @param {{ file: string, line: number, uses: string }} reference
 * @param {string} rootReal
 * @returns {{ file: string, kind: 'action' | 'workflow' }}
 */
function resolveLocalReference(reference, rootReal) {
  const value = reference.uses;
  if (
    !value.startsWith('./') ||
    value === './' ||
    value.trim() !== value ||
    value.includes('\\') ||
    value.includes('\0') ||
    value.includes('$') ||
    value.includes('?') ||
    value.includes('#') ||
    isAbsolute(value)
  ) {
    throw new Error(`${reference.file}:${reference.line}: unprovable local action reference`);
  }

  const absolute = resolve(rootReal, value.slice(2));
  const stats = inspectRepositoryPath(rootReal, absolute, reference.file, reference.line);
  if (stats.isFile()) {
    if (!/\.ya?ml$/u.test(absolute)) {
      throw new Error(
        `${reference.file}:${reference.line}: local workflow reference must name YAML`,
      );
    }
    return { file: absolute.split('\\').join('/'), kind: 'workflow' };
  }
  if (!stats.isDirectory()) {
    throw new Error(
      `${reference.file}:${reference.line}: local action reference is not a file or directory`,
    );
  }

  const candidates = [...ACTION_METADATA_NAMES]
    .map((name) => join(absolute, name))
    .filter((candidate) => existsSync(candidate));
  if (candidates.length === 0) {
    throw new Error(`${reference.file}:${reference.line}: local action metadata is missing`);
  }
  if (candidates.length !== 1) {
    throw new Error(`${reference.file}:${reference.line}: local action metadata is ambiguous`);
  }

  const metadata = candidates[0];
  const metadataStats = inspectRepositoryPath(
    rootReal,
    metadata,
    reference.file,
    reference.line,
  );
  if (!metadataStats.isFile()) {
    throw new Error(`${reference.file}:${reference.line}: local action metadata is not a file`);
  }
  return { file: metadata.split('\\').join('/'), kind: 'action' };
}

/**
 * Scans the transitive executable-reference graph rooted at workflow and local
 * action metadata files.
 *
 * @param {string} root
 * @param {Array<{ file: string, kind: 'action' | 'workflow' }>} seeds
 */
function checkPolicyGraph(root, seeds) {
  const rootReal = realpathSync.native(root);
  /** @type {Set<string>} */
  const visited = new Set();
  /** @type {Set<string>} */
  const active = new Set();
  /** @type {Array<{ file: string, line: number, uses: string, reason: string }>} */
  const violations = [];

  /**
   * @param {{ file: string, kind: 'action' | 'workflow' }} policy
   */
  function visit(policy) {
    const absolute = resolve(policy.file);
    const stats = inspectRepositoryPath(rootReal, absolute, policy.file, 1);
    if (!stats.isFile()) {
      throw new Error(`${policy.file}: policy input is not a regular file`);
    }
    const canonical = assertWithinRoot(rootReal, absolute);
    const visitedKey = `${policy.kind}:${canonical}`;
    if (active.has(canonical)) {
      throw new Error(`${policy.file}: local action reference cycle detected`);
    }
    if (visited.has(visitedKey)) return;

    active.add(canonical);
    const displayFile = absolute.split('\\').join('/');
    const parsed = parsePolicySource(readFileSync(absolute, 'utf8'), displayFile);
    const image =
      policy.kind === 'action' ? extractLocalDockerImage(parsed, displayFile) : null;
    const workflowImages =
      policy.kind === 'workflow' ? extractWorkflowContainerImages(parsed, displayFile) : [];
    const executableReferences = [
      ...parsed.references,
      ...(image?.uses.startsWith('docker://') ? [image] : []),
      ...workflowImages,
    ];
    violations.push(...checkReferences(executableReferences));

    if (image && !image.uses.startsWith('docker://')) {
      violations.push(...checkReferencedDockerfile(image, rootReal));
    }

    for (const reference of parsed.references) {
      if (!reference.uses.startsWith('./')) continue;
      visit(resolveLocalReference(reference, rootReal));
    }

    active.delete(canonical);
    visited.add(visitedKey);
  }

  for (const seed of seeds.toSorted((left, right) => left.file.localeCompare(right.file))) {
    visit(seed);
  }

  return { violations, scanned: visited.size };
}

/**
 * Recursively lists files under `dir` that satisfy `predicate`.
 *
 * Symlinks are rejected outright — both symlinked files and symlinked directories
 * cause a fail-closed throw rather than a skip. A repository that ships a link
 * into `/etc`, into another checkout, or back into itself would otherwise let the
 * pin scanner read (or loop over) content outside the audited tree, and a link
 * that shadows a local action could hide an unpinned executable reference.
 * Refusing to follow links also makes filesystem cycles unreachable; the `seen`
 * set below is belt-and-braces for hard-linked or bind-mounted directories.
 *
 * @param {string} dir
 * @param {(name: string) => boolean} predicate
 * @returns {string[]} POSIX-style paths, sorted for deterministic output.
 * @throws {Error} When a symlink, an escaping path, or a directory cycle is found.
 */
export function collectFiles(dir, predicate) {
  /** @type {string[]} */
  const found = [];

  let rootReal;
  try {
    rootReal = realpathSync.native(dir);
  } catch (error) {
    throw new Error(
      `security-audit: cannot resolve the scan root ${dir}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  /** @type {Set<string>} */
  const seen = new Set([rootReal]);

  /** @param {string} current */
  function walk(current) {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const full = join(current, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`security-audit: refusing to follow symlink: ${full}`);
      }
      if (entry.isDirectory()) {
        // Hidden directories are scanned unless explicitly named here. Local
        // actions often live in `.actions/`; skipping them wholesale would let
        // mutable nested `uses` or Docker image references bypass enforcement.
        if (SKIP_DIRS.has(entry.name)) continue;
        const real = assertWithinRoot(rootReal, full);
        if (seen.has(real)) {
          throw new Error(`security-audit: directory cycle detected at ${full}`);
        }
        seen.add(real);
        walk(full);
        continue;
      }
      // Sockets, FIFOs and device nodes are never audit inputs.
      if (!entry.isFile()) continue;
      if (predicate(entry.name)) {
        assertWithinRoot(rootReal, full);
        found.push(full.split('\\').join('/'));
      }
    }
  }

  walk(dir);
  return found.sort();
}

/**
 * Scans every YAML file under `dir`, recursively.
 *
 * @param {string} dir
 */
export function checkWorkflowDirectory(dir, root = resolve(dir, '..', '..')) {
  const files = collectFiles(dir, (name) => name.endsWith('.yml') || name.endsWith('.yaml'));
  return checkPolicyGraph(
    root,
    files.map((file) => ({ file, kind: 'workflow' })),
  ).violations;
}

/**
 * Scans local actions (`action.yml` / `action.yaml`) anywhere under `root`.
 * Composite `uses:` references and external Docker `runs.image` references are
 * both checked.
 *
 * @param {string} root
 */
export function checkLocalActions(root) {
  const files = collectFiles(root, (name) => ACTION_METADATA_NAMES.has(name));
  return checkPolicyGraph(
    root,
    files.map((file) => ({ file, kind: 'action' })),
  ).violations;
}

function main() {
  const argv = process.argv.slice(2);
  const dirIndex = argv.indexOf('--dir');
  const dir = dirIndex === -1 ? '.github/workflows' : argv[dirIndex + 1];
  const rootIndex = argv.indexOf('--root');
  const root = rootIndex === -1 ? '.' : argv[rootIndex + 1];

  let violations;
  let scanned;
  try {
    const workflowFiles = collectFiles(
      dir,
      (name) => name.endsWith('.yml') || name.endsWith('.yaml'),
    );
    const localActionFiles = collectFiles(root, (name) => ACTION_METADATA_NAMES.has(name));
    const result = checkPolicyGraph(root, [
      ...workflowFiles.map((file) => ({ file, kind: 'workflow' })),
      ...localActionFiles.map((file) => ({ file, kind: 'action' })),
    ]);
    scanned = result.scanned;
    violations = result.violations;
  } catch (error) {
    process.stderr.write(
      `security-audit: unable to read ${dir}: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
    return;
  }

  if (violations.length === 0) {
    if (process.env.GITHUB_ACTIONS !== 'true') {
      process.stdout.write(
        `security-audit: all external actions are immutably pinned across ${scanned} workflow/local-action file(s)\n`,
      );
    }
    return;
  }

  for (const violation of violations) {
    process.stderr.write(
      `${violation.file}:${violation.line}: ${violation.reason}: ${violation.uses}\n`,
    );
  }
  process.stderr.write(
    `security-audit: ${violations.length} unpinned or undocumented action reference(s)\n`,
  );
  process.exit(2);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
