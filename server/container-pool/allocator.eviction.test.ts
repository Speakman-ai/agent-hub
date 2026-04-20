/**
 * W4: Scored eviction policy + reviewer-activity hard protect.
 *
 * Pins down the wiki §4 contract the PR-env allocator must honor under
 * slot pressure:
 *
 *   1. **Scoring formula** — matches wiki §4.1 within a tolerance of 1e-6.
 *      Closed PRs dominate (+100). Draft PRs get a small nudge (+5).
 *      Human activity in the last 10 min subtracts 100. Hours-since-hit
 *      and hours-since-commit supply tie-breakers.
 *   2. **Hard protect** — a slot with reviewer activity in the last 10
 *      min is never returned by `selectEvictionCandidate()`, even when
 *      its PR is closed with score well above 100.
 *   3. **Queue-vs-reject policy** — `canAcceptPrEnvRequest()` returns
 *      `evict` when saturated with a candidate, `reject` when saturated
 *      with no candidate and queue depth ≥ threshold, `queue` otherwise.
 *   4. **Tie breaking** — when two slots score equal, the oldest-bound
 *      wins (most likely to have been abandoned).
 *   5. **Accounting** — `markEvicting()` transitions `busy → draining`,
 *      increments the `evictions` counter, and is idempotent on repeat.
 *
 * All tests use an in-memory SQLite DB and an injected fake Clock — the
 * same shape as the sibling W1/W3 suites.
 */

import Database from 'better-sqlite3';
import { describe, it, expect } from 'vitest';
import { POOL_SCHEMA } from './schema.js';
import { DEFAULT_CONFIG, PoolAllocator, type Clock } from './allocator.js';

// ─── helpers ──────────────────────────────────────────────────────────────

function makeClock(startMs = Date.parse('2026-04-20T10:00:00Z')): Clock & {
  advance(ms: number): void;
  nowMsRaw(): number;
} {
  let cur = startMs;
  return {
    nowMs: () => cur,
    nowIso: () => new Date(cur).toISOString().slice(0, 19).replace('T', ' '),
    advance(ms) {
      cur += ms;
    },
    nowMsRaw: () => cur,
  };
}

function freshAllocator(config: Partial<typeof DEFAULT_CONFIG> = {}): {
  allocator: PoolAllocator;
  db: Database.Database;
  clock: ReturnType<typeof makeClock>;
} {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(POOL_SCHEMA);
  const clock = makeClock();
  const allocator = new PoolAllocator(db, { config, clock });
  allocator.init();
  return { allocator, db, clock };
}

/** Drive a PR env request through the full "accept → tick → metadata" path. */
function bindPrEnv(
  allocator: PoolAllocator,
  db: Database.Database,
  opts: {
    prNumber: number;
    prState?: 'open' | 'closed' | 'draft' | null;
    lastCommitAt?: string | null;
    lastHttpHitAt?: string | null;
    reviewerActivityAt?: string | null;
  },
): string {
  allocator.enqueue('pr_env', { pr: opts.prNumber });
  const result = allocator.tick();
  const decision = result.assigned.find((d) => d.class === 'pr_env');
  if (!decision) throw new Error('expected PR env to be assigned');
  allocator.updatePrMetadata(decision.slotId, {
    prNumber: opts.prNumber,
    prState: opts.prState ?? 'open',
    prLastCommitAt: opts.lastCommitAt ?? null,
  });
  if (opts.lastHttpHitAt !== undefined) {
    db.prepare('UPDATE pool_slots SET last_http_hit_at = ? WHERE slot_id = ?').run(
      opts.lastHttpHitAt,
      decision.slotId,
    );
  }
  if (opts.reviewerActivityAt !== undefined) {
    db.prepare('UPDATE pool_slots SET reviewer_activity_at = ? WHERE slot_id = ?').run(
      opts.reviewerActivityAt,
      decision.slotId,
    );
  }
  return decision.slotId;
}

function iso(clock: { nowMs(): number }, offsetMs: number): string {
  return new Date(clock.nowMs() + offsetMs).toISOString().slice(0, 19).replace('T', ' ');
}

// ─── 1. scoreSlot — formula coverage ──────────────────────────────────────

describe('W4 scoreSlot — wiki §4.1 formula', () => {
  it('scores a fresh PR env (no metadata) at 0', () => {
    const { allocator, db } = freshAllocator({
      prEnvSlots: 1,
      scaffoldSlots: 0,
      overflowSlots: 0,
    });
    const slot = bindPrEnv(allocator, db, { prNumber: 1 });
    const card = allocator.scoreSlot(slot);
    expect(card).not.toBeNull();
    expect(card!.score).toBe(0);
    expect(card!.reviewerProtected).toBe(false);
    expect(card!.prState).toBe('open');
  });

  it('adds +100 for a closed PR with no other activity', () => {
    const { allocator, db } = freshAllocator({
      prEnvSlots: 1,
      scaffoldSlots: 0,
      overflowSlots: 0,
    });
    const slot = bindPrEnv(allocator, db, { prNumber: 1, prState: 'closed' });
    expect(allocator.scoreSlot(slot)!.score).toBe(100);
  });

  it('adds +5 for a draft PR', () => {
    const { allocator, db } = freshAllocator({
      prEnvSlots: 1,
      scaffoldSlots: 0,
      overflowSlots: 0,
    });
    const slot = bindPrEnv(allocator, db, { prNumber: 1, prState: 'draft' });
    expect(allocator.scoreSlot(slot)!.score).toBe(5);
  });

  it('subtracts 100 for a PR hit by a human in the last 10 min', () => {
    const { allocator, db, clock } = freshAllocator({
      prEnvSlots: 1,
      scaffoldSlots: 0,
      overflowSlots: 0,
    });
    // 5 minutes ago → inside the 10-min "human active" window.
    const fiveMinAgo = iso(clock, -5 * 60 * 1000);
    const slot = bindPrEnv(allocator, db, { prNumber: 1, lastHttpHitAt: fiveMinAgo });
    const card = allocator.scoreSlot(slot)!;
    // hoursSince = 5min / 60 ≈ 0.0833, × 3 = 0.25, minus 100 → ≈ -99.75
    expect(card.score).toBeCloseTo(0.25 - 100, 6);
  });

  it('hours-since-commit contributes ×2', () => {
    const { allocator, db, clock } = freshAllocator({
      prEnvSlots: 1,
      scaffoldSlots: 0,
      overflowSlots: 0,
    });
    // 3 hours ago.
    const threeHoursAgo = iso(clock, -3 * 60 * 60 * 1000);
    const slot = bindPrEnv(allocator, db, { prNumber: 1, lastCommitAt: threeHoursAgo });
    expect(allocator.scoreSlot(slot)!.score).toBeCloseTo(3 * 2, 6);
  });

  it('returns null for free / non-PR slots', () => {
    const { allocator } = freshAllocator({
      prEnvSlots: 1,
      scaffoldSlots: 1,
      overflowSlots: 0,
    });
    // Free pr-1 → null.
    expect(allocator.scoreSlot('pr-1')).toBeNull();
    // Free scaffold-1 → null.
    expect(allocator.scoreSlot('scaffold-1')).toBeNull();
    // Missing slot → null.
    expect(allocator.scoreSlot('nope')).toBeNull();
  });

  it('skips scaffold bindings — eviction only targets PR env class', () => {
    const { allocator, db } = freshAllocator({
      prEnvSlots: 0,
      scaffoldSlots: 1,
      overflowSlots: 0,
    });
    allocator.enqueue('scaffold', { template: 'next' });
    allocator.tick();
    // Slot is busy with a scaffold binding — scoreRow should return null.
    expect(db.prepare('SELECT status FROM pool_slots WHERE slot_id=?').get('scaffold-1')).toEqual({
      status: 'busy',
    });
    expect(allocator.scoreSlot('scaffold-1')).toBeNull();
  });
});

// ─── 2. Hard protect — reviewer activity filters the candidate out ────────

describe('W4 selectEvictionCandidate — reviewer-activity hard protect', () => {
  it('protects a closed PR with reviewer activity in the last 10 min', () => {
    const { allocator, db, clock } = freshAllocator({
      prEnvSlots: 2,
      scaffoldSlots: 0,
      overflowSlots: 0,
    });
    const recentReviewer = iso(clock, -2 * 60 * 1000); // 2 min ago
    // Candidate A: closed PR with a very stale commit (500h ago) AND
    // reviewer active 2 min ago → raw score 100 + 1000 - 100 = 1000,
    // well above B, but hard-protected so it NEVER gets picked.
    const a = bindPrEnv(allocator, db, {
      prNumber: 101,
      prState: 'closed',
      lastCommitAt: iso(clock, -500 * 60 * 60 * 1000),
      reviewerActivityAt: recentReviewer,
    });
    // Candidate B: open PR, stale commit (5h ago), no reviewer → score +10.
    const b = bindPrEnv(allocator, db, {
      prNumber: 102,
      prState: 'open',
      lastCommitAt: iso(clock, -5 * 60 * 60 * 1000),
    });
    const chosen = allocator.selectEvictionCandidate();
    expect(chosen).not.toBeNull();
    expect(chosen!.slotId).toBe(b);
    // Sanity: A would have outscored B if not protected.
    const scores = allocator.scoreAllPrEnvSlots();
    const aCard = scores.find((c) => c.slotId === a)!;
    expect(aCard.reviewerProtected).toBe(true);
    expect(aCard.score).toBeGreaterThan(chosen!.score);
  });

  it('releases the protection once the window expires', () => {
    const { allocator, db, clock } = freshAllocator({
      prEnvSlots: 1,
      scaffoldSlots: 0,
      overflowSlots: 0,
    });
    const slot = bindPrEnv(allocator, db, {
      prNumber: 1,
      prState: 'closed',
      reviewerActivityAt: iso(clock, -9 * 60 * 1000), // 9 min ago — still protected
    });
    expect(allocator.selectEvictionCandidate()).toBeNull();

    // Advance past the 10-min window.
    clock.advance(2 * 60 * 1000);
    const chosen = allocator.selectEvictionCandidate();
    expect(chosen).not.toBeNull();
    expect(chosen!.slotId).toBe(slot);
  });

  it('returns null when every candidate is hot (score ≤ 0)', () => {
    const { allocator, db, clock } = freshAllocator({
      prEnvSlots: 2,
      scaffoldSlots: 0,
      overflowSlots: 0,
    });
    bindPrEnv(allocator, db, {
      prNumber: 1,
      prState: 'open',
      lastHttpHitAt: iso(clock, -1 * 60 * 1000), // hit 1 min ago
    });
    bindPrEnv(allocator, db, {
      prNumber: 2,
      prState: 'open',
      lastHttpHitAt: iso(clock, -2 * 60 * 1000),
    });
    expect(allocator.selectEvictionCandidate()).toBeNull();
  });
});

// ─── 3. Scoring edge cases — closed+protected, fresh idle, tie-break ──────

describe('W4 scoring edge cases', () => {
  it('closed PR with recent reviewer activity → protect wins, skip', () => {
    const { allocator, db, clock } = freshAllocator({
      prEnvSlots: 1,
      scaffoldSlots: 0,
      overflowSlots: 0,
    });
    const slot = bindPrEnv(allocator, db, {
      prNumber: 1,
      prState: 'closed',
      reviewerActivityAt: iso(clock, -60 * 1000), // 1 min ago
    });
    const card = allocator.scoreSlot(slot)!;
    // Score = +100 (closed) - 100 (human active within 10m because reviewer counts) = 0
    expect(card.score).toBe(0);
    expect(card.reviewerProtected).toBe(true);
    expect(allocator.selectEvictionCandidate()).toBeNull();
  });

  it('fresh idle env scores 0 and is never chosen (everything else hot too)', () => {
    const { allocator, db } = freshAllocator({
      prEnvSlots: 1,
      scaffoldSlots: 0,
      overflowSlots: 0,
    });
    bindPrEnv(allocator, db, { prNumber: 42 });
    // No http hits, no commits, no reviewer activity, open PR → score 0.
    // canAcceptPrEnvRequest saturation with score=0 candidate → queue.
    const admission = allocator.canAcceptPrEnvRequest();
    expect(admission.decision).toBe('queue');
  });

  it('tie-break: when two candidates score equal, oldest-bound wins', () => {
    const { allocator, db, clock } = freshAllocator({
      prEnvSlots: 2,
      scaffoldSlots: 0,
      overflowSlots: 0,
    });
    // First binding at t=0.
    const first = bindPrEnv(allocator, db, { prNumber: 1, prState: 'closed' });
    // Advance 5s so started_at differs between bindings.
    clock.advance(5 * 1000);
    const second = bindPrEnv(allocator, db, { prNumber: 2, prState: 'closed' });

    const chosen = allocator.selectEvictionCandidate();
    expect(chosen).not.toBeNull();
    // Both score +100; `first` started earlier → picked for eviction.
    expect(chosen!.slotId).toBe(first);
    // Sanity: scores are equal.
    const scores = allocator.scoreAllPrEnvSlots();
    const a = scores.find((c) => c.slotId === first)!;
    const b = scores.find((c) => c.slotId === second)!;
    expect(a.score).toBe(b.score);
  });
});

// ─── 4. canAcceptPrEnvRequest — admission policy ──────────────────────────

describe('W4 canAcceptPrEnvRequest — queue vs evict vs reject', () => {
  it('returns `queue` when any PR-capable slot is free', () => {
    const { allocator } = freshAllocator({
      prEnvSlots: 2,
      scaffoldSlots: 0,
      overflowSlots: 1,
    });
    expect(allocator.canAcceptPrEnvRequest().decision).toBe('queue');
  });

  it('returns `evict` when saturated with an available candidate', () => {
    const { allocator, db } = freshAllocator({
      prEnvSlots: 1,
      scaffoldSlots: 0,
      overflowSlots: 0,
    });
    const slot = bindPrEnv(allocator, db, { prNumber: 1, prState: 'closed' });
    const admission = allocator.canAcceptPrEnvRequest();
    expect(admission.decision).toBe('evict');
    if (admission.decision === 'evict') {
      expect(admission.slotId).toBe(slot);
      expect(admission.score).toBe(100);
    }
  });

  it('returns `reject` when saturated, no candidate, and queue ≥ threshold', () => {
    const { allocator, db, clock } = freshAllocator({
      prEnvSlots: 1,
      scaffoldSlots: 0,
      overflowSlots: 0,
      prQueueRejectThreshold: 3,
    });
    // Single slot is hot — human active 1 min ago → no candidate.
    bindPrEnv(allocator, db, {
      prNumber: 1,
      lastHttpHitAt: iso(clock, -60 * 1000),
    });
    // Seed the queue past the reject threshold.
    for (let i = 0; i < 3; i++) allocator.enqueue('pr_env', { pr: 100 + i });
    const admission = allocator.canAcceptPrEnvRequest();
    expect(admission.decision).toBe('reject');
  });

  it('returns `queue` when saturated, no candidate, but queue still has headroom', () => {
    const { allocator, db, clock } = freshAllocator({
      prEnvSlots: 1,
      scaffoldSlots: 0,
      overflowSlots: 0,
      prQueueRejectThreshold: 20,
    });
    bindPrEnv(allocator, db, {
      prNumber: 1,
      lastHttpHitAt: iso(clock, -60 * 1000),
    });
    // Only one queued request — well under the 20 reject threshold.
    allocator.enqueue('pr_env', { pr: 2 });
    expect(allocator.canAcceptPrEnvRequest().decision).toBe('queue');
  });

  it('treats overflow as PR-capable free capacity', () => {
    const { allocator, db } = freshAllocator({
      prEnvSlots: 1,
      scaffoldSlots: 0,
      overflowSlots: 1,
    });
    // Fill pr-1.
    bindPrEnv(allocator, db, { prNumber: 1 });
    // overflow-1 is still free → accept as queue, not eviction.
    expect(allocator.canAcceptPrEnvRequest().decision).toBe('queue');
  });
});

// ─── 5. markEvicting — accounting and idempotence ─────────────────────────

describe('W4 markEvicting — slot state + counter', () => {
  it('transitions busy → draining and bumps the eviction counter', () => {
    const { allocator, db } = freshAllocator({
      prEnvSlots: 1,
      scaffoldSlots: 0,
      overflowSlots: 0,
    });
    const slot = bindPrEnv(allocator, db, { prNumber: 1, prState: 'closed' });
    expect(allocator.getEvictionsInitiated()).toBe(0);

    const ok = allocator.markEvicting(slot);
    expect(ok).toBe(true);
    expect(allocator.getEvictionsInitiated()).toBe(1);
    expect(
      (
        db.prepare('SELECT status FROM pool_slots WHERE slot_id=?').get(slot) as {
          status: string;
        }
      ).status,
    ).toBe('draining');

    // Repeat call on a non-busy slot is a no-op.
    const second = allocator.markEvicting(slot);
    expect(second).toBe(false);
    expect(allocator.getEvictionsInitiated()).toBe(1);
  });

  it('draining slots are excluded from the eviction candidate set', () => {
    const { allocator, db } = freshAllocator({
      prEnvSlots: 2,
      scaffoldSlots: 0,
      overflowSlots: 0,
    });
    const a = bindPrEnv(allocator, db, { prNumber: 1, prState: 'closed' });
    const b = bindPrEnv(allocator, db, { prNumber: 2, prState: 'closed' });
    allocator.markEvicting(a);
    const chosen = allocator.selectEvictionCandidate();
    // Only `b` remains evictable.
    expect(chosen).not.toBeNull();
    expect(chosen!.slotId).toBe(b);
  });

  it('after release() the evicted slot is picked up by the next tick', () => {
    const { allocator, db } = freshAllocator({
      prEnvSlots: 1,
      scaffoldSlots: 0,
      overflowSlots: 0,
    });
    const old = bindPrEnv(allocator, db, { prNumber: 1, prState: 'closed' });
    // Queue a replacement while the old binding is still live.
    const replacementId = allocator.enqueue('pr_env', { pr: 2 });
    // Evict + tear-down simulation.
    expect(allocator.canAcceptPrEnvRequest().decision).toBe('evict');
    allocator.markEvicting(old);
    // Next tick can't bind yet — slot is draining, not free.
    expect(allocator.tick().assigned).toEqual([]);
    // Lifecycle layer finishes teardown → release.
    allocator.release(old);
    const result = allocator.tick();
    expect(result.assigned.map((d) => d.queueId)).toEqual([replacementId]);
  });
});

// ─── 6. Metrics integration — evictions counter is surfaced ───────────────

describe('W4 metrics integration', () => {
  it('snapshotMetrics.evictions reports the in-process counter', () => {
    const { allocator, db } = freshAllocator({
      prEnvSlots: 2,
      scaffoldSlots: 0,
      overflowSlots: 0,
    });
    const a = bindPrEnv(allocator, db, { prNumber: 1, prState: 'closed' });
    const b = bindPrEnv(allocator, db, { prNumber: 2, prState: 'closed' });
    allocator.markEvicting(a);
    allocator.markEvicting(b);
    expect(allocator.snapshotMetrics().evictions).toBe(2);
  });
});

// ─── 7. Config tunables — windows and boosts are honored ──────────────────

describe('W4 config tunables', () => {
  it('custom reviewerProtectWindowMs applies to the hard filter', () => {
    const { allocator, db, clock } = freshAllocator({
      prEnvSlots: 1,
      scaffoldSlots: 0,
      overflowSlots: 0,
      reviewerProtectWindowMs: 60 * 1000, // 1 min instead of 10
      humanActiveWindowMs: 60 * 1000, // match so the score isn't dragged negative
    });
    bindPrEnv(allocator, db, {
      prNumber: 1,
      prState: 'closed',
      reviewerActivityAt: iso(clock, -90 * 1000), // 90 s ago
    });
    // Outside the 60 s protection window — candidate is evictable again.
    const chosen = allocator.selectEvictionCandidate();
    expect(chosen).not.toBeNull();
  });

  it('custom closedPrBoost changes the dominant score', () => {
    const { allocator, db } = freshAllocator({
      prEnvSlots: 1,
      scaffoldSlots: 0,
      overflowSlots: 0,
      closedPrBoost: 42,
    });
    const slot = bindPrEnv(allocator, db, { prNumber: 1, prState: 'closed' });
    expect(allocator.scoreSlot(slot)!.score).toBe(42);
  });
});
