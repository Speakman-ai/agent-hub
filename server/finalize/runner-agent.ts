/**
 * runner-agent.ts — the pull-based runner agent that executes one Finalize job.
 *
 * Runs inside a fleet task. Loop: register → claim → materialize the worktree
 * bundle → start a fresh DinD container (via the SHARED runner-exec-args, for
 * local/remote parity) → poll for run_step directives, exec each into the
 * container while streaming stdout/stderr back, report each exit code → on a
 * `finish` directive (or 410 = channel gone) tear the container down and exit.
 *
 * The job loop takes injected `transport` + `docker` so it's unit-testable with
 * fakes (no real HTTP/Docker); `realDockerOps`/`httpTransport`/`runAgentMain`
 * wire the production implementations.
 */
import { spawn } from 'child_process';
import path from 'path';
import { buildExecJobStepArgv, sanitizeJobContainerName } from './runner-exec-args.js';
import { startJobContainer, stopJobContainer } from './job-container.js';
import {
  startHostSampler,
  type JobResourceSummary,
  type RunningSampler,
} from './job-resource-sampler.js';
import type { RunnerDirective } from './runner-job-channel.js';
import type { RunnerJobWireSpec } from './runner-backend-remote.js';
import { LocalDirBundleStore, materializeWorktree, type BundleStore } from './worktree-bundle.js';
import {
  ecsTaskProtection,
  noopTaskProtection,
  type TaskProtection,
} from './ecs-task-protection.js';
import { checkSpotInterruption } from './spot-interruption.js';

export interface AgentLogFrame {
  seq: number;
  stepIndex: number;
  stream: 'stdout' | 'stderr';
  data: string;
}

export type AgentPollResult = RunnerDirective | { type: 'idle' } | { type: 'gone' };

export interface AgentTransport {
  claim(): Promise<{ jobId: string; spec: RunnerJobWireSpec } | null>;
  poll(jobId: string): Promise<AgentPollResult>;
  postLogs(jobId: string, frames: AgentLogFrame[]): Promise<void>;
  postStepResult(jobId: string, stepIndex: number, exitCode: number | null): Promise<void>;
  postFinish(
    jobId: string,
    exitCode: number,
    resourceSummary?: JobResourceSummary | null,
  ): Promise<void>;
  /**
   * Extend the job's lease while it's alive (called on a background timer).
   * `spotInterruption` is set true once the agent's IMDS poll detects a pending
   * EC2 Spot reclaim, so the Hub can stamp the job and later classify its lost
   * lease as `spot_reclaimed` rather than a generic crash.
   */
  heartbeat(jobId: string, spotInterruption?: boolean): Promise<void>;
  /**
   * Report that this agent could not run the claimed job to completion (a throw
   * out of `runAgentJob` — worktree materialize error, inner dockerd never ready,
   * image pull failure, …). The Hub fails the job channel (unblocking the waiting
   * acquire/step immediately → infra_error → retry on a fresh agent) and marks the
   * queue row terminal, so the job is recovered NOW instead of waiting out the
   * lease reaper. Best-effort — the lease reaper is still the backstop if the
   * agent dies so hard it can't make this call.
   */
  reportError(jobId: string, detail: string): Promise<void>;
}

export interface AgentDocker {
  startContainer(spec: RunnerJobWireSpec, workspaceMount: string): Promise<string>;
  execStep(
    containerName: string,
    run: string,
    env: Record<string, string>,
    onLog: (stream: 'stdout' | 'stderr', data: string) => void,
  ): Promise<number>;
  stopContainer(containerName: string): Promise<void>;
}

/**
 * Run a single claimed job to completion. Returns the per-step exit codes.
 * Pure control flow over the injected transport/docker — the unit of test.
 */
export async function runAgentJob(args: {
  jobId: string;
  spec: RunnerJobWireSpec;
  workspaceDir: string;
  transport: AgentTransport;
  docker: AgentDocker;
  materialize?: (spec: RunnerJobWireSpec, destPath: string) => Promise<void>;
  logFlushMs?: number;
  heartbeatMs?: number;
  /**
   * Cadence of the IMDS Spot-interruption probe. Deliberately faster than the
   * heartbeat (default 5s vs 30s) so a 2-minute reclaim notice is caught well
   * within its window even when heavy step-log streaming stretches the slower
   * heartbeat tick. Runs on its OWN interval — decoupled from lease renewal so a
   * slow/hung metadata probe can never delay a heartbeat (which would risk the
   * very `lease expired` reaping this aims to prevent).
   */
  spotProbeMs?: number;
  protection?: TaskProtection;
  /**
   * Starts the host resource sampler for this job. Injectable for tests;
   * defaults to the real `/proc`-backed sampler. Returns a no-op handle on
   * platforms without `/proc` so the agent never crashes off-Linux.
   */
  startSampler?: () => RunningSampler;
  /**
   * Probe for a pending EC2 Spot interruption (IMDS). Injectable for tests;
   * defaults to the real IMDSv2 probe, which is a fast no-op off EC2. Returns
   * true once a 2-minute reclaim notice is observed.
   */
  checkSpot?: () => Promise<boolean>;
}): Promise<{ stepExits: Array<{ stepIndex: number; exitCode: number | null }> }> {
  const { jobId, spec, transport, docker } = args;
  const protection = args.protection ?? noopTaskProtection();
  const checkSpot = args.checkSpot ?? (async () => (await checkSpotInterruption()).pending);
  // Sticky: once IMDS reports a reclaim notice it never un-reports, and the Hub
  // stamp is one-way, so we keep telling the Hub on every heartbeat until the
  // instance dies. Avoids a race where one report is lost to a transient blip.
  let spotInterruption = false;
  // Shield this ECS task from deployment / scale-in termination while it owns the
  // job. A killed agent strands the shard (lease expires → reaper marks it `lost`)
  // and hangs the waiting session; protection makes a rolling deploy wait for the
  // job instead of SIGKILLing it. Best-effort — protection errors must NEVER fail
  // the job (a non-ECS host returns a no-op; a transient API blip retries below).
  void protection.set(true).catch(() => {});
  const unref = (t: ReturnType<typeof setInterval>): void => {
    if (typeof (t as { unref?: () => void }).unref === 'function') {
      (t as { unref: () => void }).unref();
    }
  };
  // Background heartbeat for the WHOLE job — through worktree materialize, DinD
  // startup, and long/silent steps — so the Hub's lease never expires under a
  // live agent (which would let the reaper mark it lost and the scaler kill it).
  // The same tick re-arms task protection before its bounded expiry lapses. It
  // reports the latest sticky spot flag but NEVER awaits the IMDS probe: lease
  // renewal must not ride on a metadata round-trip that could stall and trigger
  // the spurious reaping this whole path exists to avoid.
  const heartbeat = setInterval(() => {
    void transport.heartbeat(jobId, spotInterruption).catch(() => {});
    void protection.set(true).catch(() => {});
  }, args.heartbeatMs ?? 30_000);
  unref(heartbeat);
  // IMDS Spot-interruption probe on its OWN, faster cadence. Decoupling it from
  // the heartbeat gives many more detection chances inside the 2-minute reclaim
  // window even when the slower heartbeat tick is stretched by heavy step-log
  // streaming. On the FIRST detection we set the sticky flag AND fire an
  // out-of-band heartbeat carrying it, so the Hub stamps `spot_interruption_at`
  // immediately — and can later classify the lost lease as `spot_reclaimed`
  // (the generous retry-generation cap) — instead of waiting up to a full
  // heartbeat interval the reclaimed instance may not have left. Sticky: once
  // detected we stop probing (the heartbeat keeps re-reporting the flag).
  //
  // In-flight guard: a slow or hung IMDS round-trip can outlast `spotProbeMs`,
  // so skip any tick while a previous probe is still pending. Without this, a
  // stalled metadata service would let ticks pile up unbounded pending
  // `checkSpot()` calls for the lifetime of a long job — the exact resource leak
  // that decoupling the probe from the heartbeat could otherwise introduce.
  let probeInFlight = false;
  const spotProbe = setInterval(() => {
    if (spotInterruption || probeInFlight) return;
    probeInFlight = true;
    void checkSpot()
      .then((pending) => {
        if (!pending || spotInterruption) return;
        spotInterruption = true;
        void transport.heartbeat(jobId, true).catch(() => {});
      })
      .catch(() => {})
      .finally(() => {
        probeInFlight = false;
      });
  }, args.spotProbeMs ?? 5_000);
  unref(spotProbe);
  // Host resource sampler runs for the WHOLE job (materialize, DinD startup,
  // every step). Because the fleet reserves ~the whole box per task (one job
  // per host), host memory == job memory — see job-resource-sampler.ts.
  const sampler: RunningSampler = (args.startSampler ?? startHostSampler)();
  const stepExits: Array<{ stepIndex: number; exitCode: number | null }> = [];
  try {
    // Materialize + run in a SUBDIR of the shared workspace, never the workspace
    // root itself: that root (/finalize-ws) is a bind-mount point — it can't be
    // rmdir'd, and materializeWorktree clears its dest before cloning.
    const jobWorkspace = path.join(args.workspaceDir, 'repo');
    if (spec.worktreeRef && args.materialize) {
      await args.materialize(spec, jobWorkspace);
    }
    const containerName = await docker.startContainer(spec, jobWorkspace);
    let seq = 0;
    try {
      for (;;) {
        const d = await transport.poll(jobId);
        if (d.type === 'idle') continue;
        if (d.type === 'finish' || d.type === 'gone') break;
        if (d.type === 'cancel') continue; // container teardown handles cancellation
        // run_step: exec, streaming logs (batched), then report the exit code.
        const buffer: AgentLogFrame[] = [];
        const flush = async (): Promise<void> => {
          if (buffer.length === 0) return;
          await transport.postLogs(jobId, buffer.splice(0));
        };
        const timer = setInterval(() => void flush(), args.logFlushMs ?? 200);
        let exitCode: number | null;
        try {
          exitCode = await docker.execStep(containerName, d.run, d.env, (stream, data) => {
            buffer.push({ seq: seq++, stepIndex: d.stepIndex, stream, data });
          });
        } finally {
          clearInterval(timer);
          await flush();
        }
        stepExits.push({ stepIndex: d.stepIndex, exitCode });
        await transport.postStepResult(jobId, d.stepIndex, exitCode);
      }
    } finally {
      await docker.stopContainer(containerName);
      const summary = sampler.stop();
      if (summary) logJobResourceSummary(jobId, spec, summary);
      await transport.postFinish(jobId, 0, summary);
    }
  } finally {
    // Cleanup-safe: if the container never started (inner finally skipped),
    // this clears the sampler's timer. Double-stop is harmless.
    sampler.stop();
    clearInterval(heartbeat);
    clearInterval(spotProbe);
    // Job done (or failed): release protection so deploys / scale-to-zero can
    // replace this now-idle task. Awaited so the next claim can't race a deploy
    // that's waiting on this task to drain. Still best-effort — expiry is the
    // backstop if the clear can't reach the control plane.
    await protection.set(false).catch(() => {});
  }
  return { stepExits };
}

/**
 * Greppable one-line summary, mirrored on the Hub side by the finish route's
 * `[finalize-job-resources]` log. Runner-side copy lands in the fleet task logs.
 */
function logJobResourceSummary(
  jobId: string,
  spec: RunnerJobWireSpec,
  s: JobResourceSummary,
): void {
  const gb = (b: number): string => (b / 1024 / 1024 / 1024).toFixed(2);
  const cpu = (n: number | null): string => (n === null ? '?' : String(n));
  console.log(
    `[finalize-job-resources] queueJob=${jobId} run=${spec.runId} job=${spec.jobId} ` +
      `matrix=${spec.matrixKey} peak_mem=${gb(s.peakMemBytes)}GB/${gb(s.memTotalBytes)}GB ` +
      `peak_cpu=${cpu(s.peakCpuPercent)}% avg_cpu=${cpu(s.avgCpuPercent)}% ` +
      `samples=${s.samples} dur=${Math.round(s.durationMs / 1000)}s`,
  );
}

// ── Production implementations ──────────────────────────────────────────────

const JOB_LABELS = (spec: RunnerJobWireSpec): Record<string, string> => ({
  'agent-hub.finalize.run_id': spec.runId,
  'agent-hub.finalize.job_id': spec.jobId,
  'agent-hub.finalize.matrix_key': spec.matrixKey,
});

export function realDockerOps(): AgentDocker {
  return {
    async startContainer(spec, workspaceMount) {
      const containerName = sanitizeJobContainerName(spec.runId, spec.jobId, spec.matrixKey);
      await startJobContainer({
        containerName,
        image: spec.image,
        worktreePath: workspaceMount,
        workspaceMount,
        composeProjectName: spec.composeProjectName,
        env: spec.env,
        labels: JOB_LABELS(spec),
        visibility: spec.visibility,
        resourceProfile: spec.resourceProfile,
        // Deploy jobs (minimalEnv) never seed the container from the fleet box's
        // process.env. The per-step exec (buildExecJobStepArgv) already builds
        // env from only the delivered step env, so the remote path matches the
        // local backend's baseEnvOnly isolation end-to-end.
        baseEnvOnly: spec.minimalEnv,
      });
      return containerName;
    },
    execStep(containerName, run, env, onLog) {
      return new Promise<number>((resolve, reject) => {
        const argv = buildExecJobStepArgv({ containerName, run, env });
        const child = spawn(argv[0], argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] });
        child.stdout?.on('data', (d) => onLog('stdout', d.toString()));
        child.stderr?.on('data', (d) => onLog('stderr', d.toString()));
        child.on('error', reject);
        child.on('close', (code) => resolve(code ?? -1));
      });
    },
    async stopContainer(containerName) {
      await stopJobContainer(containerName);
    },
  };
}

export function httpTransport(hubUrl: string, token: string): AgentTransport {
  const base = hubUrl.replace(/\/$/, '');
  const auth = { Authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  return {
    async claim() {
      const res = await fetch(`${base}/api/runners/claim`, {
        method: 'POST',
        headers: auth,
        body: '{}',
      });
      if (res.status === 204) return null;
      if (!res.ok) throw new Error(`claim failed: ${res.status}`);
      return (await res.json()) as { jobId: string; spec: RunnerJobWireSpec };
    },
    async poll(jobId) {
      const res = await fetch(`${base}/api/runners/jobs/${jobId}/poll`, {
        method: 'POST',
        headers: auth,
        body: '{}',
      });
      if (res.status === 410) return { type: 'gone' };
      if (!res.ok) throw new Error(`poll failed: ${res.status}`);
      return (await res.json()) as AgentPollResult;
    },
    async postLogs(jobId, frames) {
      await fetch(`${base}/api/runners/jobs/${jobId}/logs`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ frames }),
      });
    },
    async postStepResult(jobId, stepIndex, exitCode) {
      await fetch(`${base}/api/runners/jobs/${jobId}/step-result`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ stepIndex, exitCode }),
      });
    },
    async postFinish(jobId, exitCode, resourceSummary) {
      await fetch(`${base}/api/runners/jobs/${jobId}/finish`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ exitCode, resourceSummary: resourceSummary ?? null }),
      });
    },
    async heartbeat(jobId, spotInterruption) {
      await fetch(`${base}/api/runners/jobs/${jobId}/heartbeat`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify(spotInterruption ? { spotInterruption: true } : {}),
      });
    },
    async reportError(jobId, detail) {
      await fetch(`${base}/api/runners/jobs/${jobId}/error`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ detail }),
      });
    },
  };
}

/** Bound the ECS metadata probe so a hung endpoint can't block registration. */
export const ECS_METADATA_TIMEOUT_MS = 2000;

/**
 * Best-effort resolve this task's ECS task ARN from the ECS container metadata
 * endpoint ($ECS_CONTAINER_METADATA_URI_V4/task → TaskARN). Reported at
 * registration so the Hub can arm scale-in protection on THIS exact task. Returns
 * null off-ECS or on any failure (the Hub-side protection then no-ops).
 *
 * The fetch is bounded by a short AbortSignal.timeout: registerAgent awaits this
 * before contacting the Hub, so a hung or mis-set metadata endpoint must fail
 * CLOSED to null rather than take the runner out of service.
 */
export async function resolveEcsTaskArn(fetchImpl: typeof fetch = fetch): Promise<string | null> {
  const base = process.env.ECS_CONTAINER_METADATA_URI_V4?.trim();
  if (!base) return null;
  try {
    const res = await fetchImpl(`${base.replace(/\/$/, '')}/task`, {
      signal: AbortSignal.timeout(ECS_METADATA_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { TaskARN?: unknown };
    return typeof body.TaskARN === 'string' ? body.TaskARN : null;
  } catch {
    return null;
  }
}

export async function registerAgent(
  hubUrl: string,
  fleetToken: string,
  orgScope: string,
): Promise<{ agentId: string; token: string }> {
  const ecsTaskArn = await resolveEcsTaskArn();
  const res = await fetch(`${hubUrl.replace(/\/$/, '')}/api/runners/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fleetToken, orgScope, ...(ecsTaskArn ? { ecsTaskArn } : {}) }),
  });
  if (!res.ok) throw new Error(`register failed: ${res.status}`);
  return (await res.json()) as { agentId: string; token: string };
}

/** CLI entry: register, then claim → run → repeat (one job at a time). */
export async function runAgentMain(): Promise<void> {
  const hubUrl =
    process.env.FINALIZE_RUNNER_HUB_URL || process.env.AGENT_HUB_URL || 'http://127.0.0.1:3051';
  const fleetToken = process.env.FINALIZE_RUNNER_FLEET_TOKEN;
  const orgScope = process.env.FINALIZE_RUNNER_ORG_SCOPE || 'shared';
  const workspaceDir = process.env.FINALIZE_RUNNER_WORKSPACE_DIR || '/github/workspace';
  const bundleDir = process.env.FINALIZE_RUNNER_BUNDLE_DIR;
  if (!fleetToken) throw new Error('FINALIZE_RUNNER_FLEET_TOKEN is required');

  const { token } = await registerAgent(hubUrl, fleetToken, orgScope);
  const transport = httpTransport(hubUrl, token);
  const docker = realDockerOps();
  // Under ECS this protects the task from being killed mid-job by a deploy or
  // scale-in; off-ECS (local 2a fleet) $ECS_AGENT_URI is unset → no-op.
  const protection = ecsTaskProtection();
  // Cross-host fleet: the wire spec carries a presigned getUrl, so materialize
  // fetches credential-free (store stays null, no AWS SDK in this bundle).
  // Same-host 2a: no getUrl, so fall back to the local-dir store.
  const store: BundleStore | undefined = bundleDir ? new LocalDirBundleStore(bundleDir) : undefined;
  const materialize = (spec: RunnerJobWireSpec, dest: string) =>
    materializeWorktree({ ref: spec.worktreeRef!, store, destPath: dest, rev: undefined });

  console.log(`[runner-agent] registered; polling ${hubUrl} (scope=${orgScope})`);
  for (;;) {
    let claimed: { jobId: string; spec: RunnerJobWireSpec } | null = null;
    try {
      claimed = await transport.claim();
    } catch (err) {
      console.error(`[runner-agent] claim error: ${(err as Error).message}`);
      await new Promise((r) => setTimeout(r, 2000));
      continue;
    }
    if (!claimed) continue;
    console.log(`[runner-agent] claimed job ${claimed.jobId} (${claimed.spec.jobId})`);
    const job = claimed;
    await runClaimedJobWithRecovery(transport, job.jobId, () =>
      runAgentJob({
        jobId: job.jobId,
        spec: job.spec,
        workspaceDir,
        transport,
        docker,
        materialize,
        protection,
      }),
    );
  }
}

/**
 * Run one claimed job to completion; on a thrown failure (bring-up error — the
 * worktree materialize, inner dockerd readiness, image pull, …), report the loss
 * to the Hub before returning so the job is recovered NOW (the Hub fails its job
 * channel → infra_error → retry on a fresh agent). Without this the agent's loop
 * would silently swallow the throw and claim the NEXT job, orphaning the thrown
 * one until the lease reaper notices the missing heartbeat (~one lease window).
 * The report is best-effort: a failed report must never wedge the agent loop — the
 * reaper remains the backstop for an agent that dies too hard to make the call.
 * Exported for unit-testing the recovery contract.
 */
export async function runClaimedJobWithRecovery(
  transport: AgentTransport,
  jobId: string,
  run: () => Promise<unknown>,
): Promise<void> {
  try {
    await run();
  } catch (err) {
    const detail = (err as Error).message;
    console.error(`[runner-agent] job ${jobId} failed: ${detail}`);
    try {
      await transport.reportError(jobId, detail);
    } catch (reportErr) {
      console.error(
        `[runner-agent] reportError for job ${jobId} failed: ${(reportErr as Error).message}`,
      );
    }
  }
}
