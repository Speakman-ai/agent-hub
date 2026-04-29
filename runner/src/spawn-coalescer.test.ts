/**
 * Pure tests for the SpawnCoalescer. Uses injected setTimeout/
 * clearTimeout shims so timing is deterministic — no real timers, no
 * vi.useFakeTimers complexity.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { SpawnCoalescer, type CoalescerFrame } from './spawn-coalescer.js';

interface FakeTimer {
  fn: () => void;
  ms: number;
  cancelled: boolean;
}

class FakeClock {
  timers: FakeTimer[] = [];
  setTimeout = (fn: () => void, ms: number): FakeTimer => {
    const t: FakeTimer = { fn, ms, cancelled: false };
    this.timers.push(t);
    return t;
  };
  clearTimeout = (h: unknown): void => {
    if (h && typeof h === 'object' && 'cancelled' in h) {
      (h as FakeTimer).cancelled = true;
    }
  };
  /** Fire every pending non-cancelled timer in registration order. */
  flush(): void {
    const due = this.timers.filter((t) => !t.cancelled);
    this.timers = [];
    for (const t of due) t.fn();
  }
}

function makeCoalescer(spawnId = 'spawn-1') {
  const clock = new FakeClock();
  const frames: CoalescerFrame[] = [];
  const c = new SpawnCoalescer({
    spawnId,
    emit: (f) => frames.push(f),
    flushIntervalMs: 50,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  });
  return { c, clock, frames };
}

describe('SpawnCoalescer', () => {
  let env: ReturnType<typeof makeCoalescer>;

  beforeEach(() => {
    env = makeCoalescer();
  });

  it('does not emit synchronously on first write — waits for the timer', () => {
    env.c.write('stdout', 'hello');
    expect(env.frames).toEqual([]);
  });

  it('emits one frame per channel per flush window', () => {
    env.c.write('stdout', 'hello ');
    env.c.write('stdout', 'world');
    env.clock.flush();
    expect(env.frames).toEqual([{ channel: 'stdout', data: 'hello world', seq: 0 }]);
  });

  it('keeps stdout and stderr in independent buffers + seq counters', () => {
    env.c.write('stdout', 'a');
    env.c.write('stderr', 'b');
    env.clock.flush();
    expect(env.frames).toEqual([
      { channel: 'stdout', data: 'a', seq: 0 },
      { channel: 'stderr', data: 'b', seq: 0 },
    ]);
  });

  it('increments seq monotonically per channel across windows', () => {
    env.c.write('stdout', 'one');
    env.clock.flush();
    env.c.write('stdout', 'two');
    env.clock.flush();
    env.c.write('stdout', 'three');
    env.clock.flush();
    expect(env.frames.map((f) => f.seq)).toEqual([0, 1, 2]);
    expect(env.frames.map((f) => f.data)).toEqual(['one', 'two', 'three']);
  });

  it('ignores empty writes and never emits zero-byte frames', () => {
    env.c.write('stdout', '');
    env.clock.flush();
    expect(env.frames).toEqual([]);
  });

  it('flushNow() drains both channels immediately', () => {
    env.c.write('stdout', 'pending-out');
    env.c.write('stderr', 'pending-err');
    env.c.flushNow();
    // No clock.flush() call — flushNow drains synchronously.
    expect(env.frames).toEqual([
      { channel: 'stdout', data: 'pending-out', seq: 0 },
      { channel: 'stderr', data: 'pending-err', seq: 0 },
    ]);
  });

  it('flushNow() cancels the pending timer so it cannot double-emit', () => {
    env.c.write('stdout', 'x');
    env.c.flushNow();
    env.clock.flush();
    expect(env.frames).toHaveLength(1);
  });

  it('write() after flushNow() is a no-op (closed)', () => {
    env.c.flushNow();
    env.c.write('stdout', 'late');
    env.clock.flush();
    expect(env.frames).toEqual([]);
  });

  it('does not schedule a second timer while one is already pending', () => {
    env.c.write('stdout', 'a');
    env.c.write('stdout', 'b');
    env.c.write('stdout', 'c');
    // Only one timer is alive — flushing it produces a single combined frame.
    env.clock.flush();
    expect(env.frames).toEqual([{ channel: 'stdout', data: 'abc', seq: 0 }]);
  });

  it('does not emit when both buffers are empty at flush time', () => {
    // Force a flush of stdout while stderr has never been touched.
    env.c.write('stdout', 'x');
    env.clock.flush();
    expect(env.frames).toHaveLength(1);
    // stderr nextSeq stays at 0 — no phantom frame.
    expect(env.c.getNextSeq('stderr')).toBe(0);
  });
});
