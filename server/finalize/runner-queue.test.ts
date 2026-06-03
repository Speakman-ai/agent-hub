import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { getOrgsDb, initOrgsDb, setOrgsDbPathForTests } from '../orgs.js';
import {
  appendRunnerJobLog,
  claimRunnerJob,
  enqueueRunnerJob,
  heartbeatRunnerJob,
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
    // expired by 40_000
    expect(reapExpiredRunnerLeases(40_000)).toEqual([c.id]);
    expect(runnerQueueDepth()).toBe(0); // 'lost' is terminal
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
});
