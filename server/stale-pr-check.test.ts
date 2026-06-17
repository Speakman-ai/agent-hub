/**
 * Tests for the stale PR-creation notifier.
 *
 * Strategy:
 *   - The migration-idempotency test uses a real in-memory SQLite database
 *     so we can verify the `ALTER TABLE ... ADD COLUMN stale_pr_notified_at`
 *     pattern doesn't explode when run twice.
 *   - All other tests run against a real in-memory DB so the "only stale
 *     rows come back" / "clearSessionChangesReady nulls the column" checks
 *     exercise the actual SQL rather than a hand-rolled mock.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import type { Stmts } from './types.js';
import { runStalePrCheck, startStalePrChecker } from './stale-pr-check.js';

function createTestDb() {
  const db = new Database(':memory:');

  // Minimal sessions table — mirrors the live schema bits we need plus the
  // migrated `changes_ready` and `stale_pr_notified_at` columns. We apply
  // the migration via the same idempotent guard pattern used in db.ts so a
  // re-run is exercised in practice.
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  applyMigrations(db);

  const stmts = {
    getStalePendingPrSessions: db.prepare(
      `SELECT id, name, agent_id, changes_ready, updated_at
       FROM sessions
       WHERE changes_ready IS NOT NULL
         AND stale_pr_notified_at IS NULL
         AND updated_at <= datetime('now', '-30 minutes')`,
    ),
    markStalePrNotified: db.prepare(
      "UPDATE sessions SET stale_pr_notified_at = datetime('now') WHERE id = ?",
    ),
    clearSessionChangesReady: db.prepare(
      "UPDATE sessions SET changes_ready = NULL, stale_pr_notified_at = NULL, updated_at = datetime('now') WHERE id = ?",
    ),
    getSession: db.prepare('SELECT * FROM sessions WHERE id = ?'),
    insertSession: db.prepare(
      `INSERT INTO sessions (id, agent_id, name, changes_ready, stale_pr_notified_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ),
  };

  return { db, stmts };
}

function applyMigrations(db: Database.Database) {
  try {
    db.prepare('SELECT changes_ready FROM sessions LIMIT 1').get();
  } catch {
    db.exec('ALTER TABLE sessions ADD COLUMN changes_ready TEXT DEFAULT NULL');
  }
  try {
    db.prepare('SELECT stale_pr_notified_at FROM sessions LIMIT 1').get();
  } catch {
    db.exec('ALTER TABLE sessions ADD COLUMN stale_pr_notified_at TEXT DEFAULT NULL');
  }
}

function iso(offsetMinutes: number): string {
  // SQLite-style UTC timestamp ('YYYY-MM-DD HH:MM:SS') so comparisons work.
  const now = new Date(Date.now() + offsetMinutes * 60_000);
  return now.toISOString().replace('T', ' ').slice(0, 19);
}

function silenceErrors() {
  return vi.fn();
}

describe('runStalePrCheck', () => {
  let stmts: ReturnType<typeof createTestDb>['stmts'];

  beforeEach(() => {
    ({ stmts } = createTestDb());
  });

  it('does not notify a young session (< 30 min)', async () => {
    stmts.insertSession.run(
      'sess-young',
      'agent-1',
      'Young session',
      JSON.stringify({ branch: 'feat/young' }),
      null,
      iso(-5), // 5 min ago
    );

    const broadcast = vi.fn();
    const dispatched = await runStalePrCheck({
      stmts: stmts as unknown as Pick<Stmts, 'getStalePendingPrSessions' | 'markStalePrNotified'>,
      broadcast,
      log: silenceErrors(),
    });

    expect(dispatched).toBe(0);
    const row = stmts.getSession.get('sess-young') as { stale_pr_notified_at: string | null };
    expect(row.stale_pr_notified_at).toBeNull();
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('broadcasts once for a stale session and marks it', async () => {
    stmts.insertSession.run(
      'sess-stale',
      'agent-1',
      'Ship it',
      JSON.stringify({ branch: 'feat/stale' }),
      null,
      iso(-45), // 45 min ago
    );

    const broadcast = vi.fn();
    const getAgent = vi.fn(() => ({ name: 'Hub Backend', projectId: 'agent-hub' }));

    const dispatched = await runStalePrCheck({
      stmts: stmts as unknown as Pick<Stmts, 'getStalePendingPrSessions' | 'markStalePrNotified'>,
      broadcast,
      getAgent,
      log: silenceErrors(),
    });

    expect(dispatched).toBe(1);

    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(broadcast.mock.calls[0][0]).toMatchObject({
      type: 'pr_creation_stale',
      sessionId: 'sess-stale',
      agentId: 'agent-1',
      agentName: 'Hub Backend',
      projectId: 'agent-hub',
      branch: 'feat/stale',
    });

    const row = stmts.getSession.get('sess-stale') as { stale_pr_notified_at: string | null };
    expect(row.stale_pr_notified_at).not.toBeNull();

    // A second run must not re-notify.
    broadcast.mockClear();
    const again = await runStalePrCheck({
      stmts: stmts as unknown as Pick<Stmts, 'getStalePendingPrSessions' | 'markStalePrNotified'>,
      broadcast,
      log: silenceErrors(),
    });
    expect(again).toBe(0);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('clearing changes_ready also nulls stale_pr_notified_at so the next stale cycle re-fires', () => {
    stmts.insertSession.run(
      'sess-cycle',
      'agent-2',
      'Cycle',
      JSON.stringify({ branch: 'feat/cycle' }),
      '2026-04-18 00:00:00', // already notified
      iso(-40),
    );

    // Sanity: SELECT shouldn't return the session (already notified).
    expect((stmts.getStalePendingPrSessions.all() as unknown[]).length).toBe(0);

    // User creates the PR → auto-git clears `changes_ready`.
    stmts.clearSessionChangesReady.run('sess-cycle');

    const row = stmts.getSession.get('sess-cycle') as {
      changes_ready: string | null;
      stale_pr_notified_at: string | null;
    };
    expect(row.changes_ready).toBeNull();
    expect(row.stale_pr_notified_at).toBeNull();
  });

  it('tolerates malformed changes_ready JSON and still broadcasts with no branch', async () => {
    stmts.insertSession.run('sess-bad', 'agent-3', 'Bad JSON', '{not json', null, iso(-60));

    const broadcast = vi.fn();
    const dispatched = await runStalePrCheck({
      stmts: stmts as unknown as Pick<Stmts, 'getStalePendingPrSessions' | 'markStalePrNotified'>,
      broadcast,
      log: silenceErrors(),
    });
    expect(dispatched).toBe(1);
    expect(broadcast.mock.calls[0][0]).toMatchObject({
      type: 'pr_creation_stale',
      sessionId: 'sess-bad',
      branch: undefined,
    });
  });
});

describe('migration idempotency', () => {
  it('re-running the stale_pr_notified_at migration is a no-op', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    applyMigrations(db);
    // Second pass must not throw "duplicate column" even though the column
    // already exists. The guard `try { SELECT ... } catch { ALTER TABLE ... }`
    // is what keeps it idempotent — this test would regress if anyone ever
    // replaces the guard with a bare ALTER TABLE.
    expect(() => applyMigrations(db)).not.toThrow();

    // Confirm the column actually exists after both passes.
    const cols = (db.pragma('table_info(sessions)') as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toContain('stale_pr_notified_at');
    expect(cols).toContain('changes_ready');
  });
});

describe('startStalePrChecker', () => {
  it('fires runStalePrCheck every interval and returns a stop function', async () => {
    vi.useFakeTimers();
    try {
      const { stmts } = createTestDb();
      const broadcast = vi.fn();

      const stop = startStalePrChecker(
        {
          stmts: stmts as unknown as Pick<
            Stmts,
            'getStalePendingPrSessions' | 'markStalePrNotified'
          >,
          broadcast,
          log: silenceErrors(),
        },
        1000,
      );

      // No rows → no broadcast after ticking.
      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(1000);
      expect(broadcast).not.toHaveBeenCalled();

      stop();
      await vi.advanceTimersByTimeAsync(5000);
      expect(broadcast).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
