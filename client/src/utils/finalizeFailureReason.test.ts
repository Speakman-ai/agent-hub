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

  it('returns null for unknown, empty, or non-string reasons', () => {
    expect(describeFinalizeFailureReason('totally_made_up')).toBeNull();
    expect(describeFinalizeFailureReason('')).toBeNull();
    expect(describeFinalizeFailureReason(null)).toBeNull();
    expect(describeFinalizeFailureReason(undefined)).toBeNull();
    expect(describeFinalizeFailureReason(42)).toBeNull();
  });
});
