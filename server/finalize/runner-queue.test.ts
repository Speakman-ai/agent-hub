import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { getOrgsDb, initOrgsDb, setOrgsDbPathForTests } from '../orgs.js';
import {
  appendRunnerJobLog,
  cancelRunnerJobsForRun,
  claimRunnerJob,
  enqueueRunnerJob,
  heartbeatRunnerJob,
  markRunnerJobRunning,
  markRunnerJobSpotInterruption,
  probeRunnerJobLoss,
  pruneOldestRunnerJobLogs,
  pruneRunnerJobLogs,
  runnerJobLogStats,
  reapExpiredRunnerLeases,
  reportRunnerJob,
  runnerQueueDepth,
} from './runner-queue.js';

describe('runner-queue', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'runner-queue-'));
    setOrgsDbPathForTests(path.join(dir, 'orgs.db'));
    initOrgsDb();
  });

  afterEach(() => {
    setOrgsDbPathForTests(null);
    rmSync(dir, { recursive: true, force: true });
  });

  const enq = (over: Partial<Parameters<typeof enqueueRunnerJob>[0]> = {}) =>
    enqueueRunnerJob({
      orgId: 'orgA',
      projectId: 'p1',
      runId: 'r1',
      jobId: 'e2e',
      matrixKey: '',
      image: 'img:latest',
      specJson: '{}',
      now: 1000,
      ...over,
    });

  it('hands each queued job to exactly one agent (atomic claim), FIFO by enqueue time', () => {
    const j1 = enq({ jobId: 'j1', now: 1000 });
    const j2 = enq({ jobId: 'j2', now: 1001 });

    const c1 = claimRunnerJob({ agentId: 'agent-1', leaseMs: 60_000, now: 2000 });
    const c2 = claimRunnerJob({ agentId: 'agent-2', leaseMs: 60_000, now: 2001 });
    const c3 = claimRunnerJob({ agentId: 'agent-3', leaseMs: 60_000, now: 2002 });

    expect(c1?.id).toBe(j1); // earliest enqueued first
    expect(c2?.id).toBe(j2);
    expect(c3).toBeNull(); // queue drained
    expect(c1?.attempt).toBe(1);
    expect(c1?.leaseExpiresAt).toBe(2000 + 60_000);
    expect(runnerQueueDepth()).toBe(2); // both in-flight (claimed)
  });

  it('priority outranks enqueue order', () => {
    enq({ jobId: 'low', now: 1000, priority: 0 });
    const hi = enq({ jobId: 'high', now: 1001, priority: 5 });
    const c = claimRunnerJob({ agentId: 'a', leaseMs: 1000, now: 2000 });
    expect(c?.id).toBe(hi);
  });

  it('a dedicated agent (orgId) only claims its org’s jobs', () => {
    enq({ orgId: 'orgA', jobId: 'a', now: 1000 });
    const b = enq({ orgId: 'orgB', jobId: 'b', now: 1001 });
    const c = claimRunnerJob({ agentId: 'agentB', orgId: 'orgB', leaseMs: 1000, now: 2000 });
    expect(c?.id).toBe(b);
    expect(c?.orgId).toBe('orgB');
  });

  it('report drops a job out of the in-flight depth', () => {
    const j = enq({ jobId: 'j', now: 1000 });
    claimRunnerJob({ agentId: 'a', leaseMs: 1000, now: 2000 });
    expect(runnerQueueDepth()).toBe(1);
    reportRunnerJob({ jobId: j, state: 'succeeded', exitCode: 0, now: 3000 });
    expect(runnerQueueDepth()).toBe(0);
  });

  it('heartbeat renews the lease; reaper marks only expired in-flight jobs lost', () => {
    enq({ jobId: 'j', now: 1000 });
    const c = claimRunnerJob({ agentId: 'a', leaseMs: 10_000, now: 2000 })!;
    // renew well past the original deadline
    expect(heartbeatRunnerJob({ jobId: c.id, agentId: 'a', leaseMs: 10_000, now: 20_000 })).toBe(
      true,
    );
    // not yet expired at 25_000 (lease now 30_000)
    expect(reapExpiredRunnerLeases(25_000)).toEqual([]);
    // expired by 40_000 — generic loss, no spot interruption reported
    expect(reapExpiredRunnerLeases(40_000)).toEqual([
      { id: c.id, spotReclaimed: false, ecsTaskArn: null },
    ]);
    expect(runnerQueueDepth()).toBe(0); // 'lost' is terminal
  });

  it('reaper surfaces the claiming agent ECS task ARN so protection can be cleared', () => {
    const arn = 'arn:aws:ecs:us-east-2:1:task/test-fleet/stuck123';
    getOrgsDb()
      .prepare(
        `INSERT INTO runner_agents (id, org_scope, state, ecs_task_arn, registered_at, last_seen_at)
         VALUES ('agent-x', 'shared', 'busy', ?, 1000, 1000)`,
      )
      .run(arn);
    enq({ jobId: 'j', now: 1000 });
    const c = claimRunnerJob({ agentId: 'agent-x', leaseMs: 10_000, now: 2000 })!;
    expect(reapExpiredRunnerLeases(40_000)).toEqual([
      { id: c.id, spotReclaimed: false, ecsTaskArn: arn },
    ]);
  });

  it('a reported spot interruption makes the reaped lease a known reclaim', () => {
    enq({ jobId: 'j', now: 1000 });
    const c = claimRunnerJob({ agentId: 'a', leaseMs: 10_000, now: 2000 })!;
    // Agent observed an IMDS interruption notice and reported it.
    expect(markRunnerJobSpotInterruption({ jobId: c.id, agentId: 'a', now: 5000 })).toBe(true);
    // Re-report is idempotent (sticky) — no second stamp.
    expect(markRunnerJobSpotInterruption({ jobId: c.id, agentId: 'a', now: 6000 })).toBe(false);
    // Instance dies → lease expires → reaper classifies it as a reclaim.
    expect(reapExpiredRunnerLeases(40_000)).toEqual([
      { id: c.id, spotReclaimed: true, ecsTaskArn: null },
    ]);
    const row = getOrgsDb().prepare('SELECT detail FROM runner_jobs WHERE id=?').get(c.id) as {
      detail: string;
    };
    expect(row.detail).toBe('lease expired after spot interruption notice');
  });

  it('probeRunnerJobLoss reads the loss evidence for each lifecycle state', () => {
    enq({ jobId: 'j', now: 1000 });
    const c = claimRunnerJob({ agentId: 'a', leaseMs: 10_000, now: 2000 })!;

    // Freshly claimed, lease alive: no loss signal, heartbeat visible.
    expect(probeRunnerJobLoss(c.id, 5000)).toEqual({
      state: 'claimed',
      lost: false,
      leaseExpired: false,
      spotInterrupted: false,
      heartbeatAt: 2000,
      detail: null,
    });

    // Lease deadline passed but the reaper has not ticked yet: leaseExpired.
    expect(probeRunnerJobLoss(c.id, 13_000)).toMatchObject({
      lost: false,
      leaseExpired: true,
    });

    // Spot interruption stamped (sticky) surfaces even while the lease lives.
    markRunnerJobSpotInterruption({ jobId: c.id, agentId: 'a', now: 6000 });
    expect(probeRunnerJobLoss(c.id, 5000)).toMatchObject({
      leaseExpired: false,
      spotInterrupted: true,
    });

    // Reaped: terminal lost with the persisted detail; leaseExpired no longer
    // applies (the state is no longer live).
    reapExpiredRunnerLeases(40_000);
    expect(probeRunnerJobLoss(c.id, 50_000)).toMatchObject({
      state: 'lost',
      lost: true,
      leaseExpired: false,
      spotInterrupted: true,
      detail: 'lease expired after spot interruption notice',
    });

    // Missing row → null (caller falls back to default classification).
    expect(probeRunnerJobLoss('no-such-job', 5000)).toBeNull();
  });

  it('markRunnerJobSpotInterruption refuses a non-claiming agent', () => {
    enq({ jobId: 'j', now: 1000 });
    const c = claimRunnerJob({ agentId: 'a', leaseMs: 10_000, now: 2000 })!;
    expect(markRunnerJobSpotInterruption({ jobId: c.id, agentId: 'intruder', now: 5000 })).toBe(
      false,
    );
    expect(reapExpiredRunnerLeases(40_000)).toEqual([
      { id: c.id, spotReclaimed: false, ecsTaskArn: null },
    ]);
  });

  it('log spool dedupes on (job_id, seq)', () => {
    const j = enq({ jobId: 'j', now: 1000 });
    appendRunnerJobLog({ jobId: j, seq: 0, stepIndex: 1, stream: 'stdout', data: 'a', now: 1 });
    appendRunnerJobLog({ jobId: j, seq: 0, stepIndex: 1, stream: 'stdout', data: 'dup', now: 2 });
    appendRunnerJobLog({ jobId: j, seq: 1, stepIndex: 1, stream: 'stderr', data: 'b', now: 3 });
    const n = getOrgsDb()
      .prepare('SELECT COUNT(*) AS n FROM runner_job_logs WHERE job_id=?')
      .get(j) as { n: number };
    expect(n.n).toBe(2); // duplicate seq=0 ignored
    const first = getOrgsDb()
      .prepare('SELECT data FROM runner_job_logs WHERE job_id=? AND seq=0')
      .get(j) as { data: string };
    expect(first.data).toBe('a'); // original kept, not 'dup'
  });

  describe('pruneRunnerJobLogs', () => {
    const countLogs = () =>
      (getOrgsDb().prepare('SELECT COUNT(*) AS n FROM runner_job_logs').get() as { n: number }).n;

    it('deletes frames older than the cutoff and keeps newer ones', () => {
      const j = enq({ jobId: 'j', now: 1000 });
      appendRunnerJobLog({
        jobId: j,
        seq: 0,
        stepIndex: 0,
        stream: 'stdout',
        data: 'old',
        now: 100,
      });
      appendRunnerJobLog({
        jobId: j,
        seq: 1,
        stepIndex: 0,
        stream: 'stdout',
        data: 'edge',
        now: 200,
      });
      appendRunnerJobLog({
        jobId: j,
        seq: 2,
        stepIndex: 0,
        stream: 'stdout',
        data: 'new',
        now: 300,
      });

      const deleted = pruneRunnerJobLogs({ cutoff: 200 });

      expect(deleted).toBe(1); // only `at < 200` (the cutoff is exclusive)
      expect(countLogs()).toBe(2);
      const survivors = getOrgsDb()
        .prepare('SELECT data FROM runner_job_logs ORDER BY seq')
        .all() as Array<{ data: string }>;
      expect(survivors.map((r) => r.data)).toEqual(['edge', 'new']);
    });

    it('returns 0 and deletes nothing when all frames are within retention', () => {
      const j = enq({ jobId: 'j', now: 1000 });
      appendRunnerJobLog({ jobId: j, seq: 0, stepIndex: 0, stream: 'stdout', data: 'x', now: 500 });
      expect(pruneRunnerJobLogs({ cutoff: 100 })).toBe(0);
      expect(countLogs()).toBe(1);
    });

    it('drains a backlog larger than one batch across batches in a single call', () => {
      const j = enq({ jobId: 'j', now: 1000 });
      const insert = getOrgsDb().prepare(
        'INSERT INTO runner_job_logs (job_id, seq, step_index, stream, data, at) VALUES (?,?,?,?,?,?)',
      );
      const tx = getOrgsDb().transaction(() => {
        for (let i = 0; i < 25; i++) insert.run(j, i, 0, 'stdout', 'd', 10);
      });
      tx();

      // batchSize 10 + enough maxBatches: all 25 expired rows go in one call.
      expect(pruneRunnerJobLogs({ cutoff: 100, batchSize: 10, maxBatches: 50 })).toBe(25);
      expect(countLogs()).toBe(0);
    });

    it('caps work per call at batchSize * maxBatches, leaving the rest for the next tick', () => {
      const j = enq({ jobId: 'j', now: 1000 });
      const insert = getOrgsDb().prepare(
        'INSERT INTO runner_job_logs (job_id, seq, step_index, stream, data, at) VALUES (?,?,?,?,?,?)',
      );
      const tx = getOrgsDb().transaction(() => {
        for (let i = 0; i < 25; i++) insert.run(j, i, 0, 'stdout', 'd', 10);
      });
      tx();

      // batchSize 10 * maxBatches 2 = at most 20 deleted this call.
      expect(pruneRunnerJobLogs({ cutoff: 100, batchSize: 10, maxBatches: 2 })).toBe(20);
      expect(countLogs()).toBe(5);
      // The next tick drains the remainder.
      expect(pruneRunnerJobLogs({ cutoff: 100, batchSize: 10, maxBatches: 2 })).toBe(5);
      expect(countLogs()).toBe(0);
    });
  });

  describe('pruneOldestRunnerJobLogs', () => {
    const countLogs = () =>
      (getOrgsDb().prepare('SELECT COUNT(*) AS n FROM runner_job_logs').get() as { n: number }).n;

    const seed = (n: number, atFn: (i: number) => number) => {
      const j = enq({ jobId: 'j', now: 1000 });
      const insert = getOrgsDb().prepare(
        'INSERT INTO runner_job_logs (job_id, seq, step_index, stream, data, at) VALUES (?,?,?,?,?,?)',
      );
      getOrgsDb().transaction(() => {
        for (let i = 0; i < n; i++) insert.run(j, i, 0, 'stdout', `row-${i}`, atFn(i));
      })();
      return j;
    };

    it('is a no-op when the table is already at or under keepRows', () => {
      seed(5, (i) => 100 + i);
      expect(pruneOldestRunnerJobLogs({ keepRows: 5 })).toBe(0);
      expect(pruneOldestRunnerJobLogs({ keepRows: 50 })).toBe(0);
      expect(countLogs()).toBe(5);
    });

    it('deletes the oldest frames and keeps the newest until keepRows remain', () => {
      seed(10, (i) => 100 + i);
      expect(pruneOldestRunnerJobLogs({ keepRows: 4, batchSize: 10, maxBatches: 5 })).toBe(6);
      expect(countLogs()).toBe(4);
      const survivors = getOrgsDb()
        .prepare('SELECT data FROM runner_job_logs ORDER BY at ASC')
        .all() as Array<{ data: string }>;
      expect(survivors.map((r) => r.data)).toEqual(['row-6', 'row-7', 'row-8', 'row-9']);
    });

    it('caps work per call at maxDeletes, leaving the rest for the next tick', () => {
      seed(25, () => 10);
      expect(
        pruneOldestRunnerJobLogs({ keepRows: 0, batchSize: 10, maxBatches: 5, maxDeletes: 20 }),
      ).toBe(20);
      expect(countLogs()).toBe(5);
      expect(
        pruneOldestRunnerJobLogs({ keepRows: 0, batchSize: 10, maxBatches: 5, maxDeletes: 20 }),
      ).toBe(5);
      expect(countLogs()).toBe(0);
    });

    it('reports payload bytes alongside the row count', () => {
      seed(3, (i) => 100 + i);
      const stats = runnerJobLogStats();
      expect(stats.rows).toBe(3);
      expect(stats.payloadBytes).toBeGreaterThan(0);
    });
  });

  describe('cancelRunnerJobsForRun (Stop Finalize)', () => {
    it('cancels every non-terminal row for the run, leaving terminal rows and other runs untouched', () => {
      // term: terminal before cancel → immutable. queued/running: the two live
      // states cancel touches. other: a different run → untouched.
      const term = enq({ jobId: 'term', runId: 'run-X', now: 1000 });
      reportRunnerJob({ jobId: term, state: 'succeeded', now: 1100 });
      const queued = enq({ jobId: 'queued', runId: 'run-X', now: 1200 });
      const running = enq({ jobId: 'running', runId: 'run-X', now: 1300 });
      const other = enq({ jobId: 'other', runId: 'run-Y', now: 1400 });

      // Drive `running` into the running state (claim picks FIFO among queued;
      // `term` is terminal so it is skipped).
      claimRunnerJob({ agentId: 'a1', leaseMs: 60_000, now: 2000 }); // → queued
      claimRunnerJob({ agentId: 'a2', leaseMs: 60_000, now: 2001 }); // → running
      markRunnerJobRunning(running, 2100);

      const cancelled = cancelRunnerJobsForRun({ runId: 'run-X', now: 3000 });

      expect([...cancelled].sort()).toEqual([queued, running].sort());
      expect(probeRunnerJobLoss(queued, 3100)?.state).toBe('cancelled');
      expect(probeRunnerJobLoss(running, 3100)?.state).toBe('cancelled');
      // Terminal row is immutable; the other run is untouched.
      expect(probeRunnerJobLoss(term, 3100)?.state).toBe('succeeded');
      expect(probeRunnerJobLoss(other, 3100)?.state).toBe('queued');
    });

    it('is a no-op that returns [] when the run has no live jobs', () => {
      const done = enq({ jobId: 'done', runId: 'run-Z', now: 1000 });
      reportRunnerJob({ jobId: done, state: 'succeeded', now: 1100 });
      expect(cancelRunnerJobsForRun({ runId: 'run-Z', now: 2000 })).toEqual([]);
      expect(probeRunnerJobLoss(done, 2100)?.state).toBe('succeeded');
    });
  });
});
