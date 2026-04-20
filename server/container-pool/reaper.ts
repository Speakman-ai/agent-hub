/**
 * Container-pool reaper cron (W4).
 *
 * The reaper is the *authoritative* cleanup path for the container pool.
 * GitHub webhooks drive the happy path (open PR → build env; close PR →
 * teardown), but webhooks drop — the delivery service misses a retry,
 * the server restarts mid-request, the installation token expires for
 * 30 seconds. When a teardown signal is lost the slot stays `busy`
 * forever, a container keeps consuming memory + a host port, and the
 * pool slowly starves.
 *
 * This module runs every 2–5 minutes via the scheduler (`heartbeat.ts`)
 * and converges the pool back to a consistent state by reconciling four
 * independent sources of truth:
 *
 *   1. `pool_slots` rows (what the allocator thinks is running)
 *   2. Docker Compose projects (what the daemon says is running)
 *   3. `pr_env_ports` (what ports are reserved)
 *   4. GitHub PR state (whether the PR backing a slot is still open)
 *
 * For each mismatch the reaper takes the minimum-privilege action:
 *
 *   • Slot says busy but PR is closed on GitHub → `markEvicting(slot)`.
 *     We do NOT call `docker compose down` directly; the lifecycle
 *     layer owns teardown and calls `release()` when done. This matches
 *     the W4 eviction split (accounting vs. IO) so a double-invocation
 *     can't double-teardown.
 *
 *   • Slot marked `reserved` (provisioning) past `provisioningStaleMs`
 *     with no progress → reclaim to `free`. A crashed scaffold mid-
 *     git-push leaves this state behind. The atomic
 *     `UPDATE ... WHERE status='reserved'` claim is what makes the
 *     reaper safe to run concurrently — only one racer sees `changes>0`.
 *
 *   • Slot marked `draining` past `drainingStaleMs` → treat as stuck;
 *     release back to free. The lifecycle layer's `docker compose down
 *     --timeout 30` should never take this long; if it did, the
 *     container is either gone or unresponsive and holding the slot
 *     gains us nothing.
 *
 *   • Compose project exists but no slot references its container →
 *     orphan. `compose down` it. Bounded by the pool size (max ~12) so
 *     we never iterate an unbounded set.
 *
 *   • Port reservation in `pr_env_ports` whose PR has no live slot and
 *     is closed on GitHub → release the port.
 *
 * Idempotency is a two-layer defense. First, a singleton advisory lock
 * row (`pool_reaper_lock`) gates concurrent ticks at the process level.
 * Second, every mutation uses an atomic `UPDATE ... WHERE status = ?`
 * precondition so even if the lock somehow admits two workers (clock
 * skew, TTL miscount) the worst case is one of them does nothing.
 *
 * All IO is behind small injectable interfaces (`ReaperDockerOps`,
 * `ReaperGitHubOps`) so the test suite can simulate every edge case
 * without a real Docker daemon or GitHub app.
 */

import type { Database } from 'better-sqlite3';
import { randomUUID } from 'crypto';
import type { Clock } from './allocator.js';
import { systemClock, type PoolAllocator } from './allocator.js';

/** DDL for the singleton advisory lock table. Applied by `Reaper.init()`. */
export const REAPER_LOCK_SCHEMA = `
  CREATE TABLE IF NOT EXISTS pool_reaper_lock (
    id          TEXT PRIMARY KEY,
    holder_id   TEXT NOT NULL,
    acquired_at TEXT NOT NULL,
    expires_at  TEXT NOT NULL
  );
`;

/** The only lock row we ever write. Treat the table as a singleton mutex. */
const LOCK_ID = 'singleton';

/**
 * Docker adapter — everything the reaper needs from the daemon. Production
 * binds this to `docker ps --filter label=com.docker.compose.project=...` +
 * `docker compose down`; tests pass in an in-memory fake.
 */
export interface ReaperDockerOps {
  /**
   * List every PR-env compose project currently running. Returns one entry
   * per *project* (not per container) so the reaper reasons at the same
   * granularity as `pool_slots`. The `prNumber` is parsed out of the
   * project name (`agent-hub-pr-<N>`) so the caller doesn't need to know
   * the naming convention.
   */
  listPrEnvProjects(): Promise<Array<{ projectName: string; prNumber: number }>>;
  /**
   * Best-effort `docker compose --project-name <name> down
   * --remove-orphans --volumes`. Errors are logged by the reaper and
   * swallowed — a stuck teardown must not block the rest of the tick.
   */
  composeDown(projectName: string): Promise<void>;
}

/**
 * GitHub adapter. `null` means "PR not found" (deleted / wrong repo /
 * rate-limited). On null we skip that slot and try again next tick rather
 * than risk an erroneous eviction.
 */
export interface ReaperGitHubOps {
  getPrState(repoFullName: string, prNumber: number): Promise<'open' | 'closed' | 'draft' | null>;
}

export interface ReaperConfig {
  /**
   * A slot in `reserved` (provisioning) without a `last_activity_at`
   * update for this long is considered a crashed scaffold / mid-build
   * failure. Reclaimed to `free`. Default 10 min — scaffold builds
   * normally finish in seconds, so this is generous.
   */
  provisioningStaleMs: number;
  /**
   * A slot stuck in `draining` past this is considered a stuck teardown.
   * The lifecycle layer's `docker compose down --timeout 30` should
   * complete in under a minute; anything past 5 minutes means the
   * daemon is wedged or the callback was lost. Reclaim to `free` so the
   * slot can re-enter the pool.
   */
  drainingStaleMs: number;
  /**
   * TTL for the advisory lock. A reaper that crashes mid-tick won't
   * release the lock in `finally`, so a later tick needs to reclaim it
   * after the lease expires. Must be longer than the 95th-percentile
   * reaper run but shorter than the cron interval. Default 2 min for a
   * 3-min cron.
   */
  lockTtlMs: number;
  /**
   * Repository the reaper assumes slots belong to when cross-checking
   * PR state. Most pools serve a single repo; if you need multi-repo
   * support, pass a function in via `getRepoForSlot` on the deps.
   */
  defaultRepoFullName: string;
}

export const DEFAULT_REAPER_CONFIG: ReaperConfig = {
  provisioningStaleMs: 10 * 60 * 1000,
  drainingStaleMs: 5 * 60 * 1000,
  lockTtlMs: 2 * 60 * 1000,
  defaultRepoFullName: '',
};

export interface ReaperDeps {
  db: Database;
  allocator: PoolAllocator;
  docker: ReaperDockerOps;
  github: ReaperGitHubOps;
  clock?: Clock;
  config?: Partial<ReaperConfig>;
  /** Override the default repo mapping per slot. Optional. */
  getRepoForSlot?: (slotId: string, prNumber: number) => string;
  /** Injectable logger; defaults to console. */
  logger?: {
    log: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };
}

/**
 * Structured summary of one reaper tick. Counters reset per tick so
 * metrics / tests can assert exact work done without tracking deltas.
 * `skipped` is true when the advisory lock couldn't be acquired (another
 * tick is in flight) — the counters are all zero in that case.
 */
export interface ReaperTickResult {
  skipped: boolean;
  /** Slots transitioned to `draining` because their PR is closed on GitHub. */
  webhookDropEvictions: number;
  /** Slots reclaimed from `reserved` past the provisioning timeout. */
  crashedScaffolds: number;
  /** Slots reclaimed from `draining` past the draining timeout. */
  stuckDraining: number;
  /** Compose projects torn down because no slot row referenced them. */
  orphanedProjects: number;
  /** `pr_env_ports` rows released because the backing PR is closed / gone. */
  stalePortsReleased: number;
  /** Best-effort string summaries for logs. Bounded by the counters above. */
  notes: string[];
}

interface SlotRow {
  slot_id: string;
  class: 'pr_env' | 'scaffold' | 'overflow';
  status: 'free' | 'reserved' | 'busy' | 'draining' | 'failed';
  container_id: string | null;
  started_at: string | null;
  last_activity_at: string | null;
  pr_number: number | null;
  pr_state: 'open' | 'closed' | 'draft' | null;
}

interface PortRow {
  repo_full_name: string;
  pr_number: number;
  port: number;
}

/**
 * Parse the `datetime('now')` / ISO format that `pool_slots` columns use.
 * Returns null on missing/unparseable input so callers can short-circuit
 * without an NaN bomb. SQLite emits UTC without a trailing 'Z'; we
 * normalise that so `Date.parse` treats it as UTC instead of local.
 */
function parseDbTime(raw: string | null): number | null {
  if (!raw) return null;
  const normalised = raw.includes('T') ? raw : raw.replace(' ', 'T') + 'Z';
  const parsed = Date.parse(normalised);
  return Number.isFinite(parsed) ? parsed : null;
}

export class Reaper {
  private readonly db: Database;
  private readonly allocator: PoolAllocator;
  private readonly docker: ReaperDockerOps;
  private readonly github: ReaperGitHubOps;
  private readonly clock: Clock;
  private readonly config: ReaperConfig;
  private readonly getRepoForSlot: (slotId: string, prNumber: number) => string;
  private readonly logger: NonNullable<ReaperDeps['logger']>;
  /**
   * Stable per-instance holder id for the advisory lock. Lets a long-running
   * tick that outlives its TTL recognise its own stale lock row and refresh
   * it rather than colliding with a phantom self.
   */
  private readonly holderId = randomUUID();

  constructor(deps: ReaperDeps) {
    this.db = deps.db;
    this.allocator = deps.allocator;
    this.docker = deps.docker;
    this.github = deps.github;
    this.clock = deps.clock ?? systemClock;
    this.config = { ...DEFAULT_REAPER_CONFIG, ...(deps.config ?? {}) };
    this.getRepoForSlot = deps.getRepoForSlot ?? (() => this.config.defaultRepoFullName);
    this.logger = deps.logger ?? {
      log: (m) => console.log(m),
      warn: (m) => console.warn(m),
      error: (m) => console.error(m),
    };
  }

  /** Apply the lock DDL. Safe to call repeatedly — the CREATE is IF NOT EXISTS. */
  init(): void {
    this.db.exec(REAPER_LOCK_SCHEMA);
  }

  /**
   * Atomic lock acquisition. Uses INSERT-or-UPDATE-with-precondition so
   * two concurrent callers can never both observe success.
   *
   * The row carries `expires_at`. A stale lock (crashed holder that
   * never released) is auto-reclaimed once its lease is past.
   *
   * Returns true iff this caller holds the lock after the call.
   */
  acquireLock(now: number = this.clock.nowMs()): boolean {
    const nowIso = this.clock.nowIso();
    const expiresIso = new Date(now + this.config.lockTtlMs)
      .toISOString()
      .slice(0, 19)
      .replace('T', ' ');

    // Fast path: no row, just insert. `INSERT OR IGNORE` makes this a
    // no-op if someone else raced us; we fall through to the steal path.
    const ins = this.db
      .prepare(
        `INSERT OR IGNORE INTO pool_reaper_lock (id, holder_id, acquired_at, expires_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(LOCK_ID, this.holderId, nowIso, expiresIso);
    if (ins.changes > 0) return true;

    // Steal path: only if the current lock's lease has expired. The WHERE
    // clause is what makes this atomic — if another live holder exists,
    // `changes` is 0 and we report failure.
    const steal = this.db
      .prepare(
        `UPDATE pool_reaper_lock
            SET holder_id = ?, acquired_at = ?, expires_at = ?
          WHERE id = ? AND expires_at <= ?`,
      )
      .run(this.holderId, nowIso, expiresIso, LOCK_ID, nowIso);
    return steal.changes > 0;
  }

  /**
   * Release the lock iff we still hold it. The `WHERE holder_id = ?`
   * guard prevents a late-returning tick from clobbering a successor's
   * lease after its own TTL expired.
   */
  releaseLock(): void {
    this.db
      .prepare('DELETE FROM pool_reaper_lock WHERE id = ? AND holder_id = ?')
      .run(LOCK_ID, this.holderId);
  }

  /**
   * Run one full reaper pass. Never throws — operational failures (Docker
   * unreachable, GitHub rate-limited) are logged and surfaced in `notes`
   * so the next tick retries. Callers: the heartbeat scheduler and the
   * `/settings/pool` "run now" button.
   */
  async run(): Promise<ReaperTickResult> {
    const result: ReaperTickResult = {
      skipped: false,
      webhookDropEvictions: 0,
      crashedScaffolds: 0,
      stuckDraining: 0,
      orphanedProjects: 0,
      stalePortsReleased: 0,
      notes: [],
    };

    if (!this.acquireLock()) {
      result.skipped = true;
      result.notes.push('lock held by another reaper; skipping tick');
      return result;
    }

    try {
      await this.reapWebhookDrops(result);
      this.reapCrashedScaffolds(result);
      this.reapStuckDraining(result);
      await this.reapOrphanedComposeProjects(result);
      await this.reapStalePortReservations(result);
    } catch (err) {
      this.logger.error(`[reaper] tick threw: ${(err as Error).message}`);
      result.notes.push(`error: ${(err as Error).message}`);
    } finally {
      this.releaseLock();
    }

    return result;
  }

  // ─── 1. Webhook-drop recovery ─────────────────────────────────────────

  /**
   * For every running PR-env slot, ask GitHub whether the backing PR is
   * still open. If it's closed and we haven't already started draining,
   * enqueue for eviction.
   *
   * Uses `allocator.markEvicting()` rather than tearing the container
   * down directly. That keeps the reaper cooperative with the
   * lifecycle layer: we flip the accounting bit, and the next
   * lifecycle callback runs `docker compose down`. Same split as the
   * scored-eviction path, so the two code paths can coexist safely.
   */
  private async reapWebhookDrops(result: ReaperTickResult): Promise<void> {
    const rows = this.db
      .prepare(
        `SELECT slot_id, class, status, container_id, started_at, last_activity_at,
                pr_number, pr_state
           FROM pool_slots
          WHERE status = 'busy'
            AND pr_number IS NOT NULL
            AND (class = 'pr_env' OR class = 'overflow')`,
      )
      .all() as SlotRow[];

    for (const row of rows) {
      if (row.pr_number == null) continue;
      const repo = this.getRepoForSlot(row.slot_id, row.pr_number);
      if (!repo) {
        // No repo mapping configured — skip silently, the allocator may
        // have orphaned metadata from a config change.
        continue;
      }

      let state: 'open' | 'closed' | 'draft' | null = null;
      try {
        state = await this.github.getPrState(repo, row.pr_number);
      } catch (err) {
        // Network / rate-limit / auth error. Leave the slot alone and
        // pick it up on the next tick — NEVER evict on an error path.
        this.logger.warn(
          `[reaper] getPrState failed for ${repo}#${row.pr_number}: ${(err as Error).message}`,
        );
        continue;
      }
      if (state === null) continue; // unknown — try again later
      if (state !== 'closed') continue;

      // Cache the observation so operator tooling can see why the slot
      // is being evicted without re-hitting the GitHub API.
      this.allocator.updatePrMetadata(row.slot_id, { prState: 'closed' });

      // Atomic: only one racer can flip busy → draining. If markEvicting
      // returns false the slot was already claimed, which is fine.
      if (this.allocator.markEvicting(row.slot_id)) {
        result.webhookDropEvictions++;
        result.notes.push(`evicted ${row.slot_id} (pr #${row.pr_number} closed per GitHub)`);
      }
    }
  }

  // ─── 2. Crashed-scaffold recovery ─────────────────────────────────────

  /**
   * Atomically reclaim any slot that's been `reserved` without progress
   * past `provisioningStaleMs`. Uses the precondition
   * `status='reserved' AND last_activity_at <= cutoff` on the UPDATE so
   * two concurrent reapers can't both credit themselves with the same
   * reclaim.
   */
  private reapCrashedScaffolds(result: ReaperTickResult): void {
    const cutoff = new Date(this.clock.nowMs() - this.config.provisioningStaleMs)
      .toISOString()
      .slice(0, 19)
      .replace('T', ' ');

    const info = this.db
      .prepare(
        `UPDATE pool_slots
            SET status = 'free',
                container_id = NULL,
                started_at = NULL,
                last_activity_at = NULL,
                last_error = NULL
          WHERE status = 'reserved'
            AND (last_activity_at IS NULL OR last_activity_at <= ?)`,
      )
      .run(cutoff);
    if (info.changes > 0) {
      result.crashedScaffolds = Number(info.changes);
      result.notes.push(`reclaimed ${info.changes} crashed scaffold(s)`);
    }
  }

  // ─── 3. Stuck-draining recovery ───────────────────────────────────────

  /**
   * A slot stuck `draining` past the configured window means the
   * lifecycle layer's teardown either crashed or was lost (server
   * restart during `docker compose down`). Force-release so the slot
   * can re-enter the pool.
   *
   * We don't attempt a best-effort `compose down` here — the orphaned-
   * compose-projects pass below will catch any leftover project on the
   * next scan.
   */
  private reapStuckDraining(result: ReaperTickResult): void {
    const cutoff = new Date(this.clock.nowMs() - this.config.drainingStaleMs)
      .toISOString()
      .slice(0, 19)
      .replace('T', ' ');

    const info = this.db
      .prepare(
        `UPDATE pool_slots
            SET status = 'free',
                container_id = NULL,
                started_at = NULL,
                last_activity_at = NULL,
                last_error = NULL,
                pr_number = NULL,
                pr_state = NULL,
                pr_last_commit_at = NULL,
                last_http_hit_at = NULL,
                reviewer_activity_at = NULL
          WHERE status = 'draining'
            AND (started_at IS NULL OR started_at <= ?)`,
      )
      .run(cutoff);
    if (info.changes > 0) {
      result.stuckDraining = Number(info.changes);
      result.notes.push(`force-released ${info.changes} stuck-draining slot(s)`);
    }
  }

  // ─── 4. Orphaned compose projects ─────────────────────────────────────

  /**
   * Tear down any compose project whose PR number has no live, PR-bound
   * slot. Handles the "slot row gone but container still running" case
   * (e.g. the slot was force-released by the stuck-draining pass above,
   * or the allocator lost track during a migration).
   *
   * We only consider projects in the `agent-hub-pr-*` namespace — the
   * compose project name convention from `pr-env-builder.ts`. Any other
   * project is out-of-scope for this reaper.
   */
  private async reapOrphanedComposeProjects(result: ReaperTickResult): Promise<void> {
    let projects: Array<{ projectName: string; prNumber: number }>;
    try {
      projects = await this.docker.listPrEnvProjects();
    } catch (err) {
      this.logger.warn(`[reaper] listPrEnvProjects failed: ${(err as Error).message}`);
      return;
    }
    if (projects.length === 0) return;

    // All PR numbers currently bound to a live slot. Anything in docker
    // but not here is orphaned.
    const live = new Set<number>(
      (
        this.db
          .prepare(
            `SELECT pr_number FROM pool_slots
              WHERE pr_number IS NOT NULL
                AND status IN ('reserved','busy','draining')`,
          )
          .all() as Array<{ pr_number: number }>
      ).map((r) => r.pr_number),
    );

    for (const proj of projects) {
      if (live.has(proj.prNumber)) continue;
      try {
        await this.docker.composeDown(proj.projectName);
        result.orphanedProjects++;
        result.notes.push(`composeDown orphaned ${proj.projectName}`);
      } catch (err) {
        this.logger.warn(
          `[reaper] composeDown ${proj.projectName} failed: ${(err as Error).message}`,
        );
      }
    }
  }

  // ─── 5. Stale port reservations ───────────────────────────────────────

  /**
   * A port in `pr_env_ports` whose PR has no live slot AND is closed on
   * GitHub is a leaked reservation. Release it so the port can be
   * handed back out. We're conservative here: if GitHub is unreachable
   * or reports the PR as open we leave the reservation alone.
   */
  private async reapStalePortReservations(result: ReaperTickResult): Promise<void> {
    // Port-pool table is owned by a different module; it may not be
    // applied in all tests. Guard the query so the reaper is a no-op
    // when the table is absent.
    const tableExists = this.db
      .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='pr_env_ports'")
      .get() as { ok: number } | undefined;
    if (!tableExists) return;

    const rows = this.db
      .prepare(`SELECT repo_full_name, pr_number, port FROM pr_env_ports`)
      .all() as PortRow[];
    if (rows.length === 0) return;

    const liveSlotPrs = new Set<number>(
      (
        this.db
          .prepare(
            `SELECT pr_number FROM pool_slots
              WHERE pr_number IS NOT NULL
                AND status IN ('reserved','busy','draining')`,
          )
          .all() as Array<{ pr_number: number }>
      ).map((r) => r.pr_number),
    );

    for (const row of rows) {
      if (liveSlotPrs.has(row.pr_number)) continue;

      let state: 'open' | 'closed' | 'draft' | null = null;
      try {
        state = await this.github.getPrState(row.repo_full_name, row.pr_number);
      } catch (err) {
        this.logger.warn(
          `[reaper] getPrState failed for ${row.repo_full_name}#${row.pr_number}: ${(err as Error).message}`,
        );
        continue;
      }
      if (state !== 'closed') continue;

      const del = this.db
        .prepare(
          `DELETE FROM pr_env_ports
            WHERE repo_full_name = ? AND pr_number = ? AND port = ?`,
        )
        .run(row.repo_full_name, row.pr_number, row.port);
      if (del.changes > 0) {
        result.stalePortsReleased++;
        result.notes.push(
          `released port ${row.port} (${row.repo_full_name}#${row.pr_number}, pr closed)`,
        );
      }
    }
  }
}

/**
 * Convenience: inspect a slot row's staleness without running the full
 * tick. Exposed for operator tooling and tests that want to assert on
 * the "is this slot a reap candidate" predicate directly.
 */
export function isProvisioningStale(
  row: { status: string; last_activity_at: string | null },
  now: number,
  staleMs: number,
): boolean {
  if (row.status !== 'reserved') return false;
  const ms = parseDbTime(row.last_activity_at);
  if (ms == null) return true; // unknown timestamp → treat as stale
  return now - ms >= staleMs;
}
