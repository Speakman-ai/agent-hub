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

/** Record a terminal outcome for a job. */
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
        WHERE id=@jobId`,
    )
    .run({
      jobId: args.jobId,
      state: args.state,
      exitCode: args.exitCode ?? null,
      detail: args.detail ?? null,
      now: args.now,
    });
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
 * Mark claimed/running jobs whose lease has expired as `lost` (the reaper). The
 * orchestrator's own retry logic decides what to do — we do NOT auto-requeue.
 * Returns the affected job ids.
 */
export function reapExpiredRunnerLeases(now: number): string[] {
  const rows = getOrgsDb()
    .prepare(
      `UPDATE runner_jobs
          SET state='lost', ended_at=@now, detail='lease expired'
        WHERE state IN ('claimed','running') AND lease_expires_at IS NOT NULL
          AND lease_expires_at < @now
        RETURNING id`,
    )
    .all({ now }) as Array<{ id: string }>;
  return rows.map((r) => r.id);
}
