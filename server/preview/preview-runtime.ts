/**
 * Worktree preview runtime.
 *
 * Spawns a project-configured preview process (`npm run dev`, Vite,
 * Storybook, etc.) inside the active session's git worktree, allocates
 * a host port for it, polls the configured `healthPath` until the
 * server reports ready, and tracks the lifecycle in the
 * `worktree_previews` table. Reaping (idle TTL, session-end) is owned
 * by `preview-reaper.ts` plus the session-delete hook in
 * `routes/sessions.ts`; this module only owns the per-preview
 * start/stop/touch contract.
 *
 * Design notes:
 *
 *   - **One active preview per session.** Calling `startPreview()` twice
 *     for the same session is the documented restart path: the prior
 *     row is stopped + freed before the new one is spawned, preventing
 *     the port-leak that would otherwise stack across calls.
 *
 *   - **Port allocation is local.** We don't reuse the PR-env
 *     `pr_env_ports` table — different keying, different lifetime (see
 *     `preview-schema.ts` for the trade-off). The allocator scans
 *     `worktree_previews.port` for the lowest free port in the
 *     configured range; the `UNIQUE(port)` constraint plus a bounded
 *     retry handles the rare race where two concurrent starts pick the
 *     same gap.
 *
 *   - **All IO is injectable.** `spawn`, `fetch`, `clock`, and the log
 *     writer all flow through the constructor. Tests pass in fakes; the
 *     real production wiring lives at the bottom of the file.
 *
 *   - **Health-check loop.** Polls `healthPath` (default `/`) up to the
 *     configured deadline (default 30 s) at 500 ms cadence. Any 2xx
 *     flips the row to `ready`. Timeout flips it to `failed` and
 *     captures the first 50 lines of stdout/stderr from the spawned
 *     process for debugging.
 *
 *   - **Log tail.** stdout + stderr are streamed to a per-preview log
 *     file under the data directory (`previews/<previewId>.log`). The
 *     first 50 lines are also kept in memory so a `failed` status
 *     surfaces immediately without a disk read.
 */

import type { Database } from 'better-sqlite3';
import type { ChildProcess, SpawnOptions } from 'child_process';
import { randomUUID } from 'crypto';
import { WORKTREE_PREVIEWS_SCHEMA, DEFAULT_PREVIEW_PORT_RANGE } from './preview-schema.js';
import type { PrEnvPreviewConfig, Project } from '../types.js';

// ─── Types & contracts ──────────────────────────────────────────────────

export interface PortRange {
  readonly min: number;
  readonly max: number;
}

export type PreviewStatus = 'starting' | 'ready' | 'failed';

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
  /** Open a fresh log buffer for `previewId`. Returns its on-disk path (or null). */
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
  /** Max ms to wait for the health check before flipping to `failed`. Default 30000. */
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
   *
   * Wired in production to `loadProjectEnvForSpawn` from
   * `preview-secrets-store.ts` — that path also appends an audit row
   * recording which keys were read. Tests inject a deterministic fake
   * to assert the merge order without hitting the secrets store.
   *
   * When omitted, the runtime preserves the historical behaviour:
   * `{ ...process.env, PORT }` only. This keeps existing tests that
   * construct a `PreviewRuntime` without the dep green.
   */
  loadProjectEnv?: (projectId: string, ctx: { sessionId: string }) => Record<string, string>;
}

// ─── Constants ──────────────────────────────────────────────────────────

const DEFAULT_HEALTH_TIMEOUT_MS = 30_000;
const DEFAULT_HEALTH_INTERVAL_MS = 500;
const DEFAULT_LOG_TAIL_LINES = 50;
const DEFAULT_PREVIEW_CWD = 'client';
const DEFAULT_START_SCRIPT = 'npm run dev';

// ─── Implementation ─────────────────────────────────────────────────────

/**
 * Runtime for booting + tearing down per-session preview processes.
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

  /**
   * Live `ChildProcess` handles keyed by previewId. Kept off the DB
   * because PIDs aren't a reliable pointer once a process exits — the
   * row tracks the *desired* state, this map tracks the *running*
   * handle so we can SIGTERM it.
   */
  private readonly procs = new Map<string, ChildProcess>();

  /** First N stdout/stderr lines per preview, surfaced on `failed`. */
  private readonly logTails = new Map<string, string[]>();

  /**
   * Per-session serialization lock. Prevents two concurrent `startPreview`
   * calls for the same session from both observing `getActiveBySessionId`
   * return null and each independently allocating a port + spawning.
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
    if (this.portRange.min > this.portRange.max) {
      throw new Error(`Invalid preview port range: ${this.portRange.min}..${this.portRange.max}`);
    }
    this.db.exec(WORKTREE_PREVIEWS_SCHEMA);
  }

  // ─── Public API ───────────────────────────────────────────────────────

  /**
   * Boot a preview process inside `worktreePath` for `sessionId`. If a
   * preview already exists for the session, it is stopped + replaced.
   * Resolves once the row has been inserted in `starting` and the
   * process spawned; the health-check runs in the background and flips
   * the status to `ready` or `failed`. Callers that need the final
   * status should poll `getById(previewId)`.
   *
   * Calls for the same `sessionId` are serialized via an in-memory lock
   * so two concurrent invocations can't each observe `getActiveBySessionId`
   * returning null and independently allocate + spawn.
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

  /**
   * Serialized start implementation. Called exclusively from within
   * `withSessionLock` so at most one instance runs per session at a time.
   */
  private async _startPreview(
    sessionId: string,
    project: Project,
    worktreePath: string,
  ): Promise<StartPreviewResult> {
    // Replace-on-restart: kill any existing preview for this session
    // before allocating a new port. Skipping this step would leak the
    // prior port + child process on every chat reload.
    const existing = this.getActiveBySessionId(sessionId);
    if (existing) {
      await this.stopPreview(existing.id);
    }

    const previewCfg: PrEnvPreviewConfig = project.prEnv?.preview ?? { enabled: false };
    const startScript = (
      previewCfg.startScript ??
      project.prEnv?.startScript ??
      DEFAULT_START_SCRIPT
    ).trim();
    const previewCwd = resolvePreviewCwd(worktreePath, project);
    const healthPath = (project.prEnv?.healthPath ?? '/').trim() || '/';

    // Allocate a port and insert the `starting` row. Up to 3 attempts
    // handle the rare UNIQUE(port) race where two concurrent starts pick
    // the same gap in the port range.
    const { port, previewId, url: rootUrl, sink } = this.insertStartingRow(sessionId, project.id);

    const appendTail = (chunk: string): void => {
      const tail = this.logTails.get(previewId);
      if (!tail) return;
      const lines = chunk.split('\n').filter((l) => l.length > 0);
      for (const line of lines) {
        if (tail.length >= this.logTailLines) break;
        tail.push(line);
      }
      sink.append(chunk);
    };

    // Merge order: process.env → project preview secrets → { PORT }.
    // PORT is appended last so a malicious / accidental PORT entry in
    // the project secrets cannot redirect the dev server off the port
    // the runtime allocated (which would deadlock the health check
    // forever waiting on the wrong port).
    let projectEnv: Record<string, string> = {};
    if (this.loadProjectEnv) {
      try {
        projectEnv = this.loadProjectEnv(project.id, { sessionId });
      } catch (err) {
        // Secrets fetch failing must not block preview boot — log and
        // fall through with an empty merge. The runtime is still
        // useful without per-project env (the historical behaviour).
        this.logger.warn(
          `[preview ${previewId}] loadProjectEnv failed: ${(err as Error).message} (continuing without project env)`,
        );
      }
    }
    const spawnEnv: NodeJS.ProcessEnv = {
      ...process.env,
      ...projectEnv,
      PORT: String(port),
    };

    let child: ChildProcess;
    try {
      child = this.spawn('sh', ['-c', startScript], {
        cwd: previewCwd,
        env: spawnEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
        // detached: true puts the child in its own process group (pgid ==
        // child.pid). killGroup() then sends signals to the whole group,
        // so npm → node → vite all receive SIGTERM simultaneously rather
        // than relying on sh to forward the signal to its children.
        detached: true,
      });
    } catch (err) {
      // Spawn threw synchronously — the child was never registered in
      // `procs`, so we clean up the row and log tail directly rather
      // than going through markFailed (which would try to kill a
      // non-existent process).
      this.logger.warn(`[preview ${previewId}] spawn failed: ${(err as Error).message}`);
      this.logTails.delete(previewId);
      sink.close?.(); // release any open file handle
      this.db.prepare(`DELETE FROM worktree_previews WHERE id = ?`).run(previewId);
      throw err;
    }

    if (typeof child.pid === 'number') {
      this.db
        .prepare(`UPDATE worktree_previews SET pid = ? WHERE id = ?`)
        .run(child.pid, previewId);
    }
    this.procs.set(previewId, child);

    // Drain stdout/stderr into the log tail. Both streams may be null
    // when the spawn was given `ignore`, but our config above asks for
    // pipes so we treat them as required.
    child.stdout?.on('data', (b: Buffer) => appendTail(b.toString('utf8')));
    child.stderr?.on('data', (b: Buffer) => appendTail(b.toString('utf8')));
    child.on('error', (err) => {
      this.logger.warn(`[preview ${previewId}] child error: ${err.message}`);
      // void-cast: markFailed is async but event handlers can't await.
      // Note: 'error' events don't guarantee exitCode/signalCode are set
      // (e.g. EACCES on spawn), so waitForExit may wait up to 3s for the
      // SIGKILL fallback before the status flip completes.
      void this.markFailed(previewId, `child error: ${err.message}`);
    });
    child.on('exit', (code, signal) => {
      // If the process exits while still in `starting`, surface that as
      // a failure. An exit from `ready` or after `stopPreview` is
      // expected — leave the row alone (stopPreview handles teardown).
      const row = this.getById(previewId);
      if (row && row.status === 'starting') {
        // void-cast: markFailed is async; exitCode is already set so
        // waitForExit resolves immediately — no observable delay.
        void this.markFailed(
          previewId,
          `exited during startup: code=${code} signal=${signal ?? ''}`,
        );
      }
    });

    // Background health-check loop. Resolves the visible URL once 2xx.
    // We deliberately don't await it here — `startPreview` returns the
    // URL immediately so the caller can render an iframe placeholder
    // while the process boots.
    void this.runHealthCheck(
      previewId,
      this.urlBase(port) + (healthPath.startsWith('/') ? healthPath : `/${healthPath}`),
    );

    return { url: rootUrl, port, previewId };
  }

  /**
   * Stop the preview with `previewId`. Idempotent — a no-op when the
   * row is already gone. Sends SIGTERM, **awaits the child's exit** (with
   * a SIGKILL fallback after 3 s), then deletes the row. The await is
   * critical: the OS doesn't release the bound port until the process
   * exits, so deleting the row before exit would let the allocator hand
   * out the port again immediately, causing EADDRINUSE in the replacement
   * `startPreview`.
   */
  async stopPreview(previewId: string): Promise<void> {
    const row = this.getById(previewId);
    if (!row) return;
    const proc = this.procs.get(previewId);
    if (proc && proc.exitCode == null && proc.signalCode == null) {
      // Kill the entire process group (shell + npm + node + vite) so no
      // grandchild keeps the port bound after the shell exits.
      this.killGroup(proc, 'SIGTERM');
      // Wait for the OS to actually release the socket before we free
      // the port row — prevents EADDRINUSE in the next allocatePort().
      await this.waitForExit(proc);
    }
    this.procs.delete(previewId);
    this.logTails.delete(previewId);
    // Atomic delete — the port row is removed in the same statement so
    // the next allocator pass sees the gap.
    this.db.prepare(`DELETE FROM worktree_previews WHERE id = ?`).run(previewId);
  }

  /**
   * Resolve once `proc` has exited. If it hasn't exited within `graceMs`
   * (default 3 s), a SIGKILL is sent as a fallback before resolving.
   * Returns immediately if the process has already exited.
   */
  private waitForExit(proc: ChildProcess, graceMs = 3_000): Promise<void> {
    // exitCode / signalCode are set by Node only after the process has
    // actually terminated — non-null means it's already gone.
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
   * and `process.kill(-pid, signal)` reaches every grandchild (npm →
   * node → vite) simultaneously — no reliance on the shell forwarding
   * the signal to its children. Falls back to `proc.kill(signal)` when
   * the process group is already gone (ESRCH) or the pid is unknown.
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
   * Stop every active preview belonging to `sessionId`. Used by the
   * session-delete hook so an archived session doesn't leave a dev
   * server running. Includes 'failed' rows so zombied port rows are
   * cleaned up on session end. Returns the number of rows torn down.
   */
  async stopBySessionId(sessionId: string): Promise<number> {
    const rows = this.db
      .prepare(
        `SELECT id FROM worktree_previews
          WHERE session_id = ? AND status IN ('starting','ready','failed')`,
      )
      .all(sessionId) as Array<{ id: string }>;
    for (const r of rows) {
      await this.stopPreview(r.id);
    }
    return rows.length;
  }

  /**
   * Bump `last_active_at` so the reaper's idle-TTL clock resets. Wired
   * from chat activity in `chat.ts`. No-op on unknown previews so the
   * caller doesn't need to gate on existence.
   */
  touchPreview(previewId: string): void {
    this.db
      .prepare(
        `UPDATE worktree_previews
            SET last_active_at = datetime('now')
          WHERE id = ? AND status IN ('starting','ready')`,
      )
      .run(previewId);
  }

  /**
   * Active (non-stopped) preview for `sessionId`, or null. Includes
   * 'failed' rows so the replace-on-restart guard in `startPreview` can
   * sweep a failed row's port before allocating a new one — otherwise a
   * session that spams restarts with a broken `startScript` could stack
   * multiple failed rows that `markFailed` has already freed from the
   * allocator but not yet cleaned from the table.
   */
  getActiveBySessionId(sessionId: string): PreviewRow | null {
    const row = this.db
      .prepare(
        `SELECT * FROM worktree_previews
          WHERE session_id = ? AND status IN ('starting','ready','failed')
          ORDER BY started_at DESC
          LIMIT 1`,
      )
      .get(sessionId) as PreviewRow | undefined;
    return row ?? null;
  }

  /** Single row by id. Used by tests and the log-tail debug API. */
  getById(previewId: string): PreviewRow | null {
    const row = this.db.prepare(`SELECT * FROM worktree_previews WHERE id = ?`).get(previewId) as
      | PreviewRow
      | undefined;
    return row ?? null;
  }

  /** First N captured log lines for a preview — for boot-failure debugging. */
  getLogTail(previewId: string): string[] {
    return [...(this.logTails.get(previewId) ?? [])];
  }

  // ─── Internals ────────────────────────────────────────────────────────

  /**
   * Serialize async work for a given `sessionId`. Calls for the same
   * session queue behind each other; calls for different sessions run
   * in parallel. Errors in one call do not block subsequent calls for
   * the same session. The lock entry is removed once the queue is drained
   * to prevent unbounded Map growth.
   */
  private async withSessionLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    const prior = this.sessionLocks.get(sessionId) ?? Promise.resolve();
    // settled resolves regardless of whether prior rejected — errors in
    // one start don't prevent the next start from running.
    const settled = prior.catch(() => {});
    const next = settled.then(() => fn());
    const nextSettled = next.catch(() => {});
    this.sessionLocks.set(sessionId, nextSettled);
    try {
      return await next;
    } finally {
      // Clean up the map entry when no subsequent caller has queued
      // behind us — avoids unbounded growth on long-lived sessions.
      if (this.sessionLocks.get(sessionId) === nextSettled) {
        this.sessionLocks.delete(sessionId);
      }
    }
  }

  /**
   * Allocate a port, open a log sink, insert a `starting` row, and return
   * all three. Retries up to 3 times on a UNIQUE(port) conflict — the rare
   * race where two concurrent `startPreview` calls pick the same gap.
   */
  private insertStartingRow(
    sessionId: string,
    projectId: string,
  ): { previewId: string; port: number; url: string; sink: ReturnType<PreviewLogSink['open']> } {
    const MAX_ATTEMPTS = 3;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const port = this.allocatePort();
      const previewId = randomUUID();
      const url = this.urlBase(port);
      const sink = this.logSink.open(previewId);
      this.logTails.set(previewId, []);
      try {
        this.db
          .prepare(
            `INSERT INTO worktree_previews
               (id, session_id, project_id, pid, port, url, log_path, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'starting')`,
          )
          .run(previewId, sessionId, projectId, null, port, url, sink.path);
        return { previewId, port, url, sink };
      } catch (err: unknown) {
        // Roll back the in-memory state for this attempt before retrying.
        this.logTails.delete(previewId);
        sink.close?.(); // release any open file handle to avoid fd leaks
        if (
          attempt < MAX_ATTEMPTS - 1 &&
          (err as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE'
        ) {
          this.logger.warn(`[preview] port ${port} conflict on attempt ${attempt + 1}, retrying`);
          // If the conflicting row is 'failed' (port held only by the UNIQUE
          // constraint — its process was already killed by markFailed), delete
          // it so the port is immediately reclaimable. Without this, a failed
          // row from any session poisons that port slot for up to idleTTL (600 s)
          // because allocatePort() excludes only 'starting'/'ready' rows yet the
          // UNIQUE constraint still rejects an INSERT against a 'failed' row.
          const conflicting = this.db
            .prepare(`SELECT id, status FROM worktree_previews WHERE port = ?`)
            .get(port) as { id: string; status: string } | undefined;
          if (conflicting?.status === 'failed') {
            this.db.prepare(`DELETE FROM worktree_previews WHERE id = ?`).run(conflicting.id);
          }
          continue;
        }
        throw err;
      }
    }
    // Unreachable — the loop always returns or throws within MAX_ATTEMPTS.
    throw new Error('unreachable: port retry loop exited without returning');
  }

  /**
   * Lowest-free-port allocator. Scans `worktree_previews` for occupied
   * ports in the configured range and returns the first gap. Only
   * 'starting' and 'ready' rows are considered taken — 'failed' rows have
   * had their process killed (see `markFailed`) so their port is available
   * for immediate reuse.
   */
  private allocatePort(): number {
    const taken = new Set(
      (
        this.db
          .prepare(
            `SELECT port FROM worktree_previews
              WHERE port BETWEEN ? AND ?
                AND status IN ('starting', 'ready')`,
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

  /**
   * Poll `healthUrl` until 2xx or `healthTimeoutMs` elapses. On
   * success flips status → `ready`; on timeout flips → `failed` and
   * stores the captured log tail in the row's `last_active_at`-adjacent
   * status field for the API to surface. Never throws — operational
   * errors (fetch reject, network reset) keep the loop running so a
   * slow boot still wins.
   */
  private async runHealthCheck(previewId: string, healthUrl: string): Promise<void> {
    const deadline = this.clock.nowMs() + this.healthTimeoutMs;
    while (this.clock.nowMs() < deadline) {
      const row = this.getById(previewId);
      // Caller stopped the preview while we were polling — bail out.
      if (!row || row.status !== 'starting') return;
      try {
        const res = await this.fetch(healthUrl);
        if (res.ok) {
          this.db
            .prepare(
              `UPDATE worktree_previews
                  SET status = 'ready',
                      last_active_at = datetime('now')
                WHERE id = ? AND status = 'starting'`,
            )
            .run(previewId);
          return;
        }
      } catch {
        // ignore — preview process may not have bound the port yet
      }
      await this.clock.sleep(this.healthIntervalMs);
    }
    // Deadline blown. Mark failed and surface the log tail in the
    // logger so operators see why without grepping.
    const tail = this.getLogTail(previewId).slice(0, this.logTailLines).join('\n');
    await this.markFailed(previewId, `health check timed out after ${this.healthTimeoutMs}ms`);
    this.logger.warn(
      `[preview ${previewId}] failed health check; first ${this.logTailLines} log line(s):\n${tail}`,
    );
  }

  private async markFailed(previewId: string, reason: string): Promise<void> {
    if (!this.getById(previewId)) return; // already deleted (e.g. concurrent stopPreview)
    const proc = this.procs.get(previewId);
    if (proc && proc.exitCode == null && proc.signalCode == null) {
      // Kill the entire process group so no grandchild keeps the port bound.
      this.killGroup(proc, 'SIGTERM');
      // Await actual process exit before flipping status to 'failed'.
      // allocatePort() excludes 'starting'/'ready' rows, so the port
      // stays "taken" until we update the row below — ensuring the port
      // is genuinely released (OS socket closed) before any replacement
      // startPreview can claim it.
      await this.waitForExit(proc);
    }
    this.procs.delete(previewId);
    // logTails is kept — the tail is still useful for debugging the
    // failed status via getLogTail().
    this.db
      .prepare(
        `UPDATE worktree_previews
            SET status = 'failed',
                last_active_at = datetime('now')
          WHERE id = ? AND status IN ('starting','ready')`,
      )
      .run(previewId);
    this.logger.warn(`[preview ${previewId}] ${reason}`);
  }
}

// ─── Path resolution ────────────────────────────────────────────────────

/**
 * Resolve the cwd for the spawned preview process. Default is `<worktree>/client`
 * (matching the most common Vite/CRA layout in Agent-Hub-managed
 * projects); the project may override via `prEnv.preview.startScript`
 * which is interpreted relative to the worktree root.
 *
 * Note: the cwd selection is intentionally simple — the spec calls for
 * a `client` default with override via the start-script semantics.
 * Anything fancier (per-project preview-cwd field) is a follow-up.
 */
function resolvePreviewCwd(worktreePath: string, _project: Project): string {
  // We default to <worktree>/<DEFAULT_PREVIEW_CWD>. If the project's
  // start script is an absolute path or contains a shell `cd`, that's
  // user-supplied and runs from the worktree root via the `sh -c`
  // wrapper above; falling through to <worktree>/client is the
  // documented default.
  return joinPosix(worktreePath, DEFAULT_PREVIEW_CWD);
}

/** Tiny POSIX-style join that doesn't pull in `path` (keeps the unit test surface small). */
function joinPosix(a: string, b: string): string {
  if (!b) return a;
  if (b.startsWith('/')) return b;
  return a.endsWith('/') ? a + b : `${a}/${b}`;
}
