import { describe, it, expect } from 'vitest';
import { describeMirrorState } from './mirrorStatus.js';

describe('describeMirrorState', () => {
  it('returns null when mirror is disabled or absent', () => {
    expect(describeMirrorState(null)).toBeNull();
    expect(describeMirrorState({ enabled: false, state: { diverged: true } })).toBeNull();
  });

  it('returns null when synced', () => {
    expect(describeMirrorState({ enabled: true, state: { status: 'synced' } })).toBeNull();
  });

  it('hides the transient "ahead" state (outbound mirror handles it)', () => {
    expect(
      describeMirrorState({ enabled: true, state: { status: 'ahead', aheadBy: 2 } }),
    ).toBeNull();
  });

  it('flags divergence as an error with both ahead/behind counts', () => {
    const d = describeMirrorState({
      enabled: true,
      state: { status: 'diverged', diverged: true, aheadBy: 2, behindBy: 1 },
    });
    expect(d.severity).toBe('error');
    expect(d.title).toMatch(/diverged/i);
    expect(d.detail).toMatch(/Hub \+2, GitHub \+1/);
    expect(d.showReconcile).toBe(true);
  });

  it('flags a recorded push error (not yet cleared)', () => {
    const d = describeMirrorState({
      enabled: true,
      state: {
        status: 'behind',
        lastError: '! [rejected]   main -> main (fetch first)\nhint: ...',
      },
    });
    // diverged check is false; lastError path wins for status !== synced.
    expect(d.severity).toBe('error');
    expect(d.detail).toBe('! [rejected]   main -> main (fetch first)');
  });

  it('does not surface a stale error once status is synced again', () => {
    expect(
      describeMirrorState({ enabled: true, state: { status: 'synced', lastError: 'old failure' } }),
    ).toBeNull();
  });

  it('warns when GitHub is ahead and offers reconcile', () => {
    const d = describeMirrorState({ enabled: true, state: { status: 'behind', behindBy: 1 } });
    expect(d.severity).toBe('warn');
    expect(d.detail).toMatch(/1 commit on GitHub is not yet pulled/);
    expect(d.showReconcile).toBe(true);
  });
});
