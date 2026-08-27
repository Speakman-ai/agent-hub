/**
 * runner-queue.ts — control-plane queue ops for the multi-tenant runner fleet.
 *
 * Backed by the shared `orgs.db` (see runner-queue-schema.ts). The remote
 * RunnerBackend enqueues a job here; a pull-based agent claims it, streams steps
 * back, and reports the result, which the backend mirrors into the per-org
 * `agent-hub.db` run state.
 *
 * CONCURRENCY: claim is an atomic conditional `UPDATE ... WHERE state='queued'
 * ... RETURNING`. This is race-free ONLY because better-sqlite3 serializes
 * writers within one process. If the control plane is ever sharded across
 * processes/hosts, this assumption breaks — revisit with a real lock/queue.
 */
import { randomUUID } from 'crypto';
import { getOrgsDb } from '../orgs.js';
import type { RunnerJobState } from './runner-queue-schema.js';

export interface EnqueueRunnerJobInput {
  orgId: string;
  projectId: string;
  runId: string;
  jobId: string;
  matrixKey: string;
  image: string;
  /** Serialized JobClaimSpec WITHOUT secrets (worktreeRef, env, steps, …). */
  specJson: string;
  secretsRef?: string | null;
  runnerClass?: string;
  /** 'shared' (any agent) or a specific org_id for a dedicated pool. */
  orgScope?: string;
  priority?: number;
  now: number;
}

export interface ClaimedRunnerJob {
  id: string;
  orgId: string;
  projectId: string;
  runId: string;
  jobId: string;
  matrixKey: string;
  image: string;
  specJson: string;
  secretsRef: string | null;
  attempt: number;
  leaseExpiresAt: number;
}

interface RunnerJobRow {
  id: string;
  org_id: string;
  project_id: string;
  run_id: string;
  job_id: string;
  matrix_key: string;
  image: string;
  spec_json: string;
  secrets_ref: string | null;
  attempt: number;
  lease_expires_at: number;
  state: RunnerJobState;
}

/** Insert a queued job. Returns the queue job id. */
export function enqueueRunnerJob(input: EnqueueRunnerJobInput): string {
  const id = randomUUID();
  getOrgsDb()
    .prepare(
      `INSERT INTO runner_jobs
         (id, org_id, project_id, run_id, job_id, matrix_key, state, image,
          runner_class, org_scope, priority, spec_json, secrets_ref, attempt, enqueued_at)
       VALUES
         (@id, @orgId, @projectId, @runId, @jobId, @matrixKey, 'queued', @image,
          @runnerClass, @orgScope, @priority, @specJson, @secretsRef, 0, @now)`,
    )
    .run({
      id,
      orgId: input.orgId,
      projectId: input.projectId,
      runId: input.runId,
      jobId: input.jobId,
      matrixKey: input.matrixKey,
      image: input.image,
      runnerClass: input.runnerClass ?? 'default',
      orgScope: input.orgScope ?? 'shared',
      priority: input.priority ?? 0,
      specJson: input.specJson,
      secretsRef: input.secretsRef ?? null,
      now: input.now,
    });
  return id;
}

/**
 * Atomically claim the next queued job for an agent. `orgId` restricts a
 * dedicated agent to its org; pass null for a shared-pool agent (claims any).
 * Returns null when the queue is empty for this agent.
 */
export function claimRunnerJob(args: {
  agentId: string;
  runnerClass?: string;
  orgId?: string | null;
  leaseMs: number;
  now: number;
}): ClaimedRunnerJob | null {
  const orgFilter = args.orgId ? 'AND org_id = @orgId' : '';
  const row = getOrgsDb()
    .prepare(
      `UPDATE runner_jobs
          SET state='claimed', claimed_by=@agentId, claimed_at=@now,
              lease_expires_at=@now + @leaseMs, heartbeat_at=@now, attempt=attempt+1
        WHERE id = (
          SELECT id FROM runner_jobs
           WHERE state='queued' AND runner_class=@runnerClass ${orgFilter}
           ORDER BY priority DESC, enqueued_at ASC
           LIMIT 1
        ) AND state='queued'
        RETURNING id, org_id, project_id, run_id, job_id, matrix_key, image,
                  spec_json, secrets_ref, attempt, lease_expires_at`,
    )
    .get({
      agentId: args.agentId,
      runnerClass: args.runnerClass ?? 'default',
      orgId: args.orgId ?? null,
      leaseMs: args.leaseMs,
      now: args.now,
    }) as RunnerJobRow | undefined;
  if (!row) return null;
  return {
    id: row.id,
    orgId: row.org_id,
    projectId: row.project_id,
    runId: row.run_id,
    jobId: row.job_id,
    matrixKey: row.matrix_key,
    image: row.image,
    specJson: row.spec_json,
    secretsRef: row.secrets_ref,
    attempt: row.attempt,
    leaseExpiresAt: row.lease_expires_at,
  };
}

/** Mark a claimed job as actively running (first step started). */
export function markRunnerJobRunning(jobId: string, now: number): void {
  getOrgsDb()
    .prepare(`UPDATE runner_jobs SET state='running', heartbeat_at=@now WHERE id=@jobId`)
    .run({ jobId, now });
}

/**
 * Record that the agent owning this job observed an EC2 Spot interruption notice
 * (IMDS `spot/instance-action`). Stamps `spot_interruption_at` once (sticky —
 * never cleared) so that when the lease later expires (instance gone), the reaper
 * can classify the lost job as a known reclaim rather than a generic agent crash.
 *
 * Scoped to the claiming agent + a live (claimed/running) state so a stale or
 * spoofed report can't mark someone else's job. Returns true if the row was
 * stamped (idempotent: re-reporting on an already-stamped job is a no-op that
 * still returns false because `changes` is 0).
 */
export function markRunnerJobSpotInterruption(args: {
  jobId: string;
  agentId: string;
  now: number;
}): boolean {
  const res = getOrgsDb()
    .prepare(
      `UPDATE runner_jobs
          SET spot_interruption_at=@now
        WHERE id=@jobId AND claimed_by=@agentId AND state IN ('claimed','running')
          AND spot_interruption_at IS NULL`,
    )
    .run({ jobId: args.jobId, agentId: args.agentId, now: args.now });
  return res.changes === 1;
}

/** Renew a job's lease; returns false if the job is gone or already terminal. */
export function heartbeatRunnerJob(args: {
  jobId: string;
  agentId: string;
  leaseMs: number;
  now: number;
}): boolean {
  const res = getOrgsDb()
    .prepare(
      `UPDATE runner_jobs
          SET heartbeat_at=@now, lease_expires_at=@now + @leaseMs
        WHERE id=@jobId AND claimed_by=@agentId AND state IN ('claimed','running')`,
    )
    .run({ jobId: args.jobId, agentId: args.agentId, leaseMs: args.leaseMs, now: args.now });
  return res.changes === 1;
}

/** Record the first terminal outcome for a live or queued job. Terminal rows are immutable. */
export function reportRunnerJob(args: {
  jobId: string;
  state: 'succeeded' | 'failed' | 'cancelled' | 'lost';
  exitCode?: number | null;
  detail?: string | null;
  now: number;
}): void {
  getOrgsDb()
    .prepare(
      `UPDATE runner_jobs
          SET state=@state, exit_code=@exitCode, detail=@detail, ended_at=@now
        WHERE id=@jobId AND state IN ('queued','claimed','running')`,
    )
    .run({
      jobId: args.jobId,
      state: args.state,
      exitCode: args.exitCode ?? null,
      detail: args.detail ?? null,
      now: args.now,
    });
}

/**
 * Cancel every non-terminal queue row for a run in one statement — the Stop
 * Finalize path. A `queued` row flips `cancelled` before any agent claims it (so
 * it is never picked up); a `claimed`/`running` row flips `cancelled` so the
 * fleet stops treating it as live work and the agent tears down on its next poll
 * (the channel is removed in the same cancel pass → `410 gone`). Terminal rows
 * are immutable and left untouched. Returns the ids that were actually
 * transitioned so the caller can unblock their in-process channels.
 */
export function cancelRunnerJobsForRun(args: {
  runId: string;
  now: number;
  detail?: string | null;
}): string[] {
  const rows = getOrgsDb()
    .prepare(
      `UPDATE runner_jobs
          SET state='cancelled', detail=@detail, ended_at=@now
        WHERE run_id=@runId AND state IN ('queued','claimed','running')
        RETURNING id`,
    )
    .all({ runId: args.runId, now: args.now, detail: args.detail ?? 'finalize run cancelled' }) as {
    id: string;
  }[];
  return rows.map((r) => r.id);
}

/** Append one log frame to the durable spool (idempotent on (job_id, seq)). */
export function appendRunnerJobLog(args: {
  jobId: string;
  seq: number;
  stepIndex: number;
  stream: 'stdout' | 'stderr';
  data: string;
  now: number;
}): void {
  getOrgsDb()
    .prepare(
      `INSERT OR IGNORE INTO runner_job_logs (job_id, seq, step_index, stream, data, at)
       VALUES (@jobId, @seq, @stepIndex, @stream, @data, @now)`,
    )
    .run({
      jobId: args.jobId,
      seq: args.seq,
      stepIndex: args.stepIndex,
      stream: args.stream,
      data: args.data,
      now: args.now,
    });
}

/**
 * Prune `runner_job_logs` frames older than `cutoff` (epoch ms), in bounded
 * batches so a single tick can never block the synchronous better-sqlite3 event
 * loop — the exact failure mode this reaper exists to prevent. A naive
 * `DELETE ... WHERE at < cutoff` over a multi-million-row backlog is one giant
 * synchronous statement that stalls the loop (= the slow page loads). Instead we
 * delete in `batchSize` chunks (via a rowid subquery — better-sqlite3's bundled
 * SQLite isn't built with `DELETE ... LIMIT`) and stop after `maxBatches` chunks
 * so a huge first-run backlog drains across several ticks rather than one stall.
 *
 * Returns the number of rows deleted this call.
 */
export function pruneRunnerJobLogs(args: {
  cutoff: number;
  batchSize?: number;
  maxBatches?: number;
}): number {
  const batchSize = args.batchSize ?? 5_000;
  const maxBatches = args.maxBatches ?? 200;
  const db = getOrgsDb();
  const stmt = db.prepare(
    `DELETE FROM runner_job_logs
       WHERE rowid IN (
         SELECT rowid FROM runner_job_logs WHERE at < @cutoff LIMIT @batchSize
       )`,
  );
  let deleted = 0;
  for (let i = 0; i < maxBatches; i++) {
    const res = stmt.run({ cutoff: args.cutoff, batchSize });
    deleted += res.changes;
    if (res.changes < batchSize) break;
  }
  return deleted;
}

/**
 * In-flight depth (queued + claimed + running) — the autoscaler signal.
 * Pass orgId for a per-tenant metric; omit for the aggregate.
 */
export function runnerQueueDepth(orgId?: string): number {
  const where = orgId ? 'AND org_id=@orgId' : '';
  const row = getOrgsDb()
    .prepare(
      `SELECT COUNT(*) AS n FROM runner_jobs
        WHERE state IN ('queued','claimed','running') ${where}`,
    )
    .get({ orgId: orgId ?? null }) as { n: number };
  return row.n;
}

/**
 * In-flight count (claimed + running only) — jobs that currently OWN an agent
 * and would LOSE work if that agent were terminated. Distinct from queued work,
 * which has no agent yet and only drives scale-UP. The dynamic scale-down path
 * uses this as the floor it must never shrink below; `runnerQueueDepth()` (which
 * also counts `queued`) still drives scale-up so a backlog isn't starved.
 * Pass orgId for a per-tenant metric; omit for the aggregate.
 */
export function runnerInflightCount(orgId?: string): number {
  const where = orgId ? 'AND org_id=@orgId' : '';
  const row = getOrgsDb()
    .prepare(
      `SELECT COUNT(*) AS n FROM runner_jobs
        WHERE state IN ('claimed','running') ${where}`,
    )
    .get({ orgId: orgId ?? null }) as { n: number };
  return row.n;
}

/**
 * Point-in-time loss evidence for a leased job, read by the step-runner when a
 * remote step hits its hard timeout without ever reporting termination. The
 * step-runner uses this to decide whether the "timeout" is a genuine step
 * overrun on a live runner (CI-class, parked) or the runner dying underneath
 * the step (infra-class, retried on a fresh agent).
 */
export interface RunnerJobLossProbe {
  state: RunnerJobState;
  /** The reaper (or an error report) already marked the job terminal-lost. */
  lost: boolean;
  /** Still claimed/running but the lease deadline has passed (reaper tick pending). */
  leaseExpired: boolean;
  /** The agent reported an EC2 Spot interruption notice (sticky stamp). */
  spotInterrupted: boolean;
  /** Last heartbeat (epoch ms), or null if the agent never heartbeat. */
  heartbeatAt: number | null;
  /** The persisted queue-row detail, when any. */
  detail: string | null;
}

/**
 * Read the loss evidence for one queue job. Returns null when the row is gone
 * (nothing to conclude — callers fall back to their default classification).
 * Pure read; safe on the step-settlement hot path.
 */
export function probeRunnerJobLoss(jobId: string, now: number): RunnerJobLossProbe | null {
  const row = getOrgsDb()
    .prepare(
      `SELECT state, lease_expires_at, heartbeat_at, spot_interruption_at, detail
         FROM runner_jobs WHERE id=?`,
    )
    .get(jobId) as
    | {
        state: RunnerJobState;
        lease_expires_at: number | null;
        heartbeat_at: number | null;
        spot_interruption_at: number | null;
        detail: string | null;
      }
    | undefined;
  if (!row) return null;
  const live = row.state === 'claimed' || row.state === 'running';
  return {
    state: row.state,
    lost: row.state === 'lost',
    leaseExpired: live && row.lease_expires_at != null && row.lease_expires_at < now,
    spotInterrupted: row.spot_interruption_at != null,
    heartbeatAt: row.heartbeat_at ?? null,
    detail: row.detail ?? null,
  };
}

/** A job marked `lost` by the reaper, plus whether it was a known Spot reclaim. */
export interface ReapedRunnerJob {
  id: string;
  /**
   * True iff the agent reported an EC2 Spot interruption notice before the lease
   * expired (`spot_interruption_at` was set). The fleet scaler uses this to fail
   * the in-process channel with a `spot_reclaimed` marker so step-runner picks
   * the generous reclaim retry cap instead of `container_unavailable`.
   */
  spotReclaimed: boolean;
  /**
   * The reaped agent's ECS task ARN (runner_agents.ecs_task_arn), or null if the
   * agent is off-ECS / unknown. The fleet scaler clears Hub task protection on
   * this task so a stuck-but-alive worker doesn't stay protected for the full Hub
   * lease, blocking scale-in / deploy reclaim.
   */
  ecsTaskArn: string | null;
}

/**
 * Mark claimed/running jobs whose lease has expired as `lost` (the reaper). The
 * orchestrator's own retry logic decides what to do — we do NOT auto-requeue.
 * Returns the affected jobs, each flagged with whether the agent had reported a
 * Spot interruption notice (so the loss is a known reclaim, not a crash). The
 * persisted `detail` mirrors that distinction for post-hoc inspection.
 */
export function reapExpiredRunnerLeases(now: number): ReapedRunnerJob[] {
  const db = getOrgsDb();
  const rows = db
    .prepare(
      `UPDATE runner_jobs
          SET state='lost', ended_at=@now,
              detail = CASE
                WHEN spot_interruption_at IS NOT NULL
                  THEN 'lease expired after spot interruption notice'
                ELSE 'lease expired'
              END
        WHERE state IN ('claimed','running') AND lease_expires_at IS NOT NULL
          AND lease_expires_at < @now
        RETURNING id, spot_interruption_at, claimed_by`,
    )
    .all({ now }) as Array<{
    id: string;
    spot_interruption_at: number | null;
    claimed_by: string | null;
  }>;
  if (!rows.length) return [];
  // Resolve each reaped agent's ECS task ARN (cached per agent) so the caller can
  // clear Hub task protection on the stuck task. Separate lookup because RETURNING
  // can't join runner_agents.
  const getArn = db.prepare('SELECT ecs_task_arn FROM runner_agents WHERE id=?');
  const arnByAgent = new Map<string, string | null>();
  return rows.map((r) => {
    let ecsTaskArn: string | null = null;
    if (r.claimed_by) {
      if (!arnByAgent.has(r.claimed_by)) {
        const a = getArn.get(r.claimed_by) as { ecs_task_arn?: string | null } | undefined;
        arnByAgent.set(r.claimed_by, a?.ecs_task_arn ?? null);
      }
      ecsTaskArn = arnByAgent.get(r.claimed_by) ?? null;
    }
    return { id: r.id, spotReclaimed: r.spot_interruption_at != null, ecsTaskArn };
  });
}
