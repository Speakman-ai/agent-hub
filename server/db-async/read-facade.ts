/**
 * Async read facade — the seam Phase-2 route handlers call instead of running a
 * heavy SELECT synchronously on the main thread.
 *
 * Per the locked `facade-scope` decision, ONLY measured-slow READ paths route
 * through here; writes and transactions stay synchronous on the main thread.
 * The facade is deliberately statement-based (not raw-SQL): callers pass the
 * existing prepared `Stmts` entry, and the facade reads its `.source` so the SQL
 * text has a single source of truth and can never drift from the sync path.
 *
 * Two implementations, one interface:
 *   - `poolReadFacade` (production default) forwards `stmt.source` + params to the
 *     shared `worker_threads` reader pool, so the SQLite work happens off the
 *     event loop.
 *   - `syncReadFacade` runs the statement on the calling thread and resolves a
 *     Promise. Tests install it via {@link setReadFacadeForTesting} so route
 *     integration tests stay fast and deterministic (no worker spawn / teardown)
 *     while exercising the exact same async handler code. The reader pool itself
 *     is covered directly by `reader-pool.test.ts` and `read-facade.test.ts`.
 */
import { getSharedReaderPool } from './index.js';

/** Minimal surface the facade needs from a better-sqlite3 (or instrumented) statement. */
export interface ReadableStatement {
  /** Raw SQL text — forwarded to the reader pool. */
  readonly source: string;
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
}

export interface AsyncReadFacade {
  all<Row = unknown>(stmt: ReadableStatement, params?: unknown[]): Promise<Row[]>;
  get<Row = unknown>(stmt: ReadableStatement, params?: unknown[]): Promise<Row | undefined>;
}

/** Production default: run the read on the shared worker pool, off the event loop. */
export const poolReadFacade: AsyncReadFacade = {
  all: <Row = unknown>(stmt: ReadableStatement, params: unknown[] = []) =>
    getSharedReaderPool().all<Row>(stmt.source, params),
  get: <Row = unknown>(stmt: ReadableStatement, params: unknown[] = []) =>
    getSharedReaderPool().get<Row>(stmt.source, params),
};

/**
 * Synchronous-backed facade: runs the statement on the calling thread and wraps
 * the result in a resolved Promise. Behaviour-identical to the sync path for the
 * success case. Used by the test harness (and available as a safe fallback for
 * environments where spawning workers is undesirable).
 */
export const syncReadFacade: AsyncReadFacade = {
  all: <Row = unknown>(stmt: ReadableStatement, params: unknown[] = []) =>
    Promise.resolve(stmt.all(...params) as Row[]),
  get: <Row = unknown>(stmt: ReadableStatement, params: unknown[] = []) =>
    Promise.resolve(stmt.get(...params) as Row | undefined),
};

let override: AsyncReadFacade | null = null;

/**
 * Install a facade override (test harness installs {@link syncReadFacade}).
 * Pass `null` to restore the production pool-backed facade.
 */
export function setReadFacadeForTesting(facade: AsyncReadFacade | null): void {
  override = facade;
}

/** Resolve the active facade — the test override if set, else the pool default. */
export function getReadFacade(): AsyncReadFacade {
  return override ?? poolReadFacade;
}

/** Convenience: async `all` through the active facade. */
export function readAll<Row = unknown>(
  stmt: ReadableStatement,
  params: unknown[] = [],
): Promise<Row[]> {
  return getReadFacade().all<Row>(stmt, params);
}

/** Convenience: async `get` through the active facade. */
export function readGet<Row = unknown>(
  stmt: ReadableStatement,
  params: unknown[] = [],
): Promise<Row | undefined> {
  return getReadFacade().get<Row>(stmt, params);
}
