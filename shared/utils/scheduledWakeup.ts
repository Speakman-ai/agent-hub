/**
 * ScheduleWakeup countdown. Input has only relative `delaySeconds`; wall-clock
 * fire time needs the session-event timestamp as epoch ms. Never fall back to
 * "now" (that restarts the countdown on every load).
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
 * Normalize tool input. Missing `scheduledAtMs` hides the countdown; never use
 * "now".
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
 * Countdown chip at `nowMs`. `due` means the time arrived, not that the agent woke.
 */
export function wakeupCountdown(wakeup: ScheduledWakeup, nowMs: number): WakeupCountdown {
  if (wakeup.stop) {
    return { state: 'stopped', label: 'loop stopped', remainingMs: null, progress: null };
  }
  if (wakeup.firesAtMs === null) {
    // No anchor/delay: show the requested delay as static text.
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

/** Tick every 1s under a minute, else every 15s. */
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
 * Expanded card body for the tool response. Null only while in flight.
 * An errored result with an empty body still renders (the 'error' label is the signal).
 */
export function wakeupResultPanel(
  result: { output?: unknown; isError?: unknown } | null | undefined,
): WakeupResultPanel | null {
  if (!result) return null;
  const errored = result.isError === true;
  const raw = typeof result.output === 'string' ? result.output : '';
  const truncated = raw.length > WAKEUP_RESULT_MAX_CHARS;
  // Errored result with empty body still needs to render; silence reads as success.
  const text = raw ? raw.slice(0, WAKEUP_RESULT_MAX_CHARS) : '(empty)';
  return { label: errored ? 'error' : 'result', text, errored, truncated };
}
