/**
 * Provisioning orchestrator.
 *
 * Sequences the phases of a new-project scaffold job and emits typed
 * events to any subscriber over a ring buffer. The executor (the thing
 * that actually creates the template tree, wires the GitHub repo,
 * etc.) is injectable so tests can drive the orchestrator with fakes
 * and production can plug in the real scaffold-builder.
 *
 * Event contract — must stay in sync with:
 *   - client/src/utils/provisioningClient.js
 *   - client/src/utils/provisioningStatus.js
 *   - client/src/components/ProvisioningStatus.jsx
 *
 *   {type:'phase', phase:<id>, status:'started'|'ok'|'failed'|'skipped',
 *    message?, at:<ISO>}
 *   {type:'log',   line, at:<ISO>}
 *   {type:'done',  repoUrl?, partial?, error?:{code,message,hint?}}
 *
 * The ring buffer lets a socket that reconnects after a brief drop
 * replay every event since the job started; the buffer cap matches the
 * client-side LOG_BUFFER_MAX so bounded memory stays bounded even for
 * chatty scaffolds.
 */

import type { Stmts } from '../types.js';

/** Ordered phase ids — must match provisioningStatus.js `PROVISIONING_PHASES`. */
export const PROVISIONING_PHASE_IDS = [
  'validate',
  'mint-token',
  'copy-template',
  'rewrite-pkg',
  'wire-tests',
  'wire-lint',
  'git-init',
  'gh-create',
  'gh-push',
] as const;

export type ProvisioningPhaseId = (typeof PROVISIONING_PHASE_IDS)[number];

/** Phases that are only relevant when the user asked for GitHub integration. */
export const GITHUB_PHASE_IDS: ReadonlySet<ProvisioningPhaseId> = new Set([
  'mint-token',
  'gh-create',
  'gh-push',
]);

export type PhaseStatus = 'started' | 'ok' | 'failed' | 'skipped';

export interface PhaseEvent {
  type: 'phase';
  phase: ProvisioningPhaseId;
  status: PhaseStatus;
  message?: string;
  at: string;
}

export interface LogEvent {
  type: 'log';
  line: string;
  at: string;
}

export interface DoneEvent {
  type: 'done';
  repoUrl?: string;
  partial?: boolean;
  error?: { code: number; message: string; hint?: string };
  at: string;
}

export type ProvisioningEvent = PhaseEvent | LogEvent | DoneEvent;

export interface ProvisioningPayload {
  /** `description` in the adaptive questionnaire, `prompt` was the older name. */
  description?: string;
  prompt?: string;
  appType?: string | null;
  stack?: string | null;
  integrations?: string[] | 'idk' | null;
  authDetail?: string | null;
  name?: string;
  visibility?: string | null;
  [key: string]: unknown;
}

/** What the executor receives for each non-skipped phase. */
export interface ExecutorPhaseCtx {
  jobId: string;
  projectId: string | null;
  payload: ProvisioningPayload;
  log: (line: string) => void;
}

/** Return shape from `executor.runPhase()`. */
export interface ExecutorPhaseResult {
  status: 'ok' | 'failed';
  /** Short free-form status text rendered next to the phase row. */
  message?: string;
  /** Present on gh-create / gh-push success — propagates into `done.repoUrl`. */
  repoUrl?: string;
  /** Present on failure — propagates into `done.error`. */
  error?: { code: number; message: string; hint?: string };
}

/**
 * Pluggable phase executor. Production wires this to the scaffold-builder
 * (container pool). Tests stub each phase.
 *
 * The orchestrator calls `runPhase` sequentially; a 'failed' return halts
 * the sequence (no further phases run) unless the phase is a non-critical
 * gh-* step *after* git-init has succeeded, in which case the orchestrator
 * emits a partial done.
 */
export interface ProvisioningExecutor {
  runPhase(phase: ProvisioningPhaseId, ctx: ExecutorPhaseCtx): Promise<ExecutorPhaseResult>;
}

interface JobState {
  id: string;
  projectId: string | null;
  payload: ProvisioningPayload;
  events: ProvisioningEvent[];
  /** True once a 'done' event has been appended. */
  finished: boolean;
  subscribers: Set<(ev: ProvisioningEvent) => void>;
}

const EVENT_BUFFER_CAP = 2000;

const jobs = new Map<string, JobState>();

/** Exposed for tests — drops every running + historical job. */
export function _resetJobsForTests(): void {
  jobs.clear();
}

export function getJob(jobId: string): JobState | undefined {
  return jobs.get(jobId);
}

export function snapshotEvents(jobId: string): ProvisioningEvent[] {
  const job = jobs.get(jobId);
  if (!job) return [];
  return [...job.events];
}

export function isJobFinished(jobId: string): boolean {
  const job = jobs.get(jobId);
  return !!job?.finished;
}

function nowIso(): string {
  return new Date().toISOString();
}

function appendEvent(job: JobState, ev: ProvisioningEvent): void {
  job.events.push(ev);
  if (job.events.length > EVENT_BUFFER_CAP) {
    // Drop from the head so the tail (including terminal 'done') is always kept.
    job.events.splice(0, job.events.length - EVENT_BUFFER_CAP);
  }
  for (const sub of job.subscribers) {
    try {
      sub(ev);
    } catch {
      /* subscriber errors never block the orchestrator */
    }
  }
}

/**
 * Subscribe to a job's event stream. The subscriber receives every
 * buffered event immediately (replay), then every live event until it
 * unsubscribes — or until the job terminates, at which point the
 * subscriber is auto-unregistered.
 *
 * Returns an `unsubscribe` fn the caller MUST invoke when its consumer
 * (e.g. a WebSocket) goes away.
 */
export function subscribeToJob(
  jobId: string,
  handler: (ev: ProvisioningEvent) => void,
): (() => void) | null {
  const job = jobs.get(jobId);
  if (!job) return null;

  // Replay.
  for (const ev of job.events) {
    try {
      handler(ev);
    } catch {
      /* ignore */
    }
  }

  // If the job already finished, there's nothing to live-tail — but we
  // still return an unsubscribe so callers don't have to branch.
  if (job.finished) {
    return () => {};
  }

  job.subscribers.add(handler);
  return () => {
    job.subscribers.delete(handler);
  };
}

/** Returns the planned phase order for a payload, with skips baked in. */
export function plannedPhases(payload: ProvisioningPayload): {
  phase: ProvisioningPhaseId;
  skip: boolean;
}[] {
  const withGithub = hasGithubIntegration(payload);
  return PROVISIONING_PHASE_IDS.map((phase) => ({
    phase,
    skip: !withGithub && GITHUB_PHASE_IDS.has(phase),
  }));
}

export function hasGithubIntegration(payload: ProvisioningPayload): boolean {
  const integrations = payload.integrations;
  if (integrations === 'idk' || integrations == null) {
    // 'idk' defers to the agent — we default to including GitHub so the
    // happy path is covered. Callers who want to disable GH explicitly
    // must pass an array without 'github'.
    return true;
  }
  if (Array.isArray(integrations)) {
    return integrations.includes('github');
  }
  return false;
}

export interface StartJobOptions {
  jobId: string;
  payload: ProvisioningPayload;
  projectId: string | null;
  executor: ProvisioningExecutor;
  stmts?: Stmts;
}

/**
 * Register a job and start running it asynchronously. Returns immediately;
 * callers typically store `jobId` and point clients at the WebSocket.
 */
export function startProvisioningJob(opts: StartJobOptions): void {
  const { jobId, payload, projectId, executor, stmts } = opts;

  if (jobs.has(jobId)) {
    throw new Error(`Job ${jobId} already exists`);
  }

  const job: JobState = {
    id: jobId,
    projectId,
    payload,
    events: [],
    finished: false,
    subscribers: new Set(),
  };
  jobs.set(jobId, job);

  if (stmts) {
    try {
      stmts.createProvisioningJob.run(jobId, projectId, JSON.stringify(payload), 'running');
    } catch {
      /* persistence is best-effort — orchestrator still streams live. */
    }
  }

  void runJob(job, executor, stmts).catch((err: unknown) => {
    // runJob already writes a terminal done on any caught error; this
    // handler only fires for errors thrown before that accounting, which
    // would leave the job wedged otherwise.
    if (!job.finished) {
      const at = nowIso();
      const done: DoneEvent = {
        type: 'done',
        at,
        error: {
          code: 500,
          message: (err as Error)?.message || 'Unhandled orchestrator error',
        },
      };
      job.finished = true;
      appendEvent(job, done);
    }
  });
}

async function runJob(
  job: JobState,
  executor: ProvisioningExecutor,
  stmts: Stmts | undefined,
): Promise<void> {
  const plan = plannedPhases(job.payload);
  let repoUrl: string | undefined;
  let failureError: DoneEvent['error'];
  let localScaffoldReady = false; // set once git-init completes

  for (const { phase, skip } of plan) {
    if (skip) {
      appendEvent(job, {
        type: 'phase',
        phase,
        status: 'skipped',
        at: nowIso(),
      });
      continue;
    }

    appendEvent(job, {
      type: 'phase',
      phase,
      status: 'started',
      at: nowIso(),
    });

    let result: ExecutorPhaseResult;
    try {
      result = await executor.runPhase(phase, {
        jobId: job.id,
        projectId: job.projectId,
        payload: job.payload,
        log: (line: string) => {
          appendEvent(job, { type: 'log', line, at: nowIso() });
        },
      });
    } catch (err: unknown) {
      result = {
        status: 'failed',
        error: {
          code: -2,
          message: (err as Error)?.message || `Phase ${phase} threw`,
        },
      };
    }

    if (result.status === 'ok') {
      if (result.repoUrl) repoUrl = result.repoUrl;
      appendEvent(job, {
        type: 'phase',
        phase,
        status: 'ok',
        message: result.message,
        at: nowIso(),
      });
      if (phase === 'git-init') {
        localScaffoldReady = true;
      }
    } else {
      failureError = result.error ?? {
        code: -2,
        message: `Phase ${phase} failed`,
      };
      appendEvent(job, {
        type: 'phase',
        phase,
        status: 'failed',
        message: result.message ?? failureError.message,
        at: nowIso(),
      });
      // Halt on the first failure — subsequent phases do not run.
      break;
    }
  }

  // Decide terminal state.
  let done: DoneEvent;
  const at = nowIso();
  if (!failureError) {
    done = { type: 'done', at, ...(repoUrl ? { repoUrl } : {}) };
  } else if (localScaffoldReady) {
    // git-init completed before the failure — local scaffold is usable.
    done = { type: 'done', at, partial: true, error: failureError };
  } else {
    done = { type: 'done', at, error: failureError };
  }

  job.finished = true;
  appendEvent(job, done);

  // Drop subscribers so their handlers stop being called for this job.
  job.subscribers.clear();

  if (stmts) {
    const status = failureError ? (localScaffoldReady ? 'partial' : 'failed') : 'succeeded';
    try {
      stmts.finishProvisioningJob.run(
        status,
        done.repoUrl ?? null,
        done.error ? JSON.stringify(done.error) : null,
        job.id,
      );
    } catch {
      /* best-effort */
    }
  }
}

/**
 * Default (stub) executor: emits plausible messages for every phase and
 * always succeeds. Real scaffolding lives in the container-pool path;
 * this stub keeps the route callable in environments where Docker isn't
 * wired up (dev boxes, CI).
 */
export const stubExecutor: ProvisioningExecutor = {
  async runPhase(phase, ctx) {
    ctx.log(`[stub] running ${phase}`);
    if (phase === 'gh-create' || phase === 'gh-push') {
      const name =
        typeof ctx.payload.name === 'string' && ctx.payload.name !== 'idk'
          ? ctx.payload.name
          : 'new-project';
      return {
        status: 'ok',
        message: phase === 'gh-create' ? 'Repo created' : 'Initial commit pushed',
        repoUrl: `https://github.com/example/${name}`,
      };
    }
    return { status: 'ok' };
  },
};
