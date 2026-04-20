/**
 * W4: Reaper cron — idempotent cleanup for zombies and dropped webhooks.
 *
 * Coverage targets pulled directly from the card's acceptance criteria:
 *
 *   1. **Webhook-drop simulation** — PR closed on GitHub, no webhook
 *      delivered → reaper evicts on the next tick by flipping
 *      busy → draining via `allocator.markEvicting`. It must NOT call
 *      `compose down` directly (that's the lifecycle layer's job).
 *   2. **Concurrent invocation** — two reaper instances share the
 *      advisory lock; the loser reports `skipped: true` and does zero
 *      work. The winner's work is not duplicated if a second tick races
 *      in after the first's `acquireLock` but before `reapWebhookDrops`
 *      (the atomic `markEvicting` precondition covers that).
 *   3. **Partial-cleanup recovery** — (a) container down but slot row
 *      still `busy` → recovered via webhook-drop path on the next tick;
 *      (b) slot row gone but container still running → orphaned-project
 *      pass tears it down.
 *   4. **Crashed scaffolds mid-git-push** — slot stuck in `reserved`
 *      past `provisioningStaleMs` → atomic reclaim to `free`.
 *   5. **Stuck draining** — slot past `drainingStaleMs` → force release.
 *   6. **Stale port reservations** — port row with no live slot and a
 *      closed PR → released.
 *   7. **Scoped reaper** — unknown compose projects are left alone;
 *      GitHub failures don't trigger evictions.
 */

import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach } from 'vitest';
import { POOL_SCHEMA } from './schema.js';
import { PORT_POOL_SCHEMA } from './port-pool.js';
import { PoolAllocator, type Clock } from './allocator.js';
import {
  Reaper,
  DEFAULT_REAPER_CONFIG,
  isProvisioningStale,
  type ReaperDockerOps,
  type ReaperGitHubOps,
} from './reaper.js';

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

interface Harness {
  db: Database.Database;
  allocator: PoolAllocator;
  reaper: Reaper;
  clock: ReturnType<typeof makeClock>;
  docker: FakeDocker;
  github: FakeGitHub;
}

/** Minimal fake Docker adapter with call counters. */
class FakeDocker implements ReaperDockerOps {
  projects: Array<{ projectName: string; prNumber: number }> = [];
  downCalls: string[] = [];
  throwOnList: Error | null = null;
  throwOnDown: Error | null = null;
  async listPrEnvProjects() {
    if (this.throwOnList) throw this.throwOnList;
    return [...this.projects];
  }
  async composeDown(projectName: string) {
    if (this.throwOnDown) throw this.throwOnDown;
    this.downCalls.push(projectName);
    // Remove from the running set so subsequent ticks don't re-reap.
    this.projects = this.projects.filter((p) => p.projectName !== projectName);
  }
}

/** Minimal fake GitHub adapter. */
class FakeGitHub implements ReaperGitHubOps {
  states = new Map<string, 'open' | 'closed' | 'draft' | null>();
  throwFor = new Set<string>();
  calls: string[] = [];
  setState(repo: string, pr: number, state: 'open' | 'closed' | 'draft' | null) {
    this.states.set(`${repo}#${pr}`, state);
  }
  async getPrState(repo: string, pr: number) {
    const key = `${repo}#${pr}`;
    this.calls.push(key);
    if (this.throwFor.has(key)) throw new Error('rate limited');
    return this.states.get(key) ?? null;
  }
}

function mkHarness(opts: {
  config?: Partial<typeof DEFAULT_REAPER_CONFIG>;
  prEnvSlots?: number;
  scaffoldSlots?: number;
  overflowSlots?: number;
  defaultRepo?: string;
}): Harness {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(POOL_SCHEMA);
  db.exec(PORT_POOL_SCHEMA);
  const clock = makeClock();
  const allocator = new PoolAllocator(db, {
    config: {
      prEnvSlots: opts.prEnvSlots ?? 2,
      scaffoldSlots: opts.scaffoldSlots ?? 1,
      overflowSlots: opts.overflowSlots ?? 0,
    },
    clock,
  });
  allocator.init();
  const docker = new FakeDocker();
  const github = new FakeGitHub();
  const reaper = new Reaper({
    db,
    allocator,
    docker,
    github,
    clock,
    config: {
      defaultRepoFullName: opts.defaultRepo ?? 'owner/repo',
      ...(opts.config ?? {}),
    },
  });
  reaper.init();
  return { db, allocator, reaper, clock, docker, github };
}

/** Drive a PR onto a slot with full metadata for test setups. */
function bindPr(
  h: Harness,
  opts: { prNumber: number; prState?: 'open' | 'closed' | 'draft' },
): string {
  h.allocator.enqueue('pr_env', { pr: opts.prNumber });
  const res = h.allocator.tick();
  const dec = res.assigned.find((d) => d.class === 'pr_env');
  if (!dec) throw new Error('no pr_env binding');
  h.allocator.updatePrMetadata(dec.slotId, {
    prNumber: opts.prNumber,
    prState: opts.prState ?? 'open',
  });
  return dec.slotId;
}

// ─── 1. Webhook-drop simulation ───────────────────────────────────────────

describe('W4 reaper — webhook-drop recovery', () => {
  let h: Harness;
  beforeEach(() => {
    h = mkHarness({});
  });

  it('evicts a busy slot whose PR is closed on GitHub', async () => {
    const slot = bindPr(h, { prNumber: 42 });
    h.github.setState('owner/repo', 42, 'closed');

    const result = await h.reaper.run();
    expect(result.skipped).toBe(false);
    expect(result.webhookDropEvictions).toBe(1);

    const status = h.db
      .prepare('SELECT status, pr_state FROM pool_slots WHERE slot_id=?')
      .get(slot) as {
      status: string;
      pr_state: string;
    };
    expect(status.status).toBe('draining');
    expect(status.pr_state).toBe('closed');
  });

  it('leaves open PRs alone', async () => {
    bindPr(h, { prNumber: 42 });
    h.github.setState('owner/repo', 42, 'open');
    const result = await h.reaper.run();
    expect(result.webhookDropEvictions).toBe(0);
  });

  it('leaves draft PRs alone (still under active review)', async () => {
    bindPr(h, { prNumber: 42, prState: 'draft' });
    h.github.setState('owner/repo', 42, 'draft');
    const result = await h.reaper.run();
    expect(result.webhookDropEvictions).toBe(0);
  });

  it('does not evict on a GitHub error — defers to next tick', async () => {
    const slot = bindPr(h, { prNumber: 42 });
    h.github.throwFor.add('owner/repo#42');
    const result = await h.reaper.run();
    expect(result.webhookDropEvictions).toBe(0);
    expect(
      (
        h.db.prepare('SELECT status FROM pool_slots WHERE slot_id=?').get(slot) as {
          status: string;
        }
      ).status,
    ).toBe('busy');
  });

  it('treats an unknown PR (null) as a deferred tick, not an eviction', async () => {
    bindPr(h, { prNumber: 42 });
    // No state set → FakeGitHub returns null
    const result = await h.reaper.run();
    expect(result.webhookDropEvictions).toBe(0);
  });

  it('uses markEvicting (accounting only) — does not tear down compose directly', async () => {
    const slot = bindPr(h, { prNumber: 42 });
    h.github.setState('owner/repo', 42, 'closed');
    await h.reaper.run();
    // Compose down is the lifecycle layer's job; reaper must not call it
    // for webhook-drop evictions (the slot still shows up in pool_slots).
    expect(h.docker.downCalls).toEqual([]);
    // And the slot is draining, not free — awaiting lifecycle teardown.
    expect(
      (
        h.db.prepare('SELECT status FROM pool_slots WHERE slot_id=?').get(slot) as {
          status: string;
        }
      ).status,
    ).toBe('draining');
  });

  it('bumps allocator.evictionsInitiated so metrics observe the reap', async () => {
    bindPr(h, { prNumber: 1 });
    bindPr(h, { prNumber: 2 });
    h.github.setState('owner/repo', 1, 'closed');
    h.github.setState('owner/repo', 2, 'closed');
    expect(h.allocator.getEvictionsInitiated()).toBe(0);
    await h.reaper.run();
    expect(h.allocator.getEvictionsInitiated()).toBe(2);
  });
});

// ─── 2. Concurrent invocation ─────────────────────────────────────────────

describe('W4 reaper — concurrent invocation idempotency', () => {
  it('two reapers on the same db: the loser skips, the winner does work', async () => {
    const h = mkHarness({});
    bindPr(h, { prNumber: 42 });
    h.github.setState('owner/repo', 42, 'closed');

    // A second reaper sharing the same DB + allocator.
    const reaper2 = new Reaper({
      db: h.db,
      allocator: h.allocator,
      docker: h.docker,
      github: h.github,
      clock: h.clock,
      config: { defaultRepoFullName: 'owner/repo' },
    });
    reaper2.init();

    // Simulate "same tick" by acquiring the lock manually from reaper1,
    // then asking reaper2 to run. reaper2 must skip.
    expect(h.reaper.acquireLock()).toBe(true);
    const r2 = await reaper2.run();
    expect(r2.skipped).toBe(true);
    expect(r2.webhookDropEvictions).toBe(0);

    // reaper1 releases; reaper2 can now run and does the work.
    h.reaper.releaseLock();
    const r2b = await reaper2.run();
    expect(r2b.skipped).toBe(false);
    expect(r2b.webhookDropEvictions).toBe(1);
  });

  it('two serial full-ticks on a closed PR: only the first evicts', async () => {
    const h = mkHarness({});
    const slot = bindPr(h, { prNumber: 42 });
    h.github.setState('owner/repo', 42, 'closed');

    const r1 = await h.reaper.run();
    expect(r1.webhookDropEvictions).toBe(1);

    const r2 = await h.reaper.run();
    // Second tick sees the slot already draining — markEvicting is a no-op
    // (atomic UPDATE WHERE status='busy' now matches 0 rows).
    expect(r2.webhookDropEvictions).toBe(0);
    expect(
      (
        h.db.prepare('SELECT status FROM pool_slots WHERE slot_id=?').get(slot) as {
          status: string;
        }
      ).status,
    ).toBe('draining');
  });

  it('stale lock is reclaimed after TTL expires', async () => {
    const h = mkHarness({ config: { lockTtlMs: 60_000 } });
    // First reaper acquires and "crashes" (never releases).
    expect(h.reaper.acquireLock()).toBe(true);

    // A second instance immediately can't steal.
    const reaper2 = new Reaper({
      db: h.db,
      allocator: h.allocator,
      docker: h.docker,
      github: h.github,
      clock: h.clock,
      config: { defaultRepoFullName: 'owner/repo', lockTtlMs: 60_000 },
    });
    reaper2.init();
    expect(reaper2.acquireLock()).toBe(false);

    // Advance past the TTL — now the steal path kicks in.
    h.clock.advance(61_000);
    expect(reaper2.acquireLock()).toBe(true);
  });

  it('releaseLock is scoped to the holder — does not clobber a successor', () => {
    const h = mkHarness({ config: { lockTtlMs: 1000 } });
    expect(h.reaper.acquireLock()).toBe(true);

    const reaper2 = new Reaper({
      db: h.db,
      allocator: h.allocator,
      docker: h.docker,
      github: h.github,
      clock: h.clock,
      config: { defaultRepoFullName: 'owner/repo', lockTtlMs: 1000 },
    });
    reaper2.init();
    h.clock.advance(2000);
    expect(reaper2.acquireLock()).toBe(true);

    // reaper1 returning late from its tick must not release reaper2's lease.
    h.reaper.releaseLock();
    const row = h.db
      .prepare('SELECT holder_id FROM pool_reaper_lock WHERE id=?')
      .get('singleton') as { holder_id: string } | undefined;
    expect(row).not.toBeUndefined();
  });
});

// ─── 3. Partial-cleanup recovery ──────────────────────────────────────────

describe('W4 reaper — partial-cleanup recovery', () => {
  it('(a) container down but slot still busy → webhook-drop path evicts', async () => {
    // Simulates: container died from the outside (compose kill, OOM no-
    // restart), webhook notification lost. Slot row still `busy`.
    const h = mkHarness({});
    const slot = bindPr(h, { prNumber: 42 });
    // Docker says no project exists for PR 42 (container gone), but slot
    // still busy. GitHub still reports the PR as open (it's the container
    // that died, not the PR). The webhook-drop path WON'T evict here —
    // that's correct: an external crash shouldn't trigger accounting as
    // "PR closed". The lifecycle layer owns crash detection via the
    // exit-reason classifier.
    h.github.setState('owner/repo', 42, 'open');
    const r = await h.reaper.run();
    expect(r.webhookDropEvictions).toBe(0);

    // But when GitHub catches up (PR closed after the crash), next tick
    // evicts.
    h.github.setState('owner/repo', 42, 'closed');
    const r2 = await h.reaper.run();
    expect(r2.webhookDropEvictions).toBe(1);
    expect(
      (
        h.db.prepare('SELECT status FROM pool_slots WHERE slot_id=?').get(slot) as {
          status: string;
        }
      ).status,
    ).toBe('draining');
  });

  it('(b) slot row gone but container still running → composeDown called', async () => {
    const h = mkHarness({});
    // Pretend a live compose project exists for PR 99 with no backing slot
    // row (e.g. allocator restart lost the binding).
    h.docker.projects.push({ projectName: 'agent-hub-pr-99', prNumber: 99 });
    const r = await h.reaper.run();
    expect(r.orphanedProjects).toBe(1);
    expect(h.docker.downCalls).toEqual(['agent-hub-pr-99']);
  });

  it('leaves a compose project alone if its slot is still live', async () => {
    const h = mkHarness({});
    const slot = bindPr(h, { prNumber: 7 });
    expect(slot).toBeTruthy();
    h.docker.projects.push({ projectName: 'agent-hub-pr-7', prNumber: 7 });
    const r = await h.reaper.run();
    expect(r.orphanedProjects).toBe(0);
    expect(h.docker.downCalls).toEqual([]);
  });

  it('a composeDown failure is logged and does not abort other passes', async () => {
    const h = mkHarness({});
    h.docker.projects.push({ projectName: 'agent-hub-pr-99', prNumber: 99 });
    h.docker.throwOnDown = new Error('daemon unreachable');
    // Also set up a crashed-scaffold so a later pass still runs.
    h.db
      .prepare(
        "UPDATE pool_slots SET status='reserved', last_activity_at='2000-01-01 00:00:00' WHERE slot_id='scaffold-1'",
      )
      .run();
    const r = await h.reaper.run();
    expect(r.orphanedProjects).toBe(0); // docker.down threw
    // But the scaffold pass still ran and reclaimed the stale reserved slot.
    // (Note: reapCrashedScaffolds runs before reapOrphanedComposeProjects,
    // so order doesn't matter for this assertion — both passes execute.)
    expect(r.crashedScaffolds).toBe(1);
  });
});

// ─── 4. Crashed-scaffold reclaim ──────────────────────────────────────────

describe('W4 reaper — crashed scaffold reclaim', () => {
  it('reclaims a reserved slot past the provisioning timeout', async () => {
    const h = mkHarness({ config: { provisioningStaleMs: 60_000 } });
    // Manually put scaffold-1 into the reserved state with an old activity.
    h.db
      .prepare(
        "UPDATE pool_slots SET status='reserved', last_activity_at='2000-01-01 00:00:00' WHERE slot_id='scaffold-1'",
      )
      .run();
    const r = await h.reaper.run();
    expect(r.crashedScaffolds).toBe(1);
    const row = h.db.prepare('SELECT status FROM pool_slots WHERE slot_id=?').get('scaffold-1') as {
      status: string;
    };
    expect(row.status).toBe('free');
  });

  it('treats null last_activity_at as stale (defensive default)', async () => {
    const h = mkHarness({ config: { provisioningStaleMs: 60_000 } });
    h.db
      .prepare(
        "UPDATE pool_slots SET status='reserved', last_activity_at=NULL WHERE slot_id='scaffold-1'",
      )
      .run();
    const r = await h.reaper.run();
    expect(r.crashedScaffolds).toBe(1);
  });

  it('leaves fresh reserved slots alone', async () => {
    const h = mkHarness({ config: { provisioningStaleMs: 60_000 } });
    h.db
      .prepare(
        "UPDATE pool_slots SET status='reserved', last_activity_at=? WHERE slot_id='scaffold-1'",
      )
      .run(h.clock.nowIso());
    const r = await h.reaper.run();
    expect(r.crashedScaffolds).toBe(0);
  });

  it('isProvisioningStale predicate matches the internal claim', () => {
    const now = Date.parse('2026-04-20T10:00:00Z');
    expect(
      isProvisioningStale(
        { status: 'reserved', last_activity_at: '2026-04-20 09:00:00' },
        now,
        60 * 60 * 1000,
      ),
    ).toBe(true);
    expect(
      isProvisioningStale(
        { status: 'reserved', last_activity_at: '2026-04-20 09:55:00' },
        now,
        60 * 60 * 1000,
      ),
    ).toBe(false);
    expect(isProvisioningStale({ status: 'free', last_activity_at: null }, now, 60 * 1000)).toBe(
      false,
    );
  });
});

// ─── 5. Stuck-draining reclaim ────────────────────────────────────────────

describe('W4 reaper — stuck-draining reclaim', () => {
  it('force-releases a slot stuck draining past the timeout', async () => {
    const h = mkHarness({ config: { drainingStaleMs: 60_000 } });
    h.db
      .prepare(
        `UPDATE pool_slots
            SET status='draining',
                container_id='c-abc',
                started_at='2000-01-01 00:00:00',
                last_activity_at='2000-01-01 00:00:00',
                pr_number=7,
                pr_state='closed'
          WHERE slot_id='pr-1'`,
      )
      .run();
    const r = await h.reaper.run();
    expect(r.stuckDraining).toBe(1);
    const row = h.db
      .prepare('SELECT status, container_id, pr_number FROM pool_slots WHERE slot_id=?')
      .get('pr-1') as { status: string; container_id: string | null; pr_number: number | null };
    expect(row.status).toBe('free');
    expect(row.container_id).toBeNull();
    expect(row.pr_number).toBeNull();
  });

  it('leaves a fresh draining slot alone', async () => {
    const h = mkHarness({ config: { drainingStaleMs: 60_000 } });
    h.db
      .prepare(
        `UPDATE pool_slots
            SET status='draining', started_at=?
          WHERE slot_id='pr-1'`,
      )
      .run(h.clock.nowIso());
    const r = await h.reaper.run();
    expect(r.stuckDraining).toBe(0);
  });
});

// ─── 6. Stale port reservations ───────────────────────────────────────────

describe('W4 reaper — stale port reservations', () => {
  it('releases a port whose PR is closed and has no live slot', async () => {
    const h = mkHarness({});
    h.db
      .prepare(`INSERT INTO pr_env_ports (repo_full_name, pr_number, port) VALUES (?, ?, ?)`)
      .run('owner/repo', 55, 3200);
    h.github.setState('owner/repo', 55, 'closed');
    const r = await h.reaper.run();
    expect(r.stalePortsReleased).toBe(1);
    const row = h.db.prepare('SELECT COUNT(*) AS n FROM pr_env_ports WHERE port=?').get(3200) as {
      n: number;
    };
    expect(row.n).toBe(0);
  });

  it('leaves a port tied to a live slot alone, even if GitHub says closed', async () => {
    const h = mkHarness({});
    bindPr(h, { prNumber: 55 });
    h.db
      .prepare(`INSERT INTO pr_env_ports (repo_full_name, pr_number, port) VALUES (?, ?, ?)`)
      .run('owner/repo', 55, 3200);
    // Even if GitHub reports closed, the slot's still live; the webhook-
    // drop path will handle it, and the port stays until the slot releases.
    h.github.setState('owner/repo', 55, 'closed');
    const r = await h.reaper.run();
    expect(r.stalePortsReleased).toBe(0);
  });

  it('leaves a port alone when GitHub reports the PR as open', async () => {
    const h = mkHarness({});
    h.db
      .prepare(`INSERT INTO pr_env_ports (repo_full_name, pr_number, port) VALUES (?, ?, ?)`)
      .run('owner/repo', 55, 3200);
    h.github.setState('owner/repo', 55, 'open');
    const r = await h.reaper.run();
    expect(r.stalePortsReleased).toBe(0);
    expect((h.db.prepare('SELECT COUNT(*) AS n FROM pr_env_ports').get() as { n: number }).n).toBe(
      1,
    );
  });

  it('is a no-op if the port-pool table is absent', async () => {
    const db = new Database(':memory:');
    db.exec(POOL_SCHEMA);
    // Intentionally skip PORT_POOL_SCHEMA.
    const clock = makeClock();
    const allocator = new PoolAllocator(db, {
      config: { prEnvSlots: 1, scaffoldSlots: 0, overflowSlots: 0 },
      clock,
    });
    allocator.init();
    const docker = new FakeDocker();
    const github = new FakeGitHub();
    const reaper = new Reaper({
      db,
      allocator,
      docker,
      github,
      clock,
      config: { defaultRepoFullName: 'owner/repo' },
    });
    reaper.init();
    const r = await reaper.run();
    expect(r.stalePortsReleased).toBe(0);
    expect(r.skipped).toBe(false);
  });
});

// ─── 7. Cross-cutting safety ──────────────────────────────────────────────

describe('W4 reaper — cross-cutting', () => {
  it('all counters start at zero on a quiet pool', async () => {
    const h = mkHarness({});
    const r = await h.reaper.run();
    expect(r.skipped).toBe(false);
    expect(r.webhookDropEvictions).toBe(0);
    expect(r.crashedScaffolds).toBe(0);
    expect(r.stuckDraining).toBe(0);
    expect(r.orphanedProjects).toBe(0);
    expect(r.stalePortsReleased).toBe(0);
  });

  it('listPrEnvProjects failure is logged and does not abort the tick', async () => {
    const h = mkHarness({});
    h.docker.throwOnList = new Error('daemon unreachable');
    // Also queue up a webhook-drop eviction so we can prove the tick
    // continued past the docker failure.
    bindPr(h, { prNumber: 1 });
    h.github.setState('owner/repo', 1, 'closed');
    const r = await h.reaper.run();
    expect(r.orphanedProjects).toBe(0);
    expect(r.webhookDropEvictions).toBe(1);
  });

  it('skips slots with no repo mapping silently', async () => {
    const h = mkHarness({ defaultRepo: '' });
    bindPr(h, { prNumber: 1 });
    h.github.setState('', 1, 'closed');
    const r = await h.reaper.run();
    // No repo → skip, no github call.
    expect(r.webhookDropEvictions).toBe(0);
    expect(h.github.calls).toEqual([]);
  });

  it('skips non-PR-bound overflow slots in the webhook-drop pass', async () => {
    const h = mkHarness({ overflowSlots: 1 });
    // Force overflow-1 busy with NO pr_number — simulating a scaffold
    // overflow binding.
    h.db
      .prepare("UPDATE pool_slots SET status='busy', container_id='c-s' WHERE slot_id='overflow-1'")
      .run();
    const r = await h.reaper.run();
    expect(r.webhookDropEvictions).toBe(0);
    expect(h.github.calls).toEqual([]);
  });

  it('respects custom getRepoForSlot for multi-repo pools', async () => {
    const db = new Database(':memory:');
    db.exec(POOL_SCHEMA);
    db.exec(PORT_POOL_SCHEMA);
    const clock = makeClock();
    const allocator = new PoolAllocator(db, {
      config: { prEnvSlots: 2, scaffoldSlots: 0, overflowSlots: 0 },
      clock,
    });
    allocator.init();
    const docker = new FakeDocker();
    const github = new FakeGitHub();
    const reaper = new Reaper({
      db,
      allocator,
      docker,
      github,
      clock,
      config: { defaultRepoFullName: 'fallback/repo' },
      getRepoForSlot: (slotId) => (slotId === 'pr-1' ? 'acme/frontend' : 'acme/backend'),
    });
    reaper.init();

    allocator.enqueue('pr_env', { pr: 11 });
    allocator.enqueue('pr_env', { pr: 22 });
    allocator.tick();
    allocator.updatePrMetadata('pr-1', { prNumber: 11, prState: 'open' });
    allocator.updatePrMetadata('pr-2', { prNumber: 22, prState: 'open' });

    github.setState('acme/frontend', 11, 'closed');
    github.setState('acme/backend', 22, 'open');

    const r = await reaper.run();
    expect(r.webhookDropEvictions).toBe(1);
    expect(
      (
        db.prepare('SELECT status FROM pool_slots WHERE slot_id=?').get('pr-1') as {
          status: string;
        }
      ).status,
    ).toBe('draining');
    expect(
      (
        db.prepare('SELECT status FROM pool_slots WHERE slot_id=?').get('pr-2') as {
          status: string;
        }
      ).status,
    ).toBe('busy');
  });
});
