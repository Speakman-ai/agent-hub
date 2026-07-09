/**
 * Job-queue tests against a real in-memory better-sqlite3 so the atomic claim
 * SQL, indexes, and status CHECK are exercised against the actual schema.
 *
 * A mutable `clock` stands in for Date.now so backoff windows and the reaper's
 * stuck-timeout are driven deterministically without real timers. The worker
 * loop is generally driven by calling `tick()` directly rather than starting
 * the setInterval-based loop, so tests stay fast and deterministic.
 */
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JOBS_SCHEMA } from './schema.js';
import { JobQueue, type JobRow } from './job-queue.js';

let db: Database.Database;
let clock: number;
const now = () => clock;
const silent = () => {};

function makeQueue(opts: Partial<ConstructorParameters<typeof JobQueue>[0]> = {}): JobQueue {
  return new JobQueue({ db, now, log: silent, ...opts });
}

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(JOBS_SCHEMA);
  clock = 1_000_000;
});

afterEach(() => {
  db.close();
});

describe('enqueue + claim', () => {
  it('claims in priority then FIFO order and marks running with an attempt', () => {
    const q = makeQueue();
    q.enqueue('t', { n: 1 }, { priority: 5 });
    clock += 1; // ensure distinct created_at ordering intent, though FIFO tie-breaks on rowid too
    const highId = q.enqueue('t', { n: 2 }, { priority: 1 });
    clock += 1;
    q.enqueue('t', { n: 3 }, { priority: 5 });

    const first = q.claim();
    expect(first?.id).toBe(highId); // lowest priority value wins
    expect(first?.status).toBe('running');
    expect(first?.attempts).toBe(1);
    expect(first?.claimed_by).toBeTruthy();
    expect(first?.claimed_at).toBe(clock);
    expect(JSON.parse(first!.payload)).toEqual({ n: 2 });
  });

  it('does not claim jobs whose run_at is in the future (delayed)', () => {
    const q = makeQueue();
    q.enqueue('t', {}, { delayMs: 10_000 });
    expect(q.claim()).toBeUndefined();
    clock += 10_000;
    expect(q.claim()?.status).toBe('running');
  });

  it('returns undefined when the queue is empty', () => {
    expect(makeQueue().claim()).toBeUndefined();
  });
});

describe('atomic claim (concurrency / race)', () => {
  it('never hands the same job to two claimants', () => {
    // One shared db, many queue instances (distinct workerIds) all claiming.
    const N = 200;
    const producer = makeQueue();
    for (let i = 0; i < N; i++) producer.enqueue('t', { i });

    const workers = Array.from({ length: 8 }, (_, w) => makeQueue({ workerId: `w${w}` }));

    const claimedIds: string[] = [];
    // Round-robin claim across workers until the queue drains. Because the
    // claim is a single atomic UPDATE, no row can be claimed twice.
    let idle = 0;
    let wi = 0;
    while (idle < workers.length) {
      const row = workers[wi % workers.length].claim();
      if (row) {
        claimedIds.push(row.id);
        idle = 0;
      } else {
        idle++;
      }
      wi++;
    }

    expect(claimedIds).toHaveLength(N);
    expect(new Set(claimedIds).size).toBe(N); // no duplicates → no double-claim

    const running = db.prepare(`SELECT COUNT(*) c FROM jobs WHERE status='running'`).get() as {
      c: number;
    };
    expect(running.c).toBe(N);
  });
});

describe('process: success / retry / dead-letter', () => {
  it('marks a job done when the handler resolves', async () => {
    const q = makeQueue();
    const seen: unknown[] = [];
    q.register('greet', async (job) => {
      seen.push(job.payload);
    });
    const id = q.enqueue('greet', { hi: true });
    await q.process(q.claim()!);
    expect(seen).toEqual([{ hi: true }]);
    expect(q.getJob(id)?.status).toBe('done');
  });

  it('retries with exponential backoff on failure, then dead-letters at max attempts', async () => {
    const q = makeQueue({ backoff: { baseMs: 1000, factor: 2, maxMs: 60_000 } });
    q.register('boom', async () => {
      throw new Error('kaboom');
    });
    const id = q.enqueue('boom', {}, { maxAttempts: 3 });

    // Attempt 1 → fails → requeued, run_at = now + 1000
    await q.process(q.claim()!);
    let row = q.getJob(id)!;
    expect(row.status).toBe('queued');
    expect(row.attempts).toBe(1);
    expect(row.last_error).toContain('kaboom');
    expect(row.run_at).toBe(clock + 1000);

    // Not eligible until the backoff window elapses.
    expect(q.claim()).toBeUndefined();
    clock += 1000;

    // Attempt 2 → fails → requeued, run_at = now + 2000
    await q.process(q.claim()!);
    row = q.getJob(id)!;
    expect(row.status).toBe('queued');
    expect(row.attempts).toBe(2);
    expect(row.run_at).toBe(clock + 2000);
    clock += 2000;

    // Attempt 3 → fails → dead-letter (attempts == maxAttempts)
    await q.process(q.claim()!);
    row = q.getJob(id)!;
    expect(row.status).toBe('dead_letter');
    expect(row.attempts).toBe(3);
    expect(row.last_error).toContain('kaboom');
    expect(q.claim()).toBeUndefined(); // dead jobs are never claimed
  });

  it('leaves a job queued and REFUNDS the claim attempt when no handler is registered', async () => {
    const q = makeQueue({ unhandledRetryDelayMs: 5000 });
    const id = q.enqueue('unknown', {}, { maxAttempts: 5 });

    await q.process(q.claim()!);
    let row = q.getJob(id)!;
    expect(row.status).toBe('queued');
    expect(row.last_error).toContain('no handler');
    expect(row.attempts).toBe(0); // claim charged 1, no-handler release refunded it
    expect(row.run_at).toBe(clock + 5000); // deferred, not re-claimable immediately
    expect(row.lease_id).toBeNull();
    expect(q.claim()).toBeUndefined(); // deferred window not elapsed → slot not churned

    // Regression: repeated no-handler cycles must not run attempts unbounded.
    for (let i = 0; i < 10; i++) {
      clock += 5000;
      await q.process(q.claim()!);
      row = q.getJob(id)!;
      expect(row.status).toBe('queued');
      expect(row.attempts).toBe(0);
    }

    // Once a handler finally registers, the job still gets its full attempt
    // budget — it does not dead-letter prematurely.
    const seen: unknown[] = [];
    q.register('unknown', async (job) => {
      seen.push(job.id);
    });
    clock += 5000;
    await q.process(q.claim()!);
    row = q.getJob(id)!;
    expect(row.status).toBe('done');
    expect(row.attempts).toBe(1);
    expect(seen).toHaveLength(1);
  });
});

describe('reaper', () => {
  it('reclaims a job whose worker died and re-queues it with backoff', () => {
    const q = makeQueue({ stuckTimeoutMs: 30_000, backoff: { baseMs: 1000, factor: 2 } });
    const id = q.enqueue('t', {}, { maxAttempts: 3 });
    const claimed = q.claim()!; // status running, attempts 1, claimed_at = clock
    expect(claimed.status).toBe('running');

    // Not yet stuck.
    clock += 10_000;
    expect(q.reap()).toBe(0);
    expect(q.getJob(id)?.status).toBe('running');

    // Past the stuck timeout → reaped back to queued.
    clock += 25_000; // total 35s > 30s
    expect(q.reap()).toBe(1);
    const row = q.getJob(id)!;
    expect(row.status).toBe('queued');
    expect(row.attempts).toBe(1); // attempt was charged at claim, not re-charged
    expect(row.claimed_by).toBeNull();
    expect(row.last_error).toContain('reaped');
  });

  it('dead-letters a reaped job that has exhausted its attempts', () => {
    const q = makeQueue({ stuckTimeoutMs: 10_000 });
    const id = q.enqueue('t', {}, { maxAttempts: 1 });
    q.claim(); // attempts → 1 == maxAttempts
    clock += 20_000;
    expect(q.reap()).toBe(1);
    expect(q.getJob(id)?.status).toBe('dead_letter');
  });

  it('a zombie handler that finishes after its job was reaped cannot clobber the new claim', async () => {
    // The dangerous overlap: worker A claims, its handler outlives the stuck
    // timeout, the reaper requeues the job, worker B re-claims and finishes —
    // then A's stale completion must be discarded, not flip B's row to done.
    const q = makeQueue({ stuckTimeoutMs: 30_000, backoff: { baseMs: 1000 } });
    q.register('t', async () => {}); // trivial success handler
    const id = q.enqueue('t', {}, { maxAttempts: 5 });

    const leaseA = q.claim()!; // worker A, lease A, attempts 1
    expect(leaseA.status).toBe('running');

    // A's handler is still running when the reaper fires past the timeout.
    clock += 30_001;
    expect(q.reap()).toBe(1);
    let row = q.getJob(id)!;
    expect(row.status).toBe('queued');
    expect(row.lease_id).toBeNull();

    // Worker B re-claims (after the reap backoff window) and completes normally.
    clock += 1000;
    const leaseB = q.claim()!; // lease B, attempts 2
    expect(leaseB.lease_id).not.toBe(leaseA.lease_id);
    await q.process(leaseB);
    row = q.getJob(id)!;
    expect(row.status).toBe('done');
    expect(row.attempts).toBe(2);

    // Now A's zombie handler finally settles against its STALE lease.
    await q.process(leaseA);
    row = q.getJob(id)!;
    // B's terminal state stands; A's late markDone was a lease-guarded no-op.
    expect(row.status).toBe('done');
    expect(row.attempts).toBe(2);
  });

  it('a zombie retry does not resurrect a job the new claim already dead-lettered', async () => {
    const q = makeQueue({ stuckTimeoutMs: 30_000, backoff: { baseMs: 1 } });
    q.register('boom', async () => {
      throw new Error('boom');
    });
    const id = q.enqueue('boom', {}, { maxAttempts: 2 });

    const leaseA = q.claim()!; // attempts 1
    clock += 30_001;
    q.reap(); // requeue (attempts still 1, < max), run_at = now + 1ms backoff
    clock += 10;
    const leaseB = q.claim()!; // attempts 2 == max
    await q.process(leaseB); // fails at max → dead_letter
    expect(q.getJob(id)?.status).toBe('dead_letter');

    // A's zombie failure settle targets the stale lease → no-op.
    await q.process(leaseA);
    expect(q.getJob(id)?.status).toBe('dead_letter');
  });
});

describe('worker loop', () => {
  it('drains the queue via tick() respecting concurrency', async () => {
    const q = makeQueue({ concurrency: 3, now: Date.now });
    let active = 0;
    let peak = 0;
    const gate: Array<() => void> = [];
    q.register('slow', async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => gate.push(() => resolve()));
      active--;
    });
    for (let i = 0; i < 6; i++) q.enqueue('slow');

    q.start();
    // Let the loop claim up to the concurrency cap.
    await vi.waitFor(() => expect(q.inFlightCount).toBe(3));
    expect(peak).toBe(3);
    // Release all; the loop should pick up the remaining jobs.
    while (gate.length) gate.shift()!();
    await vi.waitFor(() => {
      const done = db.prepare(`SELECT COUNT(*) c FROM jobs WHERE status='done'`).get() as {
        c: number;
      };
      // keep releasing any newly gated handlers
      while (gate.length) gate.shift()!();
      expect(done.c).toBe(6);
    });
    await q.shutdown();
  });

  it('shutdown awaits in-flight handlers (no job left running)', async () => {
    const q = makeQueue({ concurrency: 1, now: Date.now });
    let release: () => void = () => {};
    let finished = false;
    q.register('hold', async () => {
      await new Promise<void>((r) => {
        release = r;
      });
      finished = true;
    });
    const id = q.enqueue('hold');
    q.start();
    await vi.waitFor(() => expect(q.inFlightCount).toBe(1));

    const shutdownPromise = q.shutdown();
    // Handler still running until we release it.
    expect(finished).toBe(false);
    release();
    await shutdownPromise;
    expect(finished).toBe(true);
    expect((q.getJob(id) as JobRow).status).toBe('done');
    expect(q.inFlightCount).toBe(0);
  });
});
