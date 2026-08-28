import { describe, it, expect, vi } from 'vitest';
import { runCoalescedReconcile, type ReconcileRefs } from './coalescedReconcile';

function makeRefs(): ReconcileRefs {
  return { inFlight: { current: null }, queued: { current: false } };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('runCoalescedReconcile', () => {
  it('runs a single pass when nothing is queued and does not schedule a follow-up', async () => {
    const refs = makeRefs();
    const reloadOnce = vi.fn().mockResolvedValue(['a']);
    const scheduleFollowUp = vi.fn();

    const result = await runCoalescedReconcile(refs, {
      maxPasses: 3,
      reloadOnce,
      scheduleFollowUp,
    });

    expect(result).toEqual(['a']);
    expect(reloadOnce).toHaveBeenCalledTimes(1);
    expect(scheduleFollowUp).not.toHaveBeenCalled();
    expect(refs.inFlight.current).toBeNull();
    expect(refs.queued.current).toBe(false);
  });

  it('coalesces concurrent calls onto the in-flight reconcile', async () => {
    const refs = makeRefs();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const reloadOnce = vi.fn().mockImplementation(async () => {
      await gate;
      return ['x'];
    });
    const scheduleFollowUp = vi.fn();

    const first = runCoalescedReconcile(refs, { maxPasses: 3, reloadOnce, scheduleFollowUp });
    // A concurrent call while the first is in flight must not start a 2nd reload.
    const second = runCoalescedReconcile(refs, { maxPasses: 3, reloadOnce, scheduleFollowUp });
    expect(refs.queued.current).toBe(true);

    release();
    await Promise.all([first, second]);

    // The queued refresh triggers exactly one more pass (2 total), then settles.
    expect(reloadOnce).toHaveBeenCalledTimes(2);
    expect(refs.queued.current).toBe(false);
    expect(scheduleFollowUp).not.toHaveBeenCalled();
  });

  it('caps re-run passes and schedules a follow-up when work is still queued', async () => {
    const refs = makeRefs();
    // Every pass, simulate a fresh event arriving mid-reload so the queue never
    // drains on its own — this is the sustained-activity case.
    const reloadOnce = vi.fn().mockImplementation(async () => {
      await tick();
      refs.queued.current = true;
      return ['y'];
    });
    const scheduleFollowUp = vi.fn();

    await runCoalescedReconcile(refs, { maxPasses: 3, reloadOnce, scheduleFollowUp });

    // Bounded to maxPasses despite the queue always being set.
    expect(reloadOnce).toHaveBeenCalledTimes(3);
    // The still-queued refresh is NOT dropped — a follow-up is scheduled once,
    // and the queued flag is consumed so the next reconcile starts clean.
    expect(scheduleFollowUp).toHaveBeenCalledTimes(1);
    expect(refs.queued.current).toBe(false);
    expect(refs.inFlight.current).toBeNull();
  });
});
