/**
 * Admin helpers for the job queue — exercised against a real in-memory
 * better-sqlite3 with the actual JOBS_SCHEMA, so the filter SQL, status
 * CHECK, and the dead-letter retry guard all run against the real table.
 */
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JOBS_SCHEMA } from './schema.js';
import { JobQueue } from './job-queue.js';
import {
  listJobs,
  countJobsByStatus,
  listJobTypes,
  retryDeadLetterJob,
  deleteJob,
  getJobRow,
  isJobStatus,
} from './admin.js';

let db: Database.Database;
let clock: number;
const now = () => clock;

function makeQueue() {
  return new JobQueue({ db, now, log: () => {} });
}

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(JOBS_SCHEMA);
  clock = 1_000_000;
});

afterEach(() => {
  db.close();
});

describe('isJobStatus', () => {
  it('accepts the four valid states and rejects others', () => {
    for (const s of ['queued', 'running', 'done', 'dead_letter']) {
      expect(isJobStatus(s)).toBe(true);
    }
    expect(isJobStatus('nope')).toBe(false);
    expect(isJobStatus(42)).toBe(false);
    expect(isJobStatus(undefined)).toBe(false);
  });
});

describe('listJobs', () => {
  it('returns newest-first and filters by status and type', () => {
    const q = makeQueue();
    const a = q.enqueue('alpha', { n: 1 });
    clock += 10;
    const b = q.enqueue('beta', { n: 2 });
    clock += 10;
    const c = q.enqueue('alpha', { n: 3 });

    const all = listJobs(db);
    expect(all.map((r) => r.id)).toEqual([c, b, a]); // created_at DESC

    const alphas = listJobs(db, { type: 'alpha' });
    expect(alphas.map((r) => r.id)).toEqual([c, a]);

    const queued = listJobs(db, { status: 'queued' });
    expect(queued.length).toBe(3);
    expect(listJobs(db, { status: 'dead_letter' })).toEqual([]);
  });

  it('applies limit and offset, clamping the limit to [1, 200]', () => {
    const q = makeQueue();
    for (let i = 0; i < 5; i++) {
      q.enqueue('t', { i });
      clock += 1;
    }
    expect(listJobs(db, { limit: 2 }).length).toBe(2);
    expect(listJobs(db, { limit: 2, offset: 4 }).length).toBe(1);
    // Out-of-range limits are clamped, not rejected: 0 floors to 1 row,
    // an oversized limit caps at the table size (below the 200 ceiling).
    expect(listJobs(db, { limit: 0 }).length).toBe(1);
    expect(listJobs(db, { limit: 9999 }).length).toBe(5);
  });
});

describe('countJobsByStatus + listJobTypes', () => {
  it('counts per status and lists distinct types sorted', () => {
    const q = makeQueue();
    q.enqueue('zeta');
    q.enqueue('alpha');
    q.enqueue('alpha');

    const counts = countJobsByStatus(db);
    expect(counts).toEqual({ queued: 3, running: 0, done: 0, dead_letter: 0, total: 3 });

    // Claim one — it flips to running.
    q.claim();
    const counts2 = countJobsByStatus(db);
    expect(counts2.queued).toBe(2);
    expect(counts2.running).toBe(1);
    expect(counts2.total).toBe(3);

    expect(listJobTypes(db)).toEqual(['alpha', 'zeta']);
  });
});

describe('retryDeadLetterJob', () => {
  it('requeues a dead-lettered job with a fresh attempt budget', async () => {
    const q = makeQueue();
    // A throwing handler with maxAttempts=1 dead-letters on the first failure.
    q.register('boom', () => {
      throw new Error('kaboom');
    });
    const id = q.enqueue('boom', {}, { maxAttempts: 1 });
    const row = q.claim();
    expect(row).toBeDefined();
    await q.process(row!);

    const dead = getJobRow(db, id)!;
    expect(dead.status).toBe('dead_letter');
    expect(dead.last_error).toContain('kaboom');
    expect(dead.attempts).toBe(1);

    clock += 500;
    const result = retryDeadLetterJob(db, id, clock);
    expect(result).toBe('retried');

    const requeued = getJobRow(db, id)!;
    expect(requeued.status).toBe('queued');
    expect(requeued.attempts).toBe(0);
    expect(requeued.last_error).toBeNull();
    expect(requeued.claimed_by).toBeNull();
    expect(requeued.lease_id).toBeNull();
    expect(requeued.run_at).toBe(clock);
  });

  it('reports not_found for an unknown id', () => {
    expect(retryDeadLetterJob(db, 'nope')).toBe('not_found');
  });

  it('refuses to retry a job that is not dead-lettered', () => {
    const q = makeQueue();
    const id = q.enqueue('t');
    expect(retryDeadLetterJob(db, id)).toBe('not_dead_letter');
    expect(getJobRow(db, id)!.status).toBe('queued');
  });
});

describe('deleteJob', () => {
  it('removes a row and reports whether one was deleted', () => {
    const q = makeQueue();
    const id = q.enqueue('t');
    expect(deleteJob(db, id)).toBe(true);
    expect(getJobRow(db, id)).toBeUndefined();
    expect(deleteJob(db, id)).toBe(false);
  });
});
