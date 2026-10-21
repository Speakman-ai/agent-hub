/**
 * Control-plane HTTP API for the pull-based runner fleet.
 *
 *   POST /api/runners/register                 fleet token -> {agentId, token}
 *   POST /api/runners/claim                     long-poll for a job (agent token)
 *   POST /api/runners/jobs/:jobId/poll          long-poll for the next directive (+ heartbeat)
 *   POST /api/runners/jobs/:jobId/logs          stream stdout/stderr frames
 *   POST /api/runners/jobs/:jobId/step-result   report a step's exit code
 *   POST /api/runners/jobs/:jobId/finish        agent torn down
 *   POST /api/runners/jobs/:jobId/environment   PR environment ready (host:port), failed, or lost
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
  setRunnerEnvironmentEndpoint,
} from './runner-queue.js';
import { getJobChannel, removeJobChannel } from './runner-job-channel.js';
import {
  armHubTaskProtection,
  clearHubTaskProtection,
  loadHubTaskProtectionConfig,
} from './hub-task-protection.js';
import type { JobResourceSummary } from './job-resource-sampler.js';
import {
  authenticateFleetToken,
  bearerToken,
  isRunnerFleetEnabled,
  signAgentToken,
  verifyAgentToken,
  type AgentTokenPayload,
} from './runner-auth.js';
import { MACOS_RUNNER_CLASS } from './runner-images.js';
import {
  DESKTOP_CAPABILITY,
  ENVIRONMENT_CAPABILITY,
  parseAgentCapabilities,
} from './runner-fleet-constants.js';
import { readDesktopHomeForJob, saveDesktopHomeForJob } from '../desktop/fleet-desktop-host.js';
import {
  desktopHomeDecisionForJob,
  recordDesktopHomeBlocked,
} from '../desktop/desktop-containers-store.js';
import type { DesktopHomeStore } from '../desktop/desktop-home-store.js';
import { getDesktopHomeSpools, getDesktopHomeStore } from '../desktop/desktop-runtime-setup.js';
import type { HomeSpools } from '../desktop/desktop-home-spool.js';
import { createReadStream, createWriteStream } from 'fs';
import { stat } from 'fs/promises';
import path from 'path';
import { Transform } from 'stream';
import { pipeline } from 'stream/promises';
import { spotReclaimDetail, spotRequeueOnNoticeEnabled } from './spot-interruption.js';
import { parseAgentBringupTimings } from './job-startup.js';

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
  /** Where fleet desktops keep their home snapshots. */
  desktopHomeStore?: () => Promise<DesktopHomeStore>;
  /** Scratch space for home transfers. */
  desktopHomeSpools?: () => HomeSpools;
  /** Largest desktop home snapshot an agent may upload. */
  maxDesktopHomeBytes?: number;
}

/** Default cap on one desktop home snapshot (gzip tarball). */
export const DEFAULT_MAX_DESKTOP_HOME_BYTES = 4 * 1024 * 1024 * 1024;

/** AGENT_HUB_DESKTOP_HOME_MAX_BYTES, else the default. */
export function resolveMaxDesktopHomeBytes(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.AGENT_HUB_DESKTOP_HOME_MAX_BYTES?.trim());
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_DESKTOP_HOME_BYTES;
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

/**
 * Express 4 does not catch a rejected async handler, and Node treats an
 * unhandled rejection as fatal, so one throw (e.g. SQLITE_BUSY on orgs.db)
 * would take down the whole Hub. Answer the request instead: 503 for a busy
 * database so the agent retries, 500 otherwise.
 */
export function guardAsyncRoute<Req extends Request>(
  label: string,
  handler: (req: Req, res: Response) => Promise<void>,
): (req: Req, res: Response) => void {
  return (req, res) => {
    handler(req, res).catch((err: unknown) => {
      const code = (err as { code?: unknown })?.code;
      const busy = typeof code === 'string' && code.startsWith('SQLITE_BUSY');
      console.error(`[runner-routes] ${label} failed:`, err);
      if (res.headersSent) {
        res.destroy();
        return;
      }
      res
        .status(busy ? 503 : 500)
        .json({ error: busy ? 'database busy, retry' : `${label} failed` });
    });
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
  const desktopHomeStore = opts.desktopHomeStore ?? getDesktopHomeStore;
  const homeSpools = opts.desktopHomeSpools ?? getDesktopHomeSpools;
  const maxDesktopHomeBytes = opts.maxDesktopHomeBytes ?? resolveMaxDesktopHomeBytes();

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
    const { fleetToken, orgScope, ecsTaskArn, runnerClass, capabilities } = (req.body ?? {}) as {
      fleetToken?: string;
      orgScope?: string;
      ecsTaskArn?: string;
      runnerClass?: string;
      capabilities?: unknown;
    };
    const auth = authenticateFleetToken(fleetToken);
    if (!auth.ok) {
      res.status(401).json({ error: 'invalid fleet token' });
      return;
    }
    // The runner class partitions the queue (Linux DinD `default` vs native
    // `macos`). Baked into the agent token so it can't be spoofed per-claim.
    const runnerClassValid =
      runnerClass && /^[a-z0-9_-]+$/.test(runnerClass) ? runnerClass : 'default';

    // Native (same-UID, no-sandbox) runners are SINGLE-TENANT only. Job code on
    // the Mac runs as the agent user and can read whatever registration
    // credential the runner holds, so that credential must be narrowly scoped:
    // require an ORG-SCOPED token and pin the agent to that org. This makes a
    // leaked native token non-escalating (it can only register agents for the
    // org the runner already serves) and guarantees a native agent never claims
    // another tenant's jobs. A `shared` native agent is refused outright.
    const isNativeClass = runnerClassValid === MACOS_RUNNER_CLASS;
    let scope: string;
    if (isNativeClass) {
      if (!auth.forcedOrgScope) {
        res.status(403).json({
          error:
            'native runner class requires an org-scoped fleet token ' +
            '(FINALIZE_RUNNER_ORG_FLEET_TOKENS); the shared global token cannot register ' +
            'a native single-tenant runner',
        });
        return;
      }
      scope = auth.forcedOrgScope;
    } else {
      // Org-scoped token is always pinned to its org; the global token may
      // register the requested scope (including `shared`) for the container fleet.
      scope =
        auth.forcedOrgScope ??
        (orgScope && /^[A-Za-z0-9_-]+$/.test(orgScope) ? orgScope : 'shared');
    }
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
    res.json({
      agentId,
      token: signAgentToken({
        agentId,
        orgScope: scope,
        runnerClass: runnerClassValid,
        capabilities: parseAgentCapabilities(capabilities),
      }),
    });
  });

  router.post(
    '/api/runners/claim',
    requireAgent,
    guardAsyncRoute('claim', async (req: RunnerReq, res: Response) => {
      const agent = req.agent!;
      const orgId = agent.orgScope === 'shared' ? null : agent.orgScope;
      touchAgent(agent.agentId);
      const deadline = Date.now() + claimWaitMs;
      for (;;) {
        const job = claimRunnerJob({
          agentId: agent.agentId,
          orgId,
          runnerClass: agent.runnerClass ?? 'default',
          canRunEnvironments: agent.capabilities?.includes(ENVIRONMENT_CAPABILITY) ?? false,
          canRunDesktops: agent.capabilities?.includes(DESKTOP_CAPABILITY) ?? false,
          leaseMs,
          now: Date.now(),
        });
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
          await armHubTaskProtection(agentTaskArn(agent.agentId), taskProtectionCfg, {
            force: true,
          });
          // Attach as soon as a live agent owns the job — do NOT wait for the first
          // directive poll. The agent still materializes the worktree + starts DinD
          // *after* claim; if acquire only resolved on that first poll, a hung
          // bring-up kept heartbeats alive while Hub steps sat `queued` forever
          // (electron shard stranded while siblings passed; fleet scaled to 1).
          // Claim-time attach lets the Hub mark steps running and queue `run_step`
          // directives; the agent drains them once bring-up finishes.
          getJobChannel(job.id)?.attach();
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
    }),
  );

  router.post(
    '/api/runners/jobs/:jobId/poll',
    requireAgent,
    guardAsyncRoute('poll', async (req: RunnerReq, res: Response) => {
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
    }),
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
      // Contact, even when the answer is 410: a stopped desktop's runner keeps
      // heartbeating while it removes the container and saves the home, and
      // the time since its last contact is evidence for a Spot reclaim.
      touchAgent(req.agent!.agentId);
      const now = Date.now();
      const live = heartbeatRunnerJob({ jobId, agentId: req.agent!.agentId, leaseMs, now });
      const spotReported =
        (req.body as { spotInterruption?: unknown } | undefined)?.spotInterruption === true;
      const firstSpotReport =
        spotReported && markRunnerJobSpotInterruption({ jobId, agentId: req.agent!.agentId, now });
      // The agent probes IMDS and sets `spotInterruption: true` once EC2 posts
      // the 2-minute reclaim notice. The instance is certain to die, so on the
      // FIRST report (the stamp is sticky and only lands once) give up on this
      // agent now instead of waiting ~2 minutes for the kill plus a lease
      // expiry: mark the queue row lost and fail the in-process channel with the
      // spot_reclaimed marker. step-runner settles the in-flight step as a
      // `spot_reclaimed` spawn-error and the per-instance infra retry re-queues
      // the shard on a fresh agent. This also keeps the doomed agent's
      // `context canceled` step result from ever being classified, since the
      // channel is already closed when it arrives. Scoped to the claiming agent
      // + a live state, so a stale or spoofed report can't touch other jobs.
      // FINALIZE_SPOT_REQUEUE_ON_NOTICE=0 keeps the stamp but skips the requeue.
      if (firstSpotReport && spotRequeueOnNoticeEnabled()) {
        reportRunnerJob({
          jobId,
          state: 'lost',
          detail: 'spot interruption notice; requeued before the instance was reclaimed',
          now,
        });
        getJobChannel(jobId)?.fail(
          new Error(
            spotReclaimDetail(
              'EC2 Spot interruption notice received; requeuing on a fresh runner before the instance is reclaimed',
            ),
          ),
        );
        void clearHubTaskProtection(agentTaskArn(req.agent!.agentId), taskProtectionCfg);
        res.status(410).json({ error: 'job requeued after spot interruption notice' });
        return;
      }
      // The row is terminal (requeued on a spot notice, reaped, cancelled):
      // whatever this agent is still running is a duplicate whose result the
      // Hub ignores. 410 tells the agent to kill the step now rather than run
      // it to completion (or until the instance dies) beside its replacement.
      // Older agents ignore the heartbeat status, so this is backward compatible.
      if (!live) {
        res.status(410).json({ error: 'job is no longer live' });
        return;
      }
      // Re-arm scale-in protection off the SAME heartbeat that keeps the lease
      // alive (throttled). This is the crux: a long shard keeps heartbeating, so
      // the Hub keeps protection fresh — it can't silently lapse the way the
      // agent's best-effort local self-protect does under load. If heartbeats
      // ever stop, the lease expires and the reaper clears protection: consistent.
      void armHubTaskProtection(agentTaskArn(req.agent!.agentId), taskProtectionCfg, {
        now: () => now,
      });
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

  // Bring-up phase timings, sent once by the agent right before its first poll.
  // Best-effort telemetry: a malformed body is ignored, never an error the agent
  // has to handle.
  router.post('/api/runners/jobs/:jobId/bringup', requireAgent, (req: RunnerReq, res: Response) => {
    const jobId = req.params.jobId as string;
    if (!authorizeJob(req.agent!, jobId, res)) return;
    const timings = parseAgentBringupTimings((req.body ?? {}).timings);
    if (timings) getJobChannel(jobId)?.onBringup(timings);
    res.status(204).end();
  });

  router.post('/api/runners/jobs/:jobId/finish', requireAgent, (req: RunnerReq, res: Response) => {
    const jobId = req.params.jobId as string;
    if (!authorizeJob(req.agent!, jobId, res)) return;
    getJobChannel(jobId)?.onFinish();
    // An environment (or desktop) is only torn down after the Hub ends its
    // row. One that finishes while still live went down on its own: record it
    // as lost so the Hub requeues it instead of routing to a dead upstream.
    getOrgsDb()
      .prepare(
        `UPDATE runner_jobs SET state='lost', detail='environment runner exited', ended_at=?
          WHERE id=? AND kind IN ('environment','desktop') AND state IN ('claimed','running')`,
      )
      .run(Date.now(), jobId);
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

  // A PR environment job reports its outcome here instead of per-step
  // results: ready with the host:port the Hub routes to, or failed. 410 when
  // the row is no longer live (stopped or rebuilt meanwhile), which tells the
  // agent to tear the stack down.
  router.post(
    '/api/runners/jobs/:jobId/environment',
    requireAgent,
    (req: RunnerReq, res: Response) => {
      const jobId = req.params.jobId as string;
      if (!authorizeJob(req.agent!, jobId, res)) return;
      const body = (req.body ?? {}) as {
        status?: unknown;
        host?: unknown;
        port?: unknown;
        detail?: unknown;
      };
      const now = Date.now();
      if (body.status === 'ready') {
        const host = typeof body.host === 'string' ? body.host.trim() : '';
        const port = typeof body.port === 'number' ? body.port : NaN;
        if (
          !/^[A-Za-z0-9.:-]{1,255}$/.test(host) ||
          !Number.isInteger(port) ||
          port < 1 ||
          port > 65535
        ) {
          res.status(400).json({ error: 'host (string) and port (1-65535) required' });
          return;
        }
        const ok = setRunnerEnvironmentEndpoint({
          jobId,
          agentId: req.agent!.agentId,
          endpoint: { host, port },
          now,
        });
        if (!ok) {
          res.status(410).json({ error: 'environment job is no longer live' });
          return;
        }
        res.status(204).end();
        return;
      }
      if (body.status === 'failed' || body.status === 'lost') {
        const detail =
          typeof body.detail === 'string' && body.detail.trim()
            ? body.detail.slice(0, 2000)
            : body.status === 'lost'
              ? 'environment stopped running'
              : 'environment failed to start';
        // `lost` (the stack died after it was ready) makes the Hub requeue it;
        // `failed` (bring-up failed) does not.
        reportRunnerJob({ jobId, state: body.status, detail, now });
        res.status(204).end();
        return;
      }
      res.status(400).json({ error: "status must be 'ready', 'failed' or 'lost'" });
    },
  );

  // Desktop home snapshots (fleet desktops). The agent downloads the last
  // snapshot before it boots the desktop and uploads a fresh one after the Hub
  // stops it, so the row is usually already cancelled by the PUT. Only the
  // claiming agent of a `desktop` row may read or write its home.
  function isDesktopJob(jobId: string, res: Response): boolean {
    const row = getOrgsDb().prepare('SELECT kind FROM runner_jobs WHERE id=?').get(jobId) as
      | { kind: string | null }
      | undefined;
    if (row?.kind !== 'desktop') {
      res.status(404).json({ error: 'not a desktop job' });
      return false;
    }
    return true;
  }

  router.get(
    '/api/runners/jobs/:jobId/desktop-home',
    requireAgent,
    async (req: RunnerReq, res: Response) => {
      const jobId = req.params.jobId as string;
      if (!authorizeJob(req.agent!, jobId, res) || !isDesktopJob(jobId, res)) return;
      touchAgent(req.agent!.agentId);
      // Express 4 doesn't catch a rejected async handler, so a spool that
      // can't be set up (full or unreadable disk) answers here instead.
      let spool: Awaited<ReturnType<HomeSpools['open']>>;
      try {
        spool = await homeSpools().open();
      } catch (err) {
        res
          .status(500)
          .json({ error: `home transfer spool unavailable: ${(err as Error).message}` });
        return;
      }
      const dir = spool.dir;
      try {
        const file = path.join(dir, 'home.tar.gz');
        const found = await readDesktopHomeForJob(jobId, await desktopHomeStore(), file);
        if (found === 'none') {
          res.status(404).json({ error: 'no home snapshot' });
          return;
        }
        if (found === 'missing') {
          // The agent must not boot a fresh home over a snapshot it can't see.
          res.status(409).json({ error: 'the saved home snapshot is missing from the store' });
          return;
        }
        const { size } = await stat(file);
        res.status(200).set({ 'content-type': 'application/gzip', 'content-length': String(size) });
        await pipeline(createReadStream(file), res);
      } catch (err) {
        if (!res.headersSent) {
          res.status(500).json({ error: `home download failed: ${(err as Error).message}` });
        } else {
          res.destroy();
        }
      } finally {
        await spool.close();
      }
    },
  );

  router.put(
    '/api/runners/jobs/:jobId/desktop-home',
    requireAgent,
    async (req: RunnerReq, res: Response) => {
      const jobId = req.params.jobId as string;
      if (!authorizeJob(req.agent!, jobId, res) || !isDesktopJob(jobId, res)) return;
      touchAgent(req.agent!.agentId);
      const declared = Number(req.headers['content-length']);
      if (Number.isFinite(declared) && declared > maxDesktopHomeBytes) {
        res.status(413).json({ error: `home snapshot exceeds ${maxDesktopHomeBytes} bytes` });
        return;
      }
      // Express 4 doesn't catch a rejected async handler, so a spool that
      // can't be set up (full or unreadable disk) answers here instead.
      let spool: Awaited<ReturnType<HomeSpools['open']>>;
      try {
        spool = await homeSpools().open();
      } catch (err) {
        res
          .status(500)
          .json({ error: `home transfer spool unavailable: ${(err as Error).message}` });
        return;
      }
      const dir = spool.dir;
      try {
        const file = path.join(dir, 'home.tar.gz');
        let seen = 0;
        const cap = new Transform({
          transform(chunk: Buffer, _enc, cb) {
            seen += chunk.length;
            if (seen > maxDesktopHomeBytes) cb(new Error('home snapshot too large'));
            else cb(null, chunk);
          },
        });
        try {
          await pipeline(req, cap, createWriteStream(file));
        } catch (err) {
          const tooBig = seen > maxDesktopHomeBytes;
          res
            .status(tooBig ? 413 : 400)
            .json({ error: tooBig ? 'home snapshot too large' : (err as Error).message });
          return;
        }
        if (seen === 0) {
          res.status(400).json({ error: 'empty home snapshot' });
          return;
        }
        const saved = await saveDesktopHomeForJob(jobId, await desktopHomeStore(), file);
        if (!saved) {
          res
            .status(410)
            .json({ error: 'the desktop moved past this run, or was deleted; upload discarded' });
          return;
        }
        res.status(204).end();
      } catch (err) {
        res.status(500).json({ error: `home upload failed: ${(err as Error).message}` });
      } finally {
        await spool.close();
      }
    },
  );

  // The Hub refused this run's home for good (413): the agent keeps it on its
  // box and reports where, before finishing. The computer is then blocked
  // from starting on an older home until an operator resolves it.
  router.post(
    '/api/runners/jobs/:jobId/desktop-home-rejected',
    requireAgent,
    (req: RunnerReq, res: Response) => {
      const jobId = req.params.jobId as string;
      if (!authorizeJob(req.agent!, jobId, res) || !isDesktopJob(jobId, res)) return;
      touchAgent(req.agent!.agentId);
      const raw = (req.body as { detail?: unknown } | undefined)?.detail;
      const detail = typeof raw === 'string' && raw.trim() ? raw.slice(0, 2000) : null;
      if (!detail) {
        res.status(400).json({ error: 'detail (string) required' });
        return;
      }
      if (
        !recordDesktopHomeBlocked({ jobId, detail: `${detail} (runner ${req.agent!.agentId})` })
      ) {
        res.status(410).json({ error: 'the desktop moved past this run, or was deleted' });
        return;
      }
      res.status(204).end();
    },
  );

  // A runner parked on a refused home asks what to do with it: `hold`,
  // `retry` (upload again) or `discard` (remove the volume, then finish).
  router.get(
    '/api/runners/jobs/:jobId/desktop-home-decision',
    requireAgent,
    (req: RunnerReq, res: Response) => {
      const jobId = req.params.jobId as string;
      if (!authorizeJob(req.agent!, jobId, res) || !isDesktopJob(jobId, res)) return;
      touchAgent(req.agent!.agentId);
      res.json({ decision: desktopHomeDecisionForJob(jobId) });
    },
  );

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
    removeJobChannel(jobId);
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
