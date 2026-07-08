import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'os';
import path from 'path';
import { mkdirSync, rmSync, existsSync } from 'fs';
import Database from 'better-sqlite3';
import { storeReplay, type ReplayEvent } from './replay-store.js';
import {
  runReplayRetentionSweep,
  startReplayRetentionSweeper,
  toSqliteUtc,
  DEFAULT_MAX_PER_SWEEP,
} from './replay-retention-sweeper.js';
import { resetArtifactStoreCache } from '../artifacts/artifact-store.js';
import { S3ArtifactStore } from '../artifacts/artifact-store-s3.js';
import type { AppConfig, SessionReplayRow, Stmts } from '../types.js';

const EVENTS: ReplayEvent[] = [
  { type: 4, timestamp: 1000, data: {} },
  { type: 2, timestamp: 1001, data: { node: {} } },
  { type: 3, timestamp: 1500, data: { source: 2 } },
];

const MS_PER_DAY = 24 * 60 * 60 * 1000;

describe('toSqliteUtc', () => {
  it('formats epoch ms as SQLite UTC text (no T, no Z, no millis)', () => {
    // 2026-06-01T12:34:56.789Z
    const ms = Date.UTC(2026, 5, 1, 12, 34, 56, 789);
    expect(toSqliteUtc(ms)).toBe('2026-06-01 12:34:56');
  });
});

describe('runReplayRetentionSweep', () => {
  let dataDir: string;
  let db: Database.Database;
  let stmts: Stmts;
  let config: AppConfig;

  function makeStmts(database: Database.Database): Stmts {
    database.exec(`
      CREATE TABLE session_replays (
        id TEXT PRIMARY KEY,
        project_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        duration_ms INTEGER NOT NULL DEFAULT 0,
        event_count INTEGER NOT NULL DEFAULT 0,
        size INTEGER NOT NULL DEFAULT 0,
        uncompressed_size INTEGER NOT NULL DEFAULT 0,
        storage_kind TEXT NOT NULL,
        storage_key TEXT NOT NULL,
        storage_bucket TEXT,
        storage_region TEXT,
        support_ticket_id TEXT,
        card_id TEXT,
        retained_until TEXT,
        retention_flagged_at TEXT,
        meta TEXT
      );
    `);
    return {
      insertSessionReplay: database.prepare(
        `INSERT INTO session_replays
           (id, project_id, duration_ms, event_count, size, uncompressed_size,
            storage_kind, storage_key, storage_bucket, storage_region,
            support_ticket_id, card_id, meta)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ),
      getSessionReplay: database.prepare('SELECT * FROM session_replays WHERE id = ?'),
      deleteSessionReplay: database.prepare('DELETE FROM session_replays WHERE id = ?'),
      getExpiredUnlinkedSessionReplays: database.prepare(
        `SELECT * FROM session_replays
          WHERE created_at < ?
            AND (retained_until IS NULL OR retained_until <= ?)
            AND support_ticket_id IS NULL
            AND card_id IS NULL
          ORDER BY created_at ASC
          LIMIT ?`,
      ),
      getExpiredUnlinkedSessionReplaysByProject: database.prepare(
        `SELECT * FROM session_replays
          WHERE created_at < ?
            AND (retained_until IS NULL OR retained_until <= ?)
            AND support_ticket_id IS NULL
            AND card_id IS NULL
            AND project_id = ?
          ORDER BY created_at ASC
          LIMIT ?`,
      ),
      flagSessionReplayRetention: database.prepare(
        `UPDATE session_replays
            SET retained_until = ?, retention_flagged_at = ?
          WHERE id = ?`,
      ),
    } as unknown as Stmts;
  }

  /** Insert a replay at a given age (days old) by writing its blob then back-
   *  dating its created_at, optionally linking it to a ticket/card. Returns the
   *  stored row. */
  async function seedReplay(opts: {
    id: string;
    ageDays: number;
    ticketId?: string | null;
    cardId?: string | null;
    projectId?: string | null;
  }): Promise<SessionReplayRow> {
    await storeReplay(
      { stmts, config },
      { id: opts.id, events: EVENTS, meta: { trigger: 'error' } },
    );
    const createdAt = toSqliteUtc(Date.now() - opts.ageDays * MS_PER_DAY);
    db.prepare(
      'UPDATE session_replays SET created_at = ?, support_ticket_id = ?, card_id = ?, project_id = ? WHERE id = ?',
    ).run(createdAt, opts.ticketId ?? null, opts.cardId ?? null, opts.projectId ?? null, opts.id);
    return db
      .prepare('SELECT * FROM session_replays WHERE id = ?')
      .get(opts.id) as SessionReplayRow;
  }

  function blobPath(row: SessionReplayRow): string {
    return path.join(dataDir, 'artifacts', row.storage_key);
  }

  beforeEach(() => {
    dataDir = path.join(
      os.tmpdir(),
      `agent-hub-replay-retention-${process.pid}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(dataDir, { recursive: true });
    resetArtifactStoreCache();
    db = new Database(':memory:');
    stmts = makeStmts(db);
    config = { dataDir, replayRetentionDays: 30 } as unknown as AppConfig;
  });

  afterEach(() => {
    db.close();
    try {
      if (existsSync(dataDir)) rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* noop */
    }
  });

  it('is a no-op when retention is disabled (replayRetentionDays = 0)', async () => {
    config = { dataDir, replayRetentionDays: 0 } as unknown as AppConfig;
    const old = await seedReplay({ id: 'r-old', ageDays: 90 });

    const result = await runReplayRetentionSweep({ stmts, config });

    expect(result).toMatchObject({ enabled: false, deleted: 0, failed: 0 });
    expect(stmts.getSessionReplay.get('r-old')).toBeTruthy();
    expect(existsSync(blobPath(old))).toBe(true);
  });

  it('deletes expired unlinked replays (row + blob) and keeps fresh ones', async () => {
    const expired = await seedReplay({ id: 'r-expired', ageDays: 45 });
    const fresh = await seedReplay({ id: 'r-fresh', ageDays: 5 });

    const result = await runReplayRetentionSweep({ stmts, config });

    expect(result).toMatchObject({ enabled: true, deleted: 1, failed: 0 });
    // Expired one is gone, blob reclaimed.
    expect(stmts.getSessionReplay.get('r-expired')).toBeUndefined();
    expect(existsSync(blobPath(expired))).toBe(false);
    // Fresh one survives.
    expect(stmts.getSessionReplay.get('r-fresh')).toBeTruthy();
    expect(existsSync(blobPath(fresh))).toBe(true);
  });

  /** Seed an expired, S3-backed row directly (no bytes written). */
  function seedS3Row(id: string): void {
    stmts.insertSessionReplay.run(
      id,
      'proj',
      100,
      3,
      200,
      400,
      's3',
      `rum/proj/2026/05/01/sess/view/${id}.json.gz`,
      'rum-bucket',
      'us-east-1',
      null,
      null,
      null,
    );
    db.prepare('UPDATE session_replays SET created_at = ? WHERE id = ?').run(
      toSqliteUtc(Date.now() - 60 * MS_PER_DAY),
      id,
    );
  }

  it('expires an S3-backed row WITHOUT deleting bytes when lifecycle is provisioned', async () => {
    // Confirmed-provisioned: the object is reaped by the bucket lifecycle rule,
    // not the app sweeper. A real S3 delete here would be a network call the sweep
    // must never make.
    seedS3Row('s3-expired');

    const s3DeleteSpy = vi.spyOn(S3ArtifactStore.prototype, 'delete');
    try {
      const result = await runReplayRetentionSweep({
        stmts,
        config,
        isLifecycleProvisioned: () => true,
      });

      expect(result).toMatchObject({ enabled: true, deleted: 1, failed: 0 });
      // Index row is gone (reconciled against the bytes lifecycle reaps)...
      expect(stmts.getSessionReplay.get('s3-expired')).toBeUndefined();
      // ...but the sweeper never touched the object.
      expect(s3DeleteSpy).not.toHaveBeenCalled();
    } finally {
      s3DeleteSpy.mockRestore();
    }
  });

  it('DELETES S3 bytes when lifecycle provisioning is unconfirmed (no orphans)', async () => {
    // Provisioning is best-effort; if it failed (missing IAM), lifecycle will
    // NOT expire the object, so the sweeper must delete it itself before dropping
    // the only pointer — otherwise it strands an un-indexed, never-expiring orphan.
    seedS3Row('s3-orphan-risk');

    // Stub the S3 delete so the fallback path doesn't make a real network call.
    const s3DeleteSpy = vi.spyOn(S3ArtifactStore.prototype, 'delete').mockResolvedValue(undefined);
    try {
      // isLifecycleProvisioned omitted → defaults to the safe "not provisioned".
      const result = await runReplayRetentionSweep({ stmts, config });

      expect(result).toMatchObject({ enabled: true, deleted: 1, failed: 0 });
      expect(stmts.getSessionReplay.get('s3-orphan-risk')).toBeUndefined();
      // The object WAS deleted by the sweeper (fallback), keyed by its storage key.
      expect(s3DeleteSpy).toHaveBeenCalledWith(
        'rum/proj/2026/05/01/sess/view/s3-orphan-risk.json.gz',
      );
    } finally {
      s3DeleteSpy.mockRestore();
    }
  });

  it('never deletes linked replays even when expired (triage history is preserved)', async () => {
    const ticketLinked = await seedReplay({ id: 'r-ticket', ageDays: 365, ticketId: 'ticket-1' });
    const cardLinked = await seedReplay({ id: 'r-card', ageDays: 365, cardId: 'card-1' });
    const unlinked = await seedReplay({ id: 'r-plain', ageDays: 365 });

    const result = await runReplayRetentionSweep({ stmts, config });

    expect(result.deleted).toBe(1);
    expect(stmts.getSessionReplay.get('r-ticket')).toBeTruthy();
    expect(existsSync(blobPath(ticketLinked))).toBe(true);
    expect(stmts.getSessionReplay.get('r-card')).toBeTruthy();
    expect(existsSync(blobPath(cardLinked))).toBe(true);
    expect(stmts.getSessionReplay.get('r-plain')).toBeUndefined();
    expect(existsSync(blobPath(unlinked))).toBe(false);
  });

  it('never expires a session flagged for extended retention (future retained_until)', async () => {
    // An expired capture flagged today for 15 months: its retained_until is far
    // in the future, so the default 30-day sweep must skip it.
    const flagged = await seedReplay({ id: 'r-flagged', ageDays: 400 });
    const retainedUntil = toSqliteUtc(Date.now() + 400 * MS_PER_DAY);
    stmts.flagSessionReplayRetention.run(retainedUntil, toSqliteUtc(Date.now()), 'r-flagged');

    const result = await runReplayRetentionSweep({ stmts, config });

    expect(result.deleted).toBe(0);
    // Row + blob both survive despite being well past the base window.
    expect(stmts.getSessionReplay.get('r-flagged')).toBeTruthy();
    expect(existsSync(blobPath(flagged))).toBe(true);
  });

  it('re-sweeps a flagged capture once its extended-retention window lapses', async () => {
    // retained_until is in the PAST (the 15-month extension already elapsed):
    // the row rejoins the normal sweep and is expired like any other.
    const lapsed = await seedReplay({ id: 'r-lapsed', ageDays: 500 });
    const retainedUntil = toSqliteUtc(Date.now() - MS_PER_DAY);
    stmts.flagSessionReplayRetention.run(retainedUntil, toSqliteUtc(Date.now()), 'r-lapsed');

    const result = await runReplayRetentionSweep({ stmts, config });

    expect(result.deleted).toBe(1);
    expect(stmts.getSessionReplay.get('r-lapsed')).toBeUndefined();
    expect(existsSync(blobPath(lapsed))).toBe(false);
  });

  it('bounds deletions per sweep and drains the backlog over subsequent sweeps', async () => {
    for (let i = 0; i < 5; i++) {
      await seedReplay({ id: `r-${i}`, ageDays: 60 });
    }

    const first = await runReplayRetentionSweep({ stmts, config }, 2);
    expect(first.deleted).toBe(2);

    const second = await runReplayRetentionSweep({ stmts, config }, 2);
    expect(second.deleted).toBe(2);

    const third = await runReplayRetentionSweep({ stmts, config }, 2);
    expect(third.deleted).toBe(1);

    const fourth = await runReplayRetentionSweep({ stmts, config }, 2);
    expect(fourth.deleted).toBe(0);
  });

  it('counts a blob-delete failure without aborting the rest of the sweep', async () => {
    await seedReplay({ id: 'r-good', ageDays: 60 });
    const bad = await seedReplay({ id: 'r-bad', ageDays: 90 });
    // Corrupt the bad row so expireReplayRow resolves the wrong backend and throws.
    db.prepare('UPDATE session_replays SET storage_kind = ? WHERE id = ?').run('bogus', bad.id);

    const logs: string[] = [];
    const result = await runReplayRetentionSweep({
      stmts,
      config,
      log: (m) => logs.push(m),
    });

    // Oldest-first: r-bad (90d) is attempted before r-good (60d). The failure is
    // counted, the good one still gets deleted.
    expect(result.failed).toBe(1);
    expect(result.deleted).toBe(1);
    expect(stmts.getSessionReplay.get('r-good')).toBeUndefined();
    expect(logs.some((l) => l.includes('failed to delete replay r-bad'))).toBe(true);
  });

  it('uses a default per-sweep cap when none is given', () => {
    expect(DEFAULT_MAX_PER_SWEEP).toBeGreaterThan(0);
  });

  it('enforces a per-tenant tighter window before the global window applies', async () => {
    const fast = await seedReplay({ id: 'fast-old', ageDays: 10, projectId: 'fast' });
    const slow = await seedReplay({ id: 'slow-mid', ageDays: 10, projectId: 'proj' });

    const result = await runReplayRetentionSweep({
      stmts,
      config,
      getRetentionOverrides: () => [{ projectId: 'fast', retentionDays: 7 }],
    });

    expect(result).toMatchObject({ enabled: true, deleted: 1 });
    // The overridden tenant's 10-day replay is gone (> 7-day window); the default
    // tenant's 10-day replay survives (< 30-day global window).
    expect(stmts.getSessionReplay.get('fast-old')).toBeUndefined();
    expect(existsSync(blobPath(fast))).toBe(false);
    expect(stmts.getSessionReplay.get('slow-mid')).toBeTruthy();
    expect(existsSync(blobPath(slow))).toBe(true);
  });

  it('runs per-tenant passes even when the global window is off', async () => {
    config = { dataDir, replayRetentionDays: 0 } as unknown as AppConfig;
    await seedReplay({ id: 'opt-in-old', ageDays: 20, projectId: 'optin' });
    await seedReplay({ id: 'default-old', ageDays: 90, projectId: 'proj' });

    const result = await runReplayRetentionSweep({
      stmts,
      config,
      getRetentionOverrides: () => [{ projectId: 'optin', retentionDays: 14 }],
    });

    expect(result).toMatchObject({ enabled: true, deleted: 1, cutoff: null });
    expect(stmts.getSessionReplay.get('opt-in-old')).toBeUndefined();
    expect(stmts.getSessionReplay.get('default-old')).toBeTruthy();
  });

  // ── Per-tenant S3 byte-ownership gate (regression: reviewer finding 2) ──────
  it('per-tenant pass DELETES S3 bytes itself when the tenant prefix rule is unconfirmed (global off)', async () => {
    // Global window OFF + a tenant override. If the sweeper delegated to a
    // per-prefix lifecycle rule that was never installed, the bytes would live
    // FOREVER. It must delete them itself instead.
    config = { dataDir, replayRetentionDays: 0 } as unknown as AppConfig;
    seedS3Row('t-off'); // project 'proj', 60 days old
    const s3DeleteSpy = vi.spyOn(S3ArtifactStore.prototype, 'delete').mockResolvedValue(undefined);
    try {
      const result = await runReplayRetentionSweep({
        stmts,
        config,
        getRetentionOverrides: () => [{ projectId: 'proj', retentionDays: 7 }],
        // isProjectLifecycleProvisioned omitted → the tenant rule is not confirmed.
      });
      expect(result.deleted).toBe(1);
      expect(stmts.getSessionReplay.get('t-off')).toBeUndefined();
      expect(s3DeleteSpy).toHaveBeenCalledWith('rum/proj/2026/05/01/sess/view/t-off.json.gz');
    } finally {
      s3DeleteSpy.mockRestore();
    }
  });

  it('per-tenant pass does NOT trust the GLOBAL lifecycle flag (tighter window would be violated)', async () => {
    // Global lifecycle IS confirmed, but the tenant's own tighter prefix rule is
    // NOT. Trusting the global rule would keep the tenant's bytes until the looser
    // global window. The per-tenant pass must delete them itself.
    seedS3Row('t-leak'); // project 'proj', 60 days old; global window = 30d
    const s3DeleteSpy = vi.spyOn(S3ArtifactStore.prototype, 'delete').mockResolvedValue(undefined);
    try {
      const result = await runReplayRetentionSweep({
        stmts,
        config,
        getRetentionOverrides: () => [{ projectId: 'proj', retentionDays: 7 }],
        isLifecycleProvisioned: () => true, // global confirmed...
        isProjectLifecycleProvisioned: () => false, // ...tenant prefix NOT confirmed
      });
      expect(result.deleted).toBe(1);
      // The global flag must not leak into the per-tenant pass.
      expect(s3DeleteSpy).toHaveBeenCalledWith('rum/proj/2026/05/01/sess/view/t-leak.json.gz');
    } finally {
      s3DeleteSpy.mockRestore();
    }
  });

  it('per-tenant pass DELEGATES S3 bytes once the tenant prefix rule is confirmed', async () => {
    seedS3Row('t-prov'); // project 'proj', 60 days old
    const s3DeleteSpy = vi.spyOn(S3ArtifactStore.prototype, 'delete');
    try {
      const result = await runReplayRetentionSweep({
        stmts,
        config,
        getRetentionOverrides: () => [{ projectId: 'proj', retentionDays: 7 }],
        isProjectLifecycleProvisioned: (pid) => pid === 'proj',
      });
      expect(result.deleted).toBe(1);
      expect(stmts.getSessionReplay.get('t-prov')).toBeUndefined();
      // The tenant's prefix rule owns the bytes — the sweeper must not touch S3.
      expect(s3DeleteSpy).not.toHaveBeenCalled();
    } finally {
      s3DeleteSpy.mockRestore();
    }
  });
});

describe('startReplayRetentionSweeper', () => {
  it('returns a no-op stopper when retention is disabled', () => {
    const stop = startReplayRetentionSweeper({
      stmts: {} as Stmts,
      config: { replayRetentionDays: 0 } as unknown as AppConfig,
    });
    expect(typeof stop).toBe('function');
    expect(() => stop()).not.toThrow();
  });

  it('schedules a sweep on an interval and the stopper clears it', () => {
    let calls = 0;
    const stmts = {
      getExpiredUnlinkedSessionReplays: { all: () => (calls++, []) },
    } as unknown as Stmts;
    const stop = startReplayRetentionSweeper(
      { stmts, config: { replayRetentionDays: 30 } as unknown as AppConfig },
      10,
    );
    // No synchronous run at start; the first fire is one interval ahead.
    expect(calls).toBe(0);
    stop();
  });

  it('starts even when the global window is off if per-tenant overrides may exist', async () => {
    let calls = 0;
    const stmts = {
      getExpiredUnlinkedSessionReplaysByProject: { all: () => (calls++, []) },
    } as unknown as Stmts;
    const stop = startReplayRetentionSweeper(
      {
        stmts,
        config: { replayRetentionDays: 0 } as unknown as AppConfig,
        getRetentionOverrides: () => [{ projectId: 'p', retentionDays: 7 }],
      },
      10,
    );
    // The timer is live (not the no-op stopper): it fires and hits the per-project
    // query even though the global window is off.
    await new Promise((r) => setTimeout(r, 25));
    stop();
    expect(calls).toBeGreaterThan(0);
  });
});
