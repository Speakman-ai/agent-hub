/**
 * DB statement wall-time instrumentation.
 *
 * Wraps better-sqlite3 prepared statements so each `run` / `get` / `all` call is
 * timed. Statements that exceed a configurable threshold are logged (statement
 * tag + duration only — never raw SQL params or user data), and per-statement
 * aggregates accumulate in memory for the `/api/config/db-stats` surface.
 *
 * `iterate` is intentionally NOT timed: it returns a lazy iterator, so timing
 * the call would capture only iterator construction (~0ms), not the row-by-row
 * consumption that happens later — a misleading near-zero reading. The `stmts`
 * layer uses `run`/`get`/`all` exclusively, so this costs no real coverage.
 *
 * This is Phase 1 of the async-DB epic: it exists so Phase 2 converts only the
 * paths this instrumentation *measures* as slow, rather than guessing.
 *
 * Overhead posture: wrapping is opt-in. When instrumentation is disabled at boot
 * (the default), {@link instrumentStmts} returns the statement map untouched, so
 * there is literally zero per-call cost in production. When enabled, a below-
 * threshold call pays only a proxy trap, a boolean check, two `performance.now()`
 * reads, and a Map update — near-zero relative to the SQLite work itself.
 */
import { performance } from 'node:perf_hooks';

export interface DbInstrumentationSettings {
  /** Master switch. When false at boot, statements are never wrapped. */
  enabled: boolean;
  /** Calls at or above this wall-time (ms) count as slow and are logged. */
  slowThresholdMs: number;
  /** Whether to emit a `[db-slow]` console line for each slow call (throttled per tag). */
  logSlow: boolean;
}

/** Immutable per-statement aggregate returned by {@link getDbInstrumentationSnapshot}. */
export interface StatementStat {
  /** The `Stmts` key the statement was registered under (never contains user data). */
  tag: string;
  count: number;
  totalMs: number;
  maxMs: number;
  slowCount: number;
}

export interface DbInstrumentationSnapshot {
  enabled: boolean;
  slowThresholdMs: number;
  /** Distinct statement tags that have recorded at least one call. */
  totalStatements: number;
  totalCalls: number;
  totalSlowCalls: number;
  /** Per-statement aggregates, sorted by total wall time descending. */
  statements: StatementStat[];
}

interface MutableStat {
  count: number;
  totalMs: number;
  maxMs: number;
  slowCount: number;
}

const DEFAULT_SLOW_THRESHOLD_MS = 10;
/** Don't emit more than one slow-log line per tag within this window (ms). */
const SLOW_LOG_MIN_INTERVAL_MS = 1000;

let enabled = false;
let slowThresholdMs = DEFAULT_SLOW_THRESHOLD_MS;
let logSlow = true;
// Process-global aggregate, keyed by statement tag — NOT per-registry. `initDb`
// runs per dataDir and instruments each one's statements, so if a future
// multi-tenant path opens several data dirs in one process, their timings merge
// under the same tag keys here. Fine for the single-DB deployment today; revisit
// (key by dataDir) before relying on these numbers to compare tenants.
const stats = new Map<string, MutableStat>();
const lastSlowLogAt = new Map<string, number>();

/**
 * Apply runtime settings. Threshold and logSlow take effect immediately for
 * subsequent calls. `enabled` gates whether {@link instrumentStmts} wraps at
 * boot; toggling it here after statements are already prepared has no effect on
 * already-wrapped/unwrapped statements (a restart re-wraps), but the wrapper's
 * internal fast path still honors it.
 *
 * Tolerant of `undefined` / non-object input: `initDb` calls this with
 * `config.dbInstrumentation`, and many tests mock `./config.js` with a partial
 * config that omits the block entirely. In that case we keep the defaults
 * (disabled) rather than throwing during DB initialization.
 */
export function configureDbInstrumentation(
  settings?: Partial<DbInstrumentationSettings> | null,
): void {
  if (!settings || typeof settings !== 'object') return;
  if (typeof settings.enabled === 'boolean') enabled = settings.enabled;
  if (
    typeof settings.slowThresholdMs === 'number' &&
    Number.isFinite(settings.slowThresholdMs) &&
    settings.slowThresholdMs >= 0
  ) {
    slowThresholdMs = settings.slowThresholdMs;
  }
  if (typeof settings.logSlow === 'boolean') logSlow = settings.logSlow;
}

export function isDbInstrumentationEnabled(): boolean {
  return enabled;
}

export function getDbSlowThresholdMs(): number {
  return slowThresholdMs;
}

/** Record a single statement execution. Exported for direct testing. */
export function recordStatementTiming(tag: string, durationMs: number): void {
  let s = stats.get(tag);
  if (!s) {
    s = { count: 0, totalMs: 0, maxMs: 0, slowCount: 0 };
    stats.set(tag, s);
  }
  s.count++;
  s.totalMs += durationMs;
  if (durationMs > s.maxMs) s.maxMs = durationMs;
  if (durationMs >= slowThresholdMs) {
    s.slowCount++;
    if (logSlow) maybeLogSlow(tag, durationMs);
  }
}

function maybeLogSlow(tag: string, durationMs: number): void {
  const now = performance.now();
  const last = lastSlowLogAt.get(tag) ?? Number.NEGATIVE_INFINITY;
  if (now - last < SLOW_LOG_MIN_INTERVAL_MS) return;
  lastSlowLogAt.set(tag, now);
  // Tag + duration only. Never log SQL text or bound parameters — those can
  // carry user data (session content, secrets, PII).
  console.warn(`[db-slow] ${tag} took ${durationMs.toFixed(1)}ms (threshold ${slowThresholdMs}ms)`);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function getDbInstrumentationSnapshot(): DbInstrumentationSnapshot {
  const statements: StatementStat[] = [];
  let totalCalls = 0;
  let totalSlowCalls = 0;
  for (const [tag, s] of stats) {
    statements.push({
      tag,
      count: s.count,
      totalMs: round2(s.totalMs),
      maxMs: round2(s.maxMs),
      slowCount: s.slowCount,
    });
    totalCalls += s.count;
    totalSlowCalls += s.slowCount;
  }
  statements.sort((a, b) => b.totalMs - a.totalMs);
  return {
    enabled,
    slowThresholdMs,
    totalStatements: statements.length,
    totalCalls,
    totalSlowCalls,
    statements,
  };
}

/** Clear all accumulated aggregates (e.g. to benchmark a specific window). */
export function resetDbInstrumentationStats(): void {
  stats.clear();
  lastSlowLogAt.clear();
}

const TIMED_METHODS = new Set(['run', 'get', 'all']);

/**
 * Wrap a single better-sqlite3 statement in a Proxy that times its execution
 * methods. The Proxy preserves the full `Statement` surface (`pluck`, `raw`,
 * `columns`, `source`, …); only `run`/`get`/`all` are timed, and only while
 * instrumentation is enabled. Bound method references are cached per statement
 * so repeated access does not re-allocate.
 *
 * Known limitation: chained modifiers that return the statement itself
 * (`.pluck()`, `.raw()`, `.expand()`, `.bind()`) are passthrough functions bound
 * to the raw target, so they return the UNWRAPPED statement. A call like
 * `stmt.raw().all()` therefore runs `all()` on the raw statement and is not
 * timed. Results stay correct — only instrumentation coverage is lost — and the
 * `stmts` layer does not chain these, so no real coverage is affected today.
 */
export function instrumentStatement<T extends object>(stmt: T, tag: string): T {
  const timedCache = new Map<string, (...args: unknown[]) => unknown>();
  const passthroughCache = new Map<string | symbol, unknown>();
  return new Proxy(stmt, {
    get(target, prop) {
      if (typeof prop === 'string' && TIMED_METHODS.has(prop)) {
        let fn = timedCache.get(prop);
        if (!fn) {
          const orig = (target as Record<string, unknown>)[prop];
          if (typeof orig !== 'function') return orig;
          const bound = (orig as (...a: unknown[]) => unknown).bind(target);
          fn = (...args: unknown[]) => {
            if (!enabled) return bound(...args);
            const start = performance.now();
            try {
              return bound(...args);
            } finally {
              recordStatementTiming(tag, performance.now() - start);
            }
          };
          timedCache.set(prop, fn);
        }
        return fn;
      }
      // Forward the real target as the receiver, NOT the Proxy. better-sqlite3
      // Statement exposes `.reader`/`.readonly`/`.busy`/`.source`/`.database`
      // as native prototype getters that unwrap `this`; invoking them with
      // `this === proxy` throws a TypeError on the native unwrap. Reading
      // against `target` keeps those getters working.
      const value = Reflect.get(target, prop, target);
      if (typeof value === 'function') {
        let bound = passthroughCache.get(prop);
        if (!bound) {
          bound = value.bind(target);
          passthroughCache.set(prop, bound);
        }
        return bound;
      }
      return value;
    },
  }) as T;
}

/**
 * Wrap every statement in a `Stmts`-shaped map. Returns the map UNCHANGED when
 * instrumentation is disabled, so production (the default) pays zero overhead.
 * Non-statement entries (anything without a callable `run`) are passed through.
 */
export function instrumentStmts<S extends object>(stmts: S): S {
  if (!enabled) return stmts;
  const out: Record<string, unknown> = {};
  for (const [tag, value] of Object.entries(stmts)) {
    if (
      value &&
      typeof value === 'object' &&
      typeof (value as { run?: unknown }).run === 'function'
    ) {
      out[tag] = instrumentStatement(value as object, tag);
    } else {
      out[tag] = value;
    }
  }
  return out as S;
}
