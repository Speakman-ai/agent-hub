import { describe, expect, it } from 'vitest';
import { PtyResizeArbiter } from './pty-resize-arbiter.js';

describe('PtyResizeArbiter', () => {
  it('returns null with no viewers', () => {
    const a = new PtyResizeArbiter();
    expect(a.effectiveSize()).toBeNull();
    expect(a.viewerCount).toBe(0);
  });

  it('a single viewer sets the effective size directly', () => {
    const a = new PtyResizeArbiter();
    a.set('v1', { cols: 120, rows: 40 });
    expect(a.effectiveSize()).toEqual({ cols: 120, rows: 40 });
  });

  it('takes the per-axis minimum across viewers (tmux smallest)', () => {
    const a = new PtyResizeArbiter();
    a.set('wide-short', { cols: 200, rows: 24 });
    a.set('narrow-tall', { cols: 80, rows: 60 });
    // cols from the narrow viewer, rows from the short viewer.
    expect(a.effectiveSize()).toEqual({ cols: 80, rows: 24 });
  });

  it('re-arbitrates upward when the smallest viewer detaches', () => {
    const a = new PtyResizeArbiter();
    a.set('big', { cols: 200, rows: 50 });
    a.set('small', { cols: 80, rows: 24 });
    expect(a.effectiveSize()).toEqual({ cols: 80, rows: 24 });

    expect(a.remove('small')).toBe(true);
    expect(a.effectiveSize()).toEqual({ cols: 200, rows: 50 });
    expect(a.remove('small')).toBe(false);
  });

  it('updating a viewer changes the arbitration', () => {
    const a = new PtyResizeArbiter();
    a.set('v1', { cols: 100, rows: 30 });
    a.set('v2', { cols: 100, rows: 30 });
    a.set('v2', { cols: 100, rows: 10 });
    expect(a.effectiveSize()).toEqual({ cols: 100, rows: 10 });
  });

  it('clamps non-finite / sub-1 dimensions to 1 and floors fractions', () => {
    const a = new PtyResizeArbiter();
    a.set('bad', { cols: 0, rows: -5 });
    expect(a.effectiveSize()).toEqual({ cols: 1, rows: 1 });

    a.remove('bad');
    a.set('nan', { cols: Number.NaN, rows: Infinity });
    expect(a.effectiveSize()).toEqual({ cols: 1, rows: 1 });

    a.remove('nan');
    a.set('frac', { cols: 80.9, rows: 24.9 });
    expect(a.effectiveSize()).toEqual({ cols: 80, rows: 24 });
  });
});
