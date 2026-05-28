/**
 * stall-watchdog.ts — Live-mode "human walked away" guard for the
 * Finalize fix-dispatch loop.
 *
 * See wiki: `finalize-code-changes-architecture-v0` §7 ("Human-walked-away
 * behavior"). The fix-dispatch helper injects a structured §7 message
 * into the originating session whenever a step fails or the reviewer
 * requests changes; the session's agent is expected to fix the worktree,
 * commit, and end its turn. Turn-end is the only signal that re-enters
 * the rebase phase.
 *
 * In **live** mode (`trigger_source = 'ui_button'`), the human watching
 * the session may walk away — they had a notification badge but didn't
 * see it land. Without a watchdog the run would sit on the
 * `dispatching` queue indefinitely, paused on the active-time clock
 * (§13) but never closing.
 *
 * The watchdog fires two timers:
 *
 *   1. **notify timer** (`notifyAfterMs`, default 60 min): pushes a
 *      `finalize_stall_warning` notification to the triggering user.
 *      The notification is a reminder; the run keeps waiting. Exactly
 *      one push per arming.
 *   2. **stall timer** (`stallAfterMs`, default 24 hr): transitions the
 *      run to `status = 'stalled_no_response'` (terminal) and posts a
 *      session message + card comment so the human picking the
 *      conversation back up sees the parked state. The dispatched fix
 *      message stays in the log so the same user can retrigger Finalize
 *      from the card UI with the conversation intact.
 *
 * **Autonomous mode is a no-op.** When `triggerSource = 'agent_block'`,
 * `armStallWatchdog` does NOT arm either timer and returns a no-op
 * cancel handle. The autonomous loop is expected to pick up the
 * dispatch in its next iteration; if it does not, that is a bug in the
 * autonomous dispatcher (treated as a `dispatch_failure` elsewhere),
 * not a Finalize problem.
 *
 * The watchdog is wired through a small dep surface so tests can drive
 * its timers deterministically. Production lets the defaults fall
 * through: `setTimer = setTimeout` (with `.unref()` so a parked
 * watchdog never blocks the Node event loop from exiting), and
 * `dispatchPush` is the project's `dispatchPushEvent` from
 * `server/push.ts`.
 */
import { v4 as uuidv4 } from 'uuid';
import type { BroadcastFn, MessageRow, Stmts } from '../types.js';
import { finalizeStallWarningPush, dispatchPushEvent } from '../push.js';

/** Wall-clock ms after which the notify push fires. Live-mode only. */
export const DEFAULT_NOTIFY_AFTER_MS = 60 * 60 * 1_000; // 60 min

/** Wall-clock ms after which the run is parked as `stalled_no_response`. Live-mode only. */
export const DEFAULT_STALL_AFTER_MS = 24 * 60 * 60 * 1_000; // 24 hr

/**
 * Lower bound on `notifyAfterMs`. Operators tuning the windows down for
 * dogfood should not be able to misconfigure a project so that every
 * fix dispatch immediately pushes a "still waiting" notification — that
 * would be useless noise. 60s is a deliberately conservative floor;
 * real dogfood configs will keep the default 60min.
 */
export const MIN_NOTIFY_AFTER_MS = 60_000;

/** Cap on either window so a bogus config can't park a run forever. */
export const MAX_STALL_AFTER_MS = 7 * 24 * 60 * 60 * 1_000; // 7 days

/**
 * Minimal injectable timer shape. Production uses `setTimeout` with
 * `.unref()`; tests use a synchronous fake that records pending timers
 * and lets the test advance them manually.
 */
export interface TimerHandle {
  /** Cancel the pending timer. Idempotent. */
  clear(): void;
}

export type ScheduleTimer = (fn: () => void, ms: number) => TimerHandle;

/** Default production scheduler: `setTimeout` with `.unref()` so a parked watchdog never holds Node open. */
export const defaultScheduleTimer: ScheduleTimer = (fn, ms) => {
  const handle = setTimeout(fn, ms);
  // The watchdog timers are observers, not work — if Node has nothing
  // else to do, the process should be allowed to exit. The optional
  // chain handles browser-ish runtimes that don't implement unref().
  handle.unref?.();
  return {
    clear() {
      clearTimeout(handle);
    },
  };
};

export interface StallWatchdogDeps {
  stmts: Pick<
    Stmts,
    'failFinalizeRun' | 'addMessage' | 'touchSession' | 'getMessageById' | 'updateFinalizeRunPhase'
  >;
  broadcast: BroadcastFn;
  /**
   * Push dispatcher injected by the orchestrator. Production wires
   * {@link dispatchPushEvent} from `server/push.ts`; tests inject a
   * fake that records calls. Optional so a deployment without Expo
   * push configured (e.g. unit tests, headless CI) does not crash the
   * watchdog — a missing dispatcher logs and continues.
   */
  dispatchPush?: typeof dispatchPushEvent;
  scheduleTimer?: ScheduleTimer;
  now?: () => number;
  /** Idempotent id minter for the stall-terminal session message. */
  newId?: () => string;
  /** Log sink; tests stub to silence noise. */
  log?: (msg: string) => void;
}

export interface StallWatchdogOptions {
  /** finalize_runs.id. */
  runId: string;
  /**
   * Originating session id. Used to write the stall-terminal message
   * into the same transcript the fix dispatch landed in.
   */
  sessionId: string;
  /** Project id — propagated to push payload data for client routing. */
  projectId: string;
  /** Card id — propagated to push payload data; included in the session message. */
  cardId: string;
  /**
   * Trigger source for the parent finalize run. Watchdog arms ONLY
   * when this is `'ui_button'`. `'agent_block'` (autonomous) is a
   * no-op by design — the autonomous loop owns its own pickup
   * cadence.
   */
  triggerSource: 'ui_button' | 'agent_block';
  /** Optional card title — included verbatim in the push body. */
  cardTitle?: string;
  /**
   * Per-project notify window override. When omitted falls back to
   * {@link DEFAULT_NOTIFY_AFTER_MS}. Clamped to
   * `[MIN_NOTIFY_AFTER_MS, MAX_STALL_AFTER_MS]`.
   */
  notifyAfterMs?: number;
  /**
   * Per-project stall window override. When omitted falls back to
   * {@link DEFAULT_STALL_AFTER_MS}. Clamped to
   * `[notify+1ms, MAX_STALL_AFTER_MS]` — strictly greater than the
   * notify window so the reminder fires before the run terminates.
   */
  stallAfterMs?: number;
}

/**
 * Handle returned by {@link armStallWatchdog}. The fix-dispatch helper
 * calls {@link cancel} when the session's turn-end signal arrives so
 * neither timer fires for a session that responded normally.
 */
export interface StallWatchdogHandle {
  /** Cancel both pending timers. Idempotent. */
  cancel(): void;
  /**
   * Inspect runtime state — exposed for tests and any future ops
   * tooling that wants to surface "this run has X minutes left before
   * it stalls". Honest read-back; mirrors the internal counters.
   */
  state(): {
    armed: boolean;
    notifyAfterMs: number;
    stallAfterMs: number;
    notified: boolean;
    stalled: boolean;
    cancelled: boolean;
    armedAtMs: number;
  };
}

/**
 * Outcome surfaced when the stall timer fires. The fix-dispatch helper
 * is awaiting on the watchdog and the turn-end subscription
 * concurrently; whichever resolves first wins.
 */
export type StallTerminationReason = 'stalled_no_response';

/**
 * Arm the watchdog. Returns a handle the fix-dispatch helper uses to
 * cancel both timers on turn-end. The `onStall` callback fires exactly
 * once when the stall timer trips (after the notify push has already
 * happened, since `stallAfterMs > notifyAfterMs` by clamp).
 *
 * The function is non-throwing: a misconfiguration (notify >= stall)
 * is clamped silently and logged so a bad project config can't crash
 * the dispatch path.
 */
export function armStallWatchdog(
  deps: StallWatchdogDeps,
  opts: StallWatchdogOptions,
  onStall: (reason: StallTerminationReason) => void,
): StallWatchdogHandle {
  const scheduleTimer = deps.scheduleTimer ?? defaultScheduleTimer;
  const now = deps.now ?? Date.now;
  const newId = deps.newId ?? uuidv4;
  const log = deps.log ?? ((msg: string) => console.warn(msg));
  const dispatchPush = deps.dispatchPush ?? dispatchPushEvent;

  const { notifyAfterMs, stallAfterMs } = resolveWindows({
    notifyAfterMs: opts.notifyAfterMs,
    stallAfterMs: opts.stallAfterMs,
    log,
  });

  // Autonomous: no-op. The handle remains valid but neither timer is
  // armed — the autonomous loop owns its own pickup cadence and is not
  // a "human walked away" scenario. We still expose state() so the
  // orchestrator can prove it asked.
  if (opts.triggerSource !== 'ui_button') {
    return {
      cancel() {
        /* no-op — never armed */
      },
      state() {
        return {
          armed: false,
          notifyAfterMs,
          stallAfterMs,
          notified: false,
          stalled: false,
          cancelled: false,
          armedAtMs: now(),
        };
      },
    };
  }

  let notified = false;
  let stalled = false;
  let cancelled = false;
  const armedAtMs = now();

  const notifyHandle = scheduleTimer(() => {
    if (cancelled || notified) return;
    notified = true;
    void firePushNotification(deps, opts, armedAtMs, dispatchPush, log);
  }, notifyAfterMs);

  const stallHandle = scheduleTimer(() => {
    if (cancelled || stalled) return;
    stalled = true;
    try {
      writeStallTerminal(deps, opts, newId, now);
    } catch (err) {
      log(
        `[finalize-stall-watchdog] writeStallTerminal failed for run=${opts.runId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    try {
      onStall('stalled_no_response');
    } catch (err) {
      log(
        `[finalize-stall-watchdog] onStall callback threw for run=${opts.runId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }, stallAfterMs);

  return {
    cancel() {
      if (cancelled) return;
      cancelled = true;
      notifyHandle.clear();
      stallHandle.clear();
    },
    state() {
      return {
        armed: true,
        notifyAfterMs,
        stallAfterMs,
        notified,
        stalled,
        cancelled,
        armedAtMs,
      };
    },
  };
}

// ─── internals ──────────────────────────────────────────────────────

/**
 * Clamp the configured windows so an operator typo can't break the
 * watchdog contract.
 *
 *   - `notifyAfterMs` floor = {@link MIN_NOTIFY_AFTER_MS}.
 *   - `stallAfterMs` floor  = `notifyAfterMs + 1` (strictly greater so
 *     the reminder always fires before the terminal state).
 *   - Both ceil = {@link MAX_STALL_AFTER_MS}.
 *   - Non-finite / negative / NaN values fall through to the defaults
 *     so partial Project config (one field set, the other omitted)
 *     stays valid.
 */
function resolveWindows(args: {
  notifyAfterMs?: number;
  stallAfterMs?: number;
  log: (msg: string) => void;
}): { notifyAfterMs: number; stallAfterMs: number } {
  const log = args.log;
  const rawNotify = sanitizeMs(args.notifyAfterMs, DEFAULT_NOTIFY_AFTER_MS);
  const rawStall = sanitizeMs(args.stallAfterMs, DEFAULT_STALL_AFTER_MS);

  const notifyAfterMs = clamp(rawNotify, MIN_NOTIFY_AFTER_MS, MAX_STALL_AFTER_MS);
  if (notifyAfterMs !== rawNotify) {
    log(
      `[finalize-stall-watchdog] notifyAfterMs=${rawNotify} clamped to ${notifyAfterMs}ms (bounds ${MIN_NOTIFY_AFTER_MS}..${MAX_STALL_AFTER_MS})`,
    );
  }

  let stallAfterMs = clamp(rawStall, notifyAfterMs + 1, MAX_STALL_AFTER_MS);
  if (stallAfterMs !== rawStall) {
    log(
      `[finalize-stall-watchdog] stallAfterMs=${rawStall} clamped to ${stallAfterMs}ms (bounds ${notifyAfterMs + 1}..${MAX_STALL_AFTER_MS})`,
    );
  }
  // Defensive: clamp() handles bounds, but if someone configured
  // notify == MAX_STALL_AFTER_MS, the lower bound exceeds the upper
  // bound and `clamp` returns the lower bound, which equals
  // notify + 1. Cap to MAX explicitly.
  if (stallAfterMs > MAX_STALL_AFTER_MS) stallAfterMs = MAX_STALL_AFTER_MS;
  return { notifyAfterMs, stallAfterMs };
}

function sanitizeMs(v: number | undefined, fallback: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return fallback;
  return Math.floor(v);
}

function clamp(v: number, min: number, max: number): number {
  if (v < min) return min;
  if (v > max) return max;
  return v;
}

async function firePushNotification(
  deps: StallWatchdogDeps,
  opts: StallWatchdogOptions,
  armedAtMs: number,
  dispatchPush: typeof dispatchPushEvent,
  log: (msg: string) => void,
): Promise<void> {
  const now = deps.now ?? Date.now;
  const ageMinutes = Math.max(1, Math.round((now() - armedAtMs) / 60_000));
  const { title, body } = finalizeStallWarningPush({
    cardTitle: opts.cardTitle,
    ageMinutes,
  });
  try {
    await dispatchPush('finalize_stall_warning', {
      title,
      body,
      data: {
        type: 'finalize_stall_warning',
        runId: opts.runId,
        sessionId: opts.sessionId,
        cardId: opts.cardId,
        projectId: opts.projectId,
      },
    });
  } catch (err) {
    log(
      `[finalize-stall-watchdog] push dispatch failed for run=${opts.runId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

/**
 * Persist the terminal state. Mirrors the existing `failFinalizeRun`
 * statement but writes `status = 'stalled_no_response'` rather than a
 * failure class — the run is parked, not failed. Active-seconds is
 * untouched (the clock was paused while we waited for turn-end, per
 * §13). After the row write, drop a system message into the session
 * transcript so the human picking up the conversation sees what
 * happened.
 */
function writeStallTerminal(
  deps: StallWatchdogDeps,
  opts: StallWatchdogOptions,
  newId: () => string,
  now: () => number,
): void {
  const { stmts, broadcast } = deps;
  stmts.failFinalizeRun.run('stalled_no_response', 'stalled_no_response', opts.runId);
  // Emit a phase-terminal broadcast so the checks panel + card status
  // chip clear their spinners. We do NOT flip `phase` here — the row
  // remains in `'dispatching'` phase by intent, since the dispatch is
  // what got abandoned. The phase + terminal status together render as
  // "Stalled while waiting on a fix" in the UI.
  broadcast({
    type: 'finalize_run_phase_changed',
    run_id: opts.runId,
    phase: 'dispatching',
    status: 'stalled_no_response',
    failure_reason: 'stalled_no_response',
  });

  const cardLabel = opts.cardTitle ? ` for card "${opts.cardTitle}"` : '';
  const stallMinutes = Math.max(
    1,
    Math.round((opts.stallAfterMs ?? DEFAULT_STALL_AFTER_MS) / 60_000),
  );
  const body = [
    `Finalize Code Changes${cardLabel} was parked after ${stallMinutes} minutes with no response.`,
    '',
    'The fix dispatch above is still in this log — when you are ready, retrigger Finalize from the card to resume.',
  ].join('\n');
  const metadata = JSON.stringify({
    kind: 'finalize_stalled_no_response',
    runId: opts.runId,
    cardId: opts.cardId,
    stalledAt: now(),
    stallAfterMs: opts.stallAfterMs ?? DEFAULT_STALL_AFTER_MS,
  });
  const msgId = newId();
  try {
    stmts.addMessage.run(
      msgId,
      opts.sessionId,
      'system',
      body,
      null,
      null,
      null,
      metadata,
      null,
      null,
      null,
    );
  } catch (err) {
    // Best-effort — the DB row terminal-state write is the canonical
    // signal; a chat-message hiccup must not propagate.
    console.warn(
      `[finalize-stall-watchdog] addMessage failed for session=${opts.sessionId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return;
  }
  try {
    stmts.touchSession.run(opts.sessionId);
  } catch {
    /* best-effort */
  }
  try {
    const inserted = stmts.getMessageById.get(msgId) as MessageRow | undefined;
    if (inserted) {
      broadcast({ type: 'message', sessionId: opts.sessionId, message: inserted });
    }
  } catch (err) {
    console.warn(
      `[finalize-stall-watchdog] message broadcast failed for session=${opts.sessionId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

export const __test = {
  resolveWindows,
  sanitizeMs,
  clamp,
};
