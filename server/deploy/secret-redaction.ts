/** Replacement text for a redacted secret value in deploy step output. */
export const REDACTED = '***';

/**
 * Shortest fragment worth redacting. Masking two- or three-character values
 * would shred ordinary log text and still hide nothing useful.
 */
export const MIN_REDACT_LENGTH = 4;

/**
 * A short line exempt from masking: ASCII punctuation only, like the `{` / `}`
 * / `],` lines of a JSON key file. An allowlist, not "no ASCII letters or
 * digits", so non-ASCII letters, digits, and symbols never count as harmless.
 */
const STRUCTURAL_LINE_RE = /^[!-/:-@[-`{-~]*$/;

/**
 * Whether every part of `value` that could identify the secret will be masked.
 * Lines shorter than {@link MIN_REDACT_LENGTH} are not redacted, so a secret is
 * only accepted when each such line is structural punctuation. The store
 * rejects anything else, so no stored secret value can reach deploy output
 * unmasked.
 */
export function isFullyRedactable(value: string): boolean {
  const lines = value.split(/\r?\n/).map((line) => line.trim());
  if (!lines.some((line) => line.length >= MIN_REDACT_LENGTH)) return false;
  return lines.every((line) => line.length >= MIN_REDACT_LENGTH || STRUCTURAL_LINE_RE.test(line));
}

/**
 * Build a line redactor for a set of secret values. Output is processed one
 * line at a time, so a multi-line value (a PEM key) is split into its lines and
 * each line is masked on its own. Longer fragments are replaced first so a
 * value that contains another value is masked whole.
 */
export function createSecretRedactor(values: readonly string[]): (line: string) => string {
  const fragments = new Set<string>();
  for (const value of values) {
    for (const part of value.split(/\r?\n/)) {
      const trimmed = part.trim();
      if (trimmed.length >= MIN_REDACT_LENGTH) fragments.add(trimmed);
    }
  }
  if (fragments.size === 0) return (line) => line;
  const ordered = [...fragments].sort((a, b) => b.length - a.length);
  return (line) => {
    let out = line;
    for (const fragment of ordered) {
      if (out.includes(fragment)) out = out.split(fragment).join(REDACTED);
    }
    return out;
  };
}
