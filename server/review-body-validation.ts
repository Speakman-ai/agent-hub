/**
 * Validates formal PR review bodies submitted to POST /api/pr/review.
 *
 * GitHub allows APPROVE with an empty or trivial body; Agent Hub requires a
 * substantive markdown summary so automated reviewer sessions cannot land
 * misleading rubber-stamp approvals when stream output is truncated or
 * degenerate (e.g. the model emits "test" and still picks APPROVE).
 */

export type FormalReviewEvent = 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';

/** Minimum trimmed length for any formal review body (all events). */
export const MIN_FORMAL_REVIEW_BODY_CHARS = 40;

/** Minimum letters + digits so bodies cannot be punctuation/whitespace padding. */
export const MIN_FORMAL_REVIEW_ALNUM_CHARS = 18;

const EXACT_PLACEHOLDER_BODIES = new Set(
  [
    'test',
    'testing',
    'ok',
    'okay',
    'k',
    'kk',
    'yes',
    'yep',
    'no',
    'nope',
    'nah',
    'n/a',
    'na',
    'none',
    'nothing',
    'placeholder',
    'tbd',
    'todo',
    'wip',
    'lgtm',
    'ship it',
    'shipit',
    'approved',
    'approve',
    'looks good',
    'looks good to me',
    'pass',
    'passed',
    'fine',
    'done',
    '.',
    '..',
    '...',
    '-',
    '--',
    '—',
  ].map((s) => s.toLowerCase()),
);

function normalizeForPlaceholderCheck(s: string): string {
  return s
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[`_*#>[\]()]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function countLetterAndDigitChars(s: string): number {
  const m = s.match(/[\p{L}\p{N}]/gu);
  return m ? m.length : 0;
}

/**
 * True when the body is mostly a tiny vocabulary repeated many times
 * (e.g. "test test test ...") — catches padding past MIN_FORMAL_REVIEW_BODY_CHARS.
 */
function isRepetitiveLowEntropyBody(trimmed: string): boolean {
  const tokens = trimmed.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  if (tokens.length < 10) return false;
  const unique = new Set(tokens);
  if (unique.size > 3) return false;
  const trivial = new Set([
    'test',
    'testing',
    'ok',
    'okay',
    'yes',
    'yep',
    'no',
    'nope',
    'nah',
    'a',
    'x',
    'foo',
    'bar',
    'baz',
    'lgtm',
    'hi',
    'hey',
  ]);
  return [...unique].every((w) => trivial.has(w));
}

export type ValidateFormalReviewBodyResult =
  | { valid: true; trimmed: string }
  | { valid: false; error: string };

/**
 * Validates the review body for Agent Hub's formal review endpoint.
 * All events require a non-empty, substantive body.
 */
export function validateFormalReviewBody(
  event: FormalReviewEvent,
  body: string | undefined,
): ValidateFormalReviewBodyResult {
  void event; // same rules for APPROVE / REQUEST_CHANGES / COMMENT
  const trimmed = typeof body === 'string' ? body.trim() : '';
  if (!trimmed) {
    return { valid: false, error: 'body is required and must not be empty or whitespace-only' };
  }
  if (trimmed.length < MIN_FORMAL_REVIEW_BODY_CHARS) {
    return {
      valid: false,
      error: `body must be at least ${MIN_FORMAL_REVIEW_BODY_CHARS} characters (substantive review summary)`,
    };
  }
  const alnum = countLetterAndDigitChars(trimmed);
  if (alnum < MIN_FORMAL_REVIEW_ALNUM_CHARS) {
    return {
      valid: false,
      error: `body must contain at least ${MIN_FORMAL_REVIEW_ALNUM_CHARS} letters or digits (not only punctuation or symbols)`,
    };
  }
  const normalized = normalizeForPlaceholderCheck(trimmed);
  if (EXACT_PLACEHOLDER_BODIES.has(normalized)) {
    return {
      valid: false,
      error: 'body is placeholder-only and cannot be submitted as a formal review',
    };
  }
  if (isRepetitiveLowEntropyBody(trimmed)) {
    return {
      valid: false,
      error: 'body appears to be repetitive filler rather than a substantive review',
    };
  }
  return { valid: true, trimmed };
}
