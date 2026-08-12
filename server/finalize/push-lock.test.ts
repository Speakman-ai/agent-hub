import { describe, expect, it, vi } from 'vitest';
import { acquirePushLock, type PushLockStmts } from './push-lock.js';

/**
 * In-memory stand-in for the four `finalize_push_locks` statements, with the
 * same `INSERT OR IGNORE` semantics better-sqlite3 gives us: the insert only
 * takes effect when the (project, base) key is free.
 */
function fakeLockStmts(clock: { now: number }) {
  const rows = new Map<string, { holder_run_id: string; acquired_at: number }>();
  const key = (p: string, b: string) => `${p}::${b}`;
  const stmts = {
    acquireFinalizePushLock: {
      run: vi.fn((p: string, b: string, holder: string, at: number) => {
        if (rows.has(key(p, b))) return { changes: 0 };
        rows.set(key(p, b), { holder_run_id: holder, acquired_at: at });
        return { changes: 1 };
      }),
    },
    getFinalizePushLock: {
      get: vi.fn((p: string, b: string) => {
        const row = rows.get(key(p, b));
        return row ? { project_id: p, base_branch: b, ...row } : undefined;
      }),
    },
    releaseFinalizePushLock: {
      run: vi.fn((p: string, b: string, holder: string) => {
        const row = rows.get(key(p, b));
        if (row?.holder_run_id === holder) rows.delete(key(p, b));
        return { changes: 1 };
      }),
    },
    expireFinalizePushLock: {
      run: vi.fn((p: string, b: string, cutoff: number) => {
        const row = rows.get(key(p, b));
        if (row && row.acquired_at < cutoff) rows.delete(key(p, b));
        return { changes: 1 };
      }),
    },
    touchFinalizePushLock: {
      run: vi.fn((at: number, p: string, b: string, holder: string) => {
        const row = rows.get(key(p, b));
        // Holder-scoped, like the real UPDATE.
        if (row?.holder_run_id === holder) row.acquired_at = at;
        return { changes: 1 };
      }),
    },
  } as unknown as PushLockStmts;
  return { stmts, rows, clock };
}

/** Timer double: collects the heartbeat callback instead of scheduling it. */
function manualTimers() {
  const ticks: Array<() => void> = [];
  let cleared = 0;
  return {
    timers: {
      setInterval: (fn: () => void) => {
        ticks.push(fn);
        return ticks.length - 1;
      },
      clearInterval: () => {
        cleared += 1;
      },
    },
    tick: () => ticks.forEach((fn) => fn()),
    clearedCount: () => cleared,
  };
}

const base = (stmts: PushLockStmts, clock: { now: number }, holderRunId: string) => ({
  stmts,
  projectId: 'proj-1',
  baseBranch: 'main',
  holderRunId,
  now: () => clock.now,
  sleep: async (ms: number) => {
    clock.now += ms;
  },
});

describe('acquirePushLock', () => {
  it('lets one holder in and refuses a second run after the wait expires', async () => {
    const clock = { now: 1_000 };
    const { stmts } = fakeLockStmts(clock);

    const first = await acquirePushLock(base(stmts, clock, 'run-a'));
    expect(first.ok).toBe(true);

    const second = await acquirePushLock({
      ...base(stmts, clock, 'run-b'),
      waitMs: 2_000,
      pollMs: 500,
    });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.heldBy).toBe('run-a');
  });

  it('acquires once the holder releases mid-wait', async () => {
    const clock = { now: 1_000 };
    const { stmts } = fakeLockStmts(clock);
    const first = await acquirePushLock(base(stmts, clock, 'run-a'));
    expect(first.ok).toBe(true);

    let slept = 0;
    const second = await acquirePushLock({
      ...base(stmts, clock, 'run-b'),
      waitMs: 10_000,
      pollMs: 500,
      sleep: async (ms: number) => {
        clock.now += ms;
        slept += 1;
        // The holder finishes landing while run-b is waiting.
        if (slept === 2 && first.ok) first.handle.release();
      },
    });

    expect(second.ok).toBe(true);
    expect(slept).toBe(2);
  });

  // The automation path holds the lock around push + merge, then calls
  // runFinalizePush, which takes it again by the same run id.
  it('is re-entrant for the same run and the inner release does not free it', async () => {
    const clock = { now: 1_000 };
    const { stmts } = fakeLockStmts(clock);

    const outer = await acquirePushLock(base(stmts, clock, 'run-a'));
    const inner = await acquirePushLock(base(stmts, clock, 'run-a'));
    expect(inner.ok).toBe(true);
    if (!inner.ok || !outer.ok) return;
    expect(inner.handle.reentrant).toBe(true);

    inner.handle.release();

    // Still held by run-a, so an unrelated run is still locked out.
    const other = await acquirePushLock({ ...base(stmts, clock, 'run-b'), waitMs: 0 });
    expect(other.ok).toBe(false);

    outer.handle.release();
    const after = await acquirePushLock({ ...base(stmts, clock, 'run-b'), waitMs: 0 });
    expect(after.ok).toBe(true);
  });

  it('takes over a lock whose holder died', async () => {
    const clock = { now: 1_000 };
    const { stmts } = fakeLockStmts(clock);
    await acquirePushLock(base(stmts, clock, 'run-dead'));

    clock.now += 20 * 60_000;
    const taken = await acquirePushLock({
      ...base(stmts, clock, 'run-b'),
      waitMs: 0,
      staleMs: 15 * 60_000,
    });
    expect(taken.ok).toBe(true);
  });

  it('ignores a release from a run whose lock was already taken over', async () => {
    const clock = { now: 1_000 };
    const { stmts } = fakeLockStmts(clock);
    const dead = await acquirePushLock(base(stmts, clock, 'run-dead'));

    clock.now += 20 * 60_000;
    const taken = await acquirePushLock({
      ...base(stmts, clock, 'run-b'),
      waitMs: 0,
      staleMs: 15 * 60_000,
    });
    expect(taken.ok).toBe(true);

    // The zombie wakes up and releases; that must not free run-b's lock.
    if (dead.ok) dead.handle.release();
    const other = await acquirePushLock({ ...base(stmts, clock, 'run-c'), waitMs: 0 });
    expect(other.ok).toBe(false);
    if (!other.ok) expect(other.heldBy).toBe('run-b');
  });

  it('release is idempotent', async () => {
    const clock = { now: 1_000 };
    const { stmts } = fakeLockStmts(clock);
    const got = await acquirePushLock(base(stmts, clock, 'run-a'));
    if (!got.ok) throw new Error('expected lock');
    got.handle.release();
    got.handle.release();
    expect(
      (stmts.releaseFinalizePushLock as unknown as { run: { mock: { calls: unknown[] } } }).run.mock
        .calls.length,
    ).toBe(1);
  });

  it('no-ops when the lock statements are not wired', async () => {
    const clock = { now: 1_000 };
    const got = await acquirePushLock(base({} as PushLockStmts, clock, 'run-a'));
    expect(got.ok).toBe(true);
    if (got.ok) got.handle.release();
  });
});

describe('acquirePushLock heartbeat', () => {
  // Regression: the lock aged out from its original acquired_at, so a push
  // plus an awaited auto-merge running past the stale window could be taken
  // over while the first holder was still landing — reopening the exact race
  // the lock closes.
  it('keeps a long hold alive so it is not taken over as stale', async () => {
    const clock = { now: 1_000 };
    const { stmts } = fakeLockStmts(clock);
    const timers = manualTimers();

    const held = await acquirePushLock({
      ...base(stmts, clock, 'run-long'),
      timers: timers.timers,
    });
    expect(held.ok).toBe(true);

    // A 20-minute landing, heartbeating every minute.
    for (let minute = 0; minute < 20; minute += 1) {
      clock.now += 60_000;
      timers.tick();
    }

    const other = await acquirePushLock({
      ...base(stmts, clock, 'run-b'),
      waitMs: 0,
      staleMs: 15 * 60_000,
    });
    expect(other.ok).toBe(false);
    if (!other.ok) expect(other.heldBy).toBe('run-long');
  });

  it('stops heartbeating after release', async () => {
    const clock = { now: 1_000 };
    const { stmts } = fakeLockStmts(clock);
    const timers = manualTimers();

    const held = await acquirePushLock({
      ...base(stmts, clock, 'run-a'),
      timers: timers.timers,
    });
    if (!held.ok) throw new Error('expected lock');

    held.handle.release();
    expect(timers.clearedCount()).toBe(1);

    const touch = stmts.touchFinalizePushLock as unknown as { run: { mock: { calls: unknown[] } } };
    const before = touch.run.mock.calls.length;
    timers.tick();
    held.handle.renew();
    expect(touch.run.mock.calls.length).toBe(before);
  });

  // A holder taken over as stale must not resurrect its claim by heartbeating
  // onto the new holder's row.
  it('a taken-over holder cannot refresh the new holder lock', async () => {
    const clock = { now: 1_000 };
    const { stmts, rows } = fakeLockStmts(clock);
    const timers = manualTimers();

    const dead = await acquirePushLock({
      ...base(stmts, clock, 'run-dead'),
      timers: timers.timers,
    });
    if (!dead.ok) throw new Error('expected lock');

    clock.now += 20 * 60_000;
    const taken = await acquirePushLock({
      ...base(stmts, clock, 'run-b'),
      waitMs: 0,
      staleMs: 15 * 60_000,
    });
    expect(taken.ok).toBe(true);

    const acquiredAt = rows.get('proj-1::main')?.acquired_at;
    clock.now += 5_000;
    dead.handle.renew();
    expect(rows.get('proj-1::main')?.holder_run_id).toBe('run-b');
    expect(rows.get('proj-1::main')?.acquired_at).toBe(acquiredAt);
  });
});
