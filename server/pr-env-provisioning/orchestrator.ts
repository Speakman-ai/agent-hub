/**
 * PR-env provisioning orchestrator.
 *
 * Drives the "Provision PR Environments" wizard documented in
 * `docs/architecture/pr-environments-provisioning-wizard-v1-spec.md`.
 *
 * Mirrors the shape of `server/provisioning/orchestrator.ts` (new-project
 * scaffold flow): a fixed ordered phase list, an injectable executor, a
 * ring-buffered event stream, and per-job subscribers that get replay +
 * live tail with `?since=<seq>` resume semantics.
 *
 * This module ships the **state machine + event contract only**. The
 * real adapters (host detection, certbot subprocess, IAM SDK calls,
 * verify wrapper) are intentionally not wired here — they land as
 * follow-up cards once reviewers have signed off on the contract. A
 * stub executor (`stubExecutor`) drives every phase to `ok` so the
 * orchestrator + route + WS plumbing can be exercised end-to-end before
 * real adapters exist.
 *
 * Event contract — must stay in sync with the future client consumer:
 *
 *   {type:'phase', phase:<id>, status:'started'|'ok'|'failed'|'skipped',
 *    message?, at:<ISO>, seq}
 *   {type:'log',   line, at:<ISO>, seq}
 *   {type:'done',  ok|partial|error, remediations?, at:<ISO>, seq}
 *
 * The ring-buffer cap matches the new-project orchestrator
 * (EVENT_BUFFER_CAP=2000) so a reconnecting client can replay every
 * event since job start under typical loads.
 */

/** Ordered phase ids — frozen V1 set. See wiki spec § "Phase ids". */
export const PR_ENV_PHASE_IDS = [
  'detect-host',
  'write-tier3-config',
  'issue-cert',
  'attach-iam',
  'verify',
] as const;

export type PrEnvPhaseId = (typeof PR_ENV_PHASE_IDS)[number];

export type PhaseStatus = 'started' | 'ok' | 'failed' | 'skipped';

export interface PhaseEvent {
  type: 'phase';
  phase: PrEnvPhaseId;
  status: PhaseStatus;
  message?: string;
  at: string;
  seq?: number;
}

export interface LogEvent {
  type: 'log';
  /** Phase that produced the log line. Lets the UI group logs under their row. */
  phase: PrEnvPhaseId;
  line: string;
  at: string;
  seq?: number;
}

/**
 * Remediation card surfaced when verify fails or when a phase has work
 * the wizard can't do itself (e.g. IAM with no keys + no usable instance
 * role). See wiki spec § "Remediation card schema".
 */
export interface RemediationCard {
  check: 'cert' | 'nginx' | 'github-app' | 'route53' | 'webhook' | 'docker';
  severity: 'red' | 'amber';
  headline: string;
  detail?: string;
  actions: Array<{
    label: string;
    kind: 'retry' | 'copy' | 'link' | 'open-settings';
    payload?: string;
  }>;
}

export interface DoneEvent {
  type: 'done';
  /**
   * `ok` — every required phase finished green (skipped counts as green).
   * `partial` — wizard ran to completion but verify surfaced red rows;
   *             remediations is non-empty.
   * `error` — a phase before verify failed hard and the wizard halted.
   */
  outcome: 'ok' | 'partial' | 'error';
  error?: { code: number; message: string; hint?: string };
  remediations?: RemediationCard[];
  at: string;
  seq?: number;
}

export type PrEnvProvisionEvent = PhaseEvent | LogEvent | DoneEvent;

/** Inputs the operator types into the wizard. See wiki spec § "Operator UX". */
export interface PrEnvProvisionPayload {
  previewHost: string;
  hostedZoneId: string;
  repoFullName: string;
  /** When true, write-tier3-config is skipped — used by the dry-run preview. */
  dryRun?: boolean;
  /** Optional override for the cert ACME contact email. Defaults to admin@<previewHost>. */
  operatorEmail?: string;
}

/** Per-phase context handed to the executor. */
export interface ExecutorPhaseCtx {
  jobId: string;
  payload: PrEnvProvisionPayload;
  /** Append a log line attributed to the *currently running* phase. */
  log: (line: string) => void;
}

export interface ExecutorPhaseResult {
  status: 'ok' | 'failed' | 'skipped';
  message?: string;
  error?: { code: number; message: string; hint?: string };
  /** Verify-only: any remediation cards produced by red rows. */
  remediations?: RemediationCard[];
}

export interface PrEnvExecutor {
  runPhase(phase: PrEnvPhaseId, ctx: ExecutorPhaseCtx): Promise<ExecutorPhaseResult>;
}

/** Drives every phase to `ok` with a generic message — used by tests + early UI smoke. */
export const stubExecutor: PrEnvExecutor = {
  async runPhase(phase) {
    return { status: 'ok', message: `stub: ${phase} ok` };
  },
};

interface JobState {
  id: string;
  payload: PrEnvProvisionPayload;
  events: PrEnvProvisionEvent[];
  nextSeq: number;
  finished: boolean;
  outcome: DoneEvent['outcome'] | null;
  finishedAt: string | null;
  subscribers: Set<(ev: PrEnvProvisionEvent) => void>;
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

export function snapshotEvents(jobId: string): PrEnvProvisionEvent[] {
  const job = jobs.get(jobId);
  if (!job) return [];
  return [...job.events];
}

export function isJobFinished(jobId: string): boolean {
  return !!jobs.get(jobId)?.finished;
}

/** Most-recent finished job's terminal summary, or null if none yet. */
export function lastFinishedSummary(): {
  jobId: string;
  outcome: DoneEvent['outcome'];
  finishedAt: string;
} | null {
  let best: JobState | null = null;
  for (const job of jobs.values()) {
    if (!job.finished || !job.finishedAt) continue;
    if (!best || job.finishedAt > (best.finishedAt ?? '')) best = job;
  }
  if (!best || !best.finishedAt || !best.outcome) return null;
  return { jobId: best.id, outcome: best.outcome, finishedAt: best.finishedAt };
}

function nowIso(): string {
  return new Date().toISOString();
}

function appendEvent(job: JobState, ev: PrEnvProvisionEvent): void {
  ev.seq = job.nextSeq++;
  job.events.push(ev);
  if (job.events.length > EVENT_BUFFER_CAP) {
    // Head-drop so the terminal `done` event is always retained.
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

export interface SubscribeOptions {
  /** Replay only events with `seq > since`. Enables WS reconnect-resume. */
  since?: number;
}

/**
 * Subscribe to a job's event stream. Replays buffered events first
 * (filtered by `since`), then live-tails until unsubscribe or job end.
 * Returns null if the job id is unknown; otherwise returns an
 * unsubscribe fn the caller MUST invoke when its consumer disconnects.
 */
export function subscribeToJob(
  jobId: string,
  handler: (ev: PrEnvProvisionEvent) => void,
  opts: SubscribeOptions = {},
): (() => void) | null {
  const job = jobs.get(jobId);
  if (!job) return null;

  const since = typeof opts.since === 'number' && Number.isFinite(opts.since) ? opts.since : -1;
  for (const ev of job.events) {
    if (typeof ev.seq === 'number' && ev.seq <= since) continue;
    try {
      handler(ev);
    } catch {
      /* ignore */
    }
  }

  if (job.finished) return () => {};

  job.subscribers.add(handler);
  return () => {
    job.subscribers.delete(handler);
  };
}

/**
 * Returns the planned phase list for a payload, with skips baked in.
 * V1 only skips `write-tier3-config` when `dryRun` is set.
 */
export function plannedPhases(payload: PrEnvProvisionPayload): {
  phase: PrEnvPhaseId;
  skip: boolean;
}[] {
  return PR_ENV_PHASE_IDS.map((phase) => ({
    phase,
    skip: phase === 'write-tier3-config' && payload.dryRun === true,
  }));
}

export interface StartJobOptions {
  jobId: string;
  payload: PrEnvProvisionPayload;
  executor: PrEnvExecutor;
}

/**
 * Validate inputs, register the job, and start running it asynchronously.
 * Throws on invalid payload or duplicate jobId so the route handler can
 * convert to a 4xx response synchronously.
 */
export function startProvisionJob(opts: StartJobOptions): void {
  const { jobId, payload, executor } = opts;
  if (jobs.has(jobId)) throw new Error(`Job ${jobId} already exists`);
  if (!payload.previewHost?.trim()) throw new Error('previewHost is required');
  if (!payload.hostedZoneId?.trim()) throw new Error('hostedZoneId is required');
  if (!payload.repoFullName?.trim()) throw new Error('repoFullName is required');

  const job: JobState = {
    id: jobId,
    payload,
    events: [],
    nextSeq: 0,
    finished: false,
    outcome: null,
    finishedAt: null,
    subscribers: new Set(),
  };
  jobs.set(jobId, job);

  void runJob(job, executor).catch((err: unknown) => {
    // Last-resort safety net — runJob already converts phase failures
    // into terminal `done` events, so this branch only fires on
    // programmer errors (executor throws synchronously, etc.).
    const message = err instanceof Error ? err.message : String(err);
    finishJob(job, {
      type: 'done',
      outcome: 'error',
      error: { code: 500, message, hint: 'Check server logs.' },
      at: nowIso(),
    });
  });
}

function finishJob(job: JobState, ev: DoneEvent): void {
  if (job.finished) return;
  job.finished = true;
  job.outcome = ev.outcome;
  job.finishedAt = ev.at;
  appendEvent(job, ev);
  job.subscribers.clear();
}

async function runJob(job: JobState, executor: PrEnvExecutor): Promise<void> {
  const planned = plannedPhases(job.payload);
  let collectedRemediations: RemediationCard[] = [];

  for (const { phase, skip } of planned) {
    if (skip) {
      appendEvent(job, {
        type: 'phase',
        phase,
        status: 'skipped',
        message: 'skipped by payload (dry-run)',
        at: nowIso(),
      });
      continue;
    }

    appendEvent(job, { type: 'phase', phase, status: 'started', at: nowIso() });

    let result: ExecutorPhaseResult;
    try {
      result = await executor.runPhase(phase, {
        jobId: job.id,
        payload: job.payload,
        log: (line: string) => appendEvent(job, { type: 'log', phase, line, at: nowIso() }),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      appendEvent(job, {
        type: 'phase',
        phase,
        status: 'failed',
        message,
        at: nowIso(),
      });
      finishJob(job, {
        type: 'done',
        outcome: 'error',
        error: { code: 500, message, hint: `Phase ${phase} threw.` },
        at: nowIso(),
      });
      return;
    }

    appendEvent(job, {
      type: 'phase',
      phase,
      status: result.status,
      message: result.message,
      at: nowIso(),
    });

    // verify is the only phase allowed to surface remediations on a
    // non-failed result — that's the "all phases ran but verify is
    // amber" case that downgrades the run to `partial`.
    if (phase === 'verify' && result.remediations?.length) {
      collectedRemediations = collectedRemediations.concat(result.remediations);
    }

    if (result.status === 'failed') {
      finishJob(job, {
        type: 'done',
        outcome: 'error',
        error: result.error ?? {
          code: 500,
          message: result.message ?? `Phase ${phase} failed`,
        },
        at: nowIso(),
      });
      return;
    }
  }

  finishJob(job, {
    type: 'done',
    outcome: collectedRemediations.length === 0 ? 'ok' : 'partial',
    remediations: collectedRemediations.length === 0 ? undefined : collectedRemediations,
    at: nowIso(),
  });
}
