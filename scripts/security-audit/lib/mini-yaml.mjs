/**
 * Fail-closed parser for the YAML subset used by this repository's GitHub
 * Actions workflows.
 *
 * Why not a YAML library: the audit tooling must have zero runtime dependencies,
 * and workflow-invariant tests are more trustworthy when the parser refuses to
 * guess. Any construct outside the supported subset raises instead of producing
 * a partially-correct document, so an unparseable workflow fails the check
 * rather than silently passing it.
 *
 * Supported: block mappings, block sequences, plain/single/double-quoted
 * scalars, `|` and `>` block scalars, comments, empty flow collections
 * (`{}` / `[]`), and `null` values from empty mapping entries.
 *
 * Deliberately unsupported (raises): anchors, aliases, tags, multi-document
 * streams, non-empty flow collections, and complex keys.
 *
 * Note: unlike YAML 1.1 loaders, bare `on`, `yes`, `no` and `off` keys are kept
 * as strings. That is the desired behavior here — `on:` is a workflow trigger
 * block, not the boolean `true`.
 */

class YamlSubsetError extends Error {
  /**
   * @param {string} message
   * @param {number} line 1-based line number.
   */
  constructor(message, line) {
    super(`${message} (line ${line})`);
    this.name = 'YamlSubsetError';
    this.line = line;
  }
}

/**
 * @param {string} raw
 */
function toLogicalLines(raw) {
  const out = [];
  const lines = raw.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const lineNo = i + 1;
    const withoutComment = stripComment(line);
    if (withoutComment.trim() === '') continue;
    const indent = withoutComment.length - withoutComment.trimStart().length;
    out.push({ indent, content: withoutComment.trimEnd(), lineNo, raw: line });
  }
  return out;
}

/**
 * Removes trailing comments while respecting quoted scalars.
 * @param {string} line
 */
function stripComment(line) {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === '#' && !inSingle && !inDouble) {
      if (i === 0 || /\s/.test(line[i - 1])) return line.slice(0, i);
    }
  }
  return line;
}

/**
 * @param {string} token
 * @param {number} lineNo
 */
function parseScalar(token, lineNo) {
  const value = token.trim();
  if (value === '') return null;
  if (value === '{}') return {};
  if (value === '[]') return [];
  if (value.startsWith('{') || value.startsWith('[')) {
    throw new YamlSubsetError('non-empty flow collections are not supported', lineNo);
  }
  if (value.startsWith('&') || value.startsWith('*') || value.startsWith('!')) {
    throw new YamlSubsetError('anchors, aliases and tags are not supported', lineNo);
  }
  if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    return value.slice(1, -1).replace(/\\(["\\/nrt])/g, (_m, c) => {
      switch (c) {
        case 'n':
          return '\n';
        case 'r':
          return '\r';
        case 't':
          return '\t';
        default:
          return c;
      }
    });
  }
  return value;
}

/**
 * Splits `key: value` while respecting quotes. Returns null when the line is not
 * a mapping entry.
 * @param {string} content
 */
function splitMappingEntry(content) {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < content.length; i += 1) {
    const ch = content[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === ':' && !inSingle && !inDouble) {
      const rest = content.slice(i + 1);
      if (rest === '' || /^\s/.test(rest)) {
        return { key: content.slice(0, i).trim(), rest: rest.trim() };
      }
    }
  }
  return null;
}

/**
 * @param {ReturnType<typeof toLogicalLines>} lines
 * @param {string} source
 */
function createParser(lines, source) {
  let cursor = 0;

  /** @param {number} indent */
  function parseNode(indent) {
    if (cursor >= lines.length) return null;
    const line = lines[cursor];
    const trimmed = line.content.trim();
    if (trimmed.startsWith('- ') || trimmed === '-') {
      return parseSequence(indent);
    }
    return parseMapping(indent);
  }

  /** @param {number} indent */
  function parseSequence(indent) {
    const items = [];
    while (cursor < lines.length) {
      const line = lines[cursor];
      if (line.indent < indent) break;
      if (line.indent > indent) {
        throw new YamlSubsetError('unexpected indentation in sequence', line.lineNo);
      }
      const trimmed = line.content.trim();
      if (!trimmed.startsWith('-')) break;
      const inline = trimmed === '-' ? '' : trimmed.slice(1).trim();
      const itemIndent = indent + 2;
      cursor += 1;
      if (inline === '') {
        items.push(cursor < lines.length && lines[cursor].indent > indent ? parseNode(lines[cursor].indent) : null);
        continue;
      }
      const entry = splitMappingEntry(inline);
      if (entry) {
        const map = {};
        assignEntry(map, entry, itemIndent, line.lineNo);
        collectMappingContinuation(map, itemIndent);
        items.push(map);
      } else {
        items.push(parseScalar(inline, line.lineNo));
      }
    }
    return items;
  }

  /**
   * @param {Record<string, unknown>} map
   * @param {{ key: string, rest: string }} entry
   * @param {number} indent
   * @param {number} lineNo
   */
  function assignEntry(map, entry, indent, lineNo) {
    if (Object.hasOwn(map, entry.key)) {
      throw new YamlSubsetError(`duplicate key "${entry.key}"`, lineNo);
    }
    if (/^[|>][-+]?\d*$/.test(entry.rest)) {
      map[entry.key] = readBlockScalar(indent, entry.rest.startsWith('>'));
      return;
    }
    if (entry.rest === '') {
      const childIndent = cursor < lines.length ? lines[cursor].indent : -1;
      if (childIndent > indent) {
        map[entry.key] = parseNode(childIndent);
      } else if (
        childIndent === indent &&
        cursor < lines.length &&
        lines[cursor].content.trim().startsWith('-')
      ) {
        // Sequences may be written at the same indentation as their parent key.
        map[entry.key] = parseSequence(childIndent);
      } else {
        map[entry.key] = null;
      }
      return;
    }
    map[entry.key] = parseScalar(entry.rest, lineNo);
  }

  /**
   * @param {number} indent
   * @param {boolean} folded
   */
  function readBlockScalar(indent, folded) {
    const parts = [];
    let blockIndent = -1;
    while (cursor < lines.length) {
      const line = lines[cursor];
      if (line.indent <= indent) break;
      if (blockIndent === -1) blockIndent = line.indent;
      parts.push(line.raw.slice(blockIndent).replace(/\s+$/, ''));
      cursor += 1;
    }
    return folded ? parts.join(' ') : parts.join('\n');
  }

  /**
   * @param {Record<string, unknown>} map
   * @param {number} indent
   */
  function collectMappingContinuation(map, indent) {
    while (cursor < lines.length) {
      const line = lines[cursor];
      if (line.indent !== indent) break;
      const trimmed = line.content.trim();
      if (trimmed.startsWith('- ') || trimmed === '-') break;
      const entry = splitMappingEntry(trimmed);
      if (!entry) break;
      cursor += 1;
      assignEntry(map, entry, indent, line.lineNo);
    }
  }

  /** @param {number} indent */
  function parseMapping(indent) {
    const map = {};
    while (cursor < lines.length) {
      const line = lines[cursor];
      if (line.indent < indent) break;
      if (line.indent > indent) {
        throw new YamlSubsetError('unexpected indentation in mapping', line.lineNo);
      }
      const trimmed = line.content.trim();
      if (trimmed.startsWith('- ') || trimmed === '-') break;
      if (trimmed === '---' || trimmed === '...') {
        throw new YamlSubsetError('multi-document streams are not supported', line.lineNo);
      }
      const entry = splitMappingEntry(trimmed);
      if (!entry) {
        throw new YamlSubsetError(`cannot parse "${trimmed}" as a mapping entry`, line.lineNo);
      }
      cursor += 1;
      assignEntry(map, entry, indent, line.lineNo);
    }
    return map;
  }

  return () => {
    if (lines.length === 0) return null;
    const doc = parseNode(lines[0].indent);
    if (cursor < lines.length) {
      throw new YamlSubsetError(`unconsumed content in ${source}`, lines[cursor].lineNo);
    }
    return doc;
  };
}

/**
 * Parses a YAML document restricted to the supported subset.
 *
 * @param {string} raw Document text.
 * @param {string} [source] Label used in error messages.
 * @returns {unknown}
 */
export function parseYaml(raw, source = '<yaml>') {
  if (typeof raw !== 'string') throw new TypeError('parseYaml expects a string');
  if (raw.includes('\t')) {
    const line = raw.split(/\r?\n/).findIndex((l) => l.includes('\t')) + 1;
    throw new YamlSubsetError('tab characters are not valid YAML indentation', line);
  }
  const lines = toLogicalLines(raw);
  return createParser(lines, source)();
}

export { YamlSubsetError };
