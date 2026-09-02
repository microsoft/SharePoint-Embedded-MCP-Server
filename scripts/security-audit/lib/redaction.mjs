/**
 * Rejection and redaction rules applied to every model response before it is
 * written anywhere or submitted as a private vulnerability report.
 *
 * Two distinct mechanisms:
 *
 * - REJECT: the finding is discarded entirely and the run fails closed. These
 *   patterns indicate the model has either echoed a real credential out of the
 *   corpus or produced a weaponized payload. Neither belongs in a report, even
 *   a private one.
 * - REDACT: the value is replaced in place with a labeled placeholder. These are
 *   lower-risk identifiers that still should not be persisted verbatim.
 */

/**
 * Patterns that cause a finding to be dropped and the run to fail closed.
 * @type {ReadonlyArray<{ label: string, pattern: RegExp }>}
 */
export const REJECT_PATTERNS = Object.freeze([
  { label: 'github-token', pattern: /\bgh[pousr]_[A-Za-z0-9]{16,}\b/ },
  { label: 'github-pat', pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/ },
  { label: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/ },
  { label: 'aws-access-key', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { label: 'private-key', pattern: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/ },
  {
    label: 'guid',
    pattern: /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/,
  },
  {
    label: 'absolute-path-posix',
    // A bounded absolute token with at least one path segment. The left
    // boundary and `(?!\/)` exclude URL `//` sequences; relative prose such as
    // `src/tools/read.ts` has no leading slash and is not matched.
    pattern:
      /(?:^|[\s"'`([{=:;,])\/(?!\/)[A-Za-z0-9._~+@%=-]+(?:\/[A-Za-z0-9._~+@%=-]+)*(?:[)\]}.,;:!?])?(?=$|[\s"'`)\]}>.,;:!?])/u,
  },
  { label: 'absolute-path-runner', pattern: /\/github\/workspace/ },
  { label: 'absolute-path-windows', pattern: /\b[A-Za-z]:\\(?:[^\s"'`]+)/ },
  { label: 'pipe-to-shell', pattern: /\b(?:curl|wget)\b[^\n|]*\|\s*(?:ba|z|d|k)?sh\b/i },
  { label: 'recursive-delete', pattern: /\brm\s+-[a-zA-Z]*r[a-zA-Z]*f?\s+\/(?:\s|$)/ },
  { label: 'powershell-invoke-expression', pattern: /\bInvoke-Expression\b|\biex\s+\(/i },
  { label: 'powershell-encoded-command', pattern: /\bpowershell(?:\.exe)?\b[^\n]*\s-e(?:nc|ncodedcommand)?\b/i },
  { label: 'base64-to-shell', pattern: /\bbase64\b[^\n|]*(?:-d|--decode)[^\n|]*\|\s*(?:ba|z|d|k)?sh\b/i },
  { label: 'script-tag', pattern: /<\s*script[\s>]/i },
  { label: 'netcat-exec', pattern: /\bnc\b[^\n]*\s-[a-zA-Z]*e[a-zA-Z]*\s/ },
  { label: 'reverse-shell', pattern: /\/dev\/tcp\/\d{1,3}(?:\.\d{1,3}){3}\// },
]);

/**
 * Patterns replaced in place with `[REDACTED:<label>]`.
 * @type {ReadonlyArray<{ label: string, pattern: RegExp }>}
 */
export const REDACT_PATTERNS = Object.freeze([
  { label: 'email', pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  { label: 'url-with-query', pattern: /\bhttps?:\/\/[^\s"'`<>]+\?[^\s"'`<>]+/g },
  { label: 'long-hex', pattern: /\b[0-9a-fA-F]{32,}\b/g },
]);

/**
 * Scans text for reject-worthy content.
 *
 * @param {string} text
 * @returns {string[]} Labels of every rule that matched. Empty when clean.
 */
export function findRejectReasons(text) {
  if (typeof text !== 'string' || text === '') return [];
  const reasons = [];
  for (const { label, pattern } of REJECT_PATTERNS) {
    // Patterns are non-global, so `test` is stateless and safe to reuse.
    if (pattern.test(text)) reasons.push(label);
  }
  return reasons;
}

/**
 * Replaces redactable values with labeled placeholders.
 *
 * @param {string} text
 * @returns {{ value: string, redactions: string[] }}
 */
export function redact(text) {
  if (typeof text !== 'string' || text === '') return { value: text, redactions: [] };
  const redactions = [];
  let value = text;
  for (const { label, pattern } of REDACT_PATTERNS) {
    value = value.replace(new RegExp(pattern.source, pattern.flags), () => {
      redactions.push(label);
      return `[REDACTED:${label}]`;
    });
  }
  return { value, redactions };
}
