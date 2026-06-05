/**
 * job-runner.ts — v2 Finalize tasks phase: parallel GHA-style jobs + matrix.
 *
 * Expands ci.yaml v2 `jobs` × `matrix.include` into isolated runner
 * containers (or host bash for `runs-on: host`) and schedules shards
 * with a bounded parallelism pool.
 */
import type { CiConfigV2, CiStepV2, JobInstance } from './ci-config-v2.js';
import {
  applyEnvToStep,
  buildFinalizeBuiltinEnv,
  expandJobInstances,
  substituteEnvString,
} from './ci-config-v2.js';
import { createContainerSpawnStep } from './container-runner.js';
import { resolveRunnerBackend, type RunnerLease } from './runner-backend.js';
import { isDindRunnerMode } from './runner-docker-mode.js';
import { isContainerRunsOn, resolveRunsOnImage } from './runner-images.js';
import {
  defaultSpawnStep,
  emitFinalizeChecksRoundTimeline,
  runStepsSequence,
  TASKS_PHASE_ENTRY_ACTIVE_SECONDS,
  type StepPersistMeta,
  type StepResult,
  type StepRunResult,
  type StepRunnerDeps,
  type SpawnStepFn,
} from './step-runner.js';
import type { CiStep } from './ci-config.js';

/** Default max parallel job shards (override with FINALIZE_MAX_PARALLEL_JOBS). */
export const DEFAULT_MAX_PARALLEL_JOBS = 4;

export interface JobRunnerOptions {
  runId: string;
  config: CiConfigV2;
  worktreePath: string;
  sessionId: string;
  branch: string;
  headSha: string;
  env?: NodeJS.ProcessEnv;
  /** Tenant identity for the remote runner queue (local backend ignores these). */
  orgId?: string;
  projectId?: string;
  /**
   * Single-job "Run Tests" dropdown scope. When set, only these job ids (plus
   * their transitive `needs:` deps and any implicit warmup prereqs) run; all
   * other jobs are dropped entirely (not even queued). `null`/empty runs every
   * job. Unknown ids are ignored; if nothing matches the phase fails with an
   * `infra_error` rather than silently passing a no-op.
   */
  jobFilter?: string[] | null;
}

/**
 * Transitive closure of `requested` over the `needsByJob` graph: the requested
 * jobs plus everything they (transitively) depend on. Unknown requested ids are
 * dropped. Used to scope a single-job debug run to "this job and the deps it
 * needs to run first".
 */
export function resolveJobClosure(
  requested: string[],
  needsByJob: Map<string, string[]>,
): Set<string> {
  const closure = new Set<string>();
  const stack = requested.filter((id) => needsByJob.has(id));
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (closure.has(id)) continue;
    closure.add(id);
    for (const dep of needsByJob.get(id) ?? []) {
      if (!closure.has(dep)) stack.push(dep);
    }
  }
  return closure;
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
 * Re-run a job instance only on `infra_error`. Each attempt re-acquires a new
 * lease (new agent, fresh DinD) and re-runs all the instance's steps from the
 * start — CI steps aren't resume-able mid-job. A real test `failure` or a
 * genuine `timeout` is NEVER retried; re-running those would just loop.
 */
export async function runInstanceWithInfraRetry(
  runOnce: () => Promise<JobInstanceOutcome>,
  maxAttempts: number = MAX_INSTANCE_INFRA_ATTEMPTS,
  onRetry?: (attempt: number, detail: string | undefined) => void,
): Promise<JobInstanceOutcome> {
  let outcome!: JobInstanceOutcome;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    outcome = await runOnce();
    if (outcome.result.status === 'infra_error' && attempt < maxAttempts) {
      onRetry?.(attempt, outcome.result.infraErrorDetail);
      continue;
    }
    break;
  }
  return outcome;
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

function toCiStep(step: CiStepV2, env: Record<string, string>): CiStep {
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

function persistJobState(
  deps: StepRunnerDeps,
  runId: string,
  jobId: string,
  matrixKey: string,
  state: 'queued' | 'running' | 'passed' | 'failed' | 'skipped',
  exitCode: number | null,
  startedAt: number | null,
  endedAt: number | null,
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

  persistJobState(
    deps,
    runId,
    instance.jobId,
    instance.matrixKey,
    'running',
    null,
    jobStartedAt,
    null,
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

    if (isDindRunnerMode()) {
      const backend = deps.runnerBackend ?? resolveRunnerBackend();
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
        );
        return {
          instance,
          result: {
            status: 'infra_error',
            stepResults: [],
            activeSecondsBilled: 0,
            infraErrorDetail: msg,
          },
        };
      }
      spawnStep = lease.spawnStep;
    } else {
      spawnStep = createContainerSpawnStep({
        image,
        composeProjectName,
        baseEnv: mergedEnv,
        labels: jobLabels,
      });
    }
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
  );

  return { instance, result };
}

/**
 * Run ci.yaml v2 jobs phase — parallel matrix shards in runner containers.
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
    phase: 'tasks',
    status: 'running',
  });

  let activeSecondsBilled = TASKS_PHASE_ENTRY_ACTIVE_SECONDS;
  stmts.updateFinalizeRunActiveSeconds.run(TASKS_PHASE_ENTRY_ACTIVE_SECONDS, opts.runId);

  const builtins = buildFinalizeBuiltinEnv({ branch: opts.branch, headSha: opts.headSha });
  let instances = expandJobInstances(opts.config, builtins);

  // Dependency graph: each job's declared `needs` plus the implicit warmup
  // prereq (every warmup job must finish before any non-warmup job starts).
  // Computed up-front so a single-job filter can resolve the transitive
  // closure (selected jobs + the deps they need to run first).
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

  // Single-job debug scope: keep only the requested jobs and everything they
  // transitively depend on (so deps still run first). Unknown ids are ignored;
  // an empty closure (every requested id unknown — e.g. ci.yaml changed since
  // the dropdown was opened) fails the phase loudly instead of passing a no-op.
  const requestedJobs = opts.jobFilter?.map((j) => j.trim()).filter((j) => j.length > 0) ?? [];
  if (requestedJobs.length > 0) {
    const closure = resolveJobClosure(requestedJobs, effectiveNeeds);
    if (closure.size === 0) {
      return {
        status: 'infra_error',
        stepResults: [],
        activeSecondsBilled,
        infraErrorDetail: `none of the requested jobs exist in ci.yaml: ${requestedJobs.join(', ')}`,
      };
    }
    instances = instances.filter((i) => closure.has(i.jobId));
    // Drop dep edges that point at filtered-out jobs (defensive — the closure
    // already contains every dep, so this is a no-op in practice, but it keeps
    // `effectiveNeeds` consistent with the surviving instance set).
    for (const jobId of [...effectiveNeeds.keys()]) {
      if (!closure.has(jobId)) {
        effectiveNeeds.delete(jobId);
        continue;
      }
      effectiveNeeds.set(
        jobId,
        (effectiveNeeds.get(jobId) ?? []).filter((d) => closure.has(d)),
      );
    }
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
    phase: 'tasks',
    status: 'running',
  });

  const budgetMs = opts.config.timeoutMinutes * 60_000;
  const budgetStartedAt = now();
  const concurrency = readMaxParallelJobs();
  const failFastCancelledJobs = new Set<string>();

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

    const outcome = await runInstanceWithInfraRetry(
      () => runJobInstance(deps, opts, instance, planned, budgetStartedAt, budgetMs, now),
      MAX_INSTANCE_INFRA_ATTEMPTS,
      (attempt, detail) =>
        console.warn(
          `[finalize-job-runner] ${instance.jobId}/${instance.matrixKey} infra_error on attempt ` +
            `${attempt}/${MAX_INSTANCE_INFRA_ATTEMPTS} (${detail ?? 'runner lost'}) — retrying on a fresh agent`,
        ),
    );

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
  const hasDeps = [...effectiveNeeds.values()].some((n) => n.length > 0);
  const outcomes = hasDeps
    ? await scheduleInstancesWithDeps(
        instances,
        effectiveNeeds,
        concurrency,
        runInstance,
        markSkipped,
      )
    : await runWithConcurrency(instances, concurrency, runInstance);

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
    const failedOutcome = outcomes.find((o) => o.result.status !== 'success')?.result;
    const failedStep = failedOutcome?.failedStep;

    if (failedOutcome?.status === 'infra_error') {
      result = {
        status: 'infra_error',
        stepResults: allStepResults,
        activeSecondsBilled,
        infraErrorDetail: failedOutcome.infraErrorDetail,
        ...(failedStep ? { failedStep } : {}),
      };
    } else if (failedOutcome?.status === 'timeout') {
      result = {
        status: 'timeout',
        stepResults: allStepResults,
        activeSecondsBilled,
        ...(failedStep ? { failedStep } : {}),
      };
    } else {
      result = {
        status: 'failure',
        stepResults: allStepResults,
        activeSecondsBilled,
        ...(failedStep ? { failedStep } : {}),
      };
    }
  }

  emitFinalizeChecksRoundTimeline(deps, { runId: opts.runId, sessionId: opts.sessionId });
  return result;
}

export { readMaxParallelJobs, sanitizeComposeProjectName };
