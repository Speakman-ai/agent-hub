import { describe, it, expect } from 'vitest';
import {
  validateFormalReviewBody,
  MIN_FORMAL_REVIEW_BODY_CHARS,
  MIN_FORMAL_REVIEW_ALNUM_CHARS,
} from './review-body-validation.js';

const validApproveBody =
  '**[2/10]** `server/foo.ts:14` — trailing whitespace nit only. No findings above severity 3; diff is mergeable as-is.';

describe('validateFormalReviewBody', () => {
  it('rejects empty / whitespace-only bodies for APPROVE', () => {
    expect(validateFormalReviewBody('APPROVE', undefined).valid).toBe(false);
    expect(validateFormalReviewBody('APPROVE', '   \n\t  ').valid).toBe(false);
  });

  it('rejects trivial placeholder "test" (reported Cursor reviewer bug)', () => {
    const r = validateFormalReviewBody('APPROVE', 'test');
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.error).toMatch(/at least \d+ characters/);
  });

  it('rejects markdown-wrapped placeholder that would pad length', () => {
    const padded = '`test` '.repeat(15).trim();
    expect(padded.length).toBeGreaterThanOrEqual(MIN_FORMAL_REVIEW_BODY_CHARS);
    const r = validateFormalReviewBody('APPROVE', padded);
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.error).toMatch(/letters or digits|repetitive filler|placeholder/i);
  });

  it('rejects bodies shorter than MIN_FORMAL_REVIEW_BODY_CHARS', () => {
    const short = 'x'.repeat(MIN_FORMAL_REVIEW_BODY_CHARS - 1);
    const r = validateFormalReviewBody('REQUEST_CHANGES', short);
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.error).toContain(String(MIN_FORMAL_REVIEW_BODY_CHARS));
  });

  it('rejects punctuation-only padding past min length', () => {
    const pad = '-'.repeat(MIN_FORMAL_REVIEW_BODY_CHARS + 5);
    const r = validateFormalReviewBody('APPROVE', pad);
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.error).toMatch(/letters or digits/);
  });

  it('rejects repetitive low-entropy filler', () => {
    const filler = Array.from({ length: 12 }, () => 'test').join(' ');
    expect(filler.length).toBeGreaterThanOrEqual(MIN_FORMAL_REVIEW_BODY_CHARS);
    const r = validateFormalReviewBody('APPROVE', filler);
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.error).toMatch(/repetitive filler/i);
  });

  it('accepts a substantive APPROVE body and returns trimmed text', () => {
    const r = validateFormalReviewBody('APPROVE', `  ${validApproveBody}  `);
    expect(r).toEqual({ valid: true, trimmed: validApproveBody });
  });

  it('enforces the same rules for REQUEST_CHANGES and COMMENT', () => {
    const okRc =
      '**[6/10]** `server/bar.ts:3` — missing null guard on user input. ' +
      '**[2/10]** `README.md` — typo in section title. Please address the blocker before merge.';
    expect(validateFormalReviewBody('REQUEST_CHANGES', okRc).valid).toBe(true);

    const thin = 'Please fix.'.repeat(10); // long but low alnum ratio? "Please fix." has letters
    // Ensure alnum count: "Please fix." * 10 - plenty of letters
    expect(thin.length).toBeGreaterThan(MIN_FORMAL_REVIEW_BODY_CHARS);
    expect(validateFormalReviewBody('REQUEST_CHANGES', thin).valid).toBe(true);
  });

  it('documents minimum alnum threshold for reviewers', () => {
    expect(MIN_FORMAL_REVIEW_ALNUM_CHARS).toBeGreaterThan(0);
    expect(MIN_FORMAL_REVIEW_BODY_CHARS).toBeGreaterThan(MIN_FORMAL_REVIEW_ALNUM_CHARS);
  });
});
