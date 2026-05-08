/**
 * op-redact.ts — Redaction helpers for 1Password CLI output.
 *
 * Prevents resolved secret values and op:// references from leaking into
 * agent logs, daily notes, or kanban card descriptions.
 *
 * Rules:
 * 1. op:// secret reference URIs are always masked (they reveal vault structure).
 * 2. Known plaintext secret values, if provided, are replaced with [redacted].
 * 3. Long token-like strings (≥32 contiguous base64/hex chars) are masked as a
 *    heuristic catch-all for resolved secret values that weren't explicitly
 *    provided to redactOpValues().
 *
 * Usage:
 *   import { redactOpRefs, redactOpValues, redactOpOutput } from './op-redact.js';
 *
 *   // Mask op:// URIs only (safe to call on any string)
 *   const clean = redactOpRefs(rawOutput);
 *
 *   // Mask specific known values (call with the values you want to suppress)
 *   const clean = redactOpValues(rawOutput, [mySecretValue]);
 *
 *   // Full pipeline: refs + known values + heuristic token masking
 *   const clean = redactOpOutput(rawOutput, [knownSecret1, knownSecret2]);
 */

/**
 * Matches op:// secret references. Stops at whitespace, quotes, or backticks.
 * In shell/template usage, unquoted op:// refs do not contain spaces (the shell
 * splits on spaces). Item names with spaces are referenced via UUID or are
 * quoted (the closing quote terminates the match naturally).
 */
const OP_REF_PATTERN = /op:\/\/[^\s"'`]+/g;

/**
 * Heuristic: mask long base64/hex token-like strings.
 *
 * Character class [A-Za-z0-9+/=_-] covers:
 *   - Standard base64 (A-Za-z0-9+/=)
 *   - URL-safe base64 (replaces + with - and / with _), used by 1Password
 *     Service Account tokens (`ops_...`) and many modern API key formats
 *
 * This matches the same class as the bash `op_redact()` helper in
 * scripts/_common.sh so both layers catch the same token shapes.
 *
 * JWT-style tokens (`header.payload.signature`) are masked per-segment since
 * `.` is not in the class. The dot separators remain visible, but the
 * individual segments are redacted — adequate to prevent value leakage.
 * Folding `.` into the class would generate too many false positives on
 * file paths and version strings.
 *
 * Threshold of 32 chars avoids false-positives on short non-secret strings.
 */
const LONG_TOKEN_PATTERN = /[A-Za-z0-9+/=_-]{32,}/g;

/** Placeholder shown in place of a masked op:// reference. */
export const OP_REF_PLACEHOLDER = '[redacted:op-ref]';

/** Placeholder shown in place of a masked known secret value. */
export const SECRET_PLACEHOLDER = '[redacted]';

/** Placeholder shown in place of a heuristically-detected token. */
export const TOKEN_PLACEHOLDER = '[redacted]';

/**
 * Mask all op:// secret reference URIs in `text`.
 * Safe to call on any string; only `op://` URIs are affected.
 */
export function redactOpRefs(text: string): string {
  if (!text) return text;
  return text.replace(OP_REF_PATTERN, OP_REF_PLACEHOLDER);
}

/**
 * Replace every occurrence of each known secret `value` in `text` with
 * `[redacted]`. Comparison is case-sensitive and literal (no regex).
 *
 * Values that are empty strings or shorter than 4 chars are skipped to
 * avoid over-redaction (e.g. redacting common short tokens like "yes").
 */
export function redactOpValues(text: string, values: string[]): string {
  if (!text) return text;
  let result = text;
  for (const v of values) {
    if (!v || v.length < 4) continue;
    // Escape for literal string replacement (not regex)
    const escaped = v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    result = result.replace(new RegExp(escaped, 'g'), SECRET_PLACEHOLDER);
  }
  return result;
}

/**
 * Apply the full redaction pipeline:
 *   1. Mask known secret values (if provided)
 *   2. Mask op:// references
 *   3. Heuristic: mask long token-like strings
 *
 * Use this for any CLI output that might contain resolved secrets before
 * it is logged, surfaced to the model, or written to a card comment.
 */
export function redactOpOutput(text: string, knownValues: string[] = []): string {
  if (!text) return text;
  let result = text;
  result = redactOpValues(result, knownValues);
  result = redactOpRefs(result);
  result = result.replace(LONG_TOKEN_PATTERN, TOKEN_PLACEHOLDER);
  return result;
}
