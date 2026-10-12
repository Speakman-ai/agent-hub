/**
 * PR environments: lifecycle service keyed by pull request.
 *
 * Triggers (native PR open / head update / close / merge / reopen, the GitHub
 * `pull_request` webhook, and the manual start/stop routes) all funnel into
 * {@link PrEnvironmentService}. It applies the pure state machine in
 * `pr-environment-state.ts`, persists the row, and hands build/teardown work to
 * a pluggable {@link PrEnvironmentRuntime}. With no runtime registered the row
 * stays `queued` until one is.
 *
 * Events for the same PR are serialized so an async config read cannot let a
 * stale event overwrite a newer one.
 */
import { v4 as uuidv4 } from 'uuid';
import type Database from 'better-sqlite3';
import type { Project } from '../types.js';
import {
  UNRESOLVED_HEAD_ERROR_PREFIX,
  transitionPrEnvironment,
  type PrEnvironmentCleanupTarget,
  type PrEnvironmentEvent,
  type PrEnvironmentSource,
  type PrEnvironmentState,
  type PrEnvironmentStatus,
  type PrEnvironmentStopReason,
} from './pr-environment-state.js';

export type { PrEnvironmentSource, PrEnvironmentStatus } from './pr-environment-state.js';

/** Max log lines kept on the row for the PR page's log tail. */
export const PR_ENVIRONMENT_LOG_TAIL_LINES = 200;

export interface PrEnvironmentRow {
  id: string;
  project_id: string;
  source: PrEnvironmentSource;
  pr_number: number;
  head_sha: string;
  head_branch: string | null;
  status: PrEnvironmentStatus;
  generation: number;
  url: string | null;
  runner_ref: string | null;
  error: string | null;
  stop_reason: PrEnvironmentStopReason | null;
  log_tail: string;
  cleanup_pending: number;
  cleanup_target: string | null;
  created_at: number;
  updated_at: number;
  ready_at: number | null;
  stopped_at: number | null;
}

/** API shape served by the `/pulls/:number/preview/*` routes. */
export interface PrEnvironmentDto {
  id: string;
  projectId: string;
  source: PrEnvironmentSource;
  prNumber: number;
  headSha: string;
  headBranch: string | null;
  status: PrEnvironmentStatus;
  url: string | null;
  error: string | null;
  stopReason: PrEnvironmentStopReason | null;
  runnerRef: string | null;
  /** A teardown was requested and not confirmed; stopping again retries it. */
  cleanupPending: boolean;
  logTail: string[];
  createdAt: string;
  updatedAt: string;
  readyAt: string | null;
  stoppedAt: string | null;
}

function parseLogTail(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((l): l is string => typeof l === 'string') : [];
  } catch {
    return [];
  }
}

const iso = (ms: number | null): string | null => (ms == null ? null : new Date(ms).toISOString());

export function toPrEnvironmentDto(row: PrEnvironmentRow): PrEnvironmentDto {
  return {
    id: row.id,
    projectId: row.project_id,
    source: row.source,
    prNumber: row.pr_number,
    headSha: row.head_sha,
    headBranch: row.head_branch,
    status: row.status,
    url: row.url,
    error: row.error,
    stopReason: row.stop_reason,
    runnerRef: row.runner_ref,
    cleanupPending: row.cleanup_pending === 1,
    logTail: parseLogTail(row.log_tail),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    readyAt: iso(row.ready_at),
    stoppedAt: iso(row.stopped_at),
  };
}

function rowToState(row: PrEnvironmentRow): PrEnvironmentState {
  return {
    status: row.status,
    headSha: row.head_sha,
    headBranch: row.head_branch,
    generation: row.generation,
    url: row.url,
    runnerRef: row.runner_ref,
    error: row.error,
    stopReason: row.stop_reason,
    cleanupPending: row.cleanup_pending === 1,
    cleanupTarget: parseCleanupTarget(row.cleanup_target),
  };
}

/**
 * Whether the PR page should show the environment panel.
 *
 * Visibility is about what exists, not only about whether a new environment
 * may be started: an environment that is still running, building, failed, or
 * whose teardown is unconfirmed must stay reachable (its URL, error, logs,
 * and Retry teardown) even after the head drops its `preview:` block.
 *
 * On a closed or merged PR (`prOpen` false) only an environment that still
 * needs attention is shown; clients must not offer Start there.
 *
 * `headDeclaresPreview` is the PR head's deploy.yaml answer.
 */
export function prEnvironmentPanelVisible(
  env: Pick<PrEnvironmentDto, 'status' | 'cleanupPending'> | null,
  headDeclaresPreview: boolean,
  prOpen = true,
): boolean {
  // Anything still running, or a teardown not yet confirmed, stays reachable
  // whatever the PR or its head now say.
  if (env && (env.cleanupPending || env.status !== 'stopped')) return true;
  return prOpen && headDeclaresPreview;
}

function parseCleanupTarget(raw: string | null): PrEnvironmentCleanupTarget | null {
  if (!raw) return null;
  try {
    const t = JSON.parse(raw) as PrEnvironmentCleanupTarget;
    return t && typeof t === 'object' && typeof t.headSha === 'string' ? t : null;
  } catch {
    return null;
  }
}

/**
 * The environment a teardown must act on: the row, with the runner identity
 * of its unconfirmed cleanup target when one is recorded (the replacement
 * row's own `runnerRef` is null until its build starts).
 */
export function teardownEnvFor(row: PrEnvironmentRow): PrEnvironmentDto {
  const env = toPrEnvironmentDto(row);
  const target = parseCleanupTarget(row.cleanup_target);
  if (!target) return env;
  return {
    ...env,
    headSha: target.headSha,
    headBranch: target.headBranch,
    runnerRef: target.runnerRef,
    url: target.url,
  };
}

// Store

export interface PrEnvironmentStore {
  get(projectId: string, source: PrEnvironmentSource, prNumber: number): PrEnvironmentRow | null;
  getById(id: string): PrEnvironmentRow | null;
  listForProject(projectId: string): PrEnvironmentRow[];
  /**
   * Rows with work outstanding for a runtime: queued builds, builds that may
   * have been interrupted, and unconfirmed teardowns (any status). Processed
   * when a runtime registers.
   */
  listPending(): PrEnvironmentRow[];
  /** Every row not fully stopped (anything running, queued, failed, or awaiting cleanup). */
  listUnsettled(): PrEnvironmentRow[];
  save(
    key: { projectId: string; source: PrEnvironmentSource; prNumber: number },
    prev: PrEnvironmentRow | null,
    next: PrEnvironmentState,
    now: number,
  ): PrEnvironmentRow;
  appendLog(id: string, lines: string[], now: number): void;
}

function prepareStatements(db: Database.Database) {
  return {
    getStmt: db.prepare(
      'SELECT * FROM pr_environments WHERE project_id = ? AND source = ? AND pr_number = ?',
    ),
    getByIdStmt: db.prepare('SELECT * FROM pr_environments WHERE id = ?'),
    listUnsettledStmt: db.prepare(
      "SELECT * FROM pr_environments WHERE status != 'stopped' OR cleanup_pending = 1",
    ),
    listPendingStmt: db.prepare(
      `SELECT * FROM pr_environments
       WHERE status IN ('queued', 'building') OR cleanup_pending = 1
       ORDER BY updated_at ASC`,
    ),
    listStmt: db.prepare(
      'SELECT * FROM pr_environments WHERE project_id = ? ORDER BY updated_at DESC',
    ),
    insertStmt: db.prepare(`
    INSERT INTO pr_environments
      (id, project_id, source, pr_number, head_sha, head_branch, status, generation, url,
       runner_ref, error, stop_reason, log_tail, cleanup_pending, cleanup_target,
       created_at, updated_at, ready_at, stopped_at)
    VALUES
      (@id, @project_id, @source, @pr_number, @head_sha, @head_branch, @status, @generation, @url,
       @runner_ref, @error, @stop_reason, @log_tail, @cleanup_pending, @cleanup_target,
       @created_at, @updated_at, @ready_at, @stopped_at)
  `),
    updateStmt: db.prepare(`
    UPDATE pr_environments SET
      head_sha = @head_sha, head_branch = @head_branch, status = @status,
      generation = @generation, url = @url, runner_ref = @runner_ref, error = @error,
      stop_reason = @stop_reason, log_tail = @log_tail, cleanup_pending = @cleanup_pending,
      cleanup_target = @cleanup_target,
      updated_at = @updated_at,
      ready_at = @ready_at, stopped_at = @stopped_at
    WHERE id = @id
  `),
    setLogStmt: db.prepare('UPDATE pr_environments SET log_tail = ?, updated_at = ? WHERE id = ?'),
  };
}

/**
 * A store bound to one database handle for its whole life. It never follows
 * the "current" database: after an org switch the Hub uses a new store (see
 * `createDbScopedPrEnvironmentService`), so in-flight work cannot land in
 * another org's rows.
 */
export function createPrEnvironmentStore(db: Database.Database): PrEnvironmentStore {
  const prepared = prepareStatements(db);
  const st = () => prepared;

  return {
    get(projectId, source, prNumber) {
      return (
        (st().getStmt.get(projectId, source, prNumber) as PrEnvironmentRow | undefined) ?? null
      );
    },
    getById(id) {
      return (st().getByIdStmt.get(id) as PrEnvironmentRow | undefined) ?? null;
    },
    listForProject(projectId) {
      return st().listStmt.all(projectId) as PrEnvironmentRow[];
    },
    listPending() {
      return st().listPendingStmt.all() as PrEnvironmentRow[];
    },
    listUnsettled() {
      return st().listUnsettledStmt.all() as PrEnvironmentRow[];
    },
    save(key, prev, next, now) {
      const rebuilt = prev ? next.generation !== prev.generation : true;
      const row: PrEnvironmentRow = {
        id: prev?.id ?? uuidv4(),
        project_id: key.projectId,
        source: key.source,
        pr_number: key.prNumber,
        head_sha: next.headSha,
        head_branch: next.headBranch,
        status: next.status,
        generation: next.generation,
        url: next.url,
        runner_ref: next.runnerRef,
        error: next.error,
        stop_reason: next.stopReason,
        // A new generation starts a fresh log; the old build's output is
        // for a commit nobody is looking at anymore.
        log_tail: rebuilt ? '[]' : (prev?.log_tail ?? '[]'),
        cleanup_pending: next.cleanupPending ? 1 : 0,
        cleanup_target: next.cleanupTarget ? JSON.stringify(next.cleanupTarget) : null,
        created_at: prev?.created_at ?? now,
        updated_at: now,
        ready_at:
          next.status === 'ready' && !(prev?.status === 'ready' && !rebuilt)
            ? now
            : rebuilt
              ? null
              : (prev?.ready_at ?? null),
        stopped_at:
          next.status !== 'stopped' ? null : prev?.status === 'stopped' ? prev.stopped_at : now,
      };
      if (prev) st().updateStmt.run(row);
      else st().insertStmt.run(row);
      return row;
    },
    appendLog(id, lines, now) {
      const row = st().getByIdStmt.get(id) as PrEnvironmentRow | undefined;
      if (!row || lines.length === 0) return;
      const merged = [...parseLogTail(row.log_tail), ...lines].slice(
        -PR_ENVIRONMENT_LOG_TAIL_LINES,
      );
      st().setLogStmt.run(JSON.stringify(merged), now, id);
    },
  };
}

// Runtime seam

/**
 * Callbacks a runtime uses to report progress for ONE generation of an
 * environment. Calls for a superseded generation are dropped.
 */
export interface PrEnvironmentReporter {
  building(runnerRef?: string | null): void;
  ready(url: string): void;
  failed(error: string): void;
  log(lines: string | string[]): void;
}

/**
 * What actually boots and tears down a PR environment (the compose stack on
 * the runner fleet). Build is fire-and-forget: report progress through the
 * reporter. Teardown must be idempotent.
 */
export interface PrEnvironmentRuntime {
  build(args: {
    project: Project;
    env: PrEnvironmentDto;
    reporter: PrEnvironmentReporter;
  }): void | Promise<void>;
  teardown(args: { project: Project; env: PrEnvironmentDto }): void | Promise<void>;
  /**
   * Adopt a build that was in flight when the Hub stopped (its reporter is
   * gone). Return true and report progress through the new reporter when the
   * runtime still tracks it; false (or omit) and the build is failed and its
   * leftovers torn down, so Retry rebuilds it.
   */
  reattach?(args: {
    project: Project;
    env: PrEnvironmentDto;
    reporter: PrEnvironmentReporter;
  }): boolean | Promise<boolean>;
}

let registeredRuntime: PrEnvironmentRuntime | null = null;

const runtimeListeners = new Set<(runtime: PrEnvironmentRuntime) => void>();

/**
 * Register the process-wide runtime. `null` unregisters (new rows then stay
 * queued). Registering notifies listeners so rows queued while no runtime was
 * present get dispatched.
 */
export function setPrEnvironmentRuntime(runtime: PrEnvironmentRuntime | null): void {
  registeredRuntime = runtime;
  if (!runtime) return;
  for (const listener of runtimeListeners) {
    try {
      listener(runtime);
    } catch (err: unknown) {
      console.warn(
        `[pr-env] runtime-registered listener failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

/** Subscribe to runtime registration. Returns an unsubscribe function. */
export function onPrEnvironmentRuntimeRegistered(
  listener: (runtime: PrEnvironmentRuntime) => void,
): () => void {
  runtimeListeners.add(listener);
  return () => {
    runtimeListeners.delete(listener);
  };
}

export function getPrEnvironmentRuntime(): PrEnvironmentRuntime | null {
  return registeredRuntime;
}

// Service

export interface PrEnvironmentServiceDeps {
  store: PrEnvironmentStore;
  /**
   * Whether the project's `.agent-hub/deploy.yaml` at exactly `headSha`
   * declares a `preview:` block. `unresolved` means the commit could not be
   * read; a thrown error is treated the same way.
   */
  probePreviewConfig: (
    project: Project,
    headSha: string,
    pr: PrIdentity,
  ) => Promise<'present' | 'absent' | 'unresolved'>;
  /** Resolve a project for queued rows dispatched on runtime registration. */
  findProject?: (projectId: string) => Project | null;
  /**
   * The PR's authoritative state (open + head, or closed/merged; null when
   * the PR is gone), read from durable storage (PR row + hosted ref). Used
   * by `reconcile` when no reader is passed, and by `catchUp` to re-check
   * every unsettled environment, so a PR change whose environment update was
   * lost (the Hub exited in between) is applied on the next catch-up.
   */
  readPrState?: (project: Project, pr: PrIdentity) => Promise<PrAuthoritativeState>;
  /**
   * Every open PR in this org, from durable storage. `catchUp` reconciles
   * each one, so a PR created or reopened just before a restart (whose
   * environment hook never ran) still gets its environment.
   */
  listOpenPrs?: () => Array<{ projectId: string; prNumber: number }>;
  broadcast?: (data: Record<string, unknown>) => void;
  /** Defaults to the registered process-wide runtime. */
  getRuntime?: () => PrEnvironmentRuntime | null;
  now?: () => number;
  log?: (msg: string) => void;
  /** Timer for automatic teardown retries (tests inject a fake). */
  schedule?: (fn: () => void, ms: number) => void;
}

/** Delay before a failed teardown is retried automatically. */
export const PR_TEARDOWN_RETRY_MS = 60_000;

type PreviewConfigProbeResult = 'present' | 'absent' | 'unresolved';

/** Re-checks, right before a build is dispatched, that the PR still wants it. */
type StillWanted = () => Promise<boolean>;

/** Reads of a PR that keeps changing during preparation before giving up. */
const STABLE_READ_ATTEMPTS = 3;

export interface PrIdentity {
  source: PrEnvironmentSource;
  prNumber: number;
}

export type PrEnvironmentStartResult =
  | { ok: true; environment: PrEnvironmentDto }
  | {
      ok: false;
      reason: 'not_found' | 'not_open' | 'no_preview_config' | 'unresolved_head';
      error: string;
    };

export interface PrHead {
  headSha: string;
  headBranch: string | null;
}

/** Authoritative PR state read inside the per-PR queue (see `reconcile`). */
export type PrAuthoritativeState =
  | ({ status: 'open' } & PrHead)
  | { status: 'closed' | 'merged' }
  | null;

export interface PrEnvironmentService {
  /** PR opened / reopened / head moved. Returns the row, or null when the head has no `preview:` block. */
  onPrOpened(project: Project, pr: PrIdentity & PrHead): Promise<PrEnvironmentDto | null>;
  onPrClosed(
    project: Project,
    pr: PrIdentity & { merged: boolean },
  ): Promise<PrEnvironmentDto | null>;
  /**
   * Bring the environment in line with the PR's current state, read by
   * `readState` inside the per-PR queue. Used for Hub-hosted PRs, whose
   * row + hosted ref are authoritative; `null` leaves the environment alone.
   */
  reconcile(
    project: Project,
    pr: PrIdentity,
    readState?: () => Promise<PrAuthoritativeState>,
  ): Promise<PrEnvironmentDto | null>;
  /**
   * Manual start. `readState` is called inside the per-PR queue, so a close or
   * merge racing the request is seen before anything is queued.
   */
  start(
    project: Project,
    pr: PrIdentity,
    readState: () => Promise<PrAuthoritativeState>,
  ): Promise<PrEnvironmentStartResult>;
  stop(project: Project, pr: PrIdentity): Promise<PrEnvironmentDto | null>;
  get(projectId: string, pr: PrIdentity): PrEnvironmentDto | null;
  list(projectId: string): PrEnvironmentDto[];
  /**
   * Catch up on work a runtime could not do while absent (or that a restart
   * interrupted): retry unconfirmed teardowns, dispatch queued builds, and
   * adopt or fail builds that were running when the Hub stopped.
   * Called when a runtime registers.
   */
  recoverPending(): Promise<{
    tornDown: number;
    dispatched: number;
    reattached: number;
    interrupted: number;
  }>;
  /**
   * Do everything this org owes: re-check every unsettled environment and
   * every open PR against the PR's state (`readPrState`), then queued and interrupted builds and
   * unconfirmed teardowns (needs a runtime). The one entry point for every
   * trigger: startup, runtime registration, an org's first use in this
   * process, and the automatic retry after a failed teardown.
   */
  catchUp(): Promise<void>;
}

export function createPrEnvironmentService(deps: PrEnvironmentServiceDeps): PrEnvironmentService {
  const now = deps.now ?? (() => Date.now());
  const getRuntime = deps.getRuntime ?? getPrEnvironmentRuntime;
  const logWarn = deps.log ?? ((msg: string) => console.warn(msg));
  const chains = new Map<string, Promise<unknown>>();
  // `${envId}:${generation}` already handed to a runtime in this process. A
  // Hub restart clears it, so queued rows are re-dispatched on re-registration.
  const dispatched = new Set<string>();
  const dispatchKey = (row: { id: string; generation: number }) => `${row.id}:${row.generation}`;

  const keyOf = (projectId: string, pr: PrIdentity) => `${projectId}|${pr.source}|${pr.prNumber}`;

  /** Serialize work per PR. */
  function serialize<T>(key: string, work: () => Promise<T>): Promise<T> {
    const prev = chains.get(key) ?? Promise.resolve();
    const run = prev.then(work, work);
    const tail = run.catch(() => undefined);
    chains.set(key, tail);
    void tail.then(() => {
      if (chains.get(key) === tail) chains.delete(key);
    });
    return run;
  }

  function broadcastRow(row: PrEnvironmentRow): void {
    deps.broadcast?.({
      type: 'pr_environment_update',
      projectId: row.project_id,
      source: row.source,
      prNumber: row.pr_number,
      status: row.status,
      environment: toPrEnvironmentDto(row),
    });
  }

  function makeReporter(
    project: Project,
    envId: string,
    generation: number,
  ): PrEnvironmentReporter {
    const apply = (event: PrEnvironmentEvent) => {
      const row = deps.store.getById(envId);
      if (!row || row.generation !== generation) return;
      const t = transitionPrEnvironment(rowToState(row), event);
      if (!t.changed || !t.next) return;
      const saved = deps.store.save(
        { projectId: project.id, source: row.source, prNumber: row.pr_number },
        row,
        t.next,
        now(),
      );
      broadcastRow(saved);
    };
    return {
      building: (runnerRef) =>
        apply({ type: 'runtime_building', generation, runnerRef: runnerRef ?? null }),
      ready: (url) => apply({ type: 'runtime_ready', generation, url }),
      failed: (error) => apply({ type: 'runtime_failed', generation, error }),
      log: (lines) => {
        const row = deps.store.getById(envId);
        if (!row || row.generation !== generation) return;
        const list = (Array.isArray(lines) ? lines : String(lines).split('\n')).filter(
          (l) => l.length > 0,
        );
        deps.store.appendLog(envId, list, now());
      },
    };
  }

  /** Persist a transition (if it changed anything) and run its effects. */
  async function applyEvent(
    project: Project,
    pr: PrIdentity,
    event: PrEnvironmentEvent,
    stillWanted?: StillWanted,
  ): Promise<PrEnvironmentRow | null> {
    const prev = deps.store.get(project.id, pr.source, pr.prNumber);
    const t = transitionPrEnvironment(prev ? rowToState(prev) : null, event);
    if (!t.next) return prev;
    let saved = prev;
    if (t.changed || !prev) {
      saved = deps.store.save(
        { projectId: project.id, source: pr.source, prNumber: pr.prNumber },
        prev,
        t.next,
        now(),
      );
      broadcastRow(saved);
    }
    await runEffects(project, prev, saved!, t.effects, stillWanted);
    return deps.store.getById(saved!.id) ?? saved;
  }

  /** Apply an internal event to a row by id (teardown results). */
  function applyById(project: Project, id: string, event: PrEnvironmentEvent): void {
    const row = deps.store.getById(id);
    if (!row) return;
    const t = transitionPrEnvironment(rowToState(row), event);
    if (!t.changed || !t.next) return;
    const saved = deps.store.save(
      { projectId: project.id, source: row.source, prNumber: row.pr_number },
      row,
      t.next,
      now(),
    );
    broadcastRow(saved);
  }

  /**
   * Tear down (when requested) and only then build. A failed teardown is
   * recorded (`cleanupPending`, and a waiting build becomes `failed`) so a
   * later stop/close/start retries it and no build runs over a live stack.
   */
  async function runEffects(
    project: Project,
    prev: PrEnvironmentRow | null,
    saved: PrEnvironmentRow,
    effects: { teardown: boolean; build: boolean },
    stillWanted?: StillWanted,
  ): Promise<void> {
    if (!effects.teardown && !effects.build) return;
    const runtime = getRuntime();
    if (!runtime) return;
    if (effects.teardown) {
      // The persisted cleanup target names the runner to remove; it survives
      // the replacement row clearing `runnerRef` and failed attempts.
      const target = saved.cleanup_target ? saved : (prev ?? saved);
      try {
        await runtime.teardown({ project, env: teardownEnvFor(target) });
        applyById(project, saved.id, { type: 'teardown_done' });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        logWarn(
          `[pr-env] teardown failed for ${project.id} ${target.source}#${target.pr_number}: ${message}`,
        );
        applyById(project, saved.id, { type: 'teardown_failed', error: message });
        // Retry on its own: the stack may still be running, and nothing else
        // is guaranteed to ask again (stop/close/start/registration).
        scheduleCatchUp(PR_TEARDOWN_RETRY_MS);
        return;
      }
    }
    if (effects.build) await ensureDispatched(project, deps.store.getById(saved.id), stillWanted);
  }

  function dispatchBuild(
    runtime: PrEnvironmentRuntime,
    project: Project,
    row: PrEnvironmentRow,
  ): void {
    dispatched.add(dispatchKey(row));
    const reporter = makeReporter(project, row.id, row.generation);
    // Not awaited: a build runs for minutes and must not hold the per-PR
    // queue, or a close/merge would wait behind it.
    void Promise.resolve()
      .then(() => runtime.build({ project, env: toPrEnvironmentDto(row), reporter }))
      .catch((err: unknown) => reporter.failed(err instanceof Error ? err.message : String(err)));
  }

  /**
   * Dispatch a queued row that no runtime has picked up yet. A row whose
   * cleanup is still unconfirmed (e.g. the Hub died mid-teardown) is torn
   * down first.
   */
  async function ensureDispatched(
    project: Project,
    row: PrEnvironmentRow | null,
    stillWanted?: StillWanted,
  ): Promise<boolean> {
    if (!row || row.status !== 'queued' || dispatched.has(dispatchKey(row))) return false;
    const runtime = getRuntime();
    if (!runtime) return false;
    if (row.cleanup_pending === 1) {
      await runEffects(project, null, row, { teardown: true, build: false });
      const after = deps.store.getById(row.id);
      if (!after || after.cleanup_pending === 1 || after.status !== 'queued') return false;
      row = after;
    }
    // Last check before anything runs, on every dispatch path (live sync,
    // Start, recovery, catch-up): the PR must still be open at this row's
    // head. It may have closed or moved while this operation awaited (config
    // probe, teardown) or before a restart; the event for that change, or the
    // next catch-up, settles the row.
    if ((stillWanted && !(await stillWanted())) || !(await prStillWants(project, row))) {
      logWarn(
        `[pr-env] not dispatching ${project.id} ${row.source}#${row.pr_number}: the PR no longer wants a build at ${row.head_sha.slice(0, 8)}`,
      );
      return false;
    }
    // The awaits above may have let the row move on.
    const current = deps.store.getById(row.id);
    if (!current || current.status !== 'queued' || current.generation !== row.generation) {
      return false;
    }
    dispatchBuild(runtime, project, current);
    return true;
  }

  /**
   * Does the PR still want a build of this row: open, at the row's head? Read
   * from durable PR state (`readPrState`). A failed read counts as "no": an
   * unknown PR state must not start anything; the next catch-up retries.
   * Without a reader (tests, non-PR callers) there is nothing to check.
   */
  async function prStillWants(project: Project, row: PrEnvironmentRow): Promise<boolean> {
    if (!deps.readPrState) return true;
    try {
      const state = await deps.readPrState(project, {
        source: row.source,
        prNumber: row.pr_number,
      });
      return state?.status === 'open' && state.headSha === row.head_sha;
    } catch {
      return false;
    }
  }

  /** Hand an orphaned build to the runtime's `reattach`, if it has one. */
  async function tryReattach(project: Project, row: PrEnvironmentRow): Promise<boolean> {
    const runtime = getRuntime();
    if (!runtime?.reattach) return false;
    // Adopt only a build its PR still wants; otherwise it is treated as
    // interrupted (failed, and its leftovers torn down).
    if (!(await prStillWants(project, row))) return false;
    const reporter = makeReporter(project, row.id, row.generation);
    try {
      const adopted = await runtime.reattach({ project, env: toPrEnvironmentDto(row), reporter });
      if (adopted) dispatched.add(dispatchKey(row));
      return adopted === true;
    } catch (err: unknown) {
      logWarn(
        `[pr-env] reattach failed for ${project.id} ${row.source}#${row.pr_number}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return false;
    }
  }

  async function probe(
    project: Project,
    headSha: string,
    pr: PrIdentity,
  ): Promise<'present' | 'absent' | 'unresolved'> {
    try {
      return await deps.probePreviewConfig(project, headSha, pr);
    } catch {
      return 'unresolved';
    }
  }

  const unresolvedError = (headSha: string) =>
    `${UNRESOLVED_HEAD_ERROR_PREFIX} ${headSha.slice(0, 12)} to check its \`preview:\` block. Retry once the commit is reachable.`;

  async function applyOpen(
    project: Project,
    pr: PrIdentity & PrHead,
    opts: { config?: PreviewConfigProbeResult; stillWanted?: StillWanted } = {},
  ): Promise<PrEnvironmentRow | null> {
    const head = { headSha: pr.headSha, headBranch: pr.headBranch };
    const config = opts.config ?? (await probe(project, pr.headSha, pr));
    let row: PrEnvironmentRow | null;
    if (config === 'absent') {
      // The head has no `preview:` block: stop any running env and record the
      // head so a later start checks this commit, not the old one.
      row = await applyEvent(project, pr, { type: 'config_removed', ...head });
    } else if (config === 'unresolved') {
      // Recorded as a visible failed row (Retry re-reads the head); the next
      // PR event at this head rebuilds it.
      row = await applyEvent(project, pr, {
        type: 'config_unresolved',
        ...head,
        error: unresolvedError(pr.headSha),
      });
    } else {
      row = await applyEvent(project, pr, { type: 'pr_open', ...head }, opts.stillWanted);
      await ensureDispatched(project, row, opts.stillWanted);
    }
    return row ? (deps.store.getById(row.id) ?? row) : null;
  }

  /**
   * Read the PR, check its head's config, and read it again. Every await
   * between reading the PR and acting on it can let it go stale (a close or
   * push lands meanwhile), so the answer is only used if the PR is still open
   * at the same head afterwards; otherwise the fresh state is evaluated. The
   * returned `stillWanted` repeats that check right before a build is
   * dispatched.
   */
  async function readStableOpenState(
    read: () => Promise<PrAuthoritativeState>,
    project: Project,
    pr: PrIdentity,
  ): Promise<
    | { kind: 'gone' }
    | { kind: 'closed'; merged: boolean }
    | {
        kind: 'open';
        head: PrHead;
        config: PreviewConfigProbeResult;
        stillWanted: StillWanted;
      }
    | { kind: 'unsettled' }
  > {
    for (let attempt = 0; attempt < STABLE_READ_ATTEMPTS; attempt++) {
      const state = await read();
      if (!state) return { kind: 'gone' };
      if (state.status !== 'open') return { kind: 'closed', merged: state.status === 'merged' };
      const config = await probe(project, state.headSha, pr);
      const sameHead = (s: PrAuthoritativeState) =>
        s?.status === 'open' && s.headSha === state.headSha;
      if (!sameHead(await read())) continue; // changed during the probe
      return {
        kind: 'open',
        head: { headSha: state.headSha, headBranch: state.headBranch },
        config,
        stillWanted: async () => sameHead(await read()),
      };
    }
    // Still changing: leave it to the queued event for the latest change.
    return { kind: 'unsettled' };
  }

  async function applyClose(
    project: Project,
    pr: PrIdentity & { merged: boolean },
  ): Promise<PrEnvironmentRow | null> {
    const row = await applyEvent(project, pr, { type: 'pr_closed', merged: pr.merged });
    return row ? (deps.store.getById(row.id) ?? row) : null;
  }

  const dto = (row: PrEnvironmentRow | null) => (row ? toPrEnvironmentDto(row) : null);

  const schedule =
    deps.schedule ??
    ((fn: () => void, ms: number) => {
      const t = setTimeout(fn, ms);
      (t as { unref?: () => void }).unref?.();
    });

  // When the next catch-up (teardown retry) is set for; null when none.
  let catchUpAt: number | null = null;
  function scheduleCatchUp(delay: number): void {
    const at = now() + delay;
    if (catchUpAt != null && catchUpAt <= at) return;
    catchUpAt = at;
    schedule(() => {
      catchUpAt = null;
      void self
        .catchUp()
        .catch((err: unknown) =>
          logWarn(`[pr-env] catch-up failed: ${err instanceof Error ? err.message : String(err)}`),
        );
    }, delay);
  }

  const self: PrEnvironmentService = {
    onPrOpened(project, pr) {
      return serialize(keyOf(project.id, pr), async () => dto(await applyOpen(project, pr)));
    },
    onPrClosed(project, pr) {
      return serialize(keyOf(project.id, pr), async () => dto(await applyClose(project, pr)));
    },
    reconcile(project, pr, readState) {
      return serialize(keyOf(project.id, pr), async () => {
        // Read the authoritative PR state inside the per-PR queue, so a head
        // lookup that started before a close/merge cannot land after it.
        const read = readState ?? (deps.readPrState && (() => deps.readPrState!(project, pr)));
        if (!read) return dto(deps.store.get(project.id, pr.source, pr.prNumber));
        const res = await readStableOpenState(read, project, pr);
        if (res.kind === 'closed')
          return dto(await applyClose(project, { ...pr, merged: res.merged }));
        if (res.kind !== 'open') return dto(deps.store.get(project.id, pr.source, pr.prNumber));
        return dto(
          await applyOpen(
            project,
            { ...pr, ...res.head },
            { config: res.config, stillWanted: res.stillWanted },
          ),
        );
      });
    },
    start(project, pr, readState) {
      return serialize(keyOf(project.id, pr), async (): Promise<PrEnvironmentStartResult> => {
        const res = await readStableOpenState(readState, project, pr);
        if (res.kind === 'gone') {
          return { ok: false, reason: 'not_found', error: `PR #${pr.prNumber} not found` };
        }
        if (res.kind === 'closed' || res.kind === 'unsettled') {
          const what = res.kind === 'closed' ? (res.merged ? 'merged' : 'closed') : 'changing';
          return {
            ok: false,
            reason: 'not_open',
            error: `A PR environment can only be started for an open pull request (PR #${pr.prNumber} is ${what}).`,
          };
        }
        const { head, config, stillWanted } = res;
        if (config === 'unresolved') {
          return { ok: false, reason: 'unresolved_head', error: unresolvedError(head.headSha) };
        }
        if (config === 'absent') {
          await applyEvent(project, pr, { type: 'config_removed', ...head });
          return {
            ok: false,
            reason: 'no_preview_config',
            error:
              'This PR has no `preview:` block in .agent-hub/deploy.yaml at its head commit, so there is no PR environment to start.',
          };
        }
        let row = await applyEvent(project, pr, { type: 'manual_start', ...head }, stillWanted);
        // A row queued before any runtime existed is a same-sha no-op for the
        // state machine; dispatch it here instead.
        await ensureDispatched(project, row, stillWanted);
        row = row ? (deps.store.getById(row.id) ?? row) : row;
        // manual_start always yields a row when config is present.
        return { ok: true, environment: toPrEnvironmentDto(row!) };
      });
    },
    stop(project, pr) {
      return serialize(keyOf(project.id, pr), async () =>
        dto(await applyEvent(project, pr, { type: 'manual_stop' })),
      );
    },
    get(projectId, pr) {
      return dto(deps.store.get(projectId, pr.source, pr.prNumber));
    },
    list(projectId) {
      return deps.store.listForProject(projectId).map(toPrEnvironmentDto);
    },
    async catchUp() {
      // First bring environments in line with their PRs: a create, reopen,
      // push, close, or merge whose environment update was lost (the Hub
      // exited in between) is applied before recovery dispatches anything.
      if (deps.readPrState) {
        // Unsettled environments (their PR may have closed or moved) and every
        // open PR (it may have been created or reopened with no environment
        // update). A manual stop survives: an open PR does not restart it.
        const targets = new Map<string, { projectId: string; pr: PrIdentity }>();
        const add = (projectId: string, pr: PrIdentity) =>
          targets.set(keyOf(projectId, pr), { projectId, pr });
        for (const row of deps.store.listUnsettled()) {
          add(row.project_id, { source: row.source, prNumber: row.pr_number });
        }
        for (const open of deps.listOpenPrs?.() ?? []) {
          add(open.projectId, { source: 'native', prNumber: open.prNumber });
        }
        for (const { projectId, pr } of targets.values()) {
          const project = deps.findProject?.(projectId);
          if (!project) continue;
          try {
            await self.reconcile(project, pr);
          } catch (err: unknown) {
            logWarn(
              `[pr-env] reconcile during catch-up failed for ${projectId}#${pr.prNumber}: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          }
        }
      }
      await self.recoverPending();
    },
    async recoverPending() {
      const totals = { tornDown: 0, dispatched: 0, reattached: 0, interrupted: 0 };
      if (!getRuntime()) return totals;
      await Promise.all(
        deps.store.listPending().map((pending) => {
          const pr = { source: pending.source, prNumber: pending.pr_number };
          return serialize(keyOf(pending.project_id, pr), async () => {
            const project = deps.findProject?.(pending.project_id);
            if (!project) return;
            // Re-read: an event may have moved the row since the listing.
            const row = deps.store.getById(pending.id);
            if (!row) return;
            if (row.status === 'queued') {
              // ensureDispatched tears down first when cleanup is pending.
              if (await ensureDispatched(project, row)) totals.dispatched += 1;
              return;
            }
            if (row.status === 'building' && !dispatched.has(dispatchKey(row))) {
              // A build from before a restart: its reporter is gone. Let the
              // runtime adopt it, else fail it and clean up what it left.
              if (await tryReattach(project, row)) {
                totals.reattached += 1;
                return;
              }
              await applyEvent(project, pr, {
                type: 'build_interrupted',
                generation: row.generation,
                error:
                  'The build was interrupted (the Hub restarted while it was running). Retry to rebuild.',
              });
              totals.interrupted += 1;
              return;
            }
            if (row.cleanup_pending === 1) {
              await runEffects(project, null, row, { teardown: true, build: false });
              if (deps.store.getById(row.id)?.cleanup_pending === 0) totals.tornDown += 1;
            }
          });
        }),
      );
      return totals;
    },
  };
  return self;
}

/**
 * Everything that identifies one organization's PR-environment world. It is
 * captured once, when a call is made, and everything the call does later
 * (queued work, awaited probes and reads, teardown, build reports, recovery)
 * uses this captured context, never "the active org" at that later time.
 */
export interface PrEnvironmentOrgContext<S = unknown> {
  /** Stable identity of the org (its database handle). */
  key: unknown;
  db: Database.Database;
  /** Project lookup for THIS org, valid even after the active org changes. */
  findProject: (projectId: string) => Project | null;
  /** The org's prepared statements, for callers that read PR rows. */
  stmts: S;
}

/** A service plus the org context it is bound to. */
export interface PinnedPrEnvironments<S = unknown> extends PrEnvironmentService {
  org: PrEnvironmentOrgContext<S>;
}

/** The facade the Hub uses: routes each call to the org current at call time. */
export interface OrgScopedPrEnvironmentService<S = unknown> extends PrEnvironmentService {
  /**
   * Capture the current org's service and context. Use the returned object
   * for an entire request or hook (including anything it defers) so every
   * step stays in that org.
   */
  pin(): PinnedPrEnvironments<S>;
}

/**
 * One `PrEnvironmentService` per org, behind one facade. `currentOrg` is
 * consulted only at call entry; the per-org service's store, queue, dispatch
 * bookkeeping, reporters, and project resolver are bound to that org for
 * good. Recovery visits every org this process has touched.
 */
export function createOrgScopedPrEnvironmentService<S>(opts: {
  currentOrg: () => PrEnvironmentOrgContext<S>;
  create: (org: PrEnvironmentOrgContext<S>) => PrEnvironmentService;
}): OrgScopedPrEnvironmentService<S> {
  const pinned = new Map<unknown, PinnedPrEnvironments<S>>();
  const pin = (): PinnedPrEnvironments<S> => {
    const org = opts.currentOrg();
    let entry = pinned.get(org.key);
    if (!entry) {
      // The first context seen for an org is kept: its project resolver is
      // what the org's service uses for recovery while the org is inactive.
      entry = { ...opts.create(org), org };
      pinned.set(org.key, entry);
      // First use of an org in this process (startup, org switch, or after a
      // runtime registered while another org was active): catch up on
      // everything it owes, not just its inbox.
      void entry.catchUp().catch(() => undefined);
    }
    return entry;
  };
  return {
    pin,
    onPrOpened: (project, pr) => pin().onPrOpened(project, pr),
    onPrClosed: (project, pr) => pin().onPrClosed(project, pr),
    reconcile: (project, pr, readState) => pin().reconcile(project, pr, readState),
    start: (project, pr, readState) => pin().start(project, pr, readState),
    stop: (project, pr) => pin().stop(project, pr),
    get: (projectId, pr) => pin().get(projectId, pr),
    list: (projectId) => pin().list(projectId),
    async catchUp() {
      pin(); // the active org is always included
      for (const entry of pinned.values()) await entry.catchUp();
    },
    async recoverPending() {
      pin(); // make sure the active org is included
      const totals = { tornDown: 0, dispatched: 0, reattached: 0, interrupted: 0 };
      for (const entry of pinned.values()) {
        const t = await entry.recoverPending();
        totals.tornDown += t.tornDown;
        totals.dispatched += t.dispatched;
        totals.reattached += t.reattached;
        totals.interrupted += t.interrupted;
      }
      return totals;
    },
  };
}
