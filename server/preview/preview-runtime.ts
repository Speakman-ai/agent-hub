/**
 * Worktree preview runtime.
 *
 * Spawns a project-configured preview process (`npm run dev`, Vite,
 * Storybook, etc.) inside the active session's git worktree, allocates
 * a host port for it, polls the configured `healthPath` until the
 * server reports ready, and tracks the lifecycle in the new
 * `worktree_preview_groups` + `worktree_preview_processes` tables.
 * Reaping (idle TTL, session-end) is owned by `preview-reaper.ts` plus
 * the session-delete hook in `routes/sessions.ts`; this module only
 * owns the per-preview start/stop/touch contract.
 *
 * Multi-process model:
 *
 *   - A *group* is the per-session container row. One row in
 *     `worktree_preview_groups` per active preview, regardless of how
 *     many child processes back it.
 *   - A group contains 1..N *processes*, one row per spawned child in
 *     `worktree_preview_processes`. The single-process happy path
 *     (legacy `startScript`-only config) is modelled as a 1-process
 *     group named `app`.
 *   - The runtime sorts processes by `dependsOn` (see
 *     `preview-process-graph.ts`) and spawns them in waves. Each
 *     process must reach 2xx on its `healthPath` before its
 *     dependents are spawned.
 *   - Group status is a rollup of per-process statuses: any `failed`
 *     short-circuits the whole group to `failed`; all `ready`
 *     promotes to `ready`; otherwise `starting`.
 *
 * Design notes:
 *
 *   - **One active preview group per session.** Calling `startPreview()`
 *     twice for the same session stops the prior group first (reverse-
 *     dependency teardown) before spawning the new one, preventing the
 *     port-leak that would otherwise stack across calls.
 *
 *   - **Port allocation is per-process, pooled globally.** The
 *     `UNIQUE(port)` invariant on `worktree_preview_processes.port`
 *     plus a bounded retry handles the rare race where two concurrent
 *     starts pick the same gap. Two processes in the same group
 *     cannot collide because allocation happens sequentially inside
 *     `_startPreview`.
 *
 *   - **All IO is injectable.** `spawn`, `fetch`, `clock`, and the log
 *     writer all flow through the constructor. Tests pass in fakes; the
 *     real production wiring lives in `routes/preview-runtime-setup.ts`.
 *
 *   - **Health-check loop.** Polls `healthPath` (default `/`) up to the
 *     configured deadline (default 30 s) at 500 ms cadence. Any 2xx
 *     flips the *process* row to `ready`; once every process in the
 *     group is ready the group is promoted to `ready`. Timeout flips
 *     the process to `failed` (which rolls the group up to `failed`
 *     too) and captures the first 50 lines of stdout/stderr from each
 *     spawned process for debugging.
 *
 *   - **Log tail.** stdout + stderr for each process are streamed to a
 *     per-process log file under the data directory
 *     (`previews/<groupId>/<processName>.log`). The first 50 lines are
 *     also kept in memory per process so a `failed` status surfaces
 *     immediately without a disk read. `getLogTail(groupId)` merges
 *     the per-process tails into one stream for the legacy single-URL
 *     surface; `getProcessLogTail(groupId, name)` returns just one.
 */

import type { Database } from 'better-sqlite3';
import type { ChildProcess, SpawnOptions } from 'child_process';
import { randomUUID } from 'crypto';
import { readFileSync, existsSync } from 'fs';
import path from 'path';
import {
  WORKTREE_PREVIEWS_SCHEMA,
  WORKTREE_PREVIEW_GROUPS_SCHEMA,
  MIGRATE_LEGACY_PREVIEWS_SQL,
  DEFAULT_PREVIEW_PORT_RANGE,
} from './preview-schema.js';
import {
  validateProcessGraph,
  formatGraphError,
  pickDefaultProcess,
} from './preview-process-graph.js';
import type { PrEnvPreviewConfig, PreviewProcess, Project } from '../types.js';

// ─── Types & contracts ──────────────────────────────────────────────────

export interface PortRange {
  readonly min: number;
  readonly max: number;
}

/** Group-level status; rollup of every child's `ProcessStatus`. */
export type PreviewStatus = 'starting' | 'ready' | 'failed';

/**
 * Process-level status. `pending` is the pre-spawn state — the row
 * exists (with a reserved port) but its dependencies haven't all
 * gone `ready` yet so the runtime hasn't called `spawn` on it.
 */
export type ProcessStatus = 'pending' | 'starting' | 'ready' | 'failed';

/**
 * Legacy single-URL preview row shape, kept for backwards compatibility
 * with `preview-block.ts`, `preview-reaper.ts`, and the existing
 * `<agenthub:preview>` flow. `id` is the group id; `pid`/`port`/`url`/
 * `log_path` are the *default surface* process's values (typically the
 * frontend leaf in a multi-process graph).
 */
export interface PreviewRow {
  id: string;
  session_id: string;
  project_id: string;
  pid: number | null;
  port: number;
  url: string;
  log_path: string | null;
  started_at: string;
  last_active_at: string;
  status: PreviewStatus;
}

/** Per-process detail row, surfaced by `GET /api/sessions/:id/preview/processes`. */
export interface PreviewProcessRow {
  id: string;
  group_id: string;
  name: string;
  pid: number | null;
  port: number;
  url: string;
  log_path: string | null;
  status: ProcessStatus;
  started_at: string;
}

export interface StartPreviewResult {
  url: string;
  port: number;
  previewId: string;
}

/**
 * Minimal `child_process.spawn`-shaped surface. Keeps the runtime
 * decoupled from the real Node import so tests inject a fake without
 * needing `vi.mock('child_process', …)`.
 */
export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

/** Tiny clock so tests can step time without `vi.useFakeTimers()`. */
export interface Clock {
  nowMs(): number;
  nowIso(): string;
  /** Resolve after `ms` real or simulated milliseconds. */
  sleep(ms: number): Promise<void>;
}

export const systemClock: Clock = {
  nowMs: () => Date.now(),
  nowIso: () => new Date().toISOString(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

/** A 2xx-or-network-error fetch surface. */
export type HealthFetchFn = (url: string) => Promise<{ ok: boolean; status: number }>;

/**
 * Where stdout/stderr are persisted. Production wraps Node's `fs`; tests
 * inject an in-memory accumulator.
 */
export interface PreviewLogSink {
  /** Open a fresh log buffer keyed by `<groupId>/<processName>`. */
  open(previewId: string): {
    path: string | null;
    append: (chunk: string) => void;
    /** Close any underlying file handle. Called on retry/spawn-throw to avoid fd leaks. */
    close?: () => void;
  };
}

export interface PreviewRuntimeConfig {
  /** Range to allocate ports from. Defaults to {@link DEFAULT_PREVIEW_PORT_RANGE}. */
  portRange?: PortRange;
  /**
   * Max ms to wait for the health check before flipping to `failed`.
   * Default 120000 (2 min) — sized so a cold worktree that runs
   * `npm install` and a first Vite/webpack compile on boot still has
   * room before we give up. Operators with faster fleets can tighten
   * this via `prEnv.preview.healthTimeoutMs` (see types.ts).
   */
  healthTimeoutMs?: number;
  /** Cadence for the health-check loop. Default 500. */
  healthIntervalMs?: number;
  /** Lines retained in memory per preview (and surfaced on failure). Default 50. */
  logTailLines?: number;
  /**
   * Hostname to use when constructing `url`. Defaults to `http://localhost:<port>`.
   * Override for nginx-fronted installs (`http://preview.<host>`).
   */
  urlBase?: (port: number) => string;
}

export interface PreviewRuntimeDeps {
  db: Database;
  spawn: SpawnFn;
  fetch: HealthFetchFn;
  clock?: Clock;
  logSink: PreviewLogSink;
  config?: PreviewRuntimeConfig;
  logger?: { log: (m: string) => void; warn: (m: string) => void; error: (m: string) => void };
  /**
   * Send a signal to a process or process group. Defaults to `process.kill`.
   * Injected so tests can record calls without touching real OS process groups.
   */
  kill?: (target: number, signal: NodeJS.Signals) => void;
  /**
   * Resolve a project's preview-env additions at spawn time. Returns a
   * key/value map merged into `child.env` *after* `process.env` but
   * *before* the runtime's own `PORT` injection (so PORT always wins).
   */
  loadProjectEnv?: (projectId: string, ctx: { sessionId: string }) => Record<string, string>;
  /**
   * Read a dotenv file relative to the worktree root. Returns an empty
   * object when the file is missing or malformed (per-process `envFile`
   * is a hint, never a hard requirement). Injected so tests don't need
   * to touch the filesystem.
   */
  readEnvFile?: (worktreePath: string, relPath: string) => Record<string, string>;
  /**
   * Optional sink invoked once per *line* of stdout/stderr from every
   * spawned preview process. Production wires this to a debounced
   * WebSocket broadcaster (see `preview-block.ts`'s `preview_log`
   * event); tests inject an in-memory recorder.
   *
   * Failures inside the callback are caught + logged — a broken
   * broadcaster must never crash the spawn or stall the health-check
   * loop. The runtime has no way to recover the line if the callback
   * throws, so unreliable transports should batch internally.
   */
  notifyLog?: (info: {
    sessionId: string;
    groupId: string;
    processName: string;
    line: string;
    stream: 'stdout' | 'stderr';
  }) => void;
}

// ─── Constants ──────────────────────────────────────────────────────────

const DEFAULT_HEALTH_TIMEOUT_MS = 120_000;
const DEFAULT_HEALTH_INTERVAL_MS = 500;
const DEFAULT_LOG_TAIL_LINES = 50;
/**
 * Default cwd for the single-process fallback. `'.'` lands at the
 * worktree root via `resolveProcessCwd` (see end of file). Projects that
 * actually boot from a subdirectory must set `prEnv.preview.processes[].cwd`
 * explicitly — hardcoding `'client'` here was an Agent-Hub-ism that broke
 * the Test-preview button for every other repo layout.
 */
const DEFAULT_PREVIEW_CWD = '.';
const DEFAULT_START_SCRIPT = 'npm run dev';
const SINGLE_PROCESS_NAME = 'app';

// ─── Implementation ─────────────────────────────────────────────────────

/**
 * Internal record kept in-memory for each running process — wraps the
 * DB row with the live `ChildProcess` handle, log tail buffer, and the
 * dependency edges we need to drive teardown order. Kept off the DB
 * because PIDs and child handles aren't durable.
 */
interface ProcessHandle {
  rowId: string;
  groupId: string;
  /** Session that owns the parent group — surfaced on `notifyLog` events. */
  sessionId: string;
  name: string;
  port: number;
  healthPath: string;
  dependsOn: readonly string[];
  child: ChildProcess | null;
  tail: string[];
  /** Resolves once the process flips to `ready` or `failed`. */
  donePromise: Promise<ProcessStatus>;
  resolveDone: (status: ProcessStatus) => void;
  /** Final/in-flight status reflected in memory; the DB row is the source of truth. */
  status: ProcessStatus;
}

/**
 * Runtime for booting + tearing down per-session preview groups.
 *
 * Construct once at server startup (the heartbeat scheduler reuses the
 * instance for the reaper). The constructor applies the schema so a
 * caller doesn't need a separate `init()`.
 */
export class PreviewRuntime {
  private readonly db: Database;
  private readonly spawn: SpawnFn;
  private readonly fetch: HealthFetchFn;
  private readonly clock: Clock;
  private readonly logSink: PreviewLogSink;
  private readonly portRange: PortRange;
  private readonly healthTimeoutMs: number;
  private readonly healthIntervalMs: number;
  private readonly logTailLines: number;
  private readonly urlBase: (port: number) => string;
  private readonly logger: NonNullable<PreviewRuntimeDeps['logger']>;
  private readonly kill: (target: number, signal: NodeJS.Signals) => void;
  private readonly loadProjectEnv:
    | ((projectId: string, ctx: { sessionId: string }) => Record<string, string>)
    | null;
  private readonly readEnvFile: (worktreePath: string, relPath: string) => Record<string, string>;
  private readonly notifyLog:
    | ((info: {
        sessionId: string;
        groupId: string;
        processName: string;
        line: string;
        stream: 'stdout' | 'stderr';
      }) => void)
    | null;

  /**
   * Live process handles keyed by groupId. Each group owns 1..N
   * handles. Kept off the DB because PIDs aren't a reliable pointer
   * once a process exits — the row tracks the *desired* state, this
   * map tracks the *running* handle so we can SIGTERM it.
   */
  private readonly groups = new Map<string, ProcessHandle[]>();

  /** Default-surface process name per group — drives `getById` / `<agenthub:preview>`. */
  private readonly defaultProcessByGroup = new Map<string, string>();

  /**
   * Per-session serialization lock. Prevents two concurrent `startPreview`
   * calls for the same session from both observing `getActiveBySessionId`
   * return null and each independently allocating ports + spawning.
   */
  private readonly sessionLocks = new Map<string, Promise<unknown>>();

  constructor(deps: PreviewRuntimeDeps) {
    this.db = deps.db;
    this.spawn = deps.spawn;
    this.fetch = deps.fetch;
    this.clock = deps.clock ?? systemClock;
    this.logSink = deps.logSink;
    this.portRange = deps.config?.portRange ?? DEFAULT_PREVIEW_PORT_RANGE;
    this.healthTimeoutMs = deps.config?.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS;
    this.healthIntervalMs = deps.config?.healthIntervalMs ?? DEFAULT_HEALTH_INTERVAL_MS;
    this.logTailLines = deps.config?.logTailLines ?? DEFAULT_LOG_TAIL_LINES;
    this.urlBase = deps.config?.urlBase ?? ((p) => `http://localhost:${p}`);
    this.logger = deps.logger ?? {
      log: (m) => console.log(m),
      warn: (m) => console.warn(m),
      error: (m) => console.error(m),
    };
    this.kill = deps.kill ?? ((t, s) => process.kill(t, s));
    this.loadProjectEnv = deps.loadProjectEnv ?? null;
    this.readEnvFile = deps.readEnvFile ?? defaultReadEnvFile;
    this.notifyLog = deps.notifyLog ?? null;
    if (this.portRange.min > this.portRange.max) {
      throw new Error(`Invalid preview port range: ${this.portRange.min}..${this.portRange.max}`);
    }
    // Apply schema in the same order db.ts uses so callers that pass in
    // a hand-built DB (tests) get the same migration semantics.
    this.db.exec(WORKTREE_PREVIEWS_SCHEMA);
    this.db.exec(WORKTREE_PREVIEW_GROUPS_SCHEMA);
    this.db.exec(MIGRATE_LEGACY_PREVIEWS_SQL);
  }

  // ─── Public API ───────────────────────────────────────────────────────

  /**
   * Boot a preview group for `sessionId`. If a group already exists for
   * the session, it is stopped + replaced. Resolves once the group row
   * has been inserted in `starting` and the first wave of processes
   * spawned; subsequent waves run in the background as their dependencies
   * flip `ready`. Callers that need the final status should poll
   * `getById(groupId)`.
   */
  async startPreview(
    sessionId: string,
    project: Project,
    worktreePath: string,
  ): Promise<StartPreviewResult> {
    return this.withSessionLock(sessionId, () =>
      this._startPreview(sessionId, project, worktreePath),
    );
  }

  private async _startPreview(
    sessionId: string,
    project: Project,
    worktreePath: string,
  ): Promise<StartPreviewResult> {
    // Replace-on-restart — kill any existing group for this session.
    const existing = this.getActiveBySessionId(sessionId);
    if (existing) {
      await this.stopPreview(existing.id);
    }

    const previewCfg: PrEnvPreviewConfig = project.prEnv?.preview ?? { enabled: false };
    const processes = this.resolveProcesses(previewCfg, project);
    const validation = validateProcessGraph(processes);
    if (!validation.ok) {
      throw new Error(`Invalid preview process graph: ${formatGraphError(validation.error)}`);
    }

    // Insert the group row before spawning anything so that, if any
    // spawn fails, the group row is the anchor for cleanup.
    const groupId = randomUUID();
    this.db
      .prepare(
        `INSERT INTO worktree_preview_groups (id, session_id, project_id, status)
         VALUES (?, ?, ?, 'starting')`,
      )
      .run(groupId, sessionId, project.id);
    this.groups.set(groupId, []);

    // Decide which process is the "default surface" for legacy single-URL
    // callers. We look at the graph: prefer a sink (no dependents) in the
    // final wave, falling back to the last process in the last wave.
    const adj = buildAdjacency(processes);
    const defaultProc = pickDefaultProcess(validation.waves, adj);
    this.defaultProcessByGroup.set(groupId, defaultProc.name);

    // Resolve project-wide env once; per-process envFile is merged on top
    // inside `spawnProcess`. Failure to load the project env must not
    // block boot (matches the historical single-process behaviour).
    let projectEnv: Record<string, string> = {};
    if (this.loadProjectEnv) {
      try {
        projectEnv = this.loadProjectEnv(project.id, { sessionId });
      } catch (err) {
        this.logger.warn(
          `[preview ${groupId}] loadProjectEnv failed: ${(err as Error).message} (continuing without project env)`,
        );
      }
    }

    // Allocate every port + insert every process row up-front. This
    // gives the UI a complete process list immediately ("backend:
    // pending, frontend: pending") rather than rows appearing one wave
    // at a time, which would make multi-process previews look broken
    // while the dependency chain unwinds.
    const handles: ProcessHandle[] = [];
    try {
      for (const proc of processes) {
        const handle = this.reserveProcessRow(groupId, sessionId, proc);
        handles.push(handle);
      }
    } catch (err) {
      // Rollback — clear any rows we already inserted before propagating
      // the allocation error so the next start gets a clean slate.
      this.db.prepare(`DELETE FROM worktree_preview_groups WHERE id = ?`).run(groupId);
      this.groups.delete(groupId);
      this.defaultProcessByGroup.delete(groupId);
      throw err;
    }
    this.groups.set(groupId, handles);

    // Schedule each wave. Within a wave, processes start in parallel.
    // Between waves, we await every handle's donePromise; if any one
    // fails the rollup short-circuits the group and the remaining
    // waves are SIGTERMed in `markGroupFailed`.
    //
    // The orchestrator must NOT silently swallow an unexpected throw
    // (e.g. a DB write failing after a schema drift) — that would leave
    // the group stuck in `starting` with no rollup. Catch and route it
    // through the same failure path the per-process error handlers use.
    this.runWaves(groupId, worktreePath, projectEnv, validation.waves, handles, processes).catch(
      async (err: unknown) => {
        const reason = err instanceof Error ? err.message : String(err);
        this.logger.error(`[preview] runWaves crashed for ${groupId}: ${reason}`);
        try {
          await this.markGroupFailed(groupId, handles, reason);
        } catch (innerErr) {
          this.logger.error(
            `[preview] markGroupFailed also threw for ${groupId}: ${
              innerErr instanceof Error ? innerErr.message : String(innerErr)
            }`,
          );
        }
      },
    );

    // The "headline" URL surfaced to the caller is the default process's
    // url. For a single-process happy path, this is the only process so
    // it's the right answer; for multi-process, the leaf (typically the
    // frontend) is what users want to iframe.
    const defaultHandle = handles.find((h) => h.name === defaultProc.name)!;
    return {
      url: this.urlBase(defaultHandle.port),
      port: defaultHandle.port,
      previewId: groupId,
    };
  }

  /**
   * Stop the preview group with `groupId`. Idempotent — a no-op when
   * the row is already gone. SIGTERMs each process in reverse-dependency
   * order, awaits their exit (with a SIGKILL fallback after the
   * configured grace), then deletes the group row (FK cascade removes
   * the process rows + frees the ports for the allocator).
   */
  async stopPreview(groupId: string): Promise<void> {
    const groupRow = this.db
      .prepare(`SELECT id FROM worktree_preview_groups WHERE id = ?`)
      .get(groupId) as { id: string } | undefined;
    if (!groupRow) return;
    const handles = this.groups.get(groupId) ?? [];
    // Teardown in reverse-dependency order so dependents go down before
    // their dependencies — protects against the dependent throwing
    // EPIPE / ECONNREFUSED on shutdown when its backend disappears
    // first.
    const ordered = reverseDependencyOrder(handles);
    for (const h of ordered) {
      if (h.child && h.child.exitCode == null && h.child.signalCode == null) {
        this.killGroup(h.child, 'SIGTERM');
        await this.waitForExit(h.child);
      }
    }
    this.groups.delete(groupId);
    this.defaultProcessByGroup.delete(groupId);
    // FK ON DELETE CASCADE removes the process rows + frees ports.
    this.db.prepare(`DELETE FROM worktree_preview_groups WHERE id = ?`).run(groupId);
    // Also clean any straggler in the legacy table (test fixtures that
    // pre-load it manually, or migrated rows that share the id).
    this.db.prepare(`DELETE FROM worktree_previews WHERE id = ?`).run(groupId);
  }

  /**
   * Stop every active preview group belonging to `sessionId`. Used by
   * the session-delete hook. Returns the number of groups torn down.
   */
  async stopBySessionId(sessionId: string): Promise<number> {
    const rows = this.db
      .prepare(
        `SELECT id FROM worktree_preview_groups
          WHERE session_id = ? AND status IN ('starting','ready','failed')`,
      )
      .all(sessionId) as Array<{ id: string }>;
    for (const r of rows) {
      await this.stopPreview(r.id);
    }
    return rows.length;
  }

  /**
   * Bump `last_active_at` so the reaper's idle-TTL clock resets.
   * No-op on unknown previews so the caller doesn't need to gate on
   * existence.
   */
  touchPreview(groupId: string): void {
    this.db
      .prepare(
        `UPDATE worktree_preview_groups
            SET last_active_at = datetime('now')
          WHERE id = ? AND status IN ('starting','ready')`,
      )
      .run(groupId);
  }

  /**
   * Active (non-stopped) group for `sessionId`, or null. Includes
   * `failed` rows so the replace-on-restart guard can sweep them.
   * Returns the legacy single-URL shape — `pid`/`port`/`url`/`log_path`
   * come from the default-surface process.
   */
  getActiveBySessionId(sessionId: string): PreviewRow | null {
    const groupRow = this.db
      .prepare(
        `SELECT id, session_id, project_id, status, started_at, last_active_at
           FROM worktree_preview_groups
          WHERE session_id = ? AND status IN ('starting','ready','failed')
          ORDER BY started_at DESC
          LIMIT 1`,
      )
      .get(sessionId) as
      | {
          id: string;
          session_id: string;
          project_id: string;
          status: PreviewStatus;
          started_at: string;
          last_active_at: string;
        }
      | undefined;
    if (!groupRow) return null;
    return this.composeLegacyRow(groupRow);
  }

  /** Single group by id, in the legacy `PreviewRow` shape. */
  getById(groupId: string): PreviewRow | null {
    const groupRow = this.db
      .prepare(
        `SELECT id, session_id, project_id, status, started_at, last_active_at
           FROM worktree_preview_groups WHERE id = ?`,
      )
      .get(groupId) as
      | {
          id: string;
          session_id: string;
          project_id: string;
          status: PreviewStatus;
          started_at: string;
          last_active_at: string;
        }
      | undefined;
    if (!groupRow) return null;
    return this.composeLegacyRow(groupRow);
  }

  /** Per-process detail rows for a group. Empty array on unknown group. */
  getProcesses(groupId: string): PreviewProcessRow[] {
    return this.db
      .prepare(
        `SELECT id, group_id, name, pid, port, url, log_path, status, started_at
           FROM worktree_preview_processes
          WHERE group_id = ?
          ORDER BY started_at ASC, name ASC`,
      )
      .all(groupId) as PreviewProcessRow[];
  }

  /**
   * First N captured log lines across every process in the group — used
   * by the boot-failure debug API. For multi-process groups, lines are
   * prefixed with `[<name>]` so the operator can tell which process
   * emitted what.
   */
  getLogTail(groupId: string): string[] {
    const handles = this.groups.get(groupId) ?? [];
    if (handles.length <= 1) {
      return [...(handles[0]?.tail ?? [])];
    }
    const merged: string[] = [];
    for (const h of handles) {
      for (const line of h.tail) {
        if (merged.length >= this.logTailLines) return merged;
        merged.push(`[${h.name}] ${line}`);
      }
    }
    return merged;
  }

  /** Per-process log tail. Used by the `GET /preview/processes/:name/logs` route. */
  getProcessLogTail(groupId: string, name: string): string[] {
    const handle = (this.groups.get(groupId) ?? []).find((h) => h.name === name);
    return [...(handle?.tail ?? [])];
  }

  // ─── Internals ────────────────────────────────────────────────────────

  /**
   * Resolve the canonical `PreviewProcess[]` for a project. When the
   * project provides an explicit `processes` array, that wins; otherwise
   * we synthesise a 1-process graph from the legacy
   * `startScript`/`port` fields so the rest of the runtime only deals
   * in one shape.
   */
  private resolveProcesses(previewCfg: PrEnvPreviewConfig, project: Project): PreviewProcess[] {
    if (previewCfg.processes && previewCfg.processes.length > 0) {
      return previewCfg.processes;
    }
    const startScript = (
      previewCfg.startScript ??
      project.prEnv?.startScript ??
      DEFAULT_START_SCRIPT
    ).trim();
    return [
      {
        name: SINGLE_PROCESS_NAME,
        startScript,
        cwd: DEFAULT_PREVIEW_CWD,
        healthPath: (project.prEnv?.healthPath ?? '/').trim() || '/',
      },
    ];
  }

  /**
   * Allocate a port, open a log sink, insert a `pending` row for
   * `proc` inside `groupId`. Retries up to 3 times on a UNIQUE(port)
   * race. Returns the in-memory `ProcessHandle`. Does NOT spawn.
   *
   * `sessionId` is stashed on the handle so `notifyLog` callbacks can
   * scope log lines to the originating chat session without a join.
   */
  private reserveProcessRow(
    groupId: string,
    sessionId: string,
    proc: PreviewProcess,
  ): ProcessHandle {
    const MAX_ATTEMPTS = 3;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const port = this.allocatePort();
      const rowId = randomUUID();
      const url = this.urlBase(port);
      const sink = this.logSink.open(`${groupId}-${proc.name}`);
      try {
        this.db
          .prepare(
            `INSERT INTO worktree_preview_processes
               (id, group_id, name, pid, port, url, log_path, status)
             VALUES (?, ?, ?, NULL, ?, ?, ?, 'pending')`,
          )
          .run(rowId, groupId, proc.name, port, url, sink.path);
      } catch (err) {
        sink.close?.();
        if (
          attempt < MAX_ATTEMPTS - 1 &&
          (err as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE'
        ) {
          this.logger.warn(
            `[preview] port ${port} conflict for ${proc.name} on attempt ${attempt + 1}, retrying`,
          );
          // If the conflicting row is from a failed group, free it so
          // the port is immediately reclaimable. Also delete the
          // orphaned group if that was its last process — otherwise
          // `getById(staleGroupId)` would keep returning a zombie row
          // with port=0/url=''.
          const conflicting = this.db
            .prepare(
              `SELECT id, status, group_id
                 FROM worktree_preview_processes
                WHERE port = ?`,
            )
            .get(port) as { id: string; status: string; group_id: string } | undefined;
          if (conflicting?.status === 'failed') {
            this.db
              .prepare(`DELETE FROM worktree_preview_processes WHERE id = ?`)
              .run(conflicting.id);
            const remaining = this.db
              .prepare(`SELECT COUNT(*) AS n FROM worktree_preview_processes WHERE group_id = ?`)
              .get(conflicting.group_id) as { n: number };
            if (remaining.n === 0) {
              this.db
                .prepare(`DELETE FROM worktree_preview_groups WHERE id = ?`)
                .run(conflicting.group_id);
              this.db
                .prepare(`DELETE FROM worktree_previews WHERE id = ?`)
                .run(conflicting.group_id);
              this.defaultProcessByGroup.delete(conflicting.group_id);
            }
          }
          continue;
        }
        throw err;
      }
      let resolveDone!: (s: ProcessStatus) => void;
      const donePromise = new Promise<ProcessStatus>((resolve) => {
        resolveDone = resolve;
      });
      const tail: string[] = [];
      const handle: ProcessHandle = {
        rowId,
        groupId,
        sessionId,
        name: proc.name,
        port,
        healthPath: normaliseHealthPath(proc.healthPath),
        dependsOn: proc.dependsOn ?? [],
        child: null,
        tail,
        donePromise,
        resolveDone,
        status: 'pending',
      };
      // Re-bind sink.append onto the new handle's tail buffer (the sink
      // itself is keyed in-memory by previewId in tests so we can read
      // it back; here we mirror its writes into `tail`).
      //
      // The append closure also fans each freshly-arrived *line* through
      // the optional `notifyLog` callback so the UI can render boot
      // output live during the `starting` window. The cap on the in-
      // memory tail is preserved (it remains the source of truth for
      // failure snapshots); `notifyLog` is fired regardless of cap so
      // late lines still reach a streaming consumer.
      const notifyLog = this.notifyLog;
      const append = (chunk: string, stream: 'stdout' | 'stderr'): void => {
        const lines = chunk.split('\n').filter((l) => l.length > 0);
        for (const line of lines) {
          if (tail.length < this.logTailLines) {
            tail.push(line);
          }
          if (notifyLog) {
            try {
              notifyLog({
                sessionId,
                groupId,
                processName: proc.name,
                line,
                stream,
              });
            } catch (err) {
              this.logger.warn(
                `[preview ${groupId}/${proc.name}] notifyLog threw: ${
                  err instanceof Error ? err.message : String(err)
                }`,
              );
            }
          }
        }
        sink.append(chunk);
      };
      // Attach the append to the handle so the spawn code path can find
      // it without re-opening the sink.
      (
        handle as ProcessHandle & {
          append: (c: string, s: 'stdout' | 'stderr') => void;
        }
      ).append = append;
      return handle;
    }
    throw new Error('unreachable: port retry loop exited without returning');
  }

  /**
   * Walk the wave list, spawning each wave once its predecessors are
   * ready. Updates the group rollup status as processes flip. Errors
   * inside a wave short-circuit the rest of the schedule via
   * `markGroupFailed`.
   */
  private async runWaves(
    groupId: string,
    worktreePath: string,
    projectEnv: Record<string, string>,
    waves: PreviewProcess[][],
    handles: ProcessHandle[],
    fullConfig: PreviewProcess[],
  ): Promise<void> {
    const byName = new Map(handles.map((h) => [h.name, h]));
    const cfgByName = new Map(fullConfig.map((p) => [p.name, p]));
    for (const wave of waves) {
      // Skip the wave if the group has already failed (a dependency in
      // an earlier wave timed out).
      const groupStatus = this.getGroupStatus(groupId);
      if (groupStatus === 'failed') return;
      // Spawn every process in this wave in parallel.
      for (const proc of wave) {
        const handle = byName.get(proc.name)!;
        const cfg = cfgByName.get(proc.name)!;
        this.spawnProcess(handle, cfg, worktreePath, projectEnv);
      }
      // Wait for every process in this wave to settle before unlocking
      // the next wave. `donePromise` resolves with the final per-process
      // status.
      const results = await Promise.all(wave.map((p) => byName.get(p.name)!.donePromise));
      if (results.some((s) => s === 'failed')) {
        await this.markGroupFailed(groupId, handles, `wave member failed`);
        return;
      }
    }
    // Every process is `ready` — promote the group.
    this.db
      .prepare(
        `UPDATE worktree_preview_groups
            SET status = 'ready',
                last_active_at = datetime('now')
          WHERE id = ? AND status = 'starting'`,
      )
      .run(groupId);
  }

  /**
   * Spawn one process under its group. Wires stdout/stderr into the
   * log tail, sets up the exit/error handlers, and kicks off the
   * health-check loop. Does not throw — synchronous spawn errors flip
   * the per-process row to `failed` and resolve the handle's
   * `donePromise`.
   */
  private spawnProcess(
    handle: ProcessHandle,
    cfg: PreviewProcess,
    worktreePath: string,
    projectEnv: Record<string, string>,
  ): void {
    const procCwd = resolveProcessCwd(worktreePath, cfg.cwd);
    let perProcessFileEnv: Record<string, string> = {};
    if (cfg.envFile) {
      try {
        perProcessFileEnv = this.readEnvFile(worktreePath, cfg.envFile);
      } catch (err) {
        this.logger.warn(
          `[preview ${handle.groupId}/${handle.name}] envFile read failed: ${(err as Error).message}`,
        );
      }
    }
    // Merge order: process.env → project env (preview secrets) →
    // per-process envFile → forced PORT. PORT is last so a malicious /
    // accidental PORT entry can't redirect the dev server off the
    // allocated port and deadlock the health check forever.
    const spawnEnv: NodeJS.ProcessEnv = {
      ...process.env,
      ...projectEnv,
      ...perProcessFileEnv,
      PORT: String(handle.port),
    };

    // Flip status to `starting` once we're about to spawn so the UI
    // can show "starting" instead of "pending" the moment a wave begins.
    this.db
      .prepare(
        `UPDATE worktree_preview_processes
            SET status = 'starting'
          WHERE id = ? AND status = 'pending'`,
      )
      .run(handle.rowId);
    handle.status = 'starting';

    let child: ChildProcess;
    try {
      child = this.spawn('sh', ['-c', cfg.startScript], {
        cwd: procCwd,
        env: spawnEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      });
    } catch (err) {
      this.logger.warn(
        `[preview ${handle.groupId}/${handle.name}] spawn failed: ${(err as Error).message}`,
      );
      void this.markProcessFailed(handle, `spawn failed: ${(err as Error).message}`);
      return;
    }
    handle.child = child;
    if (typeof child.pid === 'number') {
      this.db
        .prepare(`UPDATE worktree_preview_processes SET pid = ? WHERE id = ?`)
        .run(child.pid, handle.rowId);
    }

    const append = (
      handle as ProcessHandle & {
        append?: (c: string, s: 'stdout' | 'stderr') => void;
      }
    ).append;
    child.stdout?.on('data', (b: Buffer) => append?.(b.toString('utf8'), 'stdout'));
    child.stderr?.on('data', (b: Buffer) => append?.(b.toString('utf8'), 'stderr'));
    child.on('error', (err) => {
      this.logger.warn(`[preview ${handle.groupId}/${handle.name}] child error: ${err.message}`);
      void this.markProcessFailed(handle, `child error: ${err.message}`);
    });
    child.on('exit', (code, signal) => {
      // Exit while still `starting` is a startup failure; exit after
      // `ready` is normal (stopPreview drove it) — leave the row alone
      // in that case so stopPreview owns the deletion.
      if (handle.status === 'starting') {
        void this.markProcessFailed(
          handle,
          `exited during startup: code=${code} signal=${signal ?? ''}`,
        );
      }
    });

    void this.runHealthCheck(handle);
  }

  /**
   * Poll `handle.healthPath` until 2xx or `healthTimeoutMs` elapses.
   * On success flips the per-process row → `ready` and resolves
   * `donePromise('ready')`; on timeout flips → `failed`.
   */
  private async runHealthCheck(handle: ProcessHandle): Promise<void> {
    const healthUrl = this.urlBase(handle.port) + handle.healthPath;
    const deadline = this.clock.nowMs() + this.healthTimeoutMs;
    while (this.clock.nowMs() < deadline) {
      // Caller stopped the group while we were polling — bail.
      if (handle.status === 'failed' || handle.status === 'ready') return;
      const rowStatus = this.getProcessStatus(handle.rowId);
      if (rowStatus !== 'starting') return;
      try {
        const res = await this.fetch(healthUrl);
        if (res.ok) {
          this.db
            .prepare(
              `UPDATE worktree_preview_processes
                  SET status = 'ready'
                WHERE id = ? AND status = 'starting'`,
            )
            .run(handle.rowId);
          handle.status = 'ready';
          handle.resolveDone('ready');
          return;
        }
      } catch {
        // ignore — process may not have bound the port yet
      }
      await this.clock.sleep(this.healthIntervalMs);
    }
    const tail = handle.tail.slice(0, this.logTailLines).join('\n');
    await this.markProcessFailed(handle, `health check timed out after ${this.healthTimeoutMs}ms`);
    this.logger.warn(
      `[preview ${handle.groupId}/${handle.name}] failed health check; first ${this.logTailLines} log line(s):\n${tail}`,
    );
  }

  /**
   * Flip one process to `failed`. Kills the child if still running and
   * resolves its `donePromise('failed')`. Group rollup happens in the
   * scheduler (`runWaves` sees the failed result and calls
   * `markGroupFailed`).
   */
  private async markProcessFailed(handle: ProcessHandle, reason: string): Promise<void> {
    if (handle.status === 'failed') return;
    if (handle.child && handle.child.exitCode == null && handle.child.signalCode == null) {
      this.killGroup(handle.child, 'SIGTERM');
      await this.waitForExit(handle.child);
    }
    this.db
      .prepare(
        `UPDATE worktree_preview_processes
            SET status = 'failed'
          WHERE id = ? AND status IN ('pending','starting','ready')`,
      )
      .run(handle.rowId);
    handle.status = 'failed';
    handle.resolveDone('failed');
    this.logger.warn(`[preview ${handle.groupId}/${handle.name}] ${reason}`);
  }

  /**
   * Roll a group up to `failed` once any process failed. SIGTERMs every
   * still-running process so dependents that hadn't started yet don't
   * stack up indefinitely waiting on an upstream that's gone.
   */
  private async markGroupFailed(
    groupId: string,
    handles: ProcessHandle[],
    reason: string,
  ): Promise<void> {
    this.db
      .prepare(
        `UPDATE worktree_preview_groups
            SET status = 'failed',
                last_active_at = datetime('now')
          WHERE id = ? AND status IN ('starting','ready')`,
      )
      .run(groupId);
    // Tear down dependents (anything still pending/starting/ready) so a
    // mid-run crash doesn't leave orphans bound to ports.
    const ordered = reverseDependencyOrder(handles);
    for (const h of ordered) {
      if (h.status === 'failed') continue;
      if (h.child && h.child.exitCode == null && h.child.signalCode == null) {
        this.killGroup(h.child, 'SIGTERM');
        await this.waitForExit(h.child);
      }
      this.db
        .prepare(
          `UPDATE worktree_preview_processes
              SET status = 'failed'
            WHERE id = ? AND status IN ('pending','starting','ready')`,
        )
        .run(h.rowId);
      h.status = 'failed';
      h.resolveDone('failed');
    }
    this.logger.warn(`[preview ${groupId}] group failed: ${reason}`);
  }

  private getGroupStatus(groupId: string): PreviewStatus | null {
    const row = this.db
      .prepare(`SELECT status FROM worktree_preview_groups WHERE id = ?`)
      .get(groupId) as { status: PreviewStatus } | undefined;
    return row?.status ?? null;
  }

  private getProcessStatus(rowId: string): ProcessStatus | null {
    const row = this.db
      .prepare(`SELECT status FROM worktree_preview_processes WHERE id = ?`)
      .get(rowId) as { status: ProcessStatus } | undefined;
    return row?.status ?? null;
  }

  private composeLegacyRow(group: {
    id: string;
    session_id: string;
    project_id: string;
    status: PreviewStatus;
    started_at: string;
    last_active_at: string;
  }): PreviewRow {
    // Default-surface process for legacy single-URL callers.
    const defaultName = this.defaultProcessByGroup.get(group.id);
    let proc: PreviewProcessRow | undefined;
    if (defaultName) {
      proc = this.db
        .prepare(
          `SELECT id, group_id, name, pid, port, url, log_path, status, started_at
             FROM worktree_preview_processes
            WHERE group_id = ? AND name = ?`,
        )
        .get(group.id, defaultName) as PreviewProcessRow | undefined;
    }
    if (!proc) {
      // Cold restart / migration path — pick the highest-port row as a
      // best-effort default (the leaf is typically allocated last).
      proc = this.db
        .prepare(
          `SELECT id, group_id, name, pid, port, url, log_path, status, started_at
             FROM worktree_preview_processes
            WHERE group_id = ?
            ORDER BY port DESC
            LIMIT 1`,
        )
        .get(group.id) as PreviewProcessRow | undefined;
    }
    return {
      id: group.id,
      session_id: group.session_id,
      project_id: group.project_id,
      pid: proc?.pid ?? null,
      port: proc?.port ?? 0,
      url: proc?.url ?? '',
      log_path: proc?.log_path ?? null,
      started_at: group.started_at,
      last_active_at: group.last_active_at,
      status: group.status,
    };
  }

  /**
   * Serialize async work for a given `sessionId`. Calls for the same
   * session queue behind each other; calls for different sessions run
   * in parallel. Errors in one call do not block subsequent calls for
   * the same session.
   */
  private async withSessionLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    const prior = this.sessionLocks.get(sessionId) ?? Promise.resolve();
    const settled = prior.catch(() => {});
    const next = settled.then(() => fn());
    const nextSettled = next.catch(() => {});
    this.sessionLocks.set(sessionId, nextSettled);
    try {
      return await next;
    } finally {
      if (this.sessionLocks.get(sessionId) === nextSettled) {
        this.sessionLocks.delete(sessionId);
      }
    }
  }

  /**
   * Resolve once `proc` has exited. If it hasn't exited within `graceMs`
   * (default 3 s), a SIGKILL is sent as a fallback before resolving.
   */
  private waitForExit(proc: ChildProcess, graceMs = 3_000): Promise<void> {
    if (proc.exitCode != null || proc.signalCode != null) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const killTimer = setTimeout(() => {
        this.killGroup(proc, 'SIGKILL');
      }, graceMs);
      proc.once('exit', () => {
        clearTimeout(killTimer);
        resolve();
      });
    });
  }

  /**
   * Send `signal` to the entire process group headed by `proc`. We spawn
   * with `detached: true` so the child shell gets its own pgid (== pid),
   * and `process.kill(-pid, signal)` reaches every grandchild.
   */
  private killGroup(proc: ChildProcess, signal: 'SIGTERM' | 'SIGKILL'): void {
    if (typeof proc.pid === 'number') {
      try {
        this.kill(-proc.pid, signal);
        return;
      } catch {
        // ESRCH: process group already gone; fall through to direct kill
      }
    }
    try {
      proc.kill(signal);
    } catch {
      // ignore — process may have already exited
    }
  }

  /**
   * Lowest-free-port allocator. Scans `worktree_preview_processes` for
   * occupied ports in the configured range and returns the first gap.
   * Only `pending`/`starting`/`ready` rows count as taken — `failed`
   * rows have had their process killed (see `markProcessFailed`) so the
   * port is available for immediate reuse.
   */
  private allocatePort(): number {
    const taken = new Set(
      (
        this.db
          .prepare(
            `SELECT port FROM worktree_preview_processes
              WHERE port BETWEEN ? AND ?
                AND status IN ('pending','starting','ready')`,
          )
          .all(this.portRange.min, this.portRange.max) as Array<{ port: number }>
      ).map((r) => r.port),
    );
    for (let p = this.portRange.min; p <= this.portRange.max; p++) {
      if (!taken.has(p)) return p;
    }
    throw new Error(
      `Preview port pool exhausted: all ports in [${this.portRange.min}, ${this.portRange.max}] are in use`,
    );
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────

function normaliseHealthPath(raw: string | undefined): string {
  const v = (raw ?? '/').trim() || '/';
  return v.startsWith('/') ? v : `/${v}`;
}

/**
 * Compute teardown order — every node appears strictly after all of
 * its dependents. Used by `stopPreview` and `markGroupFailed` so a
 * frontend that talks to a backend goes down first.
 */
function reverseDependencyOrder(handles: ProcessHandle[]): ProcessHandle[] {
  const byName = new Map(handles.map((h) => [h.name, h]));
  const dependents = new Map<string, string[]>();
  for (const h of handles) dependents.set(h.name, []);
  for (const h of handles) {
    for (const dep of h.dependsOn) {
      dependents.get(dep)?.push(h.name);
    }
  }
  const visited = new Set<string>();
  const out: ProcessHandle[] = [];
  const visit = (name: string): void => {
    if (visited.has(name)) return;
    visited.add(name);
    for (const dep of dependents.get(name) ?? []) {
      visit(dep);
    }
    const handle = byName.get(name);
    if (handle) out.push(handle);
  };
  for (const h of handles) visit(h.name);
  // `out` is built post-order across dependents, which means leaves
  // (frontend) end up *before* their dependencies (backend) — exactly
  // the teardown order we want.
  return out;
}

function buildAdjacency(processes: PreviewProcess[]): Map<string, string[]> {
  const adj = new Map<string, string[]>();
  for (const p of processes) adj.set(p.name, []);
  for (const p of processes) {
    for (const dep of p.dependsOn ?? []) {
      adj.get(dep)?.push(p.name);
    }
  }
  return adj;
}

/**
 * Exported so the path-traversal containment can be tested directly
 * (and so anyone touching the rules can see what behaviour the tests
 * pin). Internal callers continue to use the un-prefixed local binding.
 */
export const __test_resolveProcessCwd = (worktreePath: string, cwd: string | undefined): string =>
  resolveProcessCwd(worktreePath, cwd);

function resolveProcessCwd(worktreePath: string, cwd: string | undefined): string {
  if (!cwd) return worktreePath;
  if (cwd.startsWith('/')) {
    // Absolute paths are rejected per the contract — degrade to the
    // worktree root so a misconfigured project still tries to boot
    // rather than throwing inside spawn.
    return worktreePath;
  }
  // Relative `..` traversal can still escape the worktree (e.g.
  // `cwd: "../escape"` → `/wt/../escape`). Normalise then verify the
  // result is contained — same containment rule we apply to envFile so
  // a stray `..` segment doesn't silently spawn outside the worktree.
  const joined = path.posix.join(worktreePath, cwd);
  const resolved = path.posix.normalize(joined);
  if (resolved !== worktreePath && !resolved.startsWith(worktreePath + path.posix.sep)) {
    return worktreePath;
  }
  return resolved;
}

/**
 * Read a dotenv-shaped file from disk. Returns `{}` on missing /
 * unreadable / malformed input — `envFile` is a hint, never a hard
 * dependency. Supports `KEY=VALUE`, `KEY="value"`, `# comment`, and
 * trailing whitespace; no multi-line / expansion support (matches the
 * smaller surface preview-secrets-store uses internally).
 */
/** Test-only re-export — see `__test_resolveProcessCwd` for rationale. */
export const __test_defaultReadEnvFile = (
  worktreePath: string,
  relPath: string,
): Record<string, string> => defaultReadEnvFile(worktreePath, relPath);

function defaultReadEnvFile(worktreePath: string, relPath: string): Record<string, string> {
  // Defensive — refuse path traversal so an `envFile: "../../../etc/passwd"`
  // can't escape the worktree.
  //
  // Naive `startsWith(worktreePath)` is unsafe when the worktree name is
  // a prefix of a sibling (`/wt` vs `/wt-secrets`): `..` traversal that
  // lands on a sibling sharing the leading bytes would pass the check
  // even though it's outside the worktree. Require equality OR a
  // following path separator so only true descendants are accepted.
  const resolved = path.posix.normalize(path.posix.join(worktreePath, relPath));
  if (resolved !== worktreePath && !resolved.startsWith(worktreePath + path.posix.sep)) {
    return {};
  }
  if (!existsSync(resolved)) return {};
  try {
    const raw = readFileSync(resolved, 'utf8');
    const out: Record<string, string> = {};
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}
