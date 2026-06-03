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
} from './runner-queue.js';
import { getJobChannel } from './runner-job-channel.js';
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

export interface RunnerRoutesOptions {
  claimWaitMs?: number;
  pollWaitMs?: number;
  leaseMs?: number;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

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

  router.post('/api/runners/register', (req: Request, res: Response) => {
    if (!isRunnerFleetEnabled()) {
      res.status(404).json({ error: 'runner fleet not enabled' });
      return;
    }
    const { fleetToken, orgScope } = (req.body ?? {}) as {
      fleetToken?: string;
      orgScope?: string;
    };
    if (!verifyFleetToken(fleetToken)) {
      res.status(401).json({ error: 'invalid fleet token' });
      return;
    }
    const scope = orgScope && /^[A-Za-z0-9_-]+$/.test(orgScope) ? orgScope : 'shared';
    const agentId = randomUUID();
    const now = Date.now();
    getOrgsDb()
      .prepare(
        `INSERT INTO runner_agents (id, org_scope, state, registered_at, last_seen_at)
         VALUES (?, ?, 'idle', ?, ?)`,
      )
      .run(agentId, scope, now, now);
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
      heartbeatRunnerJob({ jobId, agentId: req.agent!.agentId, leaseMs, now: Date.now() });
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
    getOrgsDb()
      .prepare(
        "UPDATE runner_agents SET state='idle', current_job_id=NULL, last_seen_at=? WHERE id=?",
      )
      .run(Date.now(), req.agent!.agentId);
    res.status(204).end();
  });

  return router;
}
