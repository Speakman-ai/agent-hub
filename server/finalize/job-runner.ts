/**
 * job-runner.ts — v2 Finalize tasks phase: parallel GHA-style jobs + matrix.
 *
 * Expands ci.yaml `jobs` × `matrix.include` into isolated DinD runner
 * containers (or host bash for `runs-on: host`) and schedules shards
 * with a bounded parallelism pool. DinD is the only container runner mode.
 */
import { randomUUID } from 'crypto';
import type { CiConfig, CiStep, JobInstance } from './ci-config-jobs.js';
import {
  applyEnvToStep,
  buildFinalizeBuiltinEnv,
  expandJobInstances,
  substituteEnvString,
} from './ci-config-jobs.js';
import { resolveRunnerBackend, type RunnerLease } from './runner-backend.js';
import { cancelRemoteJobsForRun } from './runner-backend-remote.js';
import { detectRepoVisibility } from './runner-repo-visibility.js';
import { hasExplicitResourceProfile, type RepoVisibility } from './runner-resource-profile.js';
import { isContainerRunsOn, resolveRunsOnImage } from './runner-images.js';
import {
  defaultSpawnStep,
  emitFinalizeChecksRoundTimeline,
  runStepsSequence,
  TASKS_PHASE_ENTRY_ACTIVE_SECONDS,
  type FlakeRecoveredInstance,
  type StepPersistMeta,
  type StepResult,
  type StepRunResult,
  type StepRunnerDeps,
  type SpawnStepFn,
} from './step-runner.js';
import { classifyFailureReason } from './infra-retry.js';
import { isWorktreeBundleFailureMessage } from './worktree-bundle.js';
import type { CancelSignal } from './fix-dispatch.js';

/** Default max parallel job shards (override with FINALIZE_MAX_PARALLEL_JOBS). */
export const DEFAULT_MAX_PARALLEL_JOBS = 4;

export interface JobRunnerOptions {
  runId: string;
  config: CiConfig;
  worktreePath: string;
  sessionId: string;
  branch: string;
  headSha: string;
  env?: NodeJS.ProcessEnv;
  /** Tenant identity for the remote runner queue (local backend ignores these). */
  orgId?: string;
  projectId?: string;
  /**
   * Run-level cancellation signal (the orchestrator's Stop-Finalize signal).
   * When it trips, in-flight step children are killed (see runStepsSequence),
   * no not-yet-started instance is launched, and no cancelled instance is
   * retried — so a Stop during the checks phase ends the phase promptly instead
   * of blocking until every test finishes on its own.
   */
  signal?: CancelSignal;
}

interface PlannedStep {
  instance: JobInstance;
  step: CiStep;
  stepIndex: number;
  namePrefix: string;
}

interface JobInstanceOutcome {
  instance: JobInstance;
  result: StepRunResult;
}

function isRemoteBackend(): boolean {
  return (process.env.FINALIZE_RUNNER_BACKEND ?? 'local').toLowerCase() === 'remote';
}

/**
 * Cap on per-instance attempts. An `infra_error` (agent loss — a Spot reclaim
 * drops the runner mid-job, its lease expires, or no agent claimed in time) is
 * transient, so the instance is re-run on a FRESH agent. Capped so a
 * persistently broken instance can't loop.
 */
export const MAX_INSTANCE_INFRA_ATTEMPTS = 3;

/**
 * Minimum viable runner-acquire window. The acquire wait is capped by the run's
 * remaining time budget so a queued job can't outlive the run — but once earlier
 * attempts (Spot reclaims, lease-loss retries) have burned that budget toward
 * zero, the cap collapses too. A sub-second window can NEVER let the fleet scale
 * up and claim the job, so every attempt fails instantly with "claimed within
 * Nms" and the per-instance infra retry + orchestrator loop spin in
 * milliseconds (the 1ms-floor livelock, card #1243).
 *
 * Two protections key off this floor (see {@link runJobInstance}):
 *   1. If less than this much budget remains, the run is genuinely out of time —
 *      stop with a distinct, non-retryable `budget_exhausted` reason instead of
 *      attempting a doomed acquire.
 *   2. The acquire timeout passed to the backend is floored here (never the old
 *      `1`), defending against the small clock drift between the guard and the
 *      acquire call.
 *
 * Env override `FINALIZE_MIN_ACQUIRE_TIMEOUT_MS` (parsed as an integer ms):
 *   - A valid value `>= 1` is honored, but coerced UP to a hard 1s minimum
 *     (`1..999 -> 1000`) — even an operator-tuned floor must stay above the
 *     sub-second window that caused the livelock, so the safety property holds
 *     regardless of the configured value.
 *   - Anything that is NOT a positive integer — unset, empty, `0`, negative, or
 *     non-numeric garbage — is treated as "no valid override" and falls back to
 *     {@link DEFAULT_MIN_ACQUIRE_TIMEOUT_MS} (30s). This is deliberately
 *     asymmetric with the `1..999 -> 1000` coercion: `0`/negative are far more
 *     likely a misconfiguration (someone trying to *disable* the floor and
 *     re-introduce the livelock) than an intentional 1s request, so we resolve
 *     them to the safe default rather than the 1s minimum.
 */
export const DEFAULT_MIN_ACQUIRE_TIMEOUT_MS = 30_000;

export function minAcquireTimeoutMs(): number {
  const raw = process.env.FINALIZE_MIN_ACQUIRE_TIMEOUT_MS?.trim();
  if (raw) {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n >= 1) return Math.max(1_000, n);
  }
  return DEFAULT_MIN_ACQUIRE_TIMEOUT_MS;
}

/** Options for {@link runInstanceWithRetries}. */
export interface InstanceRetryPolicy {
  /**
   * Total attempts allowed for a TRANSIENT `infra_error` (Spot reclaim, lost
   * agent, `runner_cancelled` collateral). Defaults to
   * {@link MAX_INSTANCE_INFRA_ATTEMPTS}. Each attempt re-acquires a fresh lease.
   */
  maxInfraAttempts?: number;
  /**
   * Extra re-runs allowed for a GENUINE test `failure` on the SAME commit
   * (config-driven `retries:` — flaky-test tolerance). `0` disables. A
   * `timeout` is never retried here (time-class), and infra collateral uses
   * `maxInfraAttempts` instead.
   */
  maxFailureRetries?: number;
  /** Called before each infra re-run with the 1-based re-run count + detail. */
  onInfraRetry?: (rerun: number, detail: string | undefined) => void;
  /** Called before each failure re-run with the 1-based re-run count + detail. */
  onFailureRetry?: (rerun: number, detail: string | undefined) => void;
  /**
   * Consulted after each attempt: when it returns true the run was cancelled,
   * so the retry loop stops immediately (a cancelled instance's non-zero exit
   * must never trigger a same-commit failure retry or a fresh-agent infra
   * retry).
   */
  isAborted?: () => boolean;
}

/**
 * Re-run a job instance across two independent, bounded retry classes. Each
 * attempt re-acquires a new lease (new agent, fresh DinD) and re-runs ALL the
 * instance's steps from the start — CI steps aren't resume-able mid-job.
 *
 *   - **infra** (`infra_error`, transient): a Spot reclaim / lost agent /
 *     `runner_cancelled` collateral is re-run on a fresh agent, up to
 *     `maxInfraAttempts` TOTAL attempts. A DETERMINISTIC reason (e.g.
 *     `worktree_bundle_failed`, which classifies CI-class) recurs identically,
 *     so it short-circuits immediately.
 *   - **failure** (`failure`, genuine red): re-run on the SAME commit up to
 *     `maxFailureRetries` extra times (config-driven `retries:`). This is the
 *     flaky-test path — a test that passes on a later run makes the shard green
 *     without any code change. A `timeout` is time-class and never retried.
 *
 * The two budgets are counted separately, so a shard that flaps infra then
 * fails a real test still gets its full failure-retry allowance.
 */
export async function runInstanceWithRetries(
  runOnce: () => Promise<JobInstanceOutcome>,
  policy: InstanceRetryPolicy = {},
): Promise<JobInstanceOutcome> {
  const maxInfraAttempts = policy.maxInfraAttempts ?? MAX_INSTANCE_INFRA_ATTEMPTS;
  const maxInfraReruns = Math.max(0, maxInfraAttempts - 1);
  const maxFailureRetries = Math.max(0, policy.maxFailureRetries ?? 0);
  let infraReruns = 0;
  let failureReruns = 0;
  let outcome!: JobInstanceOutcome;
  for (;;) {
    outcome = await runOnce();
    const status = outcome.result.status;
    if (status === 'success') break;
    // Run cancelled mid-attempt — stop before any retry so a Stop is honored
    // immediately instead of re-running the just-killed instance.
    if (policy.isAborted?.()) break;
    const reason = outcome.result.failureReason;
    const detail = outcome.result.infraErrorDetail;
    if (status === 'infra_error') {
      // Only re-run TRANSIENT infra failures; a deterministic (CI-class) reason
      // recurs on a fresh agent, so retrying just burns attempts.
      const isDeterministic = !!reason && classifyFailureReason(reason) !== 'infra';
      if (!isDeterministic && infraReruns < maxInfraReruns) {
        infraReruns += 1;
        policy.onInfraRetry?.(infraReruns, detail);
        continue;
      }
      break;
    }
    // Config-driven flaky-test retry: a genuine `failure` re-runs the whole
    // shard on the SAME commit. `timeout` deliberately falls through to break.
    if (status === 'failure' && failureReruns < maxFailureRetries) {
      failureReruns += 1;
      policy.onFailureRetry?.(failureReruns, outcome.result.failedStep?.name ?? detail);
      continue;
    }
    break;
  }
  return outcome;
}

/**
 * Back-compat wrapper: infra-only retry (no config failure retries). Kept for
 * callers/tests that only exercise the transient-infra path.
 */
export async function runInstanceWithInfraRetry(
  runOnce: () => Promise<JobInstanceOutcome>,
  maxAttempts: number = MAX_INSTANCE_INFRA_ATTEMPTS,
  onRetry?: (attempt: number, detail: string | undefined) => void,
): Promise<JobInstanceOutcome> {
  return runInstanceWithRetries(runOnce, {
    maxInfraAttempts: maxAttempts,
    maxFailureRetries: 0,
    ...(onRetry ? { onInfraRetry: onRetry } : {}),
  });
}

/**
 * Resolve the Hub-side concurrency cap (re-exported at the bottom for tests): an
 * explicit FINALIZE_MAX_PARALLEL_JOBS always wins. Otherwise the remote backend
 * is uncapped — every instance is enqueued at once and the fleet autoscaler +
 * queue manage real concurrency (each job runs on its own ECS task, bounded only
 * by FINALIZE_FLEET_MAX_AGENTS). The local backend keeps the conservative
 * default because its containers all share one host and would thrash it.
 */
function readMaxParallelJobs(): number {
  const raw = process.env.FINALIZE_MAX_PARALLEL_JOBS?.trim();
  if (raw) {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n >= 1) return n;
  }
  if (isRemoteBackend()) return Number.POSITIVE_INFINITY;
  return DEFAULT_MAX_PARALLEL_JOBS;
}

/**
 * Run job instances respecting a `needs` dependency graph, capped at
 * `concurrency` concurrent instances. An instance's job starts only once every
 * job it depends on has completed successfully; if a dependency fails (or is
 * itself skipped), the dependent job's instances are skipped. Event-driven:
 * independent jobs run concurrently and a dependent launches the moment its
 * prerequisites finish — no per-level barrier. Assumes an acyclic graph (the
 * parser rejects cycles); a defensive guard skips any leftover non-terminal
 * instances rather than hang if that ever fails to hold.
 */
async function scheduleInstancesWithDeps(
  instances: JobInstance[],
  needsByJob: Map<string, string[]>,
  concurrency: number,
  run: (instance: JobInstance) => Promise<JobInstanceOutcome>,
  skip: (instance: JobInstance) => JobInstanceOutcome,
): Promise<JobInstanceOutcome[]> {
  type JobState = 'pending' | 'running' | 'success' | 'failed' | 'skipped';
  const byJob = new Map<string, JobInstance[]>();
  for (const inst of instances) {
    const arr = byJob.get(inst.jobId);
    if (arr) arr.push(inst);
    else byJob.set(inst.jobId, [inst]);
  }
  const jobIds = [...byJob.keys()];
  const state = new Map<string, JobState>(jobIds.map((j) => [j, 'pending']));
  const remaining = new Map<string, number>(jobIds.map((j) => [j, byJob.get(j)!.length]));
  const jobFailed = new Set<string>();
  const started = new Set<JobInstance>();
  const outcomes: JobInstanceOutcome[] = [];
  let active = 0;

  const depGate = (jobId: string): 'ready' | 'wait' | 'skip' => {
    for (const dep of needsByJob.get(jobId) ?? []) {
      const s = state.get(dep);
      if (s === 'failed' || s === 'skipped') return 'skip';
      if (s !== 'success') return 'wait';
    }
    return 'ready';
  };

  return await new Promise<JobInstanceOutcome[]>((resolve) => {
    const pump = (): void => {
      // Cascade skips for jobs whose dependencies failed/were skipped.
      let changed = true;
      while (changed) {
        changed = false;
        for (const jobId of jobIds) {
          if (state.get(jobId) === 'pending' && depGate(jobId) === 'skip') {
            state.set(jobId, 'skipped');
            for (const inst of byJob.get(jobId)!) outcomes.push(skip(inst));
            changed = true;
          }
        }
      }
      // Launch ready instances up to the concurrency cap.
      for (const jobId of jobIds) {
        if (active >= concurrency) break;
        const st = state.get(jobId);
        if (st !== 'pending' && st !== 'running') continue;
        if (st === 'pending') {
          if (depGate(jobId) !== 'ready') continue;
          state.set(jobId, 'running');
        }
        for (const inst of byJob.get(jobId)!) {
          if (started.has(inst)) continue;
          if (active >= concurrency) break;
          started.add(inst);
          active += 1;
          void run(inst).then((outcome) => {
            active -= 1;
            outcomes.push(outcome);
            if (outcome.result.status !== 'success') jobFailed.add(jobId);
            remaining.set(jobId, (remaining.get(jobId) ?? 1) - 1);
            if ((remaining.get(jobId) ?? 0) === 0) {
              state.set(jobId, jobFailed.has(jobId) ? 'failed' : 'success');
            }
            pump();
          });
        }
      }
      const nonTerminal = jobIds.filter((j) => {
        const s = state.get(j);
        return s === 'pending' || s === 'running';
      });
      if (active === 0 && nonTerminal.length === 0) {
        resolve(outcomes);
        return;
      }
      // Defensive: nothing in flight but work remains and none of it could be
      // launched (would only happen on a dependency cycle the parser missed) —
      // skip the leftovers instead of hanging forever.
      if (active === 0 && nonTerminal.length > 0) {
        for (const jobId of nonTerminal) {
          state.set(jobId, 'skipped');
          for (const inst of byJob.get(jobId)!) {
            if (!started.has(inst)) outcomes.push(skip(inst));
          }
        }
        resolve(outcomes);
      }
    };
    pump();
  });
}

function sanitizeComposeProjectName(runId: string, jobId: string, matrixKey: string): string {
  const slug = `${runId}-${jobId}-${matrixKey}`.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 60);
  // Inner docker compose requires lowercase project names (Docker validates strictly).
  return `finalize-${slug}`.toLowerCase();
}

function resolveMergedEnv(
  instance: JobInstance,
  baseEnv: NodeJS.ProcessEnv | undefined,
): Record<string, string> {
  const merged: Record<string, string> = {};
  if (baseEnv) {
    for (const [key, value] of Object.entries(baseEnv)) {
      if (value !== undefined) merged[key] = value;
    }
  }
  for (const [key, value] of Object.entries(instance.env)) {
    merged[key] = substituteEnvString(value, merged);
  }
  return merged;
}

function toCiStep(step: CiStep, env: Record<string, string>): CiStep {
  const resolved = applyEnvToStep(step, env);
  return {
    name: resolved.name,
    run: resolved.run,
    // Carry step-level env so the executor can inject it into the process
    // environment (docker exec -e). Without this, step `env:` (e.g.
    // FINALIZE_WARMUP) is only substituted into `run`, never exported.
    ...(resolved.env ? { env: resolved.env } : {}),
  };
}

/**
 * Persist one job's state row. `attempt` is the per-EXECUTION nonce: minted
 * (randomUUID) when the job starts running, echoed verbatim by that
 * execution's terminal write, and NULL for queued/skipped writes. The upsert
 * only applies a terminal write whose nonce matches the row's current
 * execution (see upsertFinalizeRunJob in db.ts) — a delayed terminal from an
 * abandoned earlier execution is silently a no-op, even when a retry landed
 * in the same millisecond (which would defeat a timestamp identity).
 */
function persistJobState(
  deps: StepRunnerDeps,
  runId: string,
  jobId: string,
  matrixKey: string,
  state: 'queued' | 'running' | 'passed' | 'failed' | 'skipped',
  exitCode: number | null,
  startedAt: number | null,
  endedAt: number | null,
  attempt: string | null,
): void {
  try {
    deps.stmts.upsertFinalizeRunJob.run(
      runId,
      jobId,
      matrixKey,
      state,
      exitCode,
      startedAt,
      endedAt,
      attempt,
    );
  } catch (err) {
    console.warn(
      `[finalize-job-runner] upsertFinalizeRunJob failed run=${runId} job=${jobId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

async function runWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const idx = next;
      next += 1;
      results[idx] = await fn(items[idx]);
    }
  }
  const workers = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return results;
}

async function runJobInstance(
  deps: StepRunnerDeps,
  opts: JobRunnerOptions,
  instance: JobInstance,
  planned: PlannedStep[],
  budgetStartedAt: number,
  budgetMs: number,
  now: () => number,
): Promise<JobInstanceOutcome> {
  const { runId, worktreePath, sessionId, config } = opts;
  const persistMeta: StepPersistMeta = { jobId: instance.jobId, matrixKey: instance.matrixKey };
  const jobStartedAt = now();
  // This execution's identity. jobStartedAt is display-only (duration); the
  // nonce is what the terminal write must echo to pass the out-of-order guard.
  const jobAttempt = randomUUID();

  persistJobState(
    deps,
    runId,
    instance.jobId,
    instance.matrixKey,
    'running',
    null,
    jobStartedAt,
    null,
    jobAttempt,
  );

  const image = resolveRunsOnImage(instance.runsOn);
  let spawnStep: SpawnStepFn = deps.spawnStep ?? defaultSpawnStep;
  const mergedEnv = resolveMergedEnv(instance, opts.env);
  const composeProjectName = sanitizeComposeProjectName(
    opts.runId,
    instance.jobId,
    instance.matrixKey,
  );
  const jobLabels = {
    'agent-hub.finalize.run_id': opts.runId,
    'agent-hub.finalize.job_id': instance.jobId,
    'agent-hub.finalize.matrix_key': instance.matrixKey,
  };

  let lease: RunnerLease | null = null;

  if (isContainerRunsOn(instance.runsOn)) {
    if (!image) {
      const endedAt = now();
      const detail = `unsupported runs-on: ${instance.runsOn}`;
      console.warn(
        `[finalize-job-runner] ${instance.jobId}/${instance.matrixKey} infra_error: ${detail}`,
      );
      persistJobState(
        deps,
        runId,
        instance.jobId,
        instance.matrixKey,
        'failed',
        -1,
        jobStartedAt,
        endedAt,
        jobAttempt,
      );
      return {
        instance,
        result: {
          status: 'infra_error',
          stepResults: [],
          activeSecondsBilled: 0,
          infraErrorDetail: detail,
        },
      };
    }

    const backend = deps.runnerBackend ?? resolveRunnerBackend();

    // Budget-exhaustion guard (card #1243). When earlier attempts have already
    // consumed the run's CI time budget, the remaining-budget acquire cap
    // collapses toward zero. Acquiring with a sub-floor window is hopeless —
    // the fleet can't scale up and claim the job in time, so the attempt fails
    // instantly ("claimed within Nms"), the per-instance retry re-runs with the
    // same tiny window, and the orchestrator loop re-enters: a millisecond-fast
    // livelock that thrashes for the whole run with no genuine red. Once less
    // than a viable acquire window remains, the run is out of time: stop here
    // with a distinct, human-readable `budget_exhausted` reason. CI-class (see
    // CI_FAILURE_REASONS) so neither this instance's infra retry nor the
    // orchestrator's infra auto-retry re-runs a job that would only exhaust the
    // shared family budget again.
    const minAcquireMs = minAcquireTimeoutMs();
    const remainingBudgetMs = budgetMs - (now() - budgetStartedAt);
    if (remainingBudgetMs < minAcquireMs) {
      const endedAt = now();
      const detail =
        `finalize run budget exhausted before a runner could be acquired for job ` +
        `${instance.jobId} (${Math.max(0, Math.round(remainingBudgetMs / 1000))}s of budget ` +
        `left, need >= ${Math.round(minAcquireMs / 1000)}s to acquire an agent)`;
      console.warn(`[finalize-job-runner] ${instance.jobId}/${instance.matrixKey} ${detail}`);
      persistJobState(
        deps,
        runId,
        instance.jobId,
        instance.matrixKey,
        'failed',
        -1,
        jobStartedAt,
        endedAt,
        jobAttempt,
      );
      return {
        instance,
        result: {
          status: 'infra_error',
          stepResults: [],
          activeSecondsBilled: 0,
          infraErrorDetail: detail,
          failureReason: 'budget_exhausted',
        },
      };
    }

    // Pick the GitHub-parity resource tier from the gated repo's visibility
    // (public -> ubuntu-public, private -> ubuntu-private) so public repos get
    // exact parity without manual config. Skip the probe entirely when an
    // operator already pinned a valid profile — the override wins regardless,
    // so the gh call would be wasted. Detection failures resolve to 'unknown',
    // which keeps the stricter default tier (the safe direction).
    let visibility: RepoVisibility | undefined;
    if (!hasExplicitResourceProfile()) {
      visibility = await detectRepoVisibility({ worktreePath, env: process.env });
    }
    try {
      lease = await backend.acquire({
        orgId: opts.orgId ?? '',
        projectId: opts.projectId ?? '',
        runId: opts.runId,
        jobId: instance.jobId,
        matrixKey: instance.matrixKey,
        image,
        worktreePath,
        composeProjectName,
        env: mergedEnv,
        labels: jobLabels,
        // Floor at minAcquireMs (never the old 1ms). The guard above already
        // returned when remaining < floor, so this only protects against the
        // small clock drift consumed by visibility detection between the guard
        // and here — the window is never sub-floor.
        acquireTimeoutMs: Math.max(minAcquireMs, budgetMs - (now() - budgetStartedAt)),
        visibility,
      });
    } catch (err) {
      const endedAt = now();
      const msg = err instanceof Error ? err.message : String(err);
      // Log at the source. The retry wrapper only logs between attempts
      // (attempt < maxAttempts), so the FINAL attempt's reason would
      // otherwise be dropped — leaving an `infra_error` with no visible
      // cause in the step logs. Always surface why the runner acquire failed.
      console.warn(
        `[finalize-job-runner] ${instance.jobId}/${instance.matrixKey} runner acquire failed: ${msg}`,
      );
      persistJobState(
        deps,
        runId,
        instance.jobId,
        instance.matrixKey,
        'failed',
        -1,
        jobStartedAt,
        endedAt,
        jobAttempt,
      );
      // A `git bundle` failure (e.g. "Refusing to create empty bundle") is
      // DETERMINISTIC — re-acquiring on a fresh agent re-runs the same broken
      // bundle. Tag it with the non-infra `worktree_bundle_failed` reason so
      // neither the per-instance retry below nor the orchestrator's infra
      // auto-retry livelocks on it. Generic acquire failures (no reason) stay
      // infra-retryable as before.
      const failureReason = isWorktreeBundleFailureMessage(msg)
        ? 'worktree_bundle_failed'
        : undefined;
      return {
        instance,
        result: {
          status: 'infra_error',
          stepResults: [],
          activeSecondsBilled: 0,
          infraErrorDetail: msg,
          ...(failureReason ? { failureReason } : {}),
        },
      };
    }
    spawnStep = lease.spawnStep;
  }

  const instanceSteps = planned.filter((p) => p.instance === instance);
  const remainingBudgetMs = budgetMs - (now() - budgetStartedAt);
  const timeoutMinutes = Math.max(1, Math.ceil(remainingBudgetMs / 60_000));

  let result: StepRunResult;
  try {
    result = await runStepsSequence(
      { ...deps, spawnStep },
      {
        runId,
        sessionId,
        worktreePath,
        steps: instanceSteps.map((p) => p.step),
        stepIndices: instanceSteps.map((p) => p.stepIndex),
        stepNamePrefix: instanceSteps[0]?.namePrefix,
        timeoutMinutes: Math.min(config.timeoutMinutes, timeoutMinutes),
        env: mergedEnv,
        persistMeta,
        skipPhaseInit: true,
        emitChecksTimeline: false,
        ...(opts.signal ? { signal: opts.signal } : {}),
        // A shard is one of N parallel jobs. It must NOT stamp the run-level
        // terminal status on failure — doing so the moment the FIRST shard
        // fails marks `finalize_runs` ended while siblings are still running
        // (the "appears finished / waiting for user input mid-run" bug). The
        // orchestrator writes the single authoritative terminal after every
        // shard has been aggregated.
        deferRunTerminal: true,
      },
    );
  } finally {
    if (lease) {
      await lease.release();
    }
  }

  const jobEndedAt = now();
  const jobExit =
    result.status === 'success'
      ? 0
      : (result.failedStep?.exitCode ?? result.stepResults.at(-1)?.exitCode ?? 1);
  persistJobState(
    deps,
    runId,
    instance.jobId,
    instance.matrixKey,
    result.status === 'success' ? 'passed' : 'failed',
    jobExit,
    jobStartedAt,
    jobEndedAt,
    jobAttempt,
  );

  return { instance, result };
}

/**
 * Run the ci.yaml jobs phase — parallel matrix shards in runner containers.
 */
export async function runJobPhase(
  deps: StepRunnerDeps,
  opts: JobRunnerOptions,
): Promise<StepRunResult> {
  const { stmts, broadcast } = deps;
  const now = deps.now ?? Date.now;

  if (!opts.worktreePath) {
    return {
      status: 'infra_error',
      stepResults: [],
      activeSecondsBilled: 0,
      infraErrorDetail: 'worktree path missing',
    };
  }
  if (!opts.sessionId) {
    return {
      status: 'infra_error',
      stepResults: [],
      activeSecondsBilled: 0,
      infraErrorDetail: 'session id missing',
    };
  }

  stmts.updateFinalizeRunPhase.run('tasks', 'running', opts.runId);
  broadcast({
    type: 'finalize_run_phase_changed',
    run_id: opts.runId,
    session_id: opts.sessionId,
    phase: 'tasks',
    status: 'running',
  });

  let activeSecondsBilled = TASKS_PHASE_ENTRY_ACTIVE_SECONDS;
  stmts.updateFinalizeRunActiveSeconds.run(TASKS_PHASE_ENTRY_ACTIVE_SECONDS, opts.runId);

  const builtins = buildFinalizeBuiltinEnv({ branch: opts.branch, headSha: opts.headSha });
  const instances = expandJobInstances(opts.config, builtins);

  // Dependency graph: each job's declared `needs` plus the implicit warmup
  // prereq (every warmup job must finish before any non-warmup job starts).
  const warmupJobIds = new Set(instances.filter((i) => i.warmup).map((i) => i.jobId));
  const effectiveNeeds = new Map<string, string[]>();
  for (const instance of instances) {
    if (effectiveNeeds.has(instance.jobId)) continue;
    const implicit = instance.warmup ? [] : [...warmupJobIds];
    effectiveNeeds.set(
      instance.jobId,
      [...new Set([...instance.needs, ...implicit])].filter((d) => d !== instance.jobId),
    );
  }

  let stepIndex = 0;
  const planned: PlannedStep[] = [];
  for (const instance of instances) {
    const mergedEnv = resolveMergedEnv(instance, opts.env);
    const groupLabel = instance.matrix.group ?? instance.matrixKey;
    const namePrefix = `${instance.jobId} / ${groupLabel} / `;
    for (const rawStep of instance.steps) {
      stepIndex += 1;
      planned.push({
        instance,
        step: toCiStep(rawStep, mergedEnv),
        stepIndex,
        namePrefix,
      });
    }
    persistJobState(
      deps,
      opts.runId,
      instance.jobId,
      instance.matrixKey,
      'queued',
      null,
      null,
      null,
      null,
    );
  }

  // Persist every planned step as `queued` up front and emit the checks
  // timeline immediately, so the panel shows ALL steps (including jobs still
  // waiting on the concurrency cap) as pending from the start — instead of a
  // step only appearing once its job begins running. Each row is keyed by the
  // global step_index, so the live `finalize_run_step_state` updates and the
  // per-step upserts (ON CONFLICT run_id+step_index) overwrite it in place.
  for (const p of planned) {
    try {
      deps.stmts.upsertFinalizeRunStep.run(
        opts.runId,
        p.stepIndex,
        `${p.namePrefix}${p.step.name}`,
        'queued',
        null,
        null,
        null,
        p.instance.jobId,
        p.instance.matrixKey,
      );
    } catch (err) {
      console.warn(
        `[finalize-job-runner] queue-step persist failed run=${opts.runId} step=${p.stepIndex}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  // Nudge the client to refetch now that the queued step rows exist, so the
  // live checks panel renders every job as pending up front. Re-announce the
  // current phase rather than emitting a checks-round timeline message (which
  // would render a second, redundant checks block): the client refetches the
  // run + steps on finalize_run_phase_changed.
  broadcast({
    type: 'finalize_run_phase_changed',
    run_id: opts.runId,
    session_id: opts.sessionId,
    phase: 'tasks',
    status: 'running',
  });

  const budgetMs = opts.config.timeoutMinutes * 60_000;
  const budgetStartedAt = now();
  const concurrency = readMaxParallelJobs();
  const failFastCancelledJobs = new Set<string>();
  // Shards that failed a genuine test then PASSED on a same-commit `retries:`
  // rerun this phase. Surfaced on the phase result so the orchestrator can fold
  // them into the flake gate (a red→green retry must not auto-push as clean).
  const flakeRecoveredInstances: FlakeRecoveredInstance[] = [];

  const markSkipped = (instance: JobInstance): JobInstanceOutcome => {
    persistJobState(
      deps,
      opts.runId,
      instance.jobId,
      instance.matrixKey,
      'skipped',
      null,
      null,
      now(),
      null,
    );
    return {
      instance,
      result: {
        status: 'success' as const,
        stepResults: [],
        activeSecondsBilled: 0,
      },
    };
  };

  const runInstance = async (instance: JobInstance): Promise<JobInstanceOutcome> => {
    if (failFastCancelledJobs.has(instance.jobId)) {
      return markSkipped(instance);
    }
    // Stop pressed before this instance started (or while a dependency of it was
    // running): don't stand up a runner for it. Marking it skipped keeps the
    // dependency scheduler from launching downstream jobs against a cancelled
    // run.
    if (opts.signal?.aborted) {
      return markSkipped(instance);
    }

    let failureRerunCount = 0;
    const outcome = await runInstanceWithRetries(
      () => runJobInstance(deps, opts, instance, planned, budgetStartedAt, budgetMs, now),
      {
        maxInfraAttempts: MAX_INSTANCE_INFRA_ATTEMPTS,
        maxFailureRetries: instance.retries,
        // Never re-run an instance the user cancelled — a same-commit failure
        // retry or infra retry would defeat the Stop the moment it fired.
        isAborted: () => opts.signal?.aborted ?? false,
        onInfraRetry: (rerun, detail) =>
          console.warn(
            `[finalize-job-runner] ${instance.jobId}/${instance.matrixKey} infra_error on attempt ` +
              `${rerun}/${MAX_INSTANCE_INFRA_ATTEMPTS} (${detail ?? 'runner lost'}) — retrying on a fresh agent`,
          ),
        onFailureRetry: (rerun, detail) => {
          failureRerunCount = rerun;
          console.warn(
            `[finalize-job-runner] ${instance.jobId}/${instance.matrixKey} test failure — ` +
              `rerun ${rerun}/${instance.retries} on the same commit ` +
              `(no code change; flaky-test retry${detail ? `, step: ${detail}` : ''})`,
          );
        },
      },
    );

    // Passed only after a same-commit failure rerun → a recovered flake. Record
    // it so the orchestrator's flake gate withholds auto-push (the retry made
    // the round green, but the flake still happened and must not be laundered).
    if (outcome.result.status === 'success' && failureRerunCount > 0) {
      flakeRecoveredInstances.push({
        jobId: instance.jobId,
        matrixKey: instance.matrixKey,
        failureCount: failureRerunCount,
      });
    }

    if (outcome.result.status !== 'success' && instance.failFast) {
      failFastCancelledJobs.add(instance.jobId);
    }

    return outcome;
  };

  // Dependency-aware scheduling. A job's instances start only after every job
  // in its `needs` has completed successfully; a `warmup: true` job is an
  // implicit prerequisite of every non-warmup job (one prepare pass populates
  // the shared /finalize-cache before the matrix fans out). When a needed job
  // fails, its dependents are skipped rather than run against a cold/missing
  // cache. With no `needs` and no warmup job, everything runs straight through
  // the concurrency pool exactly as before. (`effectiveNeeds` was computed
  // up-front above so the single-job filter could resolve its dep closure.)
  // Remote backend only: when the run's CancelSignal trips mid-phase, actively
  // cancel this run's queue jobs and unblock their channels so an already-
  // dispatched shard stops and every instance promise settles promptly — rather
  // than the phase hanging on a remote step until its hard deadline, which would
  // stall the orchestrator's `cancelTerminal` and keep the composer locked. The
  // local backend needs nothing here: the step child is killed directly (see
  // runStepsSequence) and its container torn down in runJobInstance's finally.
  const unsubscribeAbort =
    opts.signal && isRemoteBackend()
      ? opts.signal.onAbort(() => {
          try {
            cancelRemoteJobsForRun(opts.runId, now());
          } catch (err) {
            console.warn(
              `[finalize-job-runner] remote cancel for run=${opts.runId} failed: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          }
        })
      : undefined;

  const hasDeps = [...effectiveNeeds.values()].some((n) => n.length > 0);
  let outcomes: JobInstanceOutcome[];
  try {
    outcomes = hasDeps
      ? await scheduleInstancesWithDeps(
          instances,
          effectiveNeeds,
          concurrency,
          runInstance,
          markSkipped,
        )
      : await runWithConcurrency(instances, concurrency, runInstance);
  } finally {
    // Release the run-signal subscription so a shared signal doesn't accumulate
    // one listener per checks round across the run's lifetime.
    unsubscribeAbort?.();
  }

  for (const outcome of outcomes) {
    activeSecondsBilled += outcome.result.activeSecondsBilled;
  }

  const allStepResults: StepResult[] = outcomes
    .flatMap((o) => o.result.stepResults)
    .sort((a, b) => a.index - b.index);

  const anyFailed = outcomes.some((o) => o.result.status !== 'success');
  let result: StepRunResult;
  if (!anyFailed) {
    result = {
      status: 'success',
      stepResults: allStepResults,
      activeSecondsBilled,
    };
  } else {
    // Prefer a GENUINE failure (CI-class `failure` / `timeout`) over an
    // `infra_error` when several shards went red. A shard cancelled mid-run
    // (`runner_cancelled` collateral, e.g. the inner dockerd died) lands as
    // `infra_error`; if a sibling shard has a real test failure, that real red
    // is what the fix agent must see — not the collateral. Falling back to the
    // first non-success outcome preserves the prior behaviour when the only
    // failures are infra-class.
    const failedOutcome =
      outcomes.find((o) => o.result.status === 'failure' || o.result.status === 'timeout')
        ?.result ?? outcomes.find((o) => o.result.status !== 'success')?.result;
    const failedStep = failedOutcome?.failedStep;

    // Collect EVERY failed step across all parallel jobs/shards — not just the
    // primary. Because the scheduler waits for all jobs to finish before we get
    // here, the orchestrator's single fix dispatch can surface every failure at
    // once (the agent fixes them together rather than rediscovering one per
    // round). Lead with genuine CI failures, then infra collateral, so the most
    // actionable reds come first; within each class, declaration order is kept.
    const orderedFailedOutcomes = [
      ...outcomes.filter((o) => o.result.status === 'failure' || o.result.status === 'timeout'),
      ...outcomes.filter((o) => o.result.status === 'infra_error'),
    ];
    const failedSteps = orderedFailedOutcomes
      .map((o) => o.result.failedStep)
      .filter((s): s is NonNullable<typeof s> => Boolean(s));

    if (failedOutcome?.status === 'infra_error') {
      result = {
        status: 'infra_error',
        stepResults: allStepResults,
        activeSecondsBilled,
        infraErrorDetail: failedOutcome.infraErrorDetail,
        // Carry the instance's machine reason (e.g. `spot_reclaimed` when a
        // runner lost its EC2 Spot instance) so the orchestrator picks the right
        // retry-generation cap instead of always assuming `container_unavailable`.
        ...(failedOutcome.failureReason ? { failureReason: failedOutcome.failureReason } : {}),
        ...(failedStep ? { failedStep } : {}),
        ...(failedSteps.length > 0 ? { failedSteps } : {}),
      };
    } else if (failedOutcome?.status === 'timeout') {
      result = {
        status: 'timeout',
        stepResults: allStepResults,
        activeSecondsBilled,
        ...(failedStep ? { failedStep } : {}),
        ...(failedSteps.length > 0 ? { failedSteps } : {}),
      };
    } else {
      result = {
        status: 'failure',
        stepResults: allStepResults,
        activeSecondsBilled,
        ...(failedStep ? { failedStep } : {}),
        ...(failedSteps.length > 0 ? { failedSteps } : {}),
      };
    }
  }

  emitFinalizeChecksRoundTimeline(deps, { runId: opts.runId, sessionId: opts.sessionId });
  return flakeRecoveredInstances.length > 0 ? { ...result, flakeRecoveredInstances } : result;
}

export { readMaxParallelJobs, sanitizeComposeProjectName };
