/**
 * PR-env port pool (W2).
 *
 * Hands out a unique host port from a fixed range (default 3100–3999) to a
 * PR preview env, and releases it when the PR closes/merges. Backed by a
 * dedicated SQLite table `pr_env_ports` so allocation is durable across
 * server restarts — a restart must not re-use a port that's still bound to
 * a running container.
 *
 * Why not reuse `pool_slots`?
 *   `pool_slots` is a *fixed* fleet (pr-1..N) keyed by slot_id. The port
 *   pool is keyed by (repo, PR number) → host port, with hundreds of
 *   possible ports — different shape, different lifecycle, different
 *   UNIQUE key. Jamming it into `pool_slots` would overload the schema.
 *
 * Concurrency:
 *   better-sqlite3 serialises synchronous calls per-process, but a
 *   future async path (or a second process via WAL) could race two
 *   allocations. The `UNIQUE(port)` constraint + bounded retry loop
 *   handles that: if a concurrent writer claimed our chosen port
 *   between SELECT and INSERT, we rescan and try the next free port.
 *
 * Idempotency:
 *   `pull_request.synchronize` fires on every push. `allocatePort()` is
 *   idempotent per `(repoFullName, prNumber)` — re-allocating for an
 *   already-assigned PR returns the existing port rather than consuming
 *   a new one.
 */

import type { Database } from 'better-sqlite3';

/** Inclusive port range. 900 ports is plenty of headroom for W2. */
export const DEFAULT_PORT_RANGE = { min: 3100, max: 3999 } as const;

export interface PortRange {
  readonly min: number;
  readonly max: number;
}

export interface PortAllocation {
  prNumber: number;
  repoFullName: string;
  port: number;
  allocatedAt: string;
}

/**
 * Thrown when every port in the configured range is already allocated.
 * Carries the range for logging / Slack alerts.
 */
export class PortPoolExhaustedError extends Error {
  public readonly range: PortRange;
  public readonly allocatedCount: number;
  constructor(range: PortRange, allocatedCount: number) {
    super(
      `PR-env port pool exhausted: all ${range.max - range.min + 1} ports in ` +
        `[${range.min}, ${range.max}] are allocated (${allocatedCount} in use).`,
    );
    this.name = 'PortPoolExhaustedError';
    this.range = range;
    this.allocatedCount = allocatedCount;
  }
}

/** DDL for the port pool. Exported so tests can seed :memory: DBs. */
export const PORT_POOL_SCHEMA = `
  CREATE TABLE IF NOT EXISTS pr_env_ports (
    repo_full_name TEXT NOT NULL,
    pr_number      INTEGER NOT NULL,
    port           INTEGER NOT NULL UNIQUE,
    allocated_at   TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (repo_full_name, pr_number)
  );
  CREATE INDEX IF NOT EXISTS idx_pr_env_ports_port ON pr_env_ports(port);
`;

export class PortPool {
  private readonly db: Database;
  private readonly range: PortRange;

  constructor(db: Database, options: { range?: PortRange } = {}) {
    this.db = db;
    this.range = options.range ?? DEFAULT_PORT_RANGE;
    if (this.range.min > this.range.max) {
      throw new Error(`Invalid port range: ${this.range.min}..${this.range.max}`);
    }
  }

  /** Apply the schema to the backing DB. Safe to call repeatedly. */
  init(): void {
    this.db.exec(PORT_POOL_SCHEMA);
  }

  /**
   * Reserve a port for `(repoFullName, prNumber)`. Idempotent — if the pair
   * already has a port, that port is returned. Otherwise the lowest free
   * port in the configured range is allocated.
   *
   * Throws `PortPoolExhaustedError` if the range is fully occupied.
   */
  allocatePort(repoFullName: string, prNumber: number): number {
    const existing = this.getPort(repoFullName, prNumber);
    if (existing != null) return existing;

    // Bounded retry handles the rare (synchronous) race where two
    // allocate() calls pick the same gap; the UNIQUE(port) constraint
    // turns the loser into a recoverable error.
    const maxAttempts = this.rangeSize();
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const candidate = this.findFirstFreePort();
      if (candidate == null) {
        throw new PortPoolExhaustedError(this.range, this.allocatedCount());
      }
      try {
        this.db
          .prepare(
            `INSERT INTO pr_env_ports (repo_full_name, pr_number, port)
             VALUES (?, ?, ?)`,
          )
          .run(repoFullName, prNumber, candidate);
        return candidate;
      } catch (err) {
        // Translate the UNIQUE conflict into a retry. Any other error is
        // fatal (surfaces the real SQLite problem).
        const msg = (err as Error).message || '';
        if (!/UNIQUE constraint failed/i.test(msg)) throw err;
      }
    }
    // If we bounced off UNIQUE conflicts for every port in the range
    // without success, the pool really is full.
    throw new PortPoolExhaustedError(this.range, this.allocatedCount());
  }

  /**
   * Release the port for `(repoFullName, prNumber)`. Returns true iff a
   * row was deleted. No-op for unknown PRs so webhook `pull_request.closed`
   * can be safely replayed.
   */
  releasePort(repoFullName: string, prNumber: number): boolean {
    const info = this.db
      .prepare('DELETE FROM pr_env_ports WHERE repo_full_name = ? AND pr_number = ?')
      .run(repoFullName, prNumber);
    return info.changes > 0;
  }

  /** Current port for the given PR, or null if none is allocated. */
  getPort(repoFullName: string, prNumber: number): number | null {
    const row = this.db
      .prepare(`SELECT port FROM pr_env_ports WHERE repo_full_name = ? AND pr_number = ?`)
      .get(repoFullName, prNumber) as { port: number } | undefined;
    return row?.port ?? null;
  }

  /** All live allocations — used by /settings/pool and tests. */
  listAllocations(): PortAllocation[] {
    const rows = this.db
      .prepare(
        `SELECT repo_full_name AS repoFullName, pr_number AS prNumber,
                port, allocated_at AS allocatedAt
           FROM pr_env_ports
           ORDER BY port ASC`,
      )
      .all() as PortAllocation[];
    return rows;
  }

  /** Number of currently-allocated ports. Cheap; used for metrics/errors. */
  allocatedCount(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM pr_env_ports').get() as { n: number }).n;
  }

  /** Read the configured port range. */
  getRange(): PortRange {
    return this.range;
  }

  // ─── internals ────────────────────────────────────────────────────────

  private rangeSize(): number {
    return this.range.max - this.range.min + 1;
  }

  /**
   * Scan the range in ascending order and return the lowest unallocated
   * port, or null when the range is full. We query once for the occupied
   * set and walk in JS — the range is capped at ~900 so this is O(n) on a
   * tiny set and avoids a recursive CTE.
   */
  private findFirstFreePort(): number | null {
    const taken = new Set(
      (
        this.db
          .prepare('SELECT port FROM pr_env_ports WHERE port BETWEEN ? AND ? ORDER BY port')
          .all(this.range.min, this.range.max) as { port: number }[]
      ).map((r) => r.port),
    );
    for (let p = this.range.min; p <= this.range.max; p++) {
      if (!taken.has(p)) return p;
    }
    return null;
  }
}
