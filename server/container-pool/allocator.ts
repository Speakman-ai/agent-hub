/**
 * Container pool allocator + dispatcher (W1).
 *
 * Implements the scheduling half of the container-pool spec (wiki page
 * "Container Pool — PR Envs + Scaffolding", §2 two-queue design and §4
 * preemption rules). Actual container spawn/reap is out of scope — this
 * module is the pure accounting layer over `pool_slots`, `pool_queue`,
 * and `pool_metrics`.
 *
 * Shape:
 *
 *   PoolAllocator — manages slot accounting, enqueue, release, and a
 *                   single `tick()` call that performs one dispatch pass.
 *                   All time comes from an injectable `Clock` so tests can
 *                   use Vitest fake timers.
 *
 *   startDispatcher — thin wrapper that drives `tick()` on a fixed 1 Hz
 *                     interval in production. Returns a stop function.
 *
 * Contract highlights (see wiki §1.4, §2.2 for full prose):
 *
 *   • Two independent FIFO queues: `pr_env` and `scaffold`. Queue ordering
 *     is (priority_tier DESC, enqueued_at ASC); for W1 every request comes
 *     in at priority_tier = 0, so this collapses to plain FIFO.
 *
 *   • Scaffolding NEVER preempts a running PR env. There is no eviction
 *     path for scaffold requests; they queue or fall through to overflow.
 *
 *   • The shared overflow slot is assigned per tick: PR-env head wins
 *     unconditionally, scaffold head wins iff the PR-env queue is empty
 *     at dispatch time. This matches the wiki §2.3 dispatcher loop and
 *     the W3 demo-day requirement ("scaffolding may only take overflow
 *     when the PR-env queue is empty"). Because every PR that arrives
 *     during a tick's transaction is observed in the next peek, the
 *     queue-empty check is equivalent to "no PR is waiting right now".
 *
 *   • `scaffoldOverflowWaitMs` (default 0) is a retained knob that lets
 *     us delay scaffold-overflow eligibility by a bounded wait on top of
 *     the queue-empty check. Kept for ops flexibility — W3 runs at 0ms
 *     per the wiki spec, but a future week can raise it if a spike
 *     pattern shows scaffold racing a PR arriving within sub-tick
 *     windows. When > 0 the rule is "PR queue empty AND scaffold has
 *     waited at least this long".
 *
 *   • `priority_tier` index decision (W1): deferred. All requests pin to
 *     tier 0 until the enterprise opt-out lands, so the existing
 *     `(status, enqueued_at)` composite index already answers the
 *     dispatcher's hot-path query with a single scan. Adding
 *     `priority_tier DESC` now would cost an index write on every enqueue
 *     for zero benefit — revisit in the same migration that introduces
 *     tier > 0 rows.
 */

import type { Database } from 'better-sqlite3';
import { randomUUID } from 'crypto';
import type { ExitReason } from './docker-lifecycle.js';
import { isQuotaViolation } from './docker-lifecycle.js';

export type QueueClass = 'pr_env' | 'scaffold';
export type SlotClass = QueueClass | 'overflow';
export type SlotStatus = 'free' | 'reserved' | 'busy' | 'draining' | 'failed';
export type QueueStatus = 'queued' | 'dispatching' | 'failed';

export interface Clock {
  /** Monotonic-ish wall clock, ms since epoch. Used for bounded-wait math. */
  nowMs(): number;
  /**
   * ISO-ish timestamp suitable for SQLite TEXT columns. Matches the format
   * `datetime('now')` produces so rows enqueued via default clauses and
   * rows inserted by this module sort consistently.
   */
  nowIso(): string;
}

export const systemClock: Clock = {
  nowMs: () => Date.now(),
  nowIso: () => new Date().toISOString().slice(0, 19).replace('T', ' '),
};

export interface AllocatorConfig {
  /** Dedicated PR-env slots (spec §1.3 target: 8). */
  prEnvSlots: number;
  /** Dedicated scaffold slots (spec §1.3 target: 3). */
  scaffoldSlots: number;
  /** Shared overflow slots (spec §1.3: 1). */
  overflowSlots: number;
  /**
   * Extra wait (ms) imposed on top of the queue-empty check before a
   * scaffold head can claim the overflow slot. PR-env requests always
   * bypass this. Default 0 — the W3 rule is "scaffold may take overflow
   * iff the PR-env queue is empty right now". Keep non-zero only if a
   * spike pattern shows sub-tick PR arrivals losing races to scaffold.
   */
  scaffoldOverflowWaitMs: number;
  /**
   * W4 eviction policy — window during which a PR env is considered
   * "human active" for the wiki §4.1 scoring term. An HTTP hit or
   * reviewer action newer than this drops the score by `humanActiveBoost`.
   * Default 10 min (600_000 ms) per spec.
   */
  humanActiveWindowMs: number;
  /**
   * W4 eviction policy — window during which reviewer activity hard-protects
   * a PR env from eviction. Unlike `humanActiveWindowMs` (a score term that
   * can in principle be overwhelmed by a very stale closed PR), a slot
   * within this window is filtered out of the candidate set entirely. Per
   * the W4 card: "Hard-protect PRs with reviewer activity in the last 10
   * minutes — these are never evicted even under pressure." Default 10 min.
   */
  reviewerProtectWindowMs: number;
  /**
   * W4 eviction policy — points subtracted from the score when the slot
   * is "human active" in the HTTP-hit sense. Matches wiki §4.1 (-100).
   * Exposed as config so tests can dial it without recompiling.
   */
  humanActiveBoost: number;
  /**
   * W4 eviction policy — points added when the PR is closed/merged. The
   * spec's +100 is dominant: a closed PR outscores even a freshly-committed
   * open one by enough to always be the first eviction target (modulo
   * reviewer-activity protection). Wiki §4.1.
   */
  closedPrBoost: number;
  /**
   * W4 eviction policy — points added when the PR is in draft state. Small
   * tie-breaker boost (draft PRs are less likely to have an active reviewer).
   * Wiki §4.1.
   */
  draftPrBoost: number;
  /**
   * W4 hard cap — when the PR-env queue grows past this depth AND every
   * PR-capable slot (dedicated + overflow) is busy with no eligible
   * eviction candidate, new PR-env requests are rejected outright. Spec
   * §4.2 pins this at 20. The acceptance check is exposed via
   * `canAcceptPrEnvRequest()`; callers (webhooks.ts) call it before
   * enqueuing so the GitHub commit-status can be set to `error` with the
   * saturated-pool message.
   */
  prQueueRejectThreshold: number;
}

export const DEFAULT_CONFIG: AllocatorConfig = {
  prEnvSlots: 8,
  scaffoldSlots: 3,
  overflowSlots: 1,
  scaffoldOverflowWaitMs: 0,
  humanActiveWindowMs: 10 * 60 * 1000,
  reviewerProtectWindowMs: 10 * 60 * 1000,
  humanActiveBoost: 100,
  closedPrBoost: 100,
  draftPrBoost: 5,
  prQueueRejectThreshold: 20,
};

/** A running PR-env slot scored as an eviction candidate. */
export interface EvictionCandidate {
  slotId: string;
  score: number;
  /**
   * True iff this slot is currently hard-protected by a recent reviewer
   * action. Protected slots never appear in `selectEvictionCandidate()`
   * but `scoreSlot()` still returns them so operators / metrics can see
   * the score the slot *would* have had without the protection.
   */
  reviewerProtected: boolean;
  prNumber: number | null;
  prState: 'open' | 'closed' | 'draft' | null;
}

/**
 * W4 acceptance-check result for a new incoming PR-env request.
 *
 * `queue`   — slot pressure is fine, caller should enqueue normally.
 * `evict`   — pool is saturated but an eviction candidate exists.
 *             Caller passes `slotId` to `markEvicting()` and enqueues;
 *             the freed slot will be picked up by the next tick.
 * `reject`  — saturated with no eviction candidate AND queue depth past
 *             `prQueueRejectThreshold`. Caller must not enqueue; return
 *             GitHub commit status `error`.
 */
export type PrEnvAdmission =
  | { decision: 'queue' }
  | { decision: 'evict'; slotId: string; score: number }
  | { decision: 'reject'; reason: 'queue_saturated' };

/** One successful queue→slot binding produced by `tick()`. */
export interface DispatchDecision {
  queueId: string;
  class: QueueClass;
  slotId: string;
  /** True if the binding consumed an overflow slot rather than a dedicated one. */
  assignedAsOverflow: boolean;
}

export interface TickMetrics {
  /** Busy+reserved+draining slots / total slots, clamped to [0,1]. */
  poolUtil: number;
  /** Sum of rows in `pool_queue` with status='queued' across both classes. */
  queueDepth: number;
  /**
   * Evictions initiated since the allocator was constructed (in-process
   * counter). W4 populates this each time a slot transitions to `draining`
   * via `markEvicting()`. Resets only on process restart — the dispatcher
   * subtracts prior samples to produce a per-sample delta for
   * `pool_metrics.evictions`.
   */
  evictions: number;
  /** Reaps performed this tick (W1 is queue-only — always 0). */
  reaps: number;
}

export interface TickResult {
  assigned: DispatchDecision[];
  /**
   * Number of queued scaffold requests that were held back because the
   * bounded wait had not yet elapsed. Surfaced so the dispatcher can log
   * a "scaffold waiting on PR envs" counter without re-querying.
   */
  scaffoldWaiting: number;
  /** Number of pr_env queue rows still queued at end of tick. */
  prEnvWaiting: number;
  metrics: TickMetrics;
}

interface QueueRow {
  id: string;
  class: QueueClass;
  payload: string;
  priority_tier: number;
  enqueued_at: string;
  enqueued_ms: number;
  status: QueueStatus;
}

interface SlotRow {
  slot_id: string;
  class: SlotClass;
  status: SlotStatus;
  container_id: string | null;
}

interface SlotScoringRow {
  slot_id: string;
  class: SlotClass;
  status: SlotStatus;
  container_id: string | null;
  started_at: string | null;
  last_activity_at: string | null;
  pr_number: number | null;
  pr_state: 'open' | 'closed' | 'draft' | null;
  pr_last_commit_at: string | null;
  last_http_hit_at: string | null;
  reviewer_activity_at: string | null;
}

/**
 * Parse a timestamp written by either `datetime('now')` (SQLite default,
 * `YYYY-MM-DD HH:MM:SS`) or our own `nowIso()` helper into ms. Falls back
 * to the current clock if the value is malformed — bounded-wait checks
 * treat unparseable timestamps as "just enqueued" which is the safe
 * direction (they wait the full window rather than jumping the queue).
 */
function parseEnqueuedMs(raw: string, clock: Clock): number {
  // SQLite's datetime('now') emits UTC without a trailing 'Z'; Date()
  // will parse that as local time, so we normalise to ISO-with-Z first.
  const normalised = raw.includes('T') ? raw : raw.replace(' ', 'T') + 'Z';
  const parsed = Date.parse(normalised);
  if (Number.isFinite(parsed)) return parsed;
  return clock.nowMs();
}

export class PoolAllocator {
  private readonly db: Database;
  private readonly config: AllocatorConfig;
  private readonly clock: Clock;
  /**
   * Monotonic in-process counter of eviction decisions *initiated* by this
   * allocator instance. A decision is counted once when the slot is
   * transitioned to `draining` via `markEvicting()`; the downstream lifecycle
   * layer is responsible for the actual container teardown. Never decremented,
   * so the dispatcher tracks deltas by diffing snapshots.
   */
  private evictionsInitiated = 0;

  constructor(db: Database, options: { config?: Partial<AllocatorConfig>; clock?: Clock } = {}) {
    this.db = db;
    this.config = { ...DEFAULT_CONFIG, ...(options.config ?? {}) };
    this.clock = options.clock ?? systemClock;
  }

  /**
   * Seed `pool_slots` with the configured fleet (pr-1..N, scaffold-1..M,
   * overflow-1..K). Safe to call repeatedly — existing rows are preserved
   * so a restart doesn't clobber live bindings.
   */
  init(): void {
    const insert = this.db.prepare(
      'INSERT OR IGNORE INTO pool_slots (slot_id, class, status) VALUES (?, ?, ?)',
    );
    const seed = this.db.transaction(() => {
      for (let i = 1; i <= this.config.prEnvSlots; i++) {
        insert.run(`pr-${i}`, 'pr_env', 'free');
      }
      for (let i = 1; i <= this.config.scaffoldSlots; i++) {
        insert.run(`scaffold-${i}`, 'scaffold', 'free');
      }
      for (let i = 1; i <= this.config.overflowSlots; i++) {
        insert.run(`overflow-${i}`, 'overflow', 'free');
      }
    });
    seed();
  }

  /**
   * Append a work item to the relevant queue. Returns the row id so the
   * caller can correlate it with future metrics / webhook status.
   */
  enqueue(
    class_: QueueClass,
    payload: unknown,
    options: { id?: string; priorityTier?: number; enqueuedAt?: string } = {},
  ): string {
    const id = options.id ?? randomUUID();
    const enqueuedAt = options.enqueuedAt ?? this.clock.nowIso();
    const serialised = typeof payload === 'string' ? payload : JSON.stringify(payload);
    this.db
      .prepare(
        `INSERT INTO pool_queue (id, class, payload, priority_tier, enqueued_at, status)
         VALUES (?, ?, ?, ?, ?, 'queued')`,
      )
      .run(id, class_, serialised, options.priorityTier ?? 0, enqueuedAt);
    return id;
  }

  /**
   * Mark a slot as free and clear its binding. Called by the (future)
   * container lifecycle layer when a container exits — for W1 tests use
   * it to simulate a slot becoming available mid-scenario.
   *
   * Also clears `last_error`: a slot that was previously failed and has
   * been explicitly released no longer carries stale failure metadata.
   */
  release(slotId: string): void {
    this.db
      .prepare(
        `UPDATE pool_slots
            SET status = 'free',
                container_id = NULL,
                started_at = NULL,
                last_activity_at = NULL,
                last_error = NULL
          WHERE slot_id = ?`,
      )
      .run(slotId);
  }

  /**
   * Mark a slot as `failed` and persist a structured `ExitReason` so
   * operator tooling can explain *why* without re-inspecting a
   * container that may have already been garbage-collected by the
   * Docker daemon. `container_id` is cleared so the slot can be
   * reclaimed without the UNIQUE(container_id) constraint biting. The
   * slot stays out of the dispatch pool until `reclaimFailedSlot()`
   * promotes it back to `free`.
   *
   * Note: `started_at` is intentionally preserved (unlike `release()`
   * which clears it) so operator triage can see when the now-failed
   * container was originally started.
   */
  markSlotFailed(slotId: string, reason: ExitReason): void {
    this.db
      .prepare(
        `UPDATE pool_slots
            SET status = 'failed',
                container_id = NULL,
                last_activity_at = ?,
                last_error = ?
          WHERE slot_id = ?`,
      )
      .run(this.clock.nowIso(), JSON.stringify(reason), slotId);
  }

  /**
   * High-level entry point for the container lifecycle layer: given a
   * classified exit reason, either reclaim the slot (clean / crash) or
   * mark it failed (quota violation). Returns the terminal slot status
   * so the caller can branch on retry / alert behavior without
   * re-querying.
   *
   * Quota violations (`oom`, `pids`) → `failed`. A human or the reaper
   * must call `reclaimFailedSlot` once the root cause is understood.
   *
   * Transient crashes (`crash`) → `free`. The job-level retry policy
   * lives elsewhere; the allocator only owns slot lifecycle.
   *
   * Clean exits → `free`. No error recorded.
   */
  handleContainerExit(slotId: string, reason: ExitReason): SlotStatus {
    if (isQuotaViolation(reason)) {
      this.markSlotFailed(slotId, reason);
      return 'failed';
    }
    this.release(slotId);
    return 'free';
  }

  /**
   * Move a slot out of `failed` back to `free`. Only valid on a
   * currently-failed slot — no-op if the slot is in any other state so
   * callers can't accidentally clobber a live binding. Returns true if
   * the transition actually ran.
   */
  reclaimFailedSlot(slotId: string): boolean {
    const info = this.db
      .prepare(
        `UPDATE pool_slots
          SET status = 'free',
              container_id = NULL,
              started_at = NULL,
              last_activity_at = NULL,
              last_error = NULL
        WHERE slot_id = ? AND status = 'failed'`,
      )
      .run(slotId);
    return info.changes > 0;
  }

  /**
   * Read-only accessor for the recorded failure reason on a failed slot.
   * Returns `null` if the slot is missing, not failed, or has no error
   * payload. Used by the /settings/pool status endpoint and tests.
   */
  getSlotError(slotId: string): ExitReason | null {
    const row = this.db
      .prepare('SELECT last_error FROM pool_slots WHERE slot_id = ?')
      .get(slotId) as { last_error: string | null } | undefined;
    if (!row || !row.last_error) return null;
    try {
      return JSON.parse(row.last_error) as ExitReason;
    } catch {
      return null;
    }
  }

  // ─── W4: eviction scoring ─────────────────────────────────────────────

  /**
   * Attach / update PR metadata on a running slot. Called by the PR-env
   * lifecycle layer when a container is spawned and again on each
   * `pull_request.synchronize` / `pull_request.closed` webhook.
   *
   * Only the fields present in `meta` are written — pass `{ prState: 'closed' }`
   * on close without resending commit timestamps. Unknown slots are silently
   * ignored (the slot may have already been recycled).
   */
  updatePrMetadata(
    slotId: string,
    meta: {
      prNumber?: number | null;
      prState?: 'open' | 'closed' | 'draft' | null;
      prLastCommitAt?: string | null;
    },
  ): void {
    const sets: string[] = [];
    const params: Array<string | number | null> = [];
    if ('prNumber' in meta) {
      sets.push('pr_number = ?');
      params.push(meta.prNumber ?? null);
    }
    if ('prState' in meta) {
      sets.push('pr_state = ?');
      params.push(meta.prState ?? null);
    }
    if ('prLastCommitAt' in meta) {
      sets.push('pr_last_commit_at = ?');
      params.push(meta.prLastCommitAt ?? null);
    }
    if (sets.length === 0) return;
    params.push(slotId);
    this.db.prepare(`UPDATE pool_slots SET ${sets.join(', ')} WHERE slot_id = ?`).run(...params);
  }

  /**
   * Record an HTTP hit on the PR env container's public URL. Called from
   * the Nginx access-log tailer (future) or from tests. Stamps
   * `last_http_hit_at` to now; also used as the "human active" signal in
   * the eviction score term.
   */
  recordHttpHit(slotId: string, timestamp: string = this.clock.nowIso()): void {
    this.db
      .prepare('UPDATE pool_slots SET last_http_hit_at = ? WHERE slot_id = ?')
      .run(timestamp, slotId);
  }

  /**
   * Record reviewer activity on the PR (comment, review, approval, change-
   * request). Called from `webhooks.ts` on `pull_request_review.submitted`
   * and `pull_request_review_comment.created` events, correlated to the
   * slot via the payload's PR number. Activity in the last
   * `reviewerProtectWindowMs` HARD-PROTECTS the slot from eviction — it
   * never appears in the candidate set while the window is live.
   */
  recordReviewerActivity(slotId: string, timestamp: string = this.clock.nowIso()): void {
    this.db
      .prepare('UPDATE pool_slots SET reviewer_activity_at = ? WHERE slot_id = ?')
      .run(timestamp, slotId);
  }

  /**
   * Compute the eviction score for a single slot per wiki §4.1. Returns
   * `null` for slots that aren't running PR envs (eviction only targets
   * PR env containers — scaffolds are short-lived and never evicted).
   *
   * The score is intentionally a pure function of the row's state at call
   * time so the same formula powers both the live dispatcher and operator
   * tooling (`/settings/pool` status page).
   */
  scoreSlot(slotId: string, now: number = this.clock.nowMs()): EvictionCandidate | null {
    const row = this.db
      .prepare(
        `SELECT slot_id, class, status, container_id, started_at, last_activity_at,
                pr_number, pr_state, pr_last_commit_at, last_http_hit_at, reviewer_activity_at
           FROM pool_slots
          WHERE slot_id = ?`,
      )
      .get(slotId) as SlotScoringRow | undefined;
    if (!row) return null;
    return this.scoreRow(row, now);
  }

  /**
   * Internal: score a pre-fetched row. Shared between `scoreSlot()` (single-
   * row, public) and `selectEvictionCandidate()` (bulk, internal).
   */
  private scoreRow(row: SlotScoringRow, now: number): EvictionCandidate | null {
    // Only running PR-env containers are eviction targets. Scaffolds are
    // protected by the "scaffolding never preempts PR env" rule in §2.2,
    // and the overflow slot is evictable only when it's PR-owned.
    const isPrBinding =
      row.class === 'pr_env' || (row.class === 'overflow' && row.pr_number !== null);
    if (!isPrBinding) return null;
    // Only `busy` slots are candidates — draining / failed / free are
    // already out of the dispatch pool.
    if (row.status !== 'busy') return null;

    // Fallback for each timestamp: if it's missing, treat it as "0 hours
    // ago" (no score contribution). A brand-new container with no PR
    // metadata yet should score near zero, not be aggressively targeted.
    const hoursSince = (iso: string | null): number => {
      if (!iso) return 0;
      const ms = parseEnqueuedMs(iso, this.clock);
      const diff = Math.max(0, now - ms);
      return diff / (1000 * 60 * 60);
    };

    const httpHitMs = row.last_http_hit_at ? parseEnqueuedMs(row.last_http_hit_at, this.clock) : 0;
    const reviewerMs = row.reviewer_activity_at
      ? parseEnqueuedMs(row.reviewer_activity_at, this.clock)
      : 0;

    const humanActive =
      (httpHitMs > 0 && now - httpHitMs <= this.config.humanActiveWindowMs) ||
      (reviewerMs > 0 && now - reviewerMs <= this.config.humanActiveWindowMs);

    const reviewerProtected =
      reviewerMs > 0 && now - reviewerMs <= this.config.reviewerProtectWindowMs;

    const score =
      hoursSince(row.last_http_hit_at) * 3 +
      hoursSince(row.pr_last_commit_at) * 2 +
      (row.pr_state === 'closed' ? this.config.closedPrBoost : 0) +
      (row.pr_state === 'draft' ? this.config.draftPrBoost : 0) -
      (humanActive ? this.config.humanActiveBoost : 0);

    return {
      slotId: row.slot_id,
      score,
      reviewerProtected,
      prNumber: row.pr_number,
      prState: row.pr_state,
    };
  }

  /**
   * Score every running PR-env binding. Exposed primarily for operator
   * tooling — the dispatcher itself uses `selectEvictionCandidate()`
   * which already filters + sorts internally.
   */
  scoreAllPrEnvSlots(now: number = this.clock.nowMs()): EvictionCandidate[] {
    const rows = this.db
      .prepare(
        `SELECT slot_id, class, status, container_id, started_at, last_activity_at,
                pr_number, pr_state, pr_last_commit_at, last_http_hit_at, reviewer_activity_at
           FROM pool_slots
          WHERE status = 'busy'
            AND (class = 'pr_env' OR (class = 'overflow' AND pr_number IS NOT NULL))`,
      )
      .all() as SlotScoringRow[];
    const out: EvictionCandidate[] = [];
    for (const row of rows) {
      const cand = this.scoreRow(row, now);
      if (cand) out.push(cand);
    }
    return out;
  }

  /**
   * Pick the best eviction candidate. Per wiki §4.2:
   *
   *   • Candidates with reviewer activity in the last
   *     `reviewerProtectWindowMs` are filtered out (hard protect).
   *   • Of the remainder, highest score wins.
   *   • If the top score is ≤ 0 (everything is hot / recently committed),
   *     return `null` — the caller should queue instead of evicting.
   *
   * Tie-breaking: when two candidates score equal, the one bound first
   * (oldest `started_at`) wins. This keeps the policy stable under small
   * timing jitter and matches the "the longer it's been live, the more
   * likely it's abandoned" intuition.
   */
  selectEvictionCandidate(now: number = this.clock.nowMs()): EvictionCandidate | null {
    const scored = this.scoreAllPrEnvSlots(now).filter((c) => !c.reviewerProtected);
    if (scored.length === 0) return null;

    // Pull started_at for tie-breaking. One extra query is cheap at pool
    // sizes of 8–12 and keeps the main scoring pass uncluttered.
    const startedAt = new Map<string, string | null>();
    for (const c of scored) {
      const r = this.db
        .prepare('SELECT started_at FROM pool_slots WHERE slot_id = ?')
        .get(c.slotId) as { started_at: string | null } | undefined;
      startedAt.set(c.slotId, r?.started_at ?? null);
    }

    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      // Tie: oldest started_at first. NULLs sort last (shouldn't happen
      // for a busy slot, but be defensive).
      const as = startedAt.get(a.slotId);
      const bs = startedAt.get(b.slotId);
      if (as && bs) return as < bs ? -1 : as > bs ? 1 : 0;
      if (as) return -1;
      if (bs) return 1;
      // Final fallback: slot_id lexicographic for determinism in tests.
      return a.slotId < b.slotId ? -1 : 1;
    });

    const top = scored[0];
    if (top.score <= 0) return null;
    return top;
  }

  /**
   * Admission check for a new PR-env request. Called by the GitHub webhook
   * handler before `enqueue()`. The full rule set (wiki §§1.4, 4.2):
   *
   *   1. If any PR-capable slot is free → `queue` (the next tick binds it).
   *   2. If all PR-capable slots are busy AND an eviction candidate exists
   *      → `evict`. Caller transitions that slot to `draining` and enqueues
   *      the new request; the freed slot is picked up on the next tick.
   *   3. If saturated with no eviction candidate AND queue depth already
   *      at / past `prQueueRejectThreshold` → `reject`.
   *   4. Otherwise (saturated, no candidate, queue still has headroom) →
   *      `queue`. The request will wait behind whatever unblocks first
   *      (a reaper teardown, a reviewer-activity window expiring, etc.).
   */
  canAcceptPrEnvRequest(now: number = this.clock.nowMs()): PrEnvAdmission {
    const freePr = (
      this.db
        .prepare("SELECT COUNT(*) AS n FROM pool_slots WHERE class = 'pr_env' AND status = 'free'")
        .get() as { n: number }
    ).n;
    const freeOverflow = (
      this.db
        .prepare(
          "SELECT COUNT(*) AS n FROM pool_slots WHERE class = 'overflow' AND status = 'free'",
        )
        .get() as { n: number }
    ).n;
    if (freePr + freeOverflow > 0) return { decision: 'queue' };

    const candidate = this.selectEvictionCandidate(now);
    if (candidate) {
      return { decision: 'evict', slotId: candidate.slotId, score: candidate.score };
    }

    const queueDepth = this.countQueued('pr_env');
    if (queueDepth >= this.config.prQueueRejectThreshold) {
      return { decision: 'reject', reason: 'queue_saturated' };
    }
    return { decision: 'queue' };
  }

  /**
   * Transition a slot from `busy` to `draining` and bump the eviction
   * counter. The actual container teardown is owned by the lifecycle layer
   * (`docker compose down --timeout 30` per §4.3); this method only flips
   * the accounting bit. Returns `true` if the slot actually transitioned
   * (was busy beforehand), `false` otherwise — a double-evict call is a
   * no-op rather than an error.
   *
   * After teardown completes the lifecycle layer calls `release(slotId)`
   * to move the slot back to `free`, at which point the next `tick()`
   * will bind the queued replacement.
   */
  markEvicting(slotId: string): boolean {
    const info = this.db
      .prepare(
        `UPDATE pool_slots
            SET status = 'draining'
          WHERE slot_id = ? AND status = 'busy'`,
      )
      .run(slotId);
    if (info.changes > 0) {
      this.evictionsInitiated++;
      return true;
    }
    return false;
  }

  /** Total evictions initiated by this process. Surfaced via `snapshotMetrics`. */
  getEvictionsInitiated(): number {
    return this.evictionsInitiated;
  }

  /**
   * Run a single dispatch pass. The caller decides the cadence — prod uses
   * `startDispatcher(this, 1000)`, tests call `tick()` directly between
   * `vi.advanceTimersByTime()` steps.
   */
  tick(): TickResult {
    const assigned: DispatchDecision[] = [];

    // Everything mutating runs in a single transaction so a concurrent
    // enqueue can't observe a half-assigned state.
    const run = this.db.transaction(() => {
      // 1. Fill dedicated PR env slots FIFO.
      for (;;) {
        const slot = this.findFreeSlot('pr_env');
        if (!slot) break;
        const head = this.popQueueHead('pr_env');
        if (!head) break;
        this.bind(slot.slot_id, head.id);
        assigned.push({
          queueId: head.id,
          class: 'pr_env',
          slotId: slot.slot_id,
          assignedAsOverflow: false,
        });
      }

      // 2. Fill dedicated scaffold slots FIFO.
      for (;;) {
        const slot = this.findFreeSlot('scaffold');
        if (!slot) break;
        const head = this.popQueueHead('scaffold');
        if (!head) break;
        this.bind(slot.slot_id, head.id);
        assigned.push({
          queueId: head.id,
          class: 'scaffold',
          slotId: slot.slot_id,
          assignedAsOverflow: false,
        });
      }

      // 3. Overflow assignment. PR env heads win outright; scaffold heads
      //    only claim overflow after the bounded wait so a late-arriving
      //    PR env can still get the slot.
      for (;;) {
        const overflow = this.findFreeSlot('overflow');
        if (!overflow) break;

        const prHead = this.peekQueueHead('pr_env');
        if (prHead) {
          this.popQueueHead('pr_env'); // consume the head we just peeked
          this.bind(overflow.slot_id, prHead.id);
          assigned.push({
            queueId: prHead.id,
            class: 'pr_env',
            slotId: overflow.slot_id,
            assignedAsOverflow: true,
          });
          continue;
        }

        // PR-env queue is empty (prHead was null above). Scaffold is now
        // eligible for overflow — the only remaining gate is the optional
        // bounded wait, which is 0 by default (W3 rule).
        const scafHead = this.peekQueueHead('scaffold');
        if (!scafHead) break;

        const waitedMs = this.clock.nowMs() - scafHead.enqueued_ms;
        if (waitedMs < this.config.scaffoldOverflowWaitMs) {
          // Head hasn't aged past the configured bounded wait. Leave it
          // and everything behind it queued — later heads are strictly
          // younger so they can't be eligible either. With the default
          // (0 ms) this branch is effectively unreachable.
          break;
        }

        this.popQueueHead('scaffold');
        this.bind(overflow.slot_id, scafHead.id);
        assigned.push({
          queueId: scafHead.id,
          class: 'scaffold',
          slotId: overflow.slot_id,
          assignedAsOverflow: true,
        });
      }
    });
    run();

    const metrics = this.snapshotMetrics();
    return {
      assigned,
      scaffoldWaiting: this.countQueued('scaffold'),
      prEnvWaiting: this.countQueued('pr_env'),
      metrics,
    };
  }

  /**
   * Append a row to `pool_metrics`. Called from the dispatcher at the same
   * cadence as `tick()` — kept separate so callers can throttle metric
   * writes (e.g. every 60 ticks) without skipping dispatches.
   */
  writeMetrics(metrics: TickMetrics, timestamp: string = this.clock.nowIso()): void {
    this.db
      .prepare(
        `INSERT INTO pool_metrics (timestamp, pool_util, queue_depth, evictions, reaps)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(timestamp, metrics.poolUtil, metrics.queueDepth, metrics.evictions, metrics.reaps);
  }

  /** Expose metrics without mutating state — used by tests and observability. */
  snapshotMetrics(): TickMetrics {
    const total = (this.db.prepare('SELECT COUNT(*) AS n FROM pool_slots').get() as { n: number })
      .n;
    const busy = (
      this.db.prepare("SELECT COUNT(*) AS n FROM pool_slots WHERE status <> 'free'").get() as {
        n: number;
      }
    ).n;
    const queueDepth = (
      this.db.prepare("SELECT COUNT(*) AS n FROM pool_queue WHERE status = 'queued'").get() as {
        n: number;
      }
    ).n;

    const poolUtil = total === 0 ? 0 : busy / total;
    return {
      poolUtil: Math.min(1, Math.max(0, poolUtil)),
      queueDepth,
      // W4: monotonic in-process counter of evictions initiated. The
      // dispatcher subtracts prior samples to produce per-interval deltas
      // when writing `pool_metrics`. Reaps remain at 0 until W5 lands.
      evictions: this.evictionsInitiated,
      reaps: 0,
    };
  }

  // ─── internals ────────────────────────────────────────────────────────

  private findFreeSlot(class_: SlotClass): SlotRow | null {
    const row = this.db
      .prepare(
        `SELECT slot_id, class, status, container_id FROM pool_slots
          WHERE class = ? AND status = 'free'
          ORDER BY slot_id ASC LIMIT 1`,
      )
      .get(class_) as SlotRow | undefined;
    return row ?? null;
  }

  private peekQueueHead(class_: QueueClass): QueueRow | null {
    const row = this.db
      .prepare(
        `SELECT id, class, payload, priority_tier, enqueued_at, status
           FROM pool_queue
          WHERE status = 'queued' AND class = ?
          ORDER BY priority_tier DESC, enqueued_at ASC
          LIMIT 1`,
      )
      .get(class_) as Omit<QueueRow, 'enqueued_ms'> | undefined;
    if (!row) return null;
    return { ...row, enqueued_ms: parseEnqueuedMs(row.enqueued_at, this.clock) };
  }

  private popQueueHead(class_: QueueClass): QueueRow | null {
    const head = this.peekQueueHead(class_);
    if (!head) return null;
    // Deleting the row is simpler than a `dispatching` state for W1 — once
    // a slot has been bound the queue item has served its purpose. W2 can
    // promote this to a soft-delete if we need post-hoc request timing.
    this.db.prepare('DELETE FROM pool_queue WHERE id = ?').run(head.id);
    return head;
  }

  private countQueued(class_: QueueClass): number {
    return (
      this.db
        .prepare("SELECT COUNT(*) AS n FROM pool_queue WHERE status = 'queued' AND class = ?")
        .get(class_) as { n: number }
    ).n;
  }

  private bind(slotId: string, queueId: string): void {
    const ts = this.clock.nowIso();
    this.db
      .prepare(
        `UPDATE pool_slots
            SET status = 'busy',
                container_id = ?,
                started_at = ?,
                last_activity_at = ?
          WHERE slot_id = ?`,
      )
      .run(queueId, ts, ts, slotId);
  }
}

/**
 * Drive `allocator.tick()` on a fixed interval. Returns a stop function.
 * Errors inside a tick are caught and logged so a single bad row can't
 * take down the dispatcher — PM2 will still restart on a hard crash.
 */
export function startDispatcher(
  allocator: PoolAllocator,
  options: {
    intervalMs?: number;
    metricsEveryNTicks?: number;
    onError?: (err: unknown) => void;
  } = {},
): () => void {
  const intervalMs = options.intervalMs ?? 1000;
  const metricsEvery = options.metricsEveryNTicks ?? 60;
  const onError = options.onError ?? ((err) => console.error('[container-pool] tick failed', err));

  let ticks = 0;
  const timer = setInterval(() => {
    try {
      const result = allocator.tick();
      ticks++;
      if (ticks % metricsEvery === 0) {
        allocator.writeMetrics(result.metrics);
      }
    } catch (err) {
      onError(err);
    }
  }, intervalMs);

  // Don't block process exit on a running dispatcher — matches the
  // heartbeat / cron runners elsewhere in the server.
  if (typeof timer.unref === 'function') timer.unref();

  return () => clearInterval(timer);
}
