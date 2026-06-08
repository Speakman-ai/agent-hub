/**
 * Unit tests for the parity store: upsert idempotency, metric emission, the
 * false-green alert, range listing, summary, and the PR#1001 seed.
 *
 * Uses a real in-memory better-sqlite3 so the upsert SQL (ON CONFLICT) and the
 * range scan are exercised against the actual schema rather than a fake.
 */
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FINALIZE_METRICS_SCHEMA } from './metrics-schema.js';
import {
  FINALIZE_PARITY_SCHEMA,
  KNOWN_PARITY_SEEDS,
  listParityRecords,
  recordParity,
  seedKnownParityObservations,
  summarizeParity,
  type ParityRecord,
  type ParityStoreDeps,
} from './parity-store.js';

function makeDeps(now: () => number): {
  db: Database.Database;
  storeDeps: ParityStoreDeps;
  log: ReturnType<typeof vi.fn>;
  falseGreens: ParityRecord[];
} {
  const db = new Database(':memory:');
  db.exec(FINALIZE_PARITY_SCHEMA);
  db.exec(FINALIZE_METRICS_SCHEMA);
  const stmts = {
    upsertFinalizeParity: db.prepare(
      `INSERT INTO finalize_github_parity
         (id, project_id, pr_number, commit_sha, run_id, finalize_verdict,
          finalize_jobs, github_verdict, github_jobs, divergence_class, note, observed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(project_id, commit_sha) DO UPDATE SET
         pr_number = excluded.pr_number,
         run_id = excluded.run_id,
         finalize_verdict = excluded.finalize_verdict,
         finalize_jobs = excluded.finalize_jobs,
         github_verdict = excluded.github_verdict,
         github_jobs = excluded.github_jobs,
         divergence_class = excluded.divergence_class,
         note = excluded.note,
         observed_at = excluded.observed_at`,
    ),
    getFinalizeParityByCommit: db.prepare(
      `SELECT id, project_id, pr_number, commit_sha, run_id, finalize_verdict,
              finalize_jobs, github_verdict, github_jobs, divergence_class, note, observed_at
         FROM finalize_github_parity WHERE project_id = ? AND commit_sha = ?`,
    ),
    listFinalizeParityInRange: db.prepare(
      `SELECT id, project_id, pr_number, commit_sha, run_id, finalize_verdict,
              finalize_jobs, github_verdict, github_jobs, divergence_class, note, observed_at
         FROM finalize_github_parity
        WHERE project_id = ? AND observed_at >= ? AND observed_at < ?
        ORDER BY observed_at DESC`,
    ),
    insertFinalizeMetric: db.prepare(
      `INSERT INTO finalize_metrics (project_id, metric_name, labels, value, run_id, observed_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ),
  } as ParityStoreDeps['stmts'];

  const log = vi.fn();
  const falseGreens: ParityRecord[] = [];
  const storeDeps: ParityStoreDeps = {
    stmts,
    now,
    log,
    onFalseGreen: (r) => falseGreens.push(r),
  };
  return { db, storeDeps, log, falseGreens };
}

function countMetrics(db: Database.Database, divergenceClass: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM finalize_metrics
        WHERE metric_name = 'finalize_github_parity'
          AND json_extract(labels, '$.divergence_class') = ?`,
    )
    .get(divergenceClass) as { n: number };
  return row.n;
}

let clock = 1_000;
const now = () => clock;

beforeEach(() => {
  clock = 1_000;
});

describe('recordParity', () => {
  let ctx: ReturnType<typeof makeDeps>;
  afterEach(() => ctx?.db.close());

  it('persists a record with the derived divergence class', () => {
    ctx = makeDeps(now);
    const rec = recordParity(ctx.storeDeps, {
      projectId: 'p1',
      commitSha: 'abc123',
      prNumber: 42,
      finalizeVerdict: 'green',
      finalizeJobs: [{ name: 'backend', state: 'green' }],
      githubVerdict: 'red',
      githubJobs: [{ name: 'backend', state: 'red' }],
    });
    expect(rec.divergence_class).toBe('false_green');
    expect(rec.pr_number).toBe(42);
    expect(rec.finalize_jobs).toEqual([{ name: 'backend', state: 'green' }]);

    const records = listParityRecords(ctx.storeDeps, {
      projectId: 'p1',
      fromMs: 0,
      toMs: 10_000,
    });
    expect(records).toHaveLength(1);
    expect(records[0].commit_sha).toBe('abc123');
    expect(records[0].github_jobs).toEqual([{ name: 'backend', state: 'red' }]);
  });

  it('fires the false-green alert + onFalseGreen hook exactly once', () => {
    ctx = makeDeps(now);
    recordParity(ctx.storeDeps, {
      projectId: 'p1',
      commitSha: 'deadbeef',
      finalizeVerdict: 'green',
      githubVerdict: 'red',
    });
    expect(ctx.falseGreens).toHaveLength(1);
    expect(ctx.log).toHaveBeenCalledTimes(1);
    expect(ctx.log.mock.calls[0][0]).toMatch(/ALERT false_green/);
  });

  it('does not alert on agree / false_red / indeterminate', () => {
    ctx = makeDeps(now);
    recordParity(ctx.storeDeps, {
      projectId: 'p1',
      commitSha: 'a1',
      finalizeVerdict: 'green',
      githubVerdict: 'green',
    });
    recordParity(ctx.storeDeps, {
      projectId: 'p1',
      commitSha: 'a2',
      finalizeVerdict: 'red',
      githubVerdict: 'green',
    });
    recordParity(ctx.storeDeps, {
      projectId: 'p1',
      commitSha: 'a3',
      finalizeVerdict: 'green',
      githubVerdict: 'unknown',
    });
    expect(ctx.falseGreens).toHaveLength(0);
    expect(ctx.log).not.toHaveBeenCalled();
  });

  it('emits one parity counter metric per new observation', () => {
    ctx = makeDeps(now);
    recordParity(ctx.storeDeps, {
      projectId: 'p1',
      commitSha: 'c1',
      finalizeVerdict: 'green',
      githubVerdict: 'red',
    });
    recordParity(ctx.storeDeps, {
      projectId: 'p1',
      commitSha: 'c2',
      finalizeVerdict: 'green',
      githubVerdict: 'green',
    });
    expect(countMetrics(ctx.db, 'false_green')).toBe(1);
    expect(countMetrics(ctx.db, 'agree_green')).toBe(1);
  });

  it('is idempotent on (project, commit) and keeps the original id', () => {
    ctx = makeDeps(now);
    const first = recordParity(ctx.storeDeps, {
      projectId: 'p1',
      commitSha: 'same',
      finalizeVerdict: 'green',
      githubVerdict: 'red',
    });
    clock = 2_000;
    // Re-record the same commit with the same (unchanged) class.
    const second = recordParity(ctx.storeDeps, {
      projectId: 'p1',
      commitSha: 'same',
      finalizeVerdict: 'green',
      githubVerdict: 'red',
    });
    expect(second.id).toBe(first.id);

    const records = listParityRecords(ctx.storeDeps, {
      projectId: 'p1',
      fromMs: 0,
      toMs: 10_000,
    });
    expect(records).toHaveLength(1);
    // Unchanged class => no second metric row, no second alert.
    expect(countMetrics(ctx.db, 'false_green')).toBe(1);
    expect(ctx.falseGreens).toHaveLength(1);
  });

  it('re-emits the metric + alert when an existing commit flips into false_green', () => {
    ctx = makeDeps(now);
    recordParity(ctx.storeDeps, {
      projectId: 'p1',
      commitSha: 'flip',
      finalizeVerdict: 'green',
      githubVerdict: 'unknown', // indeterminate first (GitHub still running)
    });
    expect(ctx.falseGreens).toHaveLength(0);
    clock = 2_000;
    recordParity(ctx.storeDeps, {
      projectId: 'p1',
      commitSha: 'flip',
      finalizeVerdict: 'green',
      githubVerdict: 'red', // now GitHub is red => false_green
    });
    expect(ctx.falseGreens).toHaveLength(1);
    expect(countMetrics(ctx.db, 'false_green')).toBe(1);
    expect(countMetrics(ctx.db, 'indeterminate')).toBe(1);
  });
});

describe('listParityRecords + summary', () => {
  let ctx: ReturnType<typeof makeDeps>;
  afterEach(() => ctx?.db.close());

  it('filters by class and returns newest first', () => {
    ctx = makeDeps(now);
    clock = 1_000;
    recordParity(ctx.storeDeps, {
      projectId: 'p1',
      commitSha: 'g1',
      finalizeVerdict: 'green',
      githubVerdict: 'green',
    });
    clock = 2_000;
    recordParity(ctx.storeDeps, {
      projectId: 'p1',
      commitSha: 'fg1',
      finalizeVerdict: 'green',
      githubVerdict: 'red',
    });

    const all = listParityRecords(ctx.storeDeps, { projectId: 'p1', fromMs: 0, toMs: 10_000 });
    expect(all.map((r) => r.commit_sha)).toEqual(['fg1', 'g1']); // newest first

    const onlyFalseGreen = listParityRecords(ctx.storeDeps, {
      projectId: 'p1',
      fromMs: 0,
      toMs: 10_000,
      divergenceClass: 'false_green',
    });
    expect(onlyFalseGreen).toHaveLength(1);
    expect(onlyFalseGreen[0].commit_sha).toBe('fg1');
  });

  it('respects the time window and project scope', () => {
    ctx = makeDeps(now);
    clock = 5_000;
    recordParity(ctx.storeDeps, {
      projectId: 'p1',
      commitSha: 'inwindow',
      finalizeVerdict: 'green',
      githubVerdict: 'green',
    });
    recordParity(ctx.storeDeps, {
      projectId: 'other',
      commitSha: 'otherproj',
      finalizeVerdict: 'green',
      githubVerdict: 'green',
    });
    expect(
      listParityRecords(ctx.storeDeps, { projectId: 'p1', fromMs: 0, toMs: 4_000 }),
    ).toHaveLength(0);
    expect(
      listParityRecords(ctx.storeDeps, { projectId: 'p1', fromMs: 0, toMs: 6_000 }),
    ).toHaveLength(1);
  });

  it('summarizes counts per class', () => {
    const summary = summarizeParity([
      { divergence_class: 'false_green' },
      { divergence_class: 'false_green' },
      { divergence_class: 'agree_green' },
      { divergence_class: 'false_red' },
      { divergence_class: 'indeterminate' },
    ] as ParityRecord[]);
    expect(summary).toEqual({
      total: 5,
      agree_green: 1,
      agree_red: 0,
      false_green: 2,
      false_red: 1,
      indeterminate: 1,
    });
  });
});

describe('seedKnownParityObservations', () => {
  let ctx: ReturnType<typeof makeDeps>;
  afterEach(() => ctx?.db.close());

  it('seeds PR#1001 as a false_green and is idempotent', () => {
    ctx = makeDeps(now);
    expect(KNOWN_PARITY_SEEDS[0].prNumber).toBe(1001);
    const seeded = seedKnownParityObservations(ctx.storeDeps, 'p1');
    expect(seeded[0].divergence_class).toBe('false_green');
    expect(seeded[0].commit_sha).toBe('6ad87ec');

    // Idempotent: re-seed does not duplicate rows.
    clock = 9_000;
    seedKnownParityObservations(ctx.storeDeps, 'p1');
    const records = listParityRecords(ctx.storeDeps, {
      projectId: 'p1',
      fromMs: 0,
      toMs: 100_000,
    });
    expect(records).toHaveLength(KNOWN_PARITY_SEEDS.length);
    // First alert fired once; re-seed with unchanged class does not re-alert.
    expect(ctx.falseGreens).toHaveLength(1);
  });
});
