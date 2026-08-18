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
 * This mirrors how the dev-server runtime delegates session-end teardown.
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
import {
  BACKGROUND_SHELL_DEFAULT_TIMEOUT_MS,
  clampBackgroundShellTimeoutMs,
  formatBackgroundShellTimeoutCap,
} from './background-shell-timeout.js';
import { sanitizeSpawnPythonEnv } from '../spawn-python-env.js';

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
 *   - `timed_out` — the hard wall-clock cap fired and the process group was killed.
 */
export type BackgroundShellStatus = 'running' | 'exited' | 'failed' | 'stopped' | 'timed_out';

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
  /**
   * 1 while the watch loop should wake the session when this shell finishes.
   * Cleared once the wake has been planned (or the watch cancelled), so a
   * shell is never the reason for two wakes.
   */
  watch: number;
  /** When the watch was consumed or cancelled. Null while still armed. */
  watch_resolved_at: string | null;
  /** Wall-clock cap in ms. The Hub SIGTERMs the process group when it fires. */
  timeout_ms: number;
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
  /**
   * Arm the watch loop: when this shell reaches a terminal status the Hub
   * wakes its session with the result instead of leaving it idle forever.
   */
  watch?: boolean;
  /**
   * Wall-clock cap in ms. Clamped to the 30-minute maximum; omitted/invalid
   * values use {@link BACKGROUND_SHELL_DEFAULT_TIMEOUT_MS}.
   */
  timeoutMs?: number;
}

/**
 * Notified whenever a shell reaches a terminal status. The watch coordinator
 * subscribes to this rather than polling, since the runtime already knows the
 * exact moment a process group is gone.
 */
export type BackgroundShellFinalizeListener = (row: BackgroundShellRow) => void;

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
 * inject an in-memory accumulator. Mirrors the dev-server runtime's sink.
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

export type BackgroundShellUpdateEvent = {
  type: 'background_shell_update';
  sessionId: string;
  shell: BackgroundShellRow;
};

/** Incremental stdout/stderr for a live Terminal job tab. */
export type BackgroundShellLogEvent = {
  type: 'background_shell_log';
  sessionId: string;
  shellId: string;
  chunk: string;
};

export type BackgroundShellBroadcast = (
  event: BackgroundShellUpdateEvent | BackgroundShellLogEvent,
) => void;

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
  /**
   * Schedule a one-shot timer. Returns a cancel function. Injected so timeout
   * tests can fire the cap without waiting 30 minutes (or even 50ms).
   */
  schedule?: (fn: () => void, delayMs: number) => () => void;
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
   * Set by `stop()` / the wall-clock cap before signalling the child. The exit
   * event that our own SIGTERM triggers then records `stopped` or `timed_out`
   * instead of `failed`, so an operator-initiated stop is never misreported
   * as a crash.
   */
  stopping: boolean;
  naturalExitTimer?: NodeJS.Timeout;
  cancelTimeout?: () => void;
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
  private readonly schedule: (fn: () => void, delayMs: number) => () => void;

  /**
   * Resolves once the boot-orphan reconcile has finished reaping + finalizing
   * rows left `running` by a prior Hub process. Exposed so tests (and any
   * future graceful-shutdown coordination) can await the escalating reap
   * rather than racing it.
   */
  readonly bootReconcile: Promise<void>;

  /** Live handles keyed by shell id. Populated on start, pruned on terminal status. */
  private readonly handles = new Map<string, ShellHandle>();

  /** Terminal-status subscribers (the watch coordinator). */
  private readonly finalizeListeners = new Set<BackgroundShellFinalizeListener>();

  /**
   * Rows left `running` by a prior Hub process, captured synchronously at
   * construction. `reconcileOrphansOnBoot` flips them terminal asynchronously,
   * so a later reader (the restart auto-resume, which runs on `listen`) cannot
   * recover the list from the table — it races the reap. Snapshot it once.
   */
  private readonly bootOrphans: readonly BackgroundShellRow[];

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
    this.schedule =
      deps.schedule ??
      ((fn, delayMs) => {
        const timer = setTimeout(fn, delayMs);
        timer.unref?.();
        return () => clearTimeout(timer);
      });
    // Apply schema so a caller can pass a hand-built DB (tests) without a
    // separate init step — same convention as other managed runtimes.
    this.db.exec(BACKGROUND_SHELLS_SCHEMA);
    this.ensurePidStartTimeColumn();
    this.ensureWatchColumns();
    this.ensureTimeoutColumn();
    this.bootOrphans = this.readBootOrphans();
    // A prior Hub process may have left rows marked `running` whose detached
    // children can still be alive. Reap them (escalating SIGTERM→SIGKILL) and
    // only then flip the row terminal. Runs in the background so it never
    // blocks server startup; `bootReconcile` resolves when it's done.
    this.bootReconcile = this.reconcileOrphansOnBoot();
  }

  // ─── Public API ───────────────────────────────────────────────────────

  /**
   * Register a terminal-status listener. Returns an unsubscribe function.
   * Listeners are invoked after the row has been written, so a subscriber
   * always reads the final status.
   */
  subscribeFinalize(listener: BackgroundShellFinalizeListener): () => void {
    this.finalizeListeners.add(listener);
    return () => {
      this.finalizeListeners.delete(listener);
    };
  }

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
    const timeoutMs = clampBackgroundShellTimeoutMs(input.timeoutMs);
    const sink = this.logSink.open(id);
    this.db
      .prepare(
        `INSERT INTO background_shells
           (id, session_id, project_id, command, label, cwd, pid, status, exit_code, log_path, watch, timeout_ms, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, 'running', NULL, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.sessionId,
        input.projectId,
        input.command,
        label,
        input.cwd,
        sink.path,
        input.watch ? 1 : 0,
        timeoutMs,
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
      this.emitLog(handle.sessionId, handle.id, chunk);
    };

    let child: ChildProcess;
    try {
      child = this.spawn('sh', ['-c', input.command], {
        cwd: input.cwd,
        env: sanitizeSpawnPythonEnv({ ...process.env }),
        stdio: ['ignore', 'pipe', 'pipe'],
        // Own process-group leader so `kill(-pid)` reaches the whole tree.
        detached: true,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.logger.warn(`[bg-shell ${id}] spawn failed: ${reason}`);
      append(`[agent-hub] spawn failed: ${reason}\n`);
      // The caller learns about a spawn failure from this call's own return
      // value, in the turn that is still running. Waking that same session
      // later to re-announce it would be pure noise, so disarm first.
      this.clearWatch(id);
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
      // `stop()` / the timeout cap set `stopping` before signalling — the
      // exit they triggered is not a crash, even though it arrives with a
      // signal. Leave finalization to `terminate()` after the group is reaped.
      if (handle.stopping) {
        // The shell leader can exit while descendants remain.
      } else if (signal) {
        this.monitorNaturalExit(handle, 'failed', null);
      } else {
        this.monitorNaturalExit(handle, code === 0 ? 'exited' : 'failed', code ?? null);
      }
    });

    handle.cancelTimeout = this.schedule(() => {
      void this.timeout(id, append);
    }, timeoutMs);

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

  /**
   * Shells for `sessionId` that a prior Hub process left `running` — i.e. the
   * ones this boot is reaping. The restart auto-resume names them in the
   * prompt so the resumed agent knows its long-running work is gone instead of
   * going back to polling it.
   */
  listBootOrphans(sessionId: string): BackgroundShellRow[] {
    return this.bootOrphans.filter((row) => row.session_id === sessionId);
  }

  /**
   * Shells for a session whose watch is still armed and whose process is still
   * running — i.e. the reason the session's watch-loop indicator is lit.
   */
  listWatched(sessionId: string): BackgroundShellRow[] {
    return this.db
      .prepare(
        `SELECT * FROM background_shells
          WHERE session_id = ? AND watch = 1 AND status = 'running'
          ORDER BY created_at ASC, rowid ASC`,
      )
      .all(sessionId) as BackgroundShellRow[];
  }

  /**
   * Every running shell across all sessions. Feeds the WS connect snapshot, so
   * a reconnecting client can rebuild its per-session view from scratch instead
   * of trusting whatever partial state it had before the socket dropped.
   */
  listRunning(): BackgroundShellRow[] {
    return this.db
      .prepare(
        `SELECT * FROM background_shells WHERE status = 'running' ORDER BY created_at ASC, rowid ASC`,
      )
      .all() as BackgroundShellRow[];
  }

  /**
   * Disarm a single shell's watch. Idempotent; safe on unknown ids. Called
   * once a wake has been planned for it, so the same completion can never
   * produce a second wake.
   */
  clearWatch(shellId: string): void {
    this.db
      .prepare(
        `UPDATE background_shells
            SET watch = 0, watch_resolved_at = ?
          WHERE id = ? AND watch = 1`,
      )
      .run(this.clock.nowIso(), shellId);
  }

  /**
   * Disarm every armed shell in a session in one statement, whatever its
   * status. Used before any teardown that kills a session's shells: the kill
   * finalizes them, and a still-armed row would make that finalize look like a
   * completion worth waking the session for.
   *
   * Returns the rows as they were *before* the disarm so callers can still see
   * which ones were running.
   */
  disarmSessionWatch(sessionId: string): BackgroundShellRow[] {
    const armed = this.db
      .prepare(`SELECT * FROM background_shells WHERE session_id = ? AND watch = 1`)
      .all(sessionId) as BackgroundShellRow[];
    if (armed.length === 0) return armed;
    this.db
      .prepare(
        `UPDATE background_shells
            SET watch = 0, watch_resolved_at = ?
          WHERE session_id = ? AND watch = 1`,
      )
      .run(this.clock.nowIso(), sessionId);
    return armed;
  }

  /**
   * Cancel a session's whole watch loop: disarm every armed shell and stop the
   * ones still running. Returns the rows that were stopped so the caller can
   * report what it tore down.
   */
  async cancelWatch(sessionId: string): Promise<BackgroundShellRow[]> {
    const armed = this.disarmSessionWatch(sessionId);
    const stopped: BackgroundShellRow[] = [];
    for (const row of armed) {
      if (row.status === 'running') {
        const result = await this.stop(row.id);
        if (result) stopped.push(result);
      }
    }
    // Emit disarmed-but-already-terminal rows too, so the UI clears its pill
    // even when nothing needed killing.
    for (const row of armed) {
      if (row.status !== 'running') {
        const updated = this.getById(row.id);
        if (updated) this.emit(updated);
      }
    }
    return stopped;
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
    return this.terminate(shellId, 'stopped');
  }

  /**
   * Wall-clock cap: SIGTERM the process group and mark the row `timed_out`.
   * Watched shells still wake the session so the agent can start the next
   * slice. No-ops if the shell already finished.
   */
  private async timeout(shellId: string, append: (chunk: string) => void): Promise<void> {
    const handle = this.handles.get(shellId);
    if (!handle || handle.finalized) return;
    const row = this.getById(shellId);
    const cap = formatBackgroundShellTimeoutCap(
      row?.timeout_ms ?? BACKGROUND_SHELL_DEFAULT_TIMEOUT_MS,
    );
    append(`[agent-hub] timed out after the ${cap} cap; stopping the process group\n`);
    this.logger.warn(`[bg-shell ${shellId}] timed out after ${cap} cap`);
    await this.terminate(shellId, 'timed_out');
  }

  private async terminate(
    shellId: string,
    status: Extract<BackgroundShellStatus, 'stopped' | 'timed_out'>,
  ): Promise<BackgroundShellRow | null> {
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
            `UPDATE background_shells SET status = ?, updated_at = ? WHERE id = ? AND status = 'running'`,
          )
          .run(status, this.clock.nowIso(), shellId);
        const updated = this.getById(shellId);
        if (updated) {
          this.emit(updated);
          this.notifyFinalize(updated);
        }
        return updated;
      }
      return row;
    }
    if (handle.finalized) return this.getById(shellId);

    // Signal FIRST, then finalize. `stopping` tells the child's exit handler
    // to leave finalization to us (not record `failed`) for the
    // signal-triggered exit; the trailing finalize covers the no-child /
    // already-exited case where no exit event will fire.
    const child = handle.child;
    if (child && typeof child.pid === 'number') {
      handle.stopping = true;
      if (handle.naturalExitTimer) clearTimeout(handle.naturalExitTimer);
      this.killGroup(child, 'SIGTERM');
      await this.waitForExit(child);
    }
    if (!handle.finalized) this.finalize(handle, status, null);
    return this.getById(shellId);
  }

  /**
   * Stop every `running` shell for a session. Used by the session-delete /
   * archive hook. Returns the number of shells stopped.
   *
   * Disarms the session's watch loop first, for the same reason `cancelWatch`
   * does: killing a shell finalizes it, and finalizing an armed shell notifies
   * the watcher. The delete path awaits this *before* it soft-deletes the row,
   * so a still-armed shell would queue a wake against a session that still
   * looks alive and the watcher would start a fresh chat turn into a session
   * about to be archived.
   */
  async stopBySessionId(sessionId: string): Promise<number> {
    this.disarmSessionWatch(sessionId);
    const rows = this.db
      .prepare(`SELECT id FROM background_shells WHERE session_id = ? AND status = 'running'`)
      .all(sessionId) as Array<{ id: string }>;
    for (const r of rows) {
      await this.stop(r.id);
    }
    return rows.length;
  }

  /**
   * Tear down exactly the shells that existed at the moment of the call, and
   * nothing else.
   *
   * The session-wide siblings (`cancelWatch`, `stopBySessionId`) re-query the
   * table after every `await`, which is correct for session delete — the
   * session is going away, so anything that appears mid-teardown should die
   * too. It is wrong for a *boundary* teardown like the Finalize push, where
   * work started after the boundary is supposed to survive. Since `stop()`
   * awaits the SIGTERM grace before escalating, that teardown can easily run
   * for seconds, and a session-wide sweep at the end of it would kill a shell
   * started in the meantime.
   *
   * So the row set is snapshotted **synchronously**, before the first `await`,
   * and every subsequent operation is keyed to those ids: the disarm targets
   * them individually rather than `WHERE session_id = ?`, and only snapshotted
   * rows are stopped. A shell created at any point after entry is invisible to
   * this call.
   *
   * Returns the rows that were actually stopped.
   */
  async stopSessionSnapshot(sessionId: string): Promise<BackgroundShellRow[]> {
    // Synchronous: no `await` may precede this read, or the snapshot is not a
    // snapshot of the boundary any more.
    const snapshot = this.db
      .prepare(`SELECT * FROM background_shells WHERE session_id = ?`)
      .all(sessionId) as BackgroundShellRow[];
    if (snapshot.length === 0) return [];

    // Per-id disarm rather than `disarmSessionWatch`: the session-wide UPDATE
    // would silently clear the watch flag of a post-boundary shell too.
    for (const row of snapshot) {
      if (row.watch === 1) this.clearWatch(row.id);
    }

    const stopped: BackgroundShellRow[] = [];
    for (const row of snapshot) {
      if (row.status === 'running') {
        const result = await this.stop(row.id);
        if (result) stopped.push(result);
      }
    }
    // Emit the disarmed-but-already-terminal rows so the UI's "watching" pill
    // clears even when nothing needed killing (same reason `cancelWatch` does).
    for (const row of snapshot) {
      if (row.status !== 'running' && row.watch === 1) {
        const updated = this.getById(row.id);
        if (updated) this.emit(updated);
      }
    }
    return stopped;
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
    try {
      handle.cancelTimeout?.();
    } catch {
      // ignore cancel failures
    }
    handle.cancelTimeout = undefined;
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
    if (row) {
      this.emit(row);
      this.notifyFinalize(row);
    }
    this.handles.delete(handle.id);
  }

  /**
   * Fan a terminal row out to subscribers. Each listener is isolated: the
   * watch coordinator throwing must never leave a shell half-finalized.
   */
  private notifyFinalize(row: BackgroundShellRow): void {
    for (const listener of this.finalizeListeners) {
      try {
        listener(row);
      } catch (err) {
        this.logger.warn(
          `[bg-shell ${row.id}] finalize listener threw: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
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

  private emitLog(sessionId: string, shellId: string, chunk: string): void {
    if (!this.broadcast || chunk.length === 0) return;
    try {
      this.broadcast({ type: 'background_shell_log', sessionId, shellId, chunk });
    } catch (err) {
      this.logger.warn(
        `[bg-shell ${shellId}] log broadcast threw: ${err instanceof Error ? err.message : String(err)}`,
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
   * Watch-loop columns, added after the table shipped. Rows written by an
   * older build default to `watch = 0` (unwatched), which is the safe
   * direction — an upgrade never starts waking sessions about shells the agent
   * launched before the feature existed.
   */
  private ensureWatchColumns(): void {
    const columns = this.db.prepare(`PRAGMA table_info(background_shells)`).all() as Array<{
      name: string;
    }>;
    const has = (name: string): boolean => columns.some((column) => column.name === name);
    if (!has('watch')) {
      this.db.exec(`ALTER TABLE background_shells ADD COLUMN watch INTEGER NOT NULL DEFAULT 0`);
    }
    if (!has('watch_resolved_at')) {
      this.db.exec(`ALTER TABLE background_shells ADD COLUMN watch_resolved_at TEXT`);
    }
  }

  /**
   * Wall-clock cap column. Rows from an older build get the 30-minute default
   * so an upgrade never leaves a pre-cap shell unbounded; in practice those
   * rows are already terminal or get reaped on boot.
   */
  private ensureTimeoutColumn(): void {
    const columns = this.db.prepare(`PRAGMA table_info(background_shells)`).all() as Array<{
      name: string;
    }>;
    if (!columns.some((column) => column.name === 'timeout_ms')) {
      this.db.exec(
        `ALTER TABLE background_shells ADD COLUMN timeout_ms INTEGER NOT NULL DEFAULT ${BACKGROUND_SHELL_DEFAULT_TIMEOUT_MS}`,
      );
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
  private readBootOrphans(): BackgroundShellRow[] {
    try {
      return this.db
        .prepare(`SELECT * FROM background_shells WHERE status = 'running'`)
        .all() as BackgroundShellRow[];
    } catch (err) {
      this.logger.warn(
        `[bg-shell] boot reconcile query failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
    }
  }

  private async reconcileOrphansOnBoot(): Promise<void> {
    const rows = this.bootOrphans;
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
      // Disarm without notifying: `restart-resume-notice.ts` already tells the
      // resumed agent that every process it started is gone, so a wake here
      // would double-notify for the same restart.
      this.clearWatch(row.id);
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
