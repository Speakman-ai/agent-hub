/**
 * ScheduleWakeup — pure helpers for rendering a countdown.
 *
 * `ScheduleWakeup` is the Claude Code tool an agent calls to ask the harness to
 * re-enter the same task after a delay. Its input carries only a *relative*
 * `delaySeconds`, so a wall-clock fire time only exists once the call is paired
 * with the timestamp of the session-event that carried it. Callers pass that
 * anchor in as epoch ms (the web/mobile clients convert the server's SQLite
 * datetime string via their own `parseDate`, which keeps timezone handling in
 * one place per surface).
 *
 * Everything here is pure so both clients can share it and unit-test it without
 * a React environment.
 */

export const SCHEDULE_WAKEUP_TOOL = 'ScheduleWakeup';

export interface ScheduledWakeup {
  /** The agent ended the loop instead of scheduling another pass. */
  stop: boolean;
  /** Requested delay, or null when absent/unparseable (always the case for a stop). */
  delaySeconds: number | null;
  /** One-line rationale the agent supplied for the chosen delay. */
  reason: string;
  /** The task text that will be replayed on wake-up. */
  prompt: string;
  /** Anchor: when the call was made, epoch ms. Null when no timestamp was available. */
  scheduledAtMs: number | null;
  /** When the wakeup is due, epoch ms. Null unless both anchor and delay are known. */
  firesAtMs: number | null;
}

export function isScheduleWakeupTool(tool: unknown): boolean {
  return tool === SCHEDULE_WAKEUP_TOOL;
}

function asTrimmedString(val: unknown): string {
  return typeof val === 'string' ? val.trim() : '';
}

/**
 * Normalize a raw `ScheduleWakeup` tool input into display-ready fields.
 *
 * `scheduledAtMs` is the wall clock of the tool call. When it is missing (an
 * older persisted event with no timestamp, say) the countdown is simply not
 * shown — we never fall back to "now", which would restart the countdown on
 * every page load and render a stale wakeup as freshly scheduled.
 */
export function parseScheduledWakeup(
  input: unknown,
  scheduledAtMs: number | null | undefined,
): ScheduledWakeup {
  const obj = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const stop = obj.stop === true;

  const rawDelay = obj.delaySeconds;
  let delaySeconds: number | null = null;
  if (typeof rawDelay === 'number' && Number.isFinite(rawDelay) && rawDelay >= 0) {
    delaySeconds = rawDelay;
  } else if (typeof rawDelay === 'string' && rawDelay.trim()) {
    // Some engines stringify numeric tool args.
    const parsed = Number(rawDelay);
    if (Number.isFinite(parsed) && parsed >= 0) delaySeconds = parsed;
  }

  const anchor =
    typeof scheduledAtMs === 'number' && Number.isFinite(scheduledAtMs) ? scheduledAtMs : null;

  // A stop has no fire time even when the model redundantly sent a delay.
  const firesAtMs =
    !stop && anchor !== null && delaySeconds !== null ? anchor + delaySeconds * 1000 : null;

  return {
    stop,
    delaySeconds: stop ? null : delaySeconds,
    reason: asTrimmedString(obj.reason),
    prompt: asTrimmedString(obj.prompt),
    scheduledAtMs: anchor,
    firesAtMs,
  };
}

/**
 * Human duration for a countdown, tuned for the [60s, 1h] range the tool
 * clamps to while still degrading sensibly outside it.
 *
 *   90_000    → "1m 30s"
 *   3_600_000 → "1h 00m"
 *   9_000     → "9s"
 */
export function formatWakeupDuration(ms: number): string {
  const totalSec = Math.max(0, Math.ceil(ms / 1000));
  const days = Math.floor(totalSec / 86400);
  const hours = Math.floor((totalSec % 86400) / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
  return `${seconds}s`;
}

export interface WakeupCountdown {
  /** 'stopped' | 'pending' | 'due' | 'unknown' */
  state: 'stopped' | 'pending' | 'due' | 'unknown';
  /** Short chip text, e.g. "in 19m 42s". Empty when there is nothing to show. */
  label: string;
  /** Milliseconds left; 0 once due, null when not computable. */
  remainingMs: number | null;
  /** Fraction elapsed in [0,1] for a progress bar; null when not computable. */
  progress: number | null;
}

/**
 * Derive the countdown chip for a parsed wakeup at wall clock `nowMs`.
 *
 * `due` does not mean "the agent woke up" — the Hub has no visibility into
 * whether the harness re-entered the loop — so the label deliberately says the
 * time has arrived rather than claiming the wakeup fired.
 */
export function wakeupCountdown(wakeup: ScheduledWakeup, nowMs: number): WakeupCountdown {
  if (wakeup.stop) {
    return { state: 'stopped', label: 'loop stopped', remainingMs: null, progress: null };
  }
  if (wakeup.firesAtMs === null) {
    // No anchor (or no delay) — fall back to the requested delay as static text
    // so the user still learns how long the agent asked for.
    if (wakeup.delaySeconds !== null) {
      return {
        state: 'unknown',
        label: `after ${formatWakeupDuration(wakeup.delaySeconds * 1000)}`,
        remainingMs: null,
        progress: null,
      };
    }
    return { state: 'unknown', label: '', remainingMs: null, progress: null };
  }

  const remainingMs = wakeup.firesAtMs - nowMs;
  if (remainingMs <= 0) {
    return { state: 'due', label: 'wakeup time reached', remainingMs: 0, progress: 1 };
  }

  const totalMs = (wakeup.delaySeconds ?? 0) * 1000;
  const progress = totalMs > 0 ? Math.min(1, Math.max(0, 1 - remainingMs / totalMs)) : null;
  return {
    state: 'pending',
    label: `in ${formatWakeupDuration(remainingMs)}`,
    remainingMs,
    progress,
  };
}

/**
 * How often the UI should re-render the countdown. Sub-minute countdowns tick
 * every second; longer ones every 15s, which is enough for a "19m" readout and
 * keeps a backgrounded tab from waking once a second for an hour.
 */
export function wakeupTickIntervalMs(remainingMs: number | null): number {
  if (remainingMs === null) return 0;
  return remainingMs <= 60_000 ? 1_000 : 15_000;
}

/** Max characters of tool output rendered inline before truncation. */
export const WAKEUP_RESULT_MAX_CHARS = 2000;

export interface WakeupResultPanel {
  /** Section heading — 'error' when the call failed. */
  label: 'error' | 'result';
  /** Body text, already truncated. Never empty. */
  text: string;
  errored: boolean;
  truncated: boolean;
}

/**
 * What the expanded card should show for the tool's own response.
 *
 * The dedicated wakeup card replaced a generic tool row that displayed
 * `result.output`, and initially dropped it — which hid scheduling
 * confirmations and, worse, the actual message when the call errored. Both
 * surfaces derive the panel from here so they cannot drift apart again.
 *
 * Returns null only while the call is still in flight (no result yet).
 */
export function wakeupResultPanel(
  result: { output?: unknown; isError?: unknown } | null | undefined,
): WakeupResultPanel | null {
  if (!result) return null;
  const errored = result.isError === true;
  const raw = typeof result.output === 'string' ? result.output : '';
  const truncated = raw.length > WAKEUP_RESULT_MAX_CHARS;
  // An errored result with an empty body still needs to render: the 'error'
  // label is itself the signal, and a silent card reads as success.
  const text = raw ? raw.slice(0, WAKEUP_RESULT_MAX_CHARS) : '(empty)';
  return { label: errored ? 'error' : 'result', text, errored, truncated };
}
