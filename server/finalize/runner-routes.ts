/**
 * runner-routes.ts — control-plane HTTP API for the pull-based runner fleet.
 *
 *   POST /api/runners/register                 fleet token -> {agentId, token}
 *   POST /api/runners/claim                     long-poll for a job (agent token)
 *   POST /api/runners/jobs/:jobId/poll          long-poll for the next directive (+ heartbeat)
 *   POST /api/runners/jobs/:jobId/logs          stream stdout/stderr frames
 *   POST /api/runners/jobs/:jobId/step-result   report a step's exit code
 *   POST /api/runners/jobs/:jobId/finish        agent torn down
 *
 * Claim/poll are HTTP long-polls (held server-side, no busy client loop). A
 * job's stream endpoints are accepted ONLY from the agent that claimed it.
 */
import { Router, type NextFunction, type Request, type Response } from 'express';
import { randomUUID } from 'crypto';
import { getOrgsDb } from '../orgs.js';
import {
  appendRunnerJobLog,
  claimRunnerJob,
  heartbeatRunnerJob,
  markRunnerJobRunning,
  markRunnerJobSpotInterruption,
  reportRunnerJob,
} from './runner-queue.js';
import { getJobChannel } from './runner-job-channel.js';
import {
  armHubTaskProtection,
  clearHubTaskProtection,
  loadHubTaskProtectionConfig,
} from './hub-task-protection.js';
import type { JobResourceSummary } from './job-resource-sampler.js';
import {
  bearerToken,
  isRunnerFleetEnabled,
  signAgentToken,
  verifyAgentToken,
  verifyFleetToken,
  type AgentTokenPayload,
} from './runner-auth.js';

interface RunnerReq extends Request {
  agent?: AgentTokenPayload;
}

/** Resolved per-job context + the reported summary, handed to the Hub sink. */
export interface JobResourcesEvent {
  jobId: string;
  orgId: string;
  projectId: string;
  runId: string;
  /** The CI job name (runner_jobs.job_id), e.g. `e2e`. */
  jobName: string;
  matrixKey: string;
  summary: JobResourceSummary;
}

export interface RunnerRoutesOptions {
  claimWaitMs?: number;
  pollWaitMs?: number;
  leaseMs?: number;
  /**
   * Called when an agent reports a job's resource summary on finish. The mount
   * site wires this to the metrics emitter + Hub log + WS broadcast. Best-effort
   * — invoked inside a try/catch so it can never fail the finish handshake.
   */
  onJobResources?: (event: JobResourcesEvent) => void;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Validate the untrusted `resourceSummary` an agent POSTs on finish. Returns a
 * clean {@link JobResourceSummary} or null (malformed → simply not recorded).
 */
export function parseResourceSummary(raw: unknown): JobResourceSummary | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const num = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) ? v : null;
  const peakMemBytes = num(r.peakMemBytes);
  const memTotalBytes = num(r.memTotalBytes);
  if (peakMemBytes === null || peakMemBytes < 0 || memTotalBytes === null || memTotalBytes <= 0) {
    return null;
  }
  return {
    peakMemBytes,
    memTotalBytes,
    peakCpuPercent: r.peakCpuPercent === null ? null : num(r.peakCpuPercent),
    avgCpuPercent: r.avgCpuPercent === null ? null : num(r.avgCpuPercent),
    samples: num(r.samples) ?? 0,
    durationMs: num(r.durationMs) ?? 0,
  };
}

export default function createRunnerRoutes(opts: RunnerRoutesOptions = {}): Router {
  const router = Router();
  const claimWaitMs = opts.claimWaitMs ?? 25_000;
  const pollWaitMs = opts.pollWaitMs ?? 25_000;
  // Lease must comfortably exceed the agent's heartbeat interval (~30s) AND
  // tolerate brief gaps. The agent heartbeats continuously (background timer +
  // on every log post), so the reaper only fires for a genuinely dead agent —
  // never mid-step. Was 120s, which reaped live agents during long e2e steps /
  // slow DinD startup, dropping depth to 0 and letting the scaler kill them.
  const leaseMs = opts.leaseMs ?? 300_000;

  function requireAgent(req: RunnerReq, res: Response, next: NextFunction): void {
    const payload = verifyAgentToken(bearerToken(req.headers.authorization));
    if (!payload) {
      res.status(401).json({ error: 'invalid or expired agent token' });
      return;
    }
    req.agent = payload;
    next();
  }

  /** A job's stream is only accessible to the agent that claimed it. */
  function authorizeJob(agent: AgentTokenPayload, jobId: string, res: Response): boolean {
    const row = getOrgsDb().prepare('SELECT claimed_by FROM runner_jobs WHERE id=?').get(jobId) as
      | { claimed_by: string | null }
      | undefined;
    if (!row) {
      res.status(404).json({ error: 'unknown job' });
      return false;
    }
    if (row.claimed_by !== agent.agentId) {
      res.status(403).json({ error: 'job is not claimed by this agent' });
      return false;
    }
    return true;
  }

  function touchAgent(agentId: string): void {
    getOrgsDb()
      .prepare('UPDATE runner_agents SET last_seen_at=? WHERE id=?')
      .run(Date.now(), agentId);
  }

  // Hub-driven ECS task scale-in protection. The Hub owns the queue lease, so it
  // arms/clears protection in lockstep with claim/heartbeat/terminal — far more
  // reliable than the agent's best-effort self-protect (which silently drops
  // under load and leaves long shards exposed to a dynamic scale-in). Off-ECS /
  // unknown cluster → every call is a no-op. Config is fixed for the process.
  const taskProtectionCfg = loadHubTaskProtectionConfig();
  const agentTaskArn = (agentId: string): string | null =>
    (
      getOrgsDb().prepare('SELECT ecs_task_arn FROM runner_agents WHERE id=?').get(agentId) as
        | { ecs_task_arn?: string | null }
        | undefined
    )?.ecs_task_arn ?? null;

  router.post('/api/runners/register', (req: Request, res: Response) => {
    if (!isRunnerFleetEnabled()) {
      res.status(404).json({ error: 'runner fleet not enabled' });
      return;
    }
    const { fleetToken, orgScope, ecsTaskArn } = (req.body ?? {}) as {
      fleetToken?: string;
      orgScope?: string;
      ecsTaskArn?: string;
    };
    if (!verifyFleetToken(fleetToken)) {
      res.status(401).json({ error: 'invalid fleet token' });
      return;
    }
    const scope = orgScope && /^[A-Za-z0-9_-]+$/.test(orgScope) ? orgScope : 'shared';
    // The agent reports its own ECS task ARN (from the ECS metadata endpoint) so
    // the Hub can protect that exact task on claim. Validate it loosely; off-ECS
    // agents send nothing and the Hub-side protection no-ops.
    const taskArn =
      typeof ecsTaskArn === 'string' && /^arn:aws:ecs:[\w-]+:\d+:task\//.test(ecsTaskArn)
        ? ecsTaskArn
        : null;
    const agentId = randomUUID();
    const now = Date.now();
    getOrgsDb()
      .prepare(
        `INSERT INTO runner_agents (id, org_scope, state, ecs_task_arn, registered_at, last_seen_at)
         VALUES (?, ?, 'idle', ?, ?, ?)`,
      )
      .run(agentId, scope, taskArn, now, now);
    res.json({ agentId, token: signAgentToken({ agentId, orgScope: scope }) });
  });

  router.post('/api/runners/claim', requireAgent, async (req: RunnerReq, res: Response) => {
    const agent = req.agent!;
    const orgId = agent.orgScope === 'shared' ? null : agent.orgScope;
    touchAgent(agent.agentId);
    const deadline = Date.now() + claimWaitMs;
    for (;;) {
      const job = claimRunnerJob({ agentId: agent.agentId, orgId, leaseMs, now: Date.now() });
      if (job) {
        getOrgsDb()
          .prepare(
            "UPDATE runner_agents SET state='busy', current_job_id=?, last_seen_at=? WHERE id=?",
          )
          .run(job.id, Date.now(), agent.agentId);
        // Arm scale-in protection BEFORE handing the job to the agent (force past
        // the throttle). AWAIT it — not fire-and-forget — so the task is actually
        // confirmed protected (or skipped off-ECS) before it becomes visible to
        // the agent; otherwise a concurrent dynamic scale-in could pick this
        // newly-busy task in the window before UpdateTaskProtection returns. The
        // call never throws (off-ECS / unknown ARN → instant 'skipped'; an ECS
        // failure → 'error', which the per-heartbeat re-arm then retries), so
        // awaiting it can't break the claim handshake.
        await armHubTaskProtection(agentTaskArn(agent.agentId), taskProtectionCfg, { force: true });
        res.json({
          jobId: job.id,
          spec: JSON.parse(job.specJson),
          secretsRef: job.secretsRef,
          leaseExpiresAt: job.leaseExpiresAt,
        });
        return;
      }
      if (Date.now() >= deadline || res.writableEnded) {
        res.status(204).end();
        return;
      }
      await sleep(Math.min(500, deadline - Date.now()));
    }
  });

  router.post(
    '/api/runners/jobs/:jobId/poll',
    requireAgent,
    async (req: RunnerReq, res: Response) => {
      const jobId = req.params.jobId as string;
      if (!authorizeJob(req.agent!, jobId, res)) return;
      const channel = getJobChannel(jobId);
      if (!channel) {
        res.status(410).json({ error: 'job channel gone (Hub restarted?)' });
        return;
      }
      heartbeatRunnerJob({ jobId, agentId: req.agent!.agentId, leaseMs, now: Date.now() });
      const directive = await channel.nextDirective(pollWaitMs);
      if (directive?.type === 'run_step') markRunnerJobRunning(jobId, Date.now());
      res.json(directive ?? { type: 'idle' });
    },
  );

  router.post('/api/runners/jobs/:jobId/logs', requireAgent, (req: RunnerReq, res: Response) => {
    const jobId = req.params.jobId as string;
    if (!authorizeJob(req.agent!, jobId, res)) return;
    const channel = getJobChannel(jobId);
    const frames = (
      (req.body?.frames ?? []) as Array<{
        seq: number;
        stepIndex: number;
        stream: 'stdout' | 'stderr';
        data: string;
      }>
    ).filter((f) => f && (f.stream === 'stdout' || f.stream === 'stderr'));
    const now = Date.now();
    // Log activity is liveness — extend the lease so a chatty step never gets reaped.
    heartbeatRunnerJob({ jobId, agentId: req.agent!.agentId, leaseMs, now });
    for (const f of frames) {
      appendRunnerJobLog({
        jobId,
        seq: f.seq,
        stepIndex: f.stepIndex,
        stream: f.stream,
        data: f.data,
        now,
      });
      channel?.onLog(f.stepIndex, f.stream, f.data);
    }
    res.status(204).end();
  });

  // Dedicated lightweight heartbeat: the agent pings this on a background timer
  // for the whole job (through worktree materialize, DinD startup, and long
  // silent steps), so a live job keeps its lease even when it isn't polling or
  // emitting logs.
  router.post(
    '/api/runners/jobs/:jobId/heartbeat',
    requireAgent,
    (req: RunnerReq, res: Response) => {
      const jobId = req.params.jobId as string;
      if (!authorizeJob(req.agent!, jobId, res)) return;
      const now = Date.now();
      heartbeatRunnerJob({ jobId, agentId: req.agent!.agentId, leaseMs, now });
      // Re-arm scale-in protection off the SAME heartbeat that keeps the lease
      // alive (throttled). This is the crux: a long shard keeps heartbeating, so
      // the Hub keeps protection fresh — it can't silently lapse the way the
      // agent's best-effort local self-protect does under load. If heartbeats
      // ever stop, the lease expires and the reaper clears protection: consistent.
      void armHubTaskProtection(agentTaskArn(req.agent!.agentId), taskProtectionCfg, {
        now: () => now,
      });
      // The agent polls IMDS on its heartbeat tick; when it sees an EC2 Spot
      // interruption notice it sets `spotInterruption: true` here. Stamp the row
      // (sticky) so that when the instance dies and the lease expires, the reaper
      // can classify the lost job as `spot_reclaimed` (generous retry cap) rather
      // than a generic crash. Honored only from the claiming agent (the queue op
      // scopes to claimed_by + a live state).
      if ((req.body as { spotInterruption?: unknown } | undefined)?.spotInterruption === true) {
        markRunnerJobSpotInterruption({ jobId, agentId: req.agent!.agentId, now });
      }
      res.status(204).end();
    },
  );

  router.post(
    '/api/runners/jobs/:jobId/step-result',
    requireAgent,
    (req: RunnerReq, res: Response) => {
      const jobId = req.params.jobId as string;
      if (!authorizeJob(req.agent!, jobId, res)) return;
      const { stepIndex, exitCode } = (req.body ?? {}) as {
        stepIndex?: number;
        exitCode?: number;
      };
      if (typeof stepIndex !== 'number') {
        res.status(400).json({ error: 'stepIndex (number) required' });
        return;
      }
      getJobChannel(jobId)?.onStepResult(stepIndex, typeof exitCode === 'number' ? exitCode : null);
      res.status(204).end();
    },
  );

  router.post('/api/runners/jobs/:jobId/finish', requireAgent, (req: RunnerReq, res: Response) => {
    const jobId = req.params.jobId as string;
    if (!authorizeJob(req.agent!, jobId, res)) return;
    getJobChannel(jobId)?.onFinish();
    // Per-job resource summary (best-effort — never fail the finish handshake).
    if (opts.onJobResources) {
      try {
        const summary = parseResourceSummary((req.body ?? {}).resourceSummary);
        if (summary) {
          const row = getOrgsDb()
            .prepare(
              'SELECT org_id, project_id, run_id, job_id, matrix_key FROM runner_jobs WHERE id=?',
            )
            .get(jobId) as
            | {
                org_id: string;
                project_id: string;
                run_id: string;
                job_id: string;
                matrix_key: string;
              }
            | undefined;
          if (row) {
            opts.onJobResources({
              jobId,
              orgId: row.org_id,
              projectId: row.project_id,
              runId: row.run_id,
              jobName: row.job_id,
              matrixKey: row.matrix_key,
              summary,
            });
          }
        }
      } catch (err) {
        console.warn(
          `[finalize-job-resources] failed to record summary for job ${jobId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    getOrgsDb()
      .prepare(
        "UPDATE runner_agents SET state='idle', current_job_id=NULL, last_seen_at=? WHERE id=?",
      )
      .run(Date.now(), req.agent!.agentId);
    // Job done → release the task so deploys / dynamic scale-in can reclaim this
    // now-idle agent. Fire-and-forget.
    void clearHubTaskProtection(agentTaskArn(req.agent!.agentId), taskProtectionCfg);
    res.status(204).end();
  });

  // The agent could not run the claimed job to completion (a throw out of
  // runAgentJob — bring-up failure before/around the first step). Fail the channel
  // so the backend's acquire/step wait unblocks NOW (→ infra_error → retry on a
  // fresh agent) and mark the queue row terminal, instead of leaving the shard
  // orphaned until the lease reaper notices the missing heartbeat. Idempotent and
  // safe if the channel is already gone (Hub restart) or the row already terminal.
  router.post('/api/runners/jobs/:jobId/error', requireAgent, (req: RunnerReq, res: Response) => {
    const jobId = req.params.jobId as string;
    if (!authorizeJob(req.agent!, jobId, res)) return;
    const detailRaw = (req.body as { detail?: unknown } | undefined)?.detail;
    const detail =
      typeof detailRaw === 'string' && detailRaw.trim()
        ? detailRaw.slice(0, 2000)
        : 'runner agent reported a job error';
    getJobChannel(jobId)?.fail(new Error(`runner agent lost — ${detail}`));
    reportRunnerJob({ jobId, state: 'lost', detail, now: Date.now() });
    getOrgsDb()
      .prepare(
        "UPDATE runner_agents SET state='idle', current_job_id=NULL, last_seen_at=? WHERE id=?",
      )
      .run(Date.now(), req.agent!.agentId);
    void clearHubTaskProtection(agentTaskArn(req.agent!.agentId), taskProtectionCfg);
    res.status(204).end();
  });

  return router;
}
