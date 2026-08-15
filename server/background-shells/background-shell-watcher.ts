/**
 * The background-shell watch loop.
 *
 * Subscribes to {@link BackgroundShellRuntime} terminal-status events and,
 * when an armed shell finishes, wakes its session by dispatching a turn
 * through the same `handleChat(null, …)` seam every other Hub automation uses
 * (queue drain, ReAct auto-continuation, restart resume, Finalize fix turns).
 *
 * Why a coordinator rather than a call inside the runtime: waking is a policy
 * decision with several ways to be wrong — the session may be mid-turn, it may
 * have been deleted, several shells may finish at once, and a wake turn can
 * itself start a shell. Keeping that policy in {@link planBackgroundShellWake}
 * and the bookkeeping here leaves the runtime a pure process owner.
 *
 * Durability: a completion is only "consumed" (`watch` cleared) once its wake
 * has actually been dispatched. A shell that finishes while the Hub is down —
 * or while a wake is deferred and the process restarts — is still armed on the
 * next boot, and {@link BackgroundShellWatcher.resumePendingOnBoot} picks it
 * up. The alternative (clear on completion) silently drops those wakes, which
 * is the exact failure this feature exists to remove.
 */

import {
  MIN_WAKE_INTERVAL_MS,
  WAKE_BUDGET_IDLE_RESET_MS,
  WAKE_LOG_TAIL_LINES,
  buildBackgroundShellWakePrompt,
  buildWakeCapNotice,
  planBackgroundShellWake,
  type WakePromptShell,
  type WatchedShellSummary,
} from './background-shell-watch.js';
import type { BackgroundShellRow } from './background-shell-runtime.js';

/**
 * The runtime surface the watcher needs. Narrowed to keep tests free of a real
 * database, log sink, and child processes.
 */
export interface WatchRuntimeLike {
  subscribeFinalize(listener: (row: BackgroundShellRow) => void): () => void;
  listWatched(sessionId: string): BackgroundShellRow[];
  getById(shellId: string): BackgroundShellRow | null;
  getLogTail(shellId: string, limit?: number): string[];
  clearWatch(shellId: string): void;
}

/** Minimal session shape the wake needs: who to dispatch as, and whether it still exists. */
export interface WatchSessionLike {
  id: string;
  agent_id: string;
  deleted_at?: string | null;
}

export interface WatcherChatMessage {
  type: 'chat';
  agentId: string;
  sessionId: string;
  content: string;
  _backgroundShellWake: true;
}

export interface BackgroundShellWatcherDeps {
  runtime: WatchRuntimeLike;
  /** Resolve a session, or undefined when it is gone. */
  getSession: (sessionId: string) => WatchSessionLike | undefined;
  /** True while a chat turn is in flight for this session. */
  isSessionBusy: (sessionId: string) => boolean;
  /**
   * True while Finalize is in flight for this session. Completions are
   * dropped rather than deferred so they cannot wake a new process the
   * moment the run parks or a fix turn ends.
   */
  isSessionFinalizing?: (sessionId: string) => boolean;
  /** Dispatch the wake turn. Mirrors `handleChat(null, msg)`. */
  dispatchChat: (msg: WatcherChatMessage) => Promise<unknown> | unknown;
  /** Write a `role: 'system'` transcript line. Used only for the give-up notice. */
  persistSystemMessage?: (
    sessionId: string,
    content: string,
    meta: Record<string, unknown>,
  ) => void;
  now?: () => number;
  logger?: { log: (m: string) => void; warn: (m: string) => void };
  /**
   * Rows whose completion has not been reported yet, read once at boot. Injected
   * so the watcher stays free of SQL; production passes a `background_shells`
   * query for `watch = 1 AND status != 'running'`.
   */
  listUnreportedCompletions?: () => BackgroundShellRow[];
}

/** Per-session wake bookkeeping. Purely in-memory; the DB holds the durable half. */
interface SessionWatchState {
  /** Finished-but-unreported shells, keyed by id so repeats collapse. */
  pending: Map<string, BackgroundShellRow>;
  wakes: number;
  lastWakeAtMs: number | null;
  /**
   * A wake is scheduled or in flight; don't plan another until it settles.
   * Covers both the microtask gap before dispatch and the turn itself.
   */
  dispatching: boolean;
  /** The give-up notice has been written; don't repeat it every completion. */
  cappedNotified: boolean;
}

function toSummary(row: BackgroundShellRow): WatchedShellSummary {
  return {
    id: row.id,
    label: row.label,
    command: row.command,
    status: row.status,
    exit_code: row.exit_code,
  };
}

export class BackgroundShellWatcher {
  private readonly deps: BackgroundShellWatcherDeps;
  private readonly now: () => number;
  private readonly logger: NonNullable<BackgroundShellWatcherDeps['logger']>;
  private readonly states = new Map<string, SessionWatchState>();
  private unsubscribe: (() => void) | null = null;

  constructor(deps: BackgroundShellWatcherDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => Date.now());
    this.logger = deps.logger ?? {
      log: (m) => console.log(m),
      warn: (m) => console.warn(m),
    };
    this.unsubscribe = deps.runtime.subscribeFinalize((row) => this.onFinalize(row));
  }

  /** Detach from the runtime. Tests and shutdown paths use this. */
  close(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /**
   * Re-arm wakes for shells that finished while no watcher was listening —
   * either the Hub restarted between completion and wake, or a deferred wake
   * never got its retry. Safe to call once on boot.
   */
  resumePendingOnBoot(): number {
    const rows = this.deps.listUnreportedCompletions?.() ?? [];
    for (const row of rows) {
      if (row.watch !== 1 || row.status === 'running') continue;
      this.enqueue(row);
    }
    if (rows.length > 0) {
      this.logger.log(
        `[bg-watch] boot: ${rows.length} unreported background-shell completion(s) queued for wake`,
      );
    }
    this.tickAll();
    return rows.length;
  }

  /**
   * Re-evaluate every session with pending completions. Called on a timer so a
   * wake deferred for a busy session (or held back by the coalescing window)
   * fires as soon as the session frees up. Mirrors the `drainIdleQueuedSessions`
   * sweep that does the same job for the message queue.
   */
  tickAll(): void {
    for (const sessionId of [...this.states.keys()]) {
      this.tick(sessionId);
    }
    this.pruneIdleStates();
  }

  /**
   * Release state for sessions that have gone quiet.
   *
   * State outlives an empty pending set on purpose — it carries the wake budget,
   * and dropping it the moment the last completion is reported would reset the
   * counter between every burst, making the cap unreachable and the runaway
   * loop it guards against possible again. So retention is time-based instead:
   * once a session has not woken for {@link WAKE_BUDGET_IDLE_RESET_MS} it is
   * demonstrably not looping, and both its budget and its memory are released.
   */
  private pruneIdleStates(): void {
    const now = this.now();
    for (const [sessionId, state] of [...this.states.entries()]) {
      if (state.pending.size > 0 || state.dispatching) continue;
      if (state.lastWakeAtMs !== null && now - state.lastWakeAtMs < WAKE_BUDGET_IDLE_RESET_MS) {
        continue;
      }
      this.states.delete(sessionId);
    }
  }

  /** Drop all in-memory state for a session. Used when its watch is cancelled. */
  forgetSession(sessionId: string): void {
    this.states.delete(sessionId);
  }

  /** Test seam: how many completions are waiting to be reported. */
  pendingCount(sessionId: string): number {
    return this.states.get(sessionId)?.pending.size ?? 0;
  }

  private onFinalize(row: BackgroundShellRow): void {
    if (row.watch !== 1) return;
    this.enqueue(row);
    this.tick(row.session_id);
  }

  private enqueue(row: BackgroundShellRow): void {
    let state = this.states.get(row.session_id);
    if (!state) {
      state = {
        pending: new Map(),
        wakes: 0,
        lastWakeAtMs: null,
        dispatching: false,
        cappedNotified: false,
      };
      this.states.set(row.session_id, state);
    }
    state.pending.set(row.id, row);
  }

  private tick(sessionId: string): void {
    const state = this.states.get(sessionId);
    if (!state || state.dispatching) return;

    // A shell whose watch was cancelled (or already reported) between enqueue
    // and now must not produce a wake. Re-reading the row makes cancellation
    // self-healing without the cancel path needing to know about this map.
    for (const shellId of [...state.pending.keys()]) {
      const current = this.deps.runtime.getById(shellId);
      if (!current || current.watch !== 1) state.pending.delete(shellId);
    }
    // Keep the (now empty) state: `pruneIdleStates` releases it on a timer so
    // the wake budget survives the gap between bursts.
    if (state.pending.size === 0) return;

    const session = this.deps.getSession(sessionId);
    const finished = [...state.pending.values()];
    const decision = planBackgroundShellWake({
      finishedShells: finished.map(toSummary),
      sessionGone: !session || Boolean(session.deleted_at),
      sessionBusy: this.deps.isSessionBusy(sessionId),
      sessionFinalizing: this.sessionIsFinalizing(sessionId),
      priorWakes: state.wakes,
      lastWakeAtMs: state.lastWakeAtMs,
      nowMs: this.now(),
    });

    if (decision.action === 'defer') return;

    if (decision.action === 'drop') {
      this.logger.log(
        `[bg-watch] drop session=${sessionId} reason=${decision.reason} shells=${finished.length}`,
      );
      if (decision.notifyHuman && !state.cappedNotified) {
        state.cappedNotified = true;
        this.safePersistSystemMessage(sessionId, buildWakeCapNotice(finished.map(toSummary)), {
          kind: 'background_shell_watch_cap',
          shellIds: finished.map((row) => row.id),
        });
      }
      for (const row of finished) this.deps.runtime.clearWatch(row.id);
      state.pending.clear();
      // `session_gone` is the one drop where the state is useless: no later
      // completion can ever wake a session that no longer exists.
      if (decision.reason === 'session_gone') this.states.delete(sessionId);
      return;
    }

    if (!session) return;

    // Claim the session before yielding, then dispatch on the next microtask.
    // Several shells routinely finish in the same tick — a matrix of test
    // shards, a build and its watcher — and dispatching the first one
    // synchronously would report it alone and leave its siblings to trigger
    // separate wake turns. Yielding lets the whole batch land in `pending`
    // first, so one wake names all of them.
    state.dispatching = true;
    queueMicrotask(() => this.dispatchWake(sessionId, session, state));
  }

  private dispatchWake(
    sessionId: string,
    session: WatchSessionLike,
    state: SessionWatchState,
  ): void {
    const finished = [...state.pending.values()];
    if (finished.length === 0) {
      state.dispatching = false;
      return;
    }
    const withLogs: WakePromptShell[] = finished.map((row) => ({
      ...toSummary(row),
      logTail: this.safeLogTail(row.id),
    }));
    const stillRunning = this.deps.runtime.listWatched(sessionId).map(toSummary);
    const content = buildBackgroundShellWakePrompt(withLogs, stillRunning);

    // Consume before dispatching: a wake turn can finish a shell of its own,
    // and re-entering `tick` with these still pending would report them twice.
    state.pending.clear();
    for (const row of finished) this.deps.runtime.clearWatch(row.id);
    state.wakes += 1;
    state.lastWakeAtMs = this.now();

    this.logger.log(
      `[bg-watch] wake session=${sessionId} shells=${finished.length} wake=${state.wakes}`,
    );

    const settle = (): void => {
      const current = this.states.get(sessionId);
      if (!current) return;
      current.dispatching = false;
      // Anything that finished during the wake turn is already queued; give it
      // a chance now rather than waiting for the next sweep. The state itself
      // stays put either way — it carries the wake budget that later
      // completions in this session must keep respecting.
      if (current.pending.size > 0) this.tick(sessionId);
    };

    try {
      const result = this.deps.dispatchChat({
        type: 'chat',
        agentId: session.agent_id,
        sessionId,
        content,
        _backgroundShellWake: true,
      });
      Promise.resolve(result)
        .catch((err: unknown) => {
          this.logger.warn(
            `[bg-watch] wake dispatch failed session=${sessionId}: ${err instanceof Error ? err.message : String(err)}`,
          );
        })
        .finally(settle);
    } catch (err) {
      this.logger.warn(
        `[bg-watch] wake dispatch threw session=${sessionId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      settle();
    }
  }

  private sessionIsFinalizing(sessionId: string): boolean {
    try {
      return this.deps.isSessionFinalizing?.(sessionId) ?? false;
    } catch (err) {
      this.logger.warn(
        `[bg-watch] isSessionFinalizing threw session=${sessionId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      // Fail closed: a throwing probe must not become a wake that collides
      // with an in-flight Finalize run.
      return true;
    }
  }

  private safeLogTail(shellId: string): string[] {
    try {
      return this.deps.runtime.getLogTail(shellId, WAKE_LOG_TAIL_LINES);
    } catch {
      return [];
    }
  }

  private safePersistSystemMessage(
    sessionId: string,
    content: string,
    meta: Record<string, unknown>,
  ): void {
    try {
      this.deps.persistSystemMessage?.(sessionId, content, meta);
    } catch (err) {
      this.logger.warn(
        `[bg-watch] system message failed session=${sessionId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

/**
 * Sweep interval for deferred wakes. Comfortably shorter than
 * {@link MIN_WAKE_INTERVAL_MS} so the coalescing window is what paces wakes,
 * not the poll.
 */
export const WATCH_SWEEP_INTERVAL_MS = Math.max(1_000, Math.floor(MIN_WAKE_INTERVAL_MS / 3));
