import { describe, it, expect } from 'vitest';
import { describeFinalizeFailureReason } from './finalizeFailureReason';

describe('describeFinalizeFailureReason', () => {
  it('explains fix_no_progress (the reported "run just stopped" case)', () => {
    const text = describeFinalizeFailureReason('fix_no_progress');
    expect(text!).toMatch(/did not land a new commit/i);
    // Never just echoes the bare code back.
    expect(text!).not.toBe('fix_no_progress');
  });

  it('explains the common infra and config failure codes', () => {
    expect(describeFinalizeFailureReason('infra_error')).toMatch(/infrastructure/i);
    expect(describeFinalizeFailureReason('container_unavailable')).toMatch(/runner container/i);
    expect(describeFinalizeFailureReason('ci_config_invalid')).toMatch(/ci\.yaml/i);
    expect(describeFinalizeFailureReason('review_failed')).toMatch(/reviewer/i);
    expect(describeFinalizeFailureReason('timeout')).toMatch(/time limit/i);
  });

  it('explains an infra-stalled reviewer as not-your-code, distinct from review_failed', () => {
    const text = describeFinalizeFailureReason('review_stalled');
    expect(text).not.toBeNull();
    expect(text!).toMatch(/infrastructure|quota|timeout/i);
    expect(text!).toMatch(/not a problem with your code|not a problem/i);
    expect(text!).not.toBe('review_stalled');
    // Must not read the same as a genuine review failure.
    expect(text).not.toBe(describeFinalizeFailureReason('review_failed'));
  });

  it('explains a non-converging review loop', () => {
    const text = describeFinalizeFailureReason('review_not_converging');
    expect(text).not.toBeNull();
    expect(text!).toMatch(/not converging|round after round/i);
    expect(text!).not.toBe('review_not_converging');
  });

  it('does not tell a user with a large change set that they changed nothing', () => {
    // Regression: a 325-file session hit no_diff_inputs and was told "There were
    // no code changes for Finalize to review or push." The code means the diff
    // could not be computed, not that the diff was empty.
    const text = describeFinalizeFailureReason('no_diff_inputs');
    expect(text).toMatch(/could not work out the diff/i);
    expect(text).not.toMatch(/no code changes/i);
  });

  it('tells a user with no CI config how to set one up', () => {
    // Regression: `ci_config_missing` had no entry, so the UI rendered the bare
    // machine code with no next step for exactly the users least likely to
    // recognise it — people on a brand-new project.
    const text = describeFinalizeFailureReason('ci_config_missing');
    expect(text).not.toBeNull();
    expect(text!).toMatch(/ci\.yaml/i);
    expect(text!).not.toBe('ci_config_missing');
  });

  it('returns null for unknown, empty, or non-string reasons', () => {
    expect(describeFinalizeFailureReason('totally_made_up')).toBeNull();
    expect(describeFinalizeFailureReason('')).toBeNull();
    expect(describeFinalizeFailureReason(null)).toBeNull();
    expect(describeFinalizeFailureReason(undefined)).toBeNull();
    expect(describeFinalizeFailureReason(42)).toBeNull();
  });
});
