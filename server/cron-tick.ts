/**
 * Cron tick wrapper — keeps node-cron Runner heartbeats non-blocking.
 *
 * Background
 * ----------
 * node-cron v4 schedules each task on its own `setTimeout`-based heartbeat
 * (see `node_modules/node-cron/dist/esm/scheduler/runner.js`). When the
 * heartbeat fires it:
 *   1. Detects whether `expectedNextExecution` has already passed (which
 *      means the event loop was blocked across the boundary). Each missed
 *      slot logs `[NODE-CRON] [WARN] missed execution at <time>`.
 *   2. Calls the user callback inside an inner `setTimeout`.
 *   3. Schedules the next heartbeat.
 *
 * Because step 2 runs *before* step 3, a user callback that does heavy
 * synchronous work (sync DB transactions, big JSON parses, GC pauses from
 * a burst of allocations, etc.) can delay the runner from arming the next
 * timer in time. And because Agent Hub schedules several tasks on
 * `* * * * *` (per-agent heartbeats, per-project crons, the autonomous
 * loop's safety net, pool-alerts, workflow-cron triggers), a burst of
 * sync work at the same minute boundary can blow past the next minute
 * boundary entirely — at which point every minute-boundary task emits the
 * "missed execution" warning at once. The historical incident on PID
 * 2202338 (2026-04-23 16:33:00 UTC) showed five simultaneous warnings
 * from this exact pattern.
 *
 * Strategy
 * --------
 * `wrapCronTick(fn)` returns a wrapper that defers `fn` to a fresh
 * macrotask via `setImmediate`. The Runner heartbeat sees the wrapper
 * return synchronously in O(microseconds), so the next heartbeat is
 * armed without waiting on user work. `fn` then executes on the next
 * tick — its sync prefix can take however long it needs without
 * distorting other tasks' heartbeats.
 *
 * `defaultTickOptions(intervalSeconds)` produces the recommended
 * `TaskOptions` for `cron.schedule`:
 *   - `noOverlap: true` — drop a fresh tick when the previous run is
 *     still pending instead of queueing a second concurrent run.
 *   - `maxRandomDelay`  — for fast-cadence schedules (≤ 60s), jitter the
 *     user-callback start across a small window so several tasks don't
 *     all hit the event loop in the same instant.
 *
 * This is a defensive layer on top of the underlying execSync→execFile
 * migration in `server/worktree.ts` (PR #689). Both fixes target the
 * same symptom from different angles: that PR removed one large source
 * of sync git work from the cron path; this wrapper prevents any
 * remaining (or future) sync work in a tick from cascading into a burst
 * of "missed execution" warnings on neighbouring tasks.
 */

import type { TaskFn, TaskOptions, TaskContext } from 'node-cron';

/**
 * Default jitter window (ms) for fast-cadence cron tasks. 1500ms is small
 * enough that the user-visible "scheduled at every minute" semantics are
 * preserved, but large enough to spread five concurrent minute-boundary
 * ticks across multiple event-loop iterations.
 */
export const FAST_CADENCE_JITTER_MS = 1500;

/**
 * Threshold (in seconds) below which we treat a schedule as fast-cadence
 * and apply `maxRandomDelay` jitter. 60s = anything that fires every
 * minute or faster. Slower schedules (every 3 min, hourly, daily) don't
 * collide as often and don't need jitter; their `expectedNextExecution`
 * windows are wider so a few hundred ms of stall doesn't trip the warning.
 */
const FAST_CADENCE_THRESHOLD_SECONDS = 60;

export type CronTickFn = TaskFn | (() => void | Promise<unknown>);

/**
 * Wrap a cron tick callback so it runs on the next macrotask via
 * `setImmediate` rather than synchronously inside the node-cron Runner
 * heartbeat. Errors are swallowed and logged — the wrapper must never
 * throw, because an uncaught throw inside `setImmediate` would crash the
 * process and a node-cron tick callback is already "best-effort" by
 * convention.
 */
export function wrapCronTick(fn: CronTickFn, label?: string): TaskFn {
  return (context: TaskContext) => {
    setImmediate(() => {
      try {
        const result = (fn as (...args: unknown[]) => unknown)(context);
        if (result && typeof (result as Promise<unknown>).catch === 'function') {
          (result as Promise<unknown>).catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`[cron-tick${label ? ` ${label}` : ''}] async error:`, msg);
          });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[cron-tick${label ? ` ${label}` : ''}] sync error:`, msg);
      }
    });
  };
}

interface DefaultTickOptionsInput {
  /**
   * Approximate interval between ticks, in seconds. Used to decide
   * whether to apply `maxRandomDelay` jitter. If unknown / unparseable,
   * pass `null` and no jitter is applied.
   */
  intervalSeconds: number | null;
  /**
   * Override the jitter window. Defaults to `FAST_CADENCE_JITTER_MS`.
   * Set to 0 to suppress jitter even on fast-cadence schedules
   * (e.g. for tests or deterministic scenarios).
   */
  maxRandomDelayMs?: number;
  /** Optional timezone passthrough. */
  timezone?: string;
  /** Optional name passthrough (helps node-cron logs). */
  name?: string;
}

/**
 * Build the recommended `TaskOptions` for `cron.schedule` based on a
 * task's expected cadence. Always returns `noOverlap: true`; adds
 * `maxRandomDelay` for fast-cadence schedules (≤ 60s).
 */
export function defaultTickOptions(input: DefaultTickOptionsInput): TaskOptions {
  const opts: TaskOptions = { noOverlap: true };
  if (input.timezone) opts.timezone = input.timezone;
  if (input.name) opts.name = input.name;
  const interval = input.intervalSeconds;
  if (interval !== null && interval <= FAST_CADENCE_THRESHOLD_SECONDS) {
    const jitter = input.maxRandomDelayMs ?? FAST_CADENCE_JITTER_MS;
    if (jitter > 0) opts.maxRandomDelay = jitter;
  }
  return opts;
}

/**
 * Best-effort estimate of the seconds between ticks for a cron
 * expression. Returns null when the expression is too complex to
 * estimate without invoking node-cron's parser. Conservative: when in
 * doubt, returns the *minimum* interval implied by the field (which is
 * what we want for the fast-cadence check — we'd rather over-jitter than
 * under-jitter).
 *
 * Recognised shapes:
 *   - `* * * * *`           → 60s
 *   - `*\/N * * * *`         → N * 60s (minute step)
 *   - `* * * * * *` (6-field)→ 1s if seconds=`*`, else null
 *   - `*\/N * * * * *`       → N seconds
 *   - everything else       → null
 *
 * Slower-than-minute schedules (`0 * * * *`, `0 3 * * *`, …) return
 * 3600s / 86400s respectively but the parser is intentionally simple —
 * any expression we can't classify confidently returns null.
 */
export function estimateIntervalSeconds(expr: string): number | null {
  if (typeof expr !== 'string') return null;
  const fields = expr.trim().split(/\s+/);
  if (fields.length < 5 || fields.length > 6) return null;

  // 6-field form: seconds minutes hours day month weekday
  if (fields.length === 6) {
    const sec = fields[0]!;
    if (sec === '*') return 1;
    const stepMatch = sec.match(/^\*\/(\d+)$/);
    if (stepMatch) {
      const n = Number(stepMatch[1]);
      return Number.isFinite(n) && n > 0 ? n : null;
    }
    return null;
  }

  // 5-field form: minutes hours day month weekday
  const min = fields[0]!;
  const hour = fields[1]!;
  if (min === '*') return 60;
  const stepMatch = min.match(/^\*\/(\d+)$/);
  if (stepMatch) {
    const n = Number(stepMatch[1]);
    return Number.isFinite(n) && n > 0 ? n * 60 : null;
  }
  // Fixed minute, wildcard hour → once per hour
  if (/^\d+$/.test(min) && hour === '*') return 3600;
  // Fixed minute + fixed hour → once per day
  if (/^\d+$/.test(min) && /^\d+$/.test(hour)) return 86400;
  return null;
}
