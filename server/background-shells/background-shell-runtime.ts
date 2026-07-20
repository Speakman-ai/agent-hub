/**
 * Background shell runtime.
 *
 * Hub-owned lifecycle for long-running shell commands that must survive
 * past the chat turn that launched them. This is the durable answer to
 * "background Bash can't be monitored after the turn ends":
 *
 *   - Claude Code's own `run_in_background` shell is a grandchild of the
 *     per-turn CLI process (`server/chat.ts` spawns a fresh, detached CLI
 *     every turn and `killProcessGroup`s it on turn end). Its `BashOutput`
 *     registry lives *inside* that CLI process, so the next turn's fresh
 *     CLI can neither poll nor reap it.
 *   - This runtime moves process ownership into the **Hub**, which is a
 *     single long-lived server process. A shell started in turn N is still
 *     in this runtime's in-memory handle map (and its `background_shells`
 *     row) in turn N+1, so `status` / `logs` / `stop` work across turns.
 *
 * Reaping is owned by the caller (session-delete / archive hook in
 * `routes/sessions.ts`), which calls {@link BackgroundShellRuntime.stopBySessionId}.
 * This mirrors how `preview-runtime.ts` delegates session-end teardown.
 *
 * Distinct from the older `background_tasks` table / `BackgroundTaskRow`
 * (async agent prompt turns) — this owns real OS shell processes.
 *
 * Design notes:
 *   - **All IO is injectable.** `spawn`, the log sink, `kill`, `clock`, and
 *     the WebSocket `broadcast` all flow through the constructor so tests
 *     inject fakes without touching the OS or `vi.mock('child_process')`.
 *   - **Own process group.** Children are spawned `detached: true` so
 *     `kill(-pid)` reaches the whole shell → grandchild tree on stop.
 *   - **Status model.** `running → exited` (code 0) | `failed` (code ≠ 0
 *     or spawn/child error) | `stopped` (we SIGTERMed it). A row never
 *     leaves a terminal status.
 */

import type { Database } from 'better-sqlite3';
import type { ChildProcess, SpawnOptions } from 'child_process';
import { execFileSync } from 'child_process';
import { randomUUID } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { BACKGROUND_SHELLS_SCHEMA } from './background-shell-schema.js';

/**
 * Default `/proc/<pid>/cmdline` reader for the boot-orphan reaper. argv is
 * NUL-separated in procfs, so preserve each argument as a separate value for
 * the PID-reuse identity check. Returns `null` when the process is gone /
 * unreadable or the platform has no `/proc` (e.g. macOS).
 */
function defaultReadProcArgv(pid: number): string[] | null {
  try {
    const argv = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
    if (argv.at(-1) === '') argv.pop();
    return argv;
  } catch {
    return null;
  }
}

/**
 * Read a process-instance token that remains stable across exec. Linux uses
 * the kernel start-time field; macOS falls back to ps(1)'s full start time.
 */
function defaultReadProcStartTime(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const close = stat.lastIndexOf(')');
    if (close < 0) return null;
    // Field 3 starts immediately after the comm field; field 22 is index 19.
    return (
      stat
        .slice(close + 2)
        .trim()
        .split(/\s+/)[19] ?? null
    );
  } catch {
    // Continue to the portable fallback below when /proc is unavailable.
  }
  if (existsSync('/proc')) return null;
  try {
    const start = execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return start || null;
  } catch {
    return null;
  }
}

/**
 * Probe whether the process group led by `pid` is still alive via the
 * signal-0 `kill(-pid, 0)` trick: it delivers no signal but performs the
 * existence/permission check. ESRCH ⇒ gone; EPERM ⇒ alive but not ours.
 */
function defaultProbeGroupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

// ─── Types & contracts ──────────────────────────────────────────────────

/**
 * Terminal + live statuses:
 *   - `running`  — process is alive.
 *   - `exited`   — process exited on its own with code 0.
 *   - `failed`   — process exited non-zero, or spawn/child errored.
 *   - `stopped`  — the runtime SIGTERMed it (stop / session reap).
 */
export type BackgroundShellStatus = 'running' | 'exited' | 'failed' | 'stopped';

/** Persisted row shape, surfaced by the REST + wrapper surfaces. */
export interface BackgroundShellRow {
  id: string;
  session_id: string;
  project_id: string;
  command: string;
  label: string | null;
  cwd: string | null;
  pid: number | null;
  pid_start_time: string | null;
  status: BackgroundShellStatus;
  exit_code: number | null;
  log_path: string | null;
  created_at: string;
  updated_at: string;
}

export interface StartBackgroundShellInput {
  sessionId: string;
  projectId: string;
  /** Shell command run via `sh -c`. */
  command: string;
  /** Absolute cwd for the child (typically the session worktree root). */
  cwd: string;
  /** Optional human label surfaced in the UI / wrapper output. */
  label?: string | null;
}

/**
 * Minimal `child_process.spawn`-shaped surface. Keeps the runtime
 * decoupled from the real Node import so tests inject a fake without
 * `vi.mock('child_process', …)`.
 */
export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

/** Tiny clock so tests can control timestamps deterministically. */
export interface Clock {
  nowIso(): string;
}

export const systemClock: Clock = {
  nowIso: () => new Date().toISOString(),
};

/**
 * Where stdout/stderr are persisted. Production wraps Node's `fs`; tests
 * inject an in-memory accumulator. Mirrors `preview-runtime`'s sink.
 */
export interface BackgroundShellLogSink {
  /** Open a fresh log buffer for `shellId`. `path` is null for in-memory sinks. */
  open(shellId: string): {
    path: string | null;
    append: (chunk: string) => void;
    close?: () => void;
  };
  /** Read persisted output after an in-memory handle has been evicted. */
  read?: (logPath: string, limit?: number) => string[];
}

export type BackgroundShellBroadcast = (event: {
  type: 'background_shell_update';
  sessionId: string;
  shell: BackgroundShellRow;
}) => void;

type OrphanReapResult = 'reaped' | 'already-gone' | 'unverified';

export interface BackgroundShellRuntimeConfig {
  /** Lines retained in the in-memory tail per shell. Default 500. */
  logTailLines?: number;
  /** Grace ms between SIGTERM and SIGKILL on stop. Default 3000. */
  killGraceMs?: number;
}

export interface BackgroundShellRuntimeDeps {
  db: Database;
  spawn: SpawnFn;
  logSink: BackgroundShellLogSink;
  clock?: Clock;
  config?: BackgroundShellRuntimeConfig;
  broadcast?: BackgroundShellBroadcast;
  logger?: { log: (m: string) => void; warn: (m: string) => void; error: (m: string) => void };
  /**
   * Send a signal to a process or process group. Defaults to `process.kill`.
   * Injected so tests can record calls without touching real OS process groups.
   */
  kill?: (target: number, signal: NodeJS.Signals) => void;
  /**
   * Read a process's argv for the boot-orphan reaper's PID-reuse guard.
   * Returns structured `/proc/<pid>/cmdline` argv on Linux, or `null` when the
   * process is gone / unreadable / the platform has no `/proc` (macOS).
   * Injected so tests exercise the reuse guard without a real process.
   */
  readProcArgv?: (pid: number) => string[] | null;
  /** Read the process-instance identity used to guard PID reuse. */
  readProcStartTime?: (pid: number) => string | null;
  /**
   * Report whether the process group led by `pid` is still alive — used by
   * the boot-orphan reaper to decide whether SIGTERM needs to escalate to
   * SIGKILL. Defaults to a `kill(-pid, 0)` probe. Injected so tests can model
   * a process that ignores SIGTERM.
   */
  probeGroupAlive?: (pid: number) => boolean;
}

// ─── Constants ──────────────────────────────────────────────────────────

const DEFAULT_LOG_TAIL_LINES = 500;
const DEFAULT_KILL_GRACE_MS = 3_000;
const NATURAL_EXIT_POLL_MS = 100;

// ─── Implementation ─────────────────────────────────────────────────────

/**
 * In-memory record for a live shell. Wraps the DB row's identity with the
 * `ChildProcess` handle and the log tail buffer, neither of which is
 * durable so both stay off the DB.
 */
interface ShellHandle {
  id: string;
  sessionId: string;
  child: ChildProcess | null;
  tail: string[];
  sinkClose?: () => void;
  /** Guards double-finalization (exit racing stop). */
  finalized: boolean;
  /**
   * Set by `stop()` before it signals the child. The exit event that our own
   * SIGTERM triggers then records `stopped` instead of `failed`, so an
   * operator-initiated stop is never misreported as a crash.
   */
  stopping: boolean;
  naturalExitTimer?: NodeJS.Timeout;
}

export class BackgroundShellRuntime {
  private readonly db: Database;
  private readonly spawn: SpawnFn;
  private readonly logSink: BackgroundShellLogSink;
  private readonly clock: Clock;
  private readonly logTailLines: number;
  private readonly killGraceMs: number;
  private readonly broadcast: BackgroundShellBroadcast | null;
  private readonly logger: NonNullable<BackgroundShellRuntimeDeps['logger']>;
  private readonly kill: (target: number, signal: NodeJS.Signals) => void;
  private readonly readProcArgv: (pid: number) => string[] | null;
  private readonly readProcStartTime: (pid: number) => string | null;
  private readonly probeGroupAlive: (pid: number) => boolean;

  /**
   * Resolves once the boot-orphan reconcile has finished reaping + finalizing
   * rows left `running` by a prior Hub process. Exposed so tests (and any
   * future graceful-shutdown coordination) can await the escalating reap
   * rather than racing it.
   */
  readonly bootReconcile: Promise<void>;

  /** Live handles keyed by shell id. Populated on start, pruned on terminal status. */
  private readonly handles = new Map<string, ShellHandle>();

  constructor(deps: BackgroundShellRuntimeDeps) {
    this.db = deps.db;
    this.spawn = deps.spawn;
    this.logSink = deps.logSink;
    this.clock = deps.clock ?? systemClock;
    this.logTailLines = deps.config?.logTailLines ?? DEFAULT_LOG_TAIL_LINES;
    this.killGraceMs = deps.config?.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
    this.broadcast = deps.broadcast ?? null;
    this.logger = deps.logger ?? {
      log: (m) => console.log(m),
      warn: (m) => console.warn(m),
      error: (m) => console.error(m),
    };
    this.kill = deps.kill ?? ((t, s) => process.kill(t, s));
    this.readProcArgv = deps.readProcArgv ?? defaultReadProcArgv;
    this.readProcStartTime = deps.readProcStartTime ?? defaultReadProcStartTime;
    this.probeGroupAlive = deps.probeGroupAlive ?? defaultProbeGroupAlive;
    // Apply schema so a caller can pass a hand-built DB (tests) without a
    // separate init step — same convention as PreviewRuntime.
    this.db.exec(BACKGROUND_SHELLS_SCHEMA);
    this.ensurePidStartTimeColumn();
    // A prior Hub process may have left rows marked `running` whose detached
    // children can still be alive. Reap them (escalating SIGTERM→SIGKILL) and
    // only then flip the row terminal. Runs in the background so it never
    // blocks server startup; `bootReconcile` resolves when it's done.
    this.bootReconcile = this.reconcileOrphansOnBoot();
  }

  // ─── Public API ───────────────────────────────────────────────────────

  /**
   * Spawn a detached background shell, persist its row as `running`, and
   * wire stdout/stderr into the log tail + sink. Returns the inserted row.
   * Never throws for a normal spawn failure — the row is inserted `failed`
   * and returned so the caller/UI can surface the error.
   */
  start(input: StartBackgroundShellInput): BackgroundShellRow {
    const id = randomUUID();
    const now = this.clock.nowIso();
    const label = input.label?.trim() ? input.label.trim() : null;
    const sink = this.logSink.open(id);
    this.db
      .prepare(
        `INSERT INTO background_shells
           (id, session_id, project_id, command, label, cwd, pid, status, exit_code, log_path, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, 'running', NULL, ?, ?, ?)`,
      )
      .run(
        id,
        input.sessionId,
        input.projectId,
        input.command,
        label,
        input.cwd,
        sink.path,
        now,
        now,
      );

    const handle: ShellHandle = {
      id,
      sessionId: input.sessionId,
      child: null,
      tail: [],
      sinkClose: sink.close,
      finalized: false,
      stopping: false,
    };
    this.handles.set(id, handle);

    const append = (chunk: string): void => {
      for (const line of chunk.split('\n')) {
        if (line.length === 0) continue;
        handle.tail.push(line);
        if (handle.tail.length > this.logTailLines) {
          handle.tail.splice(0, handle.tail.length - this.logTailLines);
        }
      }
      sink.append(chunk);
    };

    let child: ChildProcess;
    try {
      child = this.spawn('sh', ['-c', input.command], {
        cwd: input.cwd,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        // Own process-group leader so `kill(-pid)` reaches the whole tree.
        detached: true,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.logger.warn(`[bg-shell ${id}] spawn failed: ${reason}`);
      append(`[agent-hub] spawn failed: ${reason}\n`);
      this.finalize(handle, 'failed', null);
      return this.getById(id)!;
    }

    handle.child = child;
    if (typeof child.pid === 'number') {
      this.db
        .prepare(`UPDATE background_shells SET pid = ?, pid_start_time = ? WHERE id = ?`)
        .run(child.pid, this.readProcStartTime(child.pid), id);
    }
    child.stdout?.on('data', (b: Buffer) => append(b.toString('utf8')));
    child.stderr?.on('data', (b: Buffer) => append(b.toString('utf8')));
    child.on('error', (err) => {
      this.logger.warn(`[bg-shell ${id}] child error: ${err.message}`);
      append(`[agent-hub] child error: ${err.message}\n`);
      this.finalize(handle, 'failed', null);
    });
    child.on('exit', (code, signal) => {
      if (handle.finalized) return;
      // `stop()` set `stopping` before signalling — the exit it triggered is
      // an operator stop, not a crash, even though it arrives with a signal.
      if (handle.stopping) {
        // Leave finalization to `stop()` after the entire process group has
        // been reaped. The shell leader can exit while descendants remain.
      } else if (signal) {
        this.monitorNaturalExit(handle, 'failed', null);
      } else {
        this.monitorNaturalExit(handle, code === 0 ? 'exited' : 'failed', code ?? null);
      }
    });

    const row = this.getById(id)!;
    this.emit(row);
    return row;
  }

  /**
   * All shells for a session, newest first. Tie-breaks equal `created_at`
   * (two starts within the same millisecond) on the monotonic `rowid` so
   * ordering is stable insertion order, not random-UUID order.
   */
  list(sessionId: string): BackgroundShellRow[] {
    return this.db
      .prepare(
        `SELECT * FROM background_shells WHERE session_id = ? ORDER BY created_at DESC, rowid DESC`,
      )
      .all(sessionId) as BackgroundShellRow[];
  }

  /** Single shell by id, or null. */
  getById(shellId: string): BackgroundShellRow | null {
    const row = this.db.prepare(`SELECT * FROM background_shells WHERE id = ?`).get(shellId) as
      | BackgroundShellRow
      | undefined;
    return row ?? null;
  }

  /**
   * Log tail (most recent `limit` lines, default all retained). Running shells
   * use their bounded in-memory tail; finalized/prior-process shells use the
   * durable sink so evicting their handles does not lose monitoring output.
   */
  getLogTail(shellId: string, limit?: number): string[] {
    const handle = this.handles.get(shellId);
    if (!handle) {
      const row = this.getById(shellId);
      if (row?.log_path && this.logSink.read) {
        return this.logSink.read(row.log_path, limit);
      }
      return [];
    }
    const tail = handle.tail;
    if (limit != null && limit >= 0 && tail.length > limit) {
      return tail.slice(tail.length - limit);
    }
    return [...tail];
  }

  /**
   * SIGTERM the shell's process group, marking it `stopped`. Idempotent and
   * safe on unknown / already-terminal shells. SIGKILL fallback after the
   * configured grace. Returns the resulting row (or null if unknown).
   */
  async stop(shellId: string): Promise<BackgroundShellRow | null> {
    const handle = this.handles.get(shellId);
    if (!handle) {
      // No live handle — either a prior Hub process or a stop racing boot
      // reconcile. Reap the recorded process group before changing status.
      const row = this.getById(shellId);
      if (row && row.status === 'running') {
        if (row.pid != null) {
          const reapResult = await this.reapOrphanProcessGroup(
            row.pid,
            row.command,
            row.pid_start_time,
          );
          if (reapResult === 'unverified') return row;
        }
        this.db
          .prepare(
            `UPDATE background_shells SET status = 'stopped', updated_at = ? WHERE id = ? AND status = 'running'`,
          )
          .run(this.clock.nowIso(), shellId);
        const updated = this.getById(shellId);
        if (updated) this.emit(updated);
        return updated;
      }
      return row;
    }
    if (handle.finalized) return this.getById(shellId);

    // Signal FIRST, then finalize. `stopping` tells the child's exit handler
    // to record `stopped` (not `failed`) for the signal-triggered exit; the
    // trailing finalize covers the no-child / already-exited case where no
    // exit event will fire.
    const child = handle.child;
    if (child && typeof child.pid === 'number') {
      handle.stopping = true;
      if (handle.naturalExitTimer) clearTimeout(handle.naturalExitTimer);
      this.killGroup(child, 'SIGTERM');
      await this.waitForExit(child);
    }
    if (!handle.finalized) this.finalize(handle, 'stopped', null);
    return this.getById(shellId);
  }

  /**
   * Stop every `running` shell for a session. Used by the session-delete /
   * archive hook. Returns the number of shells stopped.
   */
  async stopBySessionId(sessionId: string): Promise<number> {
    const rows = this.db
      .prepare(`SELECT id FROM background_shells WHERE session_id = ? AND status = 'running'`)
      .all(sessionId) as Array<{ id: string }>;
    for (const r of rows) {
      await this.stop(r.id);
    }
    return rows.length;
  }

  // ─── Internals ────────────────────────────────────────────────────────

  /**
   * Write a terminal status + exit code, prune the in-memory handle, and
   * broadcast the update. Guarded by `handle.finalized` so an exit racing
   * a stop only writes once.
   */
  private finalize(
    handle: ShellHandle,
    status: BackgroundShellStatus,
    exitCode: number | null,
  ): void {
    if (handle.finalized) return;
    handle.finalized = true;
    if (handle.naturalExitTimer) clearTimeout(handle.naturalExitTimer);
    this.db
      .prepare(
        `UPDATE background_shells
            SET status = ?, exit_code = ?, updated_at = ?
          WHERE id = ? AND status = 'running'`,
      )
      .run(status, exitCode, this.clock.nowIso(), handle.id);
    try {
      handle.sinkClose?.();
    } catch {
      // ignore fd-close failures
    }
    handle.child = null;
    const row = this.getById(handle.id);
    if (row) this.emit(row);
    this.handles.delete(handle.id);
  }

  private emit(row: BackgroundShellRow): void {
    if (!this.broadcast) return;
    try {
      this.broadcast({ type: 'background_shell_update', sessionId: row.session_id, shell: row });
    } catch (err) {
      this.logger.warn(
        `[bg-shell ${row.id}] broadcast threw: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private monitorNaturalExit(
    handle: ShellHandle,
    status: Extract<BackgroundShellStatus, 'exited' | 'failed'>,
    exitCode: number | null,
  ): void {
    const check = (): void => {
      if (handle.finalized || handle.stopping) return;
      const pid = handle.child?.pid;
      if (typeof pid !== 'number' || !this.isProcessGroupAlive(pid)) {
        this.finalize(handle, status, exitCode);
        return;
      }
      handle.naturalExitTimer = setTimeout(check, NATURAL_EXIT_POLL_MS);
    };
    check();
  }

  private isProcessGroupAlive(pid: number): boolean {
    try {
      return this.probeGroupAlive(pid);
    } catch {
      return false;
    }
  }

  private ensurePidStartTimeColumn(): void {
    const columns = this.db.prepare(`PRAGMA table_info(background_shells)`).all() as Array<{
      name: string;
    }>;
    if (!columns.some((column) => column.name === 'pid_start_time')) {
      this.db.exec(`ALTER TABLE background_shells ADD COLUMN pid_start_time TEXT`);
    }
  }

  /**
   * On construction, any row still marked `running` belongs to a prior Hub
   * process whose in-memory handle is gone. Those children were spawned
   * `detached`, so they may still be alive (reparented to init) after the
   * restart. We must therefore *reap the OS process group before* flipping
   * the row to a terminal status — otherwise it becomes un-reapable
   * (`stopBySessionId` only selects `running`) and leaks as an orphan.
   *
   * Reaping escalates SIGTERM→SIGKILL with a settle window (the same
   * behaviour as a normal `stop()`), so a child that traps/ignores SIGTERM
   * is still torn down before the row goes terminal. Runs asynchronously so
   * it never blocks the constructor / server startup.
   */
  private async reconcileOrphansOnBoot(): Promise<void> {
    let rows: Array<{
      id: string;
      pid: number | null;
      pid_start_time: string | null;
      command: string;
    }> = [];
    try {
      rows = this.db
        .prepare(
          `SELECT id, pid, pid_start_time, command FROM background_shells WHERE status = 'running'`,
        )
        .all() as typeof rows;
    } catch (err) {
      this.logger.warn(
        `[bg-shell] boot reconcile query failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    const markFailed = this.db.prepare(
      `UPDATE background_shells SET status = 'failed', updated_at = ? WHERE id = ? AND status = 'running'`,
    );
    for (const row of rows) {
      let reapResult: OrphanReapResult = row.pid == null ? 'already-gone' : 'unverified';
      try {
        if (row.pid != null) {
          reapResult = await this.reapOrphanProcessGroup(row.pid, row.command, row.pid_start_time);
        }
      } catch (err) {
        this.logger.warn(
          `[bg-shell] boot reconcile reap failed for ${row.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      if (reapResult === 'unverified') continue;
      // Flip terminal only after the reap has escalated + settled.
      markFailed.run(this.clock.nowIso(), row.id);
      const updated = this.getById(row.id);
      if (updated) this.emit(updated);
    }
  }

  /**
   * Reap a prior-process orphan's process group, escalating SIGTERM→SIGKILL
   * with a settle window so a child that ignores SIGTERM is still killed.
   *
   * Guarded against PID reuse: after a restart the recorded pid may have been
   * recycled to an unrelated process, and signalling `-pid` would hit that
   * innocent group. So when we *can* read the live process's argv
   * (`/proc/<pid>/cmdline` on Linux), require the stored process start time;
   * this remains stable when sh execs a simple command. Legacy rows without a
   * start time require exact structured `sh -c <command>` argv and are not
   * signalled when argv is unreadable, avoiding a reused-pid kill.
   */
  private async reapOrphanProcessGroup(
    pid: number,
    command: string,
    pidStartTime: string | null,
  ): Promise<OrphanReapResult> {
    if (!this.matchesProcessIdentity(pid, command, pidStartTime)) {
      this.logger.warn(
        `[bg-shell] boot reconcile: pid ${pid} identity is unverified or reused; not signalling`,
      );
      return 'unverified';
    }
    if (!this.probeGroupAlive(pid)) return 'already-gone';
    this.trySignalGroup(pid, 'SIGTERM');
    await this.sleep(this.killGraceMs);
    if (this.probeGroupAlive(pid)) {
      // Trapped/ignored SIGTERM — escalate. SIGKILL can't be caught.
      this.trySignalGroup(pid, 'SIGKILL');
      await this.sleep(this.killGraceMs);
      if (this.probeGroupAlive(pid)) return 'unverified';
    }
    return 'reaped';
  }

  private matchesProcessIdentity(
    pid: number,
    command: string,
    pidStartTime: string | null,
  ): boolean {
    if (pidStartTime !== null) {
      // The kernel start time is stable across exec, including sh's optimized
      // exec of simple commands, but changes when the numeric pid is reused.
      return this.readProcStartTime(pid) === pidStartTime;
    }
    // Legacy rows have no process-instance token. Signal only when the old
    // shell argv is exact; if /proc is unavailable, skipping is safer than
    // risking a kill against an unrelated reused pid.
    const argv = this.readProcArgv(pid);
    return argv !== null && this.matchesShellArgv(argv, command);
  }

  private matchesShellArgv(argv: string[], command: string): boolean {
    const executable = argv[0] ?? '';
    return (
      argv.length === 3 &&
      (executable === 'sh' || executable.endsWith('/sh')) &&
      argv[1] === '-c' &&
      argv[2] === command
    );
  }

  /** Best-effort group signal; swallows ESRCH/EPERM (gone or not ours). */
  private trySignalGroup(pid: number, signal: NodeJS.Signals): void {
    try {
      this.kill(-pid, signal);
    } catch {
      // ESRCH / EPERM — nothing to do.
    }
  }

  private sleep(ms: number): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Send `signal` to the entire process group headed by `proc`. Spawned
   * `detached`, so `kill(-pid)` reaches every grandchild.
   */
  private killGroup(proc: ChildProcess, signal: 'SIGTERM' | 'SIGKILL'): void {
    if (typeof proc.pid === 'number') {
      try {
        this.kill(-proc.pid, signal);
        return;
      } catch {
        // ESRCH: group already gone — fall through to direct kill.
      }
    }
    try {
      proc.kill(signal);
    } catch {
      // ignore — process may have already exited
    }
  }

  /**
   * Wait for the entire process group, not just the shell leader. SIGKILLs the
   * group after `killGraceMs` if descendants remain, then resolves
   * unconditionally after a further grace window even if no `exit` event or
   * liveness change arrives. Teardown (`stop` / `stopBySessionId` / session
   * reap) must never hang on a wedged or unresponsive process group — so this
   * *always* settles. The caller finalizes the row as `stopped` afterward.
   */
  private waitForExit(proc: ChildProcess): Promise<void> {
    return new Promise<void>((resolve) => {
      let settled = false;
      const groupAlive = (): boolean => {
        if (typeof proc.pid !== 'number') return false;
        return this.isProcessGroupAlive(proc.pid);
      };
      const onLeaderExit = (): void => {
        if (!groupAlive()) finish();
      };
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(killTimer);
        clearTimeout(giveUpTimer);
        proc.removeListener('exit', onLeaderExit);
        resolve();
      };
      const killTimer = setTimeout(() => {
        if (groupAlive()) {
          this.killGroup(proc, 'SIGKILL');
        } else {
          finish();
        }
      }, this.killGraceMs);
      // Absolute cap: even if SIGKILL yields no `exit` event (uninterruptible
      // sleep, PID namespace quirks, a signal that silently no-ops), stop
      // waiting after the SIGKILL grace + one more window so teardown returns.
      const giveUpTimer = setTimeout(() => {
        this.logger.warn(
          `[bg-shell] waitForExit gave up on pid ${proc.pid ?? '?'} after ${this.killGraceMs * 2}ms; marking stopped anyway`,
        );
        finish();
      }, this.killGraceMs * 2);
      proc.once('exit', onLeaderExit);
      if (proc.exitCode != null || proc.signalCode != null) onLeaderExit();
    });
  }
}
