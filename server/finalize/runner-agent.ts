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
import { chownWorktreeForJobRunner } from './worktree-job-ownership.js';

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
    /**
     * Aborted when the step must stop before its own exit: the local hard
     * deadline lapsed, or the Hub asked to cancel/finish (delivered to the
     * concurrent watch poll). The implementation must kill the exec child so a
     * hung or runaway step is actually terminated — this is the ONLY place the
     * container exec can be stopped.
     */
    signal?: AbortSignal,
  ): Promise<number>;
  stopContainer(containerName: string): Promise<void>;
}

/**
 * Exit code the agent reports when it kills a step locally because its hard
 * wall-clock deadline lapsed. 124 mirrors GNU `timeout(1)` so the Hub's failure
 * classification and the human reading the log see an unambiguous timeout, not a
 * generic non-zero exit.
 */
export const STEP_DEADLINE_EXIT_CODE = 124;

/**
 * Backstop ceiling (ms) applied to a step whose `run_step` directive carries no
 * `deadlineMs` (older Hub, or a directive that omitted it). Matches the Hub's
 * `STEP_SPAWN_HARD_TIMEOUT_MS` so the agent never runs a step truly unbounded —
 * the invariant this whole path exists to guarantee. The Hub normally sends a
 * tighter, budget-derived deadline that wins over this.
 */
export const DEFAULT_STEP_DEADLINE_MS = 60 * 60 * 1_000;

/**
 * Per-attempt timeout for the two CRITICAL posts (step-result, finish). A hung
 * fetch is indistinguishable from a lost message — without a bound the agent
 * would sit in `await fetch` forever while its heartbeat keeps the lease
 * fresh, which is exactly the zombie this delivery path exists to prevent.
 */
export const CRITICAL_POST_TIMEOUT_MS = 15_000;

/** Max attempts for critical-message delivery (step-result / finish). */
export const CRITICAL_DELIVERY_ATTEMPTS = 5;

/** Base backoff between critical-delivery attempts (doubles per retry). */
export const CRITICAL_DELIVERY_BASE_DELAY_MS = 1_000;

/**
 * Deliver a critical agent→Hub message with bounded exponential-backoff
 * retries. The step-result and finish posts are the ONLY messages the Hub's
 * in-flight step promises settle on; a single unretried fetch (the historical
 * behavior) turned any transient blip — one dropped response, one LB 502, one
 * hung socket — into a run stuck `running` for the full Hub-side hard timeout
 * while the agent's heartbeat kept the lease alive (card d8a76929, run
 * 0e803638: electron tests passed in 895ms, step row sat `running` 44 min).
 *
 * Throws after the final attempt: the caller aborts the job, its heartbeat
 * stops, the lease expires, and the Hub's lease reaper settles the step as a
 * retryable infra failure — converting a silent zombie into a bounded one.
 */
export async function deliverCritical(
  what: string,
  attempt: () => Promise<void>,
  opts?: { attempts?: number; baseDelayMs?: number },
): Promise<void> {
  const attempts = Math.max(1, opts?.attempts ?? CRITICAL_DELIVERY_ATTEMPTS);
  const baseDelayMs = opts?.baseDelayMs ?? CRITICAL_DELIVERY_BASE_DELAY_MS;
  let lastErr: unknown;
  for (let i = 0; i < attempts; i += 1) {
    try {
      await attempt();
      return;
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) {
        const delayMs = baseDelayMs * 2 ** i;
        console.error(
          `[runner-agent] ${what} delivery failed (attempt ${i + 1}/${attempts}): ${
            err instanceof Error ? err.message : String(err)
          } — retrying in ${delayMs}ms`,
        );
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
  throw new Error(
    `${what} delivery failed after ${attempts} attempts: ${
      lastErr instanceof Error ? lastErr.message : String(lastErr)
    }`,
  );
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
  /**
   * Align materialized worktree ownership with the job container's `runner`
   * (uid 1000). Injectable for tests; defaults to {@link chownWorktreeForJobRunner}.
   */
  ensureJobWorktreeOwnership?: (destPath: string) => Promise<void>;
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
  /**
   * Retry knobs for critical-message delivery (step-result / finish posts).
   * Injectable so tests exercise the retry loop without real backoff waits.
   */
  delivery?: { attempts?: number; baseDelayMs?: number };
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
    // Agent image and job image can disagree on `runner`'s uid during a
    // rollout (agent on :main → 1001, job on a pinned build → 1000). Without
    // this, npm ci / venv mkdir EACCES across every shard.
    await (args.ensureJobWorktreeOwnership ?? chownWorktreeForJobRunner)(jobWorkspace);
    const containerName = await docker.startContainer(spec, jobWorkspace);
    let seq = 0;
    try {
      for (;;) {
        const d = await transport.poll(jobId);
        if (d.type === 'idle') continue;
        if (d.type === 'finish' || d.type === 'gone') break;
        if (d.type === 'cancel') continue; // no step in flight here; nothing to cancel
        // run_step: exec under a LOCAL hard deadline, streaming logs (batched),
        // then report the exit code.
        const buffer: AgentLogFrame[] = [];
        const flush = async (): Promise<void> => {
          if (buffer.length === 0) return;
          await transport.postLogs(jobId, buffer.splice(0));
        };
        const timer = setInterval(() => void flush(), args.logFlushMs ?? 200);

        // The step MUST be stoppable from outside its own exit: this agent is the
        // ONLY machine that can kill the container. Without a local deadline a hung
        // or runaway step pins us in execStep forever while the background
        // heartbeat keeps the lease fresh — so the Hub's lease reaper never fires
        // and the whole run hangs indefinitely. The Hub-side per-step timeout only
        // QUEUES a `cancel` directive, which the agent can't read mid-step (it
        // isn't polling while a step runs), so it can't stop a remote step on its
        // own. Enforcing the SAME budget-derived deadline here is what finally makes
        // the per-step ceiling effective for remote jobs. The AbortController is the
        // kill switch; execStep kills the exec child when it trips.
        const ac = new AbortController();
        const deadlineMs =
          d.deadlineMs && d.deadlineMs > 0 ? d.deadlineMs : DEFAULT_STEP_DEADLINE_MS;
        let deadlineHit = false;
        const deadline = setTimeout(() => {
          deadlineHit = true;
          ac.abort();
        }, deadlineMs);
        unref(deadline);

        let exitCode: number | null;
        try {
          exitCode = await docker.execStep(
            containerName,
            d.run,
            d.env,
            (stream, data) => {
              buffer.push({ seq: seq++, stepIndex: d.stepIndex, stream, data });
            },
            ac.signal,
          );
        } finally {
          clearTimeout(deadline);
          clearInterval(timer);
          await flush();
        }
        // A killed step reports a deterministic terminal code so the Hub's
        // runSingleStep resolves on the reported exit (instead of waiting on one
        // that never comes) and the failure is classified as a timeout, not a
        // generic non-zero exit.
        if (deadlineHit) {
          buffer.push({
            seq: seq++,
            stepIndex: d.stepIndex,
            stream: 'stderr',
            data: `\n[runner-agent] step ${d.stepIndex} exceeded its ${Math.round(
              deadlineMs / 1000,
            )}s deadline — killed\n`,
          });
          await flush();
          exitCode = STEP_DEADLINE_EXIT_CODE;
        }
        stepExits.push({ stepIndex: d.stepIndex, exitCode });
        // Critical delivery: retried with backoff, throws when exhausted. The
        // throw aborts the job loop (heartbeats stop → lease expires → the
        // Hub's lease reaper settles the step) instead of silently continuing
        // with the Hub still awaiting a result that will never arrive.
        await deliverCritical(
          `step-result (job=${jobId} step=${d.stepIndex})`,
          () => transport.postStepResult(jobId, d.stepIndex, exitCode),
          args.delivery,
        );
      }
    } finally {
      await docker.stopContainer(containerName);
      const summary = sampler.stop();
      if (summary) logJobResourceSummary(jobId, spec, summary);
      // Finish is the Hub's straggler-settling signal (channel.onFinish exits
      // any step still pending), so it gets the same retried delivery. But we
      // are in a finally: throwing here would mask the original step error, so
      // an exhausted retry only logs — the stopped heartbeat + lease reaper is
      // the backstop that surfaces the loss Hub-side either way.
      try {
        await deliverCritical(
          `finish (job=${jobId})`,
          () => transport.postFinish(jobId, 0, summary),
          args.delivery,
        );
      } catch (err) {
        console.error(
          `[runner-agent] ${err instanceof Error ? err.message : String(err)} — ` +
            'job teardown continues; the Hub lease reaper will settle any pending steps',
        );
      }
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
    execStep(containerName, run, env, onLog, signal) {
      return runExecStepChild({
        argv: buildExecJobStepArgv({ containerName, run, env }),
        onLog,
        signal,
      });
    },
    async stopContainer(containerName) {
      await stopJobContainer(containerName);
    },
  };
}

/**
 * Grace (ms) after a step's process EXITS before we stop waiting for its stdio
 * to flush. We resolve on process exit, not on stdout `close`: a leftover child
 * that inherited the exec's stdout/stderr can hold those pipes open long after
 * the step's main command exited, and waiting on `close` would hang us there
 * (GHA reaps such leftovers at job teardown rather than blocking the step). We
 * take the exit code, give the streams this brief window to drain buffered
 * output, then proceed regardless — anything still alive is reclaimed when the
 * job container is force-removed.
 */
export const STEP_EXIT_DRAIN_GRACE_MS = 2_000;

/** Grace (ms) between SIGTERM and SIGKILL when force-killing a step. */
export const STEP_KILL_GRACE_MS = 2_000;

/**
 * Run a step's child process to completion, returning its exit code.
 *
 * Two GHA-parity behaviors live here:
 *   1. **Resolve on process exit, not stdio close** (see STEP_EXIT_DRAIN_GRACE_MS)
 *      so a lingering pipe-holder can't wedge a step whose command already exited.
 *   2. **Process-GROUP termination on abort** — the child is spawned `detached`
 *      so it leads its own group; an abort SIGTERMs (then SIGKILLs) the whole
 *      group, killing the `docker exec` client plus anything it forked, rather
 *      than signalling only the leader.
 *
 * `spawnFn` is injectable for unit tests (defaults to the real `child_process`
 * spawn); tests pass a fake child so no real process is spawned.
 */
export function runExecStepChild(args: {
  argv: string[];
  onLog: (stream: 'stdout' | 'stderr', data: string) => void;
  signal?: AbortSignal;
  spawnFn?: typeof spawn;
  exitDrainGraceMs?: number;
  killGraceMs?: number;
}): Promise<number> {
  const spawnFn = args.spawnFn ?? spawn;
  const exitDrainGraceMs = args.exitDrainGraceMs ?? STEP_EXIT_DRAIN_GRACE_MS;
  const killGraceMs = args.killGraceMs ?? STEP_KILL_GRACE_MS;
  return new Promise<number>((resolve, reject) => {
    const child = spawnFn(args.argv[0], args.argv.slice(1), {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    child.stdout?.on('data', (d) => args.onLog('stdout', d.toString()));
    child.stderr?.on('data', (d) => args.onLog('stderr', d.toString()));

    let settled = false;
    const cleanupSignal = (): void => {
      if (args.signal) args.signal.removeEventListener('abort', onAbort);
    };
    const done = (code: number): void => {
      if (settled) return;
      settled = true;
      cleanupSignal();
      resolve(code);
    };
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      cleanupSignal();
      reject(err);
    });
    // Exit fires when the process terminates; close fires after its stdio drains.
    // Prefer close (full output) but never wait past the grace window for it.
    child.on('exit', (code) => {
      const exit = code ?? -1;
      let drained = false;
      const finish = (): void => {
        if (drained) return;
        drained = true;
        done(exit);
      };
      child.once('close', finish);
      setTimeout(finish, exitDrainGraceMs).unref?.();
    });

    const killGroup = (sig: NodeJS.Signals): void => {
      try {
        // Negative pid → signal the whole process group (child is group leader
        // because it was spawned detached). Falls back to the bare child if the
        // group send fails (pid already gone, or no group on this platform).
        if (typeof child.pid === 'number') process.kill(-child.pid, sig);
        else child.kill(sig);
      } catch {
        try {
          child.kill(sig);
        } catch {
          /* best-effort: the process/group is already gone */
        }
      }
    };
    const onAbort = (): void => {
      killGroup('SIGTERM');
      setTimeout(() => {
        if (!settled) killGroup('SIGKILL');
      }, killGraceMs).unref?.();
    };
    if (args.signal) {
      if (args.signal.aborted) onAbort();
      else args.signal.addEventListener('abort', onAbort, { once: true });
    }
  });
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
      // The step result is THE message the Hub's step promise settles on — a
      // silent loss here leaves the run's step row `running` until a Hub-side
      // timeout backstop fires (observed: 44 min on run 0e803638). Unlike the
      // other best-effort posts, this one must fail LOUDLY: bounded per-attempt
      // timeout (a hung fetch is a loss too) and a thrown error on non-2xx so
      // the caller's delivery-retry loop can re-send it.
      const res = await fetch(`${base}/api/runners/jobs/${jobId}/step-result`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ stepIndex, exitCode }),
        signal: AbortSignal.timeout(CRITICAL_POST_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`step-result post failed: ${res.status}`);
    },
    async postFinish(jobId, exitCode, resourceSummary) {
      // Finish settles any straggler steps Hub-side (channel.onFinish), so it
      // is the second chance for a lost step result — same loud-failure
      // contract as postStepResult.
      const res = await fetch(`${base}/api/runners/jobs/${jobId}/finish`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ exitCode, resourceSummary: resourceSummary ?? null }),
        signal: AbortSignal.timeout(CRITICAL_POST_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`finish post failed: ${res.status}`);
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

/**
 * Should the agent stop claiming new work because its instance is draining?
 * True once IMDS reports a pending EC2 Spot interruption. Without this guard
 * the claim loop happily picks up a fresh job inside the 2-minute reclaim
 * window — a job that is then GUARANTEED to be lost mid-run (lease expiry →
 * reaper → infra retry on another agent), burning a retry generation and
 * several minutes of the run's wall clock for nothing. Probe failures (off-EC2,
 * IMDS blip) report "not draining" so a healthy fleet never idles on a false
 * positive. Injectable for tests; the real probe is a fast no-op off EC2.
 */
export async function agentIsDraining(
  checkSpot: () => Promise<boolean> = async () => (await checkSpotInterruption()).pending,
): Promise<boolean> {
  try {
    return await checkSpot();
  } catch {
    return false;
  }
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
    // A draining instance (pending EC2 Spot reclaim) must NOT claim new work —
    // any job it picks up now is guaranteed to be lost mid-run. Exit instead;
    // the queued job stays `queued` for a healthy agent and the fleet scaler
    // replaces this task.
    if (await agentIsDraining()) {
      console.log(
        '[runner-agent] EC2 Spot interruption notice pending — draining instead of claiming new work',
      );
      return;
    }
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
