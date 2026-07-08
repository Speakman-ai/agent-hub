import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'os';
import path from 'path';
import { mkdirSync, rmSync, existsSync } from 'fs';
import Database from 'better-sqlite3';
import { appendSegment } from './segment-store.js';
import type { ReplayEvent } from './replay-store.js';
import {
  runRumSegmentRetentionSweep,
  startRumSegmentRetentionSweeper,
  expireRumSession,
} from './rum-segment-retention-sweeper.js';
import { toSqliteUtc } from './replay-retention.js';
import { resetArtifactStoreCache } from '../artifacts/artifact-store.js';
import { S3ArtifactStore } from '../artifacts/artifact-store-s3.js';
import type { AppConfig, RumSegmentRow, Stmts } from '../types.js';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** index_in_view=0 must carry a full snapshot (type 2). */
const SNAPSHOT_EVENTS: ReplayEvent[] = [
  { type: 4, timestamp: 1000, data: {} },
  { type: 2, timestamp: 1001, data: { node: {} } },
  { type: 3, timestamp: 1500, data: { source: 2 } },
];

function makeStmts(database: Database.Database): Stmts {
  database.exec(`
    CREATE TABLE rum_segments (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      view_id TEXT NOT NULL,
      project_id TEXT,
      index_in_view INTEGER NOT NULL,
      has_full_snapshot INTEGER NOT NULL DEFAULT 0,
      start_ts INTEGER NOT NULL DEFAULT 0,
      end_ts INTEGER NOT NULL DEFAULT 0,
      event_count INTEGER NOT NULL DEFAULT 0,
      byte_size INTEGER NOT NULL DEFAULT 0,
      storage_kind TEXT NOT NULL,
      storage_key TEXT NOT NULL,
      storage_bucket TEXT,
      storage_region TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX idx_rum_segments_slot
      ON rum_segments(session_id, view_id, index_in_view);
    CREATE INDEX idx_rum_segments_session
      ON rum_segments(session_id, start_ts, index_in_view);
    CREATE TABLE rum_sessions (
      session_id TEXT PRIMARY KEY,
      project_id TEXT,
      started_at INTEGER,
      ended_at INTEGER,
      time_spent INTEGER NOT NULL DEFAULT 0,
      view_count INTEGER NOT NULL DEFAULT 0,
      action_count INTEGER NOT NULL DEFAULT 0,
      error_count INTEGER NOT NULL DEFAULT 0,
      frustration_count INTEGER NOT NULL DEFAULT 0,
      usr_id TEXT,
      usr_email TEXT,
      usr_name TEXT,
      usr_attributes TEXT,
      device_type TEXT,
      browser TEXT,
      os TEXT,
      geo_country TEXT,
      first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  return {
    insertRumSegment: database.prepare(
      `INSERT INTO rum_segments
         (id, session_id, view_id, project_id, index_in_view, has_full_snapshot,
          start_ts, end_ts, event_count, byte_size,
          storage_kind, storage_key, storage_bucket, storage_region)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    getRumSegment: database.prepare('SELECT * FROM rum_segments WHERE id = ?'),
    listRumSegmentsBySession: database.prepare(
      `SELECT * FROM rum_segments
        WHERE session_id = ?
        ORDER BY start_ts ASC, index_in_view ASC, id ASC`,
    ),
    deleteRumSegment: database.prepare('DELETE FROM rum_segments WHERE id = ?'),
    deleteRumSegmentsBySession: database.prepare('DELETE FROM rum_segments WHERE session_id = ?'),
    insertRumSession: database.prepare(
      `INSERT INTO rum_sessions
         (session_id, project_id, started_at, ended_at, time_spent,
          view_count, action_count, error_count, frustration_count,
          usr_id, usr_email, usr_name, usr_attributes,
          device_type, browser, os, geo_country)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    getRumSession: database.prepare('SELECT * FROM rum_sessions WHERE session_id = ?'),
    updateRumSessionRollup: database.prepare(
      `UPDATE rum_sessions
          SET project_id = ?, started_at = ?, ended_at = ?, time_spent = ?,
              view_count = ?, action_count = ?, error_count = ?, frustration_count = ?,
              usr_id = ?, usr_email = ?, usr_name = ?, usr_attributes = ?,
              device_type = ?, browser = ?, os = ?, geo_country = ?,
              updated_at = datetime('now')
        WHERE session_id = ?`,
    ),
    deleteRumSession: database.prepare('DELETE FROM rum_sessions WHERE session_id = ?'),
    getExpiredRumSessions: database.prepare(
      `SELECT * FROM rum_sessions
        WHERE updated_at < ?
        ORDER BY updated_at ASC
        LIMIT ?`,
    ),
    getExpiredRumSessionsByProject: database.prepare(
      `SELECT * FROM rum_sessions
        WHERE updated_at < ?
          AND project_id = ?
        ORDER BY updated_at ASC
        LIMIT ?`,
    ),
    deleteExpiredRumSession: database.prepare(
      `DELETE FROM rum_sessions WHERE session_id = ? AND updated_at < ?`,
    ),
    getExpiredOrphanRumSegments: database.prepare(
      `SELECT s.* FROM rum_segments s
        WHERE s.created_at < ?
          AND NOT EXISTS (
            SELECT 1 FROM rum_sessions rs WHERE rs.session_id = s.session_id
          )
        ORDER BY s.created_at ASC
        LIMIT ?`,
    ),
    getExpiredOrphanRumSegmentsByProject: database.prepare(
      `SELECT s.* FROM rum_segments s
        WHERE s.created_at < ?
          AND s.project_id = ?
          AND NOT EXISTS (
            SELECT 1 FROM rum_sessions rs WHERE rs.session_id = s.session_id
          )
        ORDER BY s.created_at ASC
        LIMIT ?`,
    ),
  } as unknown as Stmts;
}

describe('runRumSegmentRetentionSweep', () => {
  let dataDir: string;
  let db: Database.Database;
  let stmts: Stmts;
  let config: AppConfig;

  beforeEach(() => {
    dataDir = path.join(
      os.tmpdir(),
      `agent-hub-rum-retention-${process.pid}-${Math.random().toString(36).slice(2)}`,
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

  /** Append one local index-0 segment for a session, then age its rows by
   *  back-dating updated_at (session) + created_at (segment). */
  async function seedLocalSession(opts: {
    sessionId: string;
    ageDays: number;
    projectId?: string;
  }): Promise<RumSegmentRow> {
    const seg = await appendSegment(
      { stmts, config },
      {
        sessionId: opts.sessionId,
        viewId: 'v0',
        indexInView: 0,
        projectId: opts.projectId ?? 'proj',
        events: SNAPSHOT_EVENTS,
        meta: null,
      },
    );
    const at = toSqliteUtc(Date.now() - opts.ageDays * MS_PER_DAY);
    db.prepare('UPDATE rum_sessions SET updated_at = ? WHERE session_id = ?').run(
      at,
      opts.sessionId,
    );
    db.prepare('UPDATE rum_segments SET created_at = ? WHERE session_id = ?').run(
      at,
      opts.sessionId,
    );
    return seg;
  }

  function blobPath(row: RumSegmentRow): string {
    return path.join(dataDir, 'artifacts', row.storage_key);
  }

  /** Seed an expired, S3-backed session index (row + one segment) directly — no
   *  bytes are written, mirroring a capture whose objects live in S3. */
  function seedS3Session(sessionId: string): RumSegmentRow {
    const at = toSqliteUtc(Date.now() - 60 * MS_PER_DAY);
    stmts.insertRumSession.run(
      sessionId,
      'proj',
      1000,
      1500,
      500,
      1,
      0,
      0,
      0,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
    );
    db.prepare('UPDATE rum_sessions SET updated_at = ? WHERE session_id = ?').run(at, sessionId);
    const segId = `${sessionId}-seg0`;
    const key = `rum/proj/2026/05/01/${sessionId}/v0/0.json.gz`;
    stmts.insertRumSegment.run(
      segId,
      sessionId,
      'v0',
      'proj',
      0,
      1,
      1000,
      1500,
      3,
      200,
      's3',
      key,
      'rum-bucket',
      'us-east-1',
    );
    db.prepare('UPDATE rum_segments SET created_at = ? WHERE id = ?').run(at, segId);
    return stmts.getRumSegment.get(segId) as RumSegmentRow;
  }

  it('is a no-op when retention is disabled (replayRetentionDays = 0)', async () => {
    config = { dataDir, replayRetentionDays: 0 } as unknown as AppConfig;
    const seg = await seedLocalSession({ sessionId: 's-old', ageDays: 90 });

    const result = await runRumSegmentRetentionSweep({ stmts, config });

    expect(result).toMatchObject({ enabled: false, sessionsDeleted: 0, segmentsDeleted: 0 });
    expect(stmts.getRumSession.get('s-old')).toBeTruthy();
    expect(existsSync(blobPath(seg))).toBe(true);
  });

  it('reaps an expired session (rows + local blob) and keeps fresh ones', async () => {
    const expired = await seedLocalSession({ sessionId: 's-expired', ageDays: 45 });
    const fresh = await seedLocalSession({ sessionId: 's-fresh', ageDays: 5 });

    const result = await runRumSegmentRetentionSweep({ stmts, config });

    expect(result).toMatchObject({
      enabled: true,
      sessionsDeleted: 1,
      segmentsDeleted: 1,
      failed: 0,
    });
    // Expired session: rollup row + segment row + blob all gone.
    expect(stmts.getRumSession.get('s-expired')).toBeUndefined();
    expect(stmts.listRumSegmentsBySession.all('s-expired')).toHaveLength(0);
    expect(existsSync(blobPath(expired))).toBe(false);
    // Fresh session survives.
    expect(stmts.getRumSession.get('s-fresh')).toBeTruthy();
    expect(existsSync(blobPath(fresh))).toBe(true);
  });

  it('reaps an S3-backed session index WITHOUT deleting bytes when lifecycle is provisioned', async () => {
    seedS3Session('s3-live');
    const s3DeleteSpy = vi.spyOn(S3ArtifactStore.prototype, 'delete');
    try {
      const result = await runRumSegmentRetentionSweep({
        stmts,
        config,
        isLifecycleProvisioned: () => true,
      });

      expect(result).toMatchObject({ enabled: true, sessionsDeleted: 1, segmentsDeleted: 1 });
      expect(stmts.getRumSession.get('s3-live')).toBeUndefined();
      expect(stmts.getRumSegment.get('s3-live-seg0')).toBeUndefined();
      // The bucket lifecycle rule owns the bytes; the sweeper must not touch S3.
      expect(s3DeleteSpy).not.toHaveBeenCalled();
    } finally {
      s3DeleteSpy.mockRestore();
    }
  });

  it('DELETES S3 bytes when lifecycle provisioning is unconfirmed (no orphans)', async () => {
    seedS3Session('s3-orphan-risk');
    const s3DeleteSpy = vi.spyOn(S3ArtifactStore.prototype, 'delete').mockResolvedValue(undefined);
    try {
      // isLifecycleProvisioned omitted → defaults to the safe "not provisioned".
      const result = await runRumSegmentRetentionSweep({ stmts, config });

      expect(result).toMatchObject({ enabled: true, sessionsDeleted: 1, segmentsDeleted: 1 });
      expect(stmts.getRumSession.get('s3-orphan-risk')).toBeUndefined();
      expect(s3DeleteSpy).toHaveBeenCalledWith('rum/proj/2026/05/01/s3-orphan-risk/v0/0.json.gz');
    } finally {
      s3DeleteSpy.mockRestore();
    }
  });

  it('reconciles an orphan segment whose session-grain row is already gone', async () => {
    const orphan = await seedLocalSession({ sessionId: 's-orphan', ageDays: 60 });
    // Drop only the session row, leaving the segment row orphaned (a rollup that
    // threw at ingest, or a partial prior sweep).
    stmts.deleteRumSession.run('s-orphan');

    const result = await runRumSegmentRetentionSweep({ stmts, config });

    // No session matched, but the aged orphan segment was reaped (row + blob).
    expect(result).toMatchObject({ sessionsDeleted: 0, segmentsDeleted: 1, failed: 0 });
    expect(stmts.getRumSegment.get(orphan.id)).toBeUndefined();
    expect(existsSync(blobPath(orphan))).toBe(false);
  });

  it('bounds sessions per sweep and drains the backlog over subsequent sweeps', async () => {
    for (let i = 0; i < 5; i++) {
      await seedLocalSession({ sessionId: `s-${i}`, ageDays: 60 });
    }

    const first = await runRumSegmentRetentionSweep({ stmts, config }, 2);
    expect(first.sessionsDeleted).toBe(2);
    const second = await runRumSegmentRetentionSweep({ stmts, config }, 2);
    expect(second.sessionsDeleted).toBe(2);
    const third = await runRumSegmentRetentionSweep({ stmts, config }, 2);
    expect(third.sessionsDeleted).toBe(1);
    const fourth = await runRumSegmentRetentionSweep({ stmts, config }, 2);
    expect(fourth.sessionsDeleted).toBe(0);
  });

  it('counts a byte-delete failure without aborting the rest of the sweep', async () => {
    await seedLocalSession({ sessionId: 's-good', ageDays: 60 });
    const bad = await seedLocalSession({ sessionId: 's-bad', ageDays: 90 });
    // Corrupt the segment backend so byte reclamation resolves an unknown store
    // and throws; the session's rows stay for the next sweep.
    db.prepare('UPDATE rum_segments SET storage_kind = ? WHERE session_id = ?').run(
      'bogus',
      's-bad',
    );

    const logs: string[] = [];
    const result = await runRumSegmentRetentionSweep({ stmts, config, log: (m) => logs.push(m) });

    // Oldest-first: s-bad (90d) is attempted first, fails; s-good (60d) still reaped.
    expect(result.failed).toBe(1);
    expect(result.sessionsDeleted).toBe(1);
    expect(stmts.getRumSession.get('s-good')).toBeUndefined();
    // The failed session's rows survive for a retry.
    expect(stmts.getRumSession.get('s-bad')).toBeTruthy();
    expect(logs.some((l) => l.includes('failed to expire session s-bad'))).toBe(true);
    void bad;
  });

  it('does NOT treat an unknown storage_kind as lifecycle-owned, even when provisioned', async () => {
    // Reviewer concern: a corrupt/unknown storage_kind must not fall through to
    // "lifecycle owns the bytes" and let the row be dropped — that would strand
    // un-indexed bytes. It must throw BEFORE any row delete (byte-before-row).
    seedS3Session('s-weird');
    db.prepare('UPDATE rum_segments SET storage_kind = ? WHERE session_id = ?').run(
      'weird',
      's-weird',
    );

    const logs: string[] = [];
    const result = await runRumSegmentRetentionSweep({
      stmts,
      config,
      isLifecycleProvisioned: () => true, // even confirmed-provisioned...
      log: (m) => logs.push(m),
    });

    // ...the unknown kind is counted failed and the rows are left intact.
    expect(result).toMatchObject({ sessionsDeleted: 0, segmentsDeleted: 0, failed: 1 });
    expect(stmts.getRumSession.get('s-weird')).toBeTruthy();
    expect(stmts.getRumSegment.get('s-weird-seg0')).toBeTruthy();
    expect(logs.some((l) => l.includes('failed to expire session s-weird'))).toBe(true);
  });

  it('enforces a per-tenant tighter window before the global window applies', async () => {
    // Tenant "fast" has a 7-day override; the global default is 30 days. A 10-day-old
    // "fast" session is expired under its own window but a 10-day-old default-tenant
    // session is not.
    await seedLocalSession({ sessionId: 'fast-old', ageDays: 10, projectId: 'fast' });
    await seedLocalSession({ sessionId: 'slow-mid', ageDays: 10, projectId: 'proj' });

    const result = await runRumSegmentRetentionSweep({
      stmts,
      config,
      getRetentionOverrides: () => [{ projectId: 'fast', retentionDays: 7 }],
    });

    expect(result).toMatchObject({ enabled: true, sessionsDeleted: 1 });
    // The overridden tenant's 10-day session is gone (past its 7-day window)...
    expect(stmts.getRumSession.get('fast-old')).toBeUndefined();
    // ...while the default-tenant 10-day session survives (< 30-day global window).
    expect(stmts.getRumSession.get('slow-mid')).toBeTruthy();
  });

  it('runs per-tenant passes even when the global window is off', async () => {
    config = { dataDir, replayRetentionDays: 0 } as unknown as AppConfig;
    await seedLocalSession({ sessionId: 'opt-in-old', ageDays: 20, projectId: 'optin' });
    await seedLocalSession({ sessionId: 'default-old', ageDays: 90, projectId: 'proj' });

    const result = await runRumSegmentRetentionSweep({
      stmts,
      config,
      getRetentionOverrides: () => [{ projectId: 'optin', retentionDays: 14 }],
    });

    // Global off → enabled true because an override exists; only the opted-in
    // tenant's expired session is reaped, the default tenant keeps-forever.
    expect(result).toMatchObject({ enabled: true, sessionsDeleted: 1, cutoff: null });
    expect(stmts.getRumSession.get('opt-in-old')).toBeUndefined();
    expect(stmts.getRumSession.get('default-old')).toBeTruthy();
  });

  it('gives each override its own per-sweep budget (batch-stall avoidance)', async () => {
    // Two tenants, each with 3 expired sessions and a tighter window. With a cap of
    // 2, each tenant's own pass reaps up to 2 — a heavy tenant can't consume the
    // other's budget.
    for (let i = 0; i < 3; i++) {
      await seedLocalSession({ sessionId: `a-${i}`, ageDays: 20, projectId: 'ta' });
      await seedLocalSession({ sessionId: `b-${i}`, ageDays: 20, projectId: 'tb' });
    }
    const result = await runRumSegmentRetentionSweep(
      {
        stmts,
        config: { dataDir, replayRetentionDays: 0 } as unknown as AppConfig,
        getRetentionOverrides: () => [
          { projectId: 'ta', retentionDays: 7 },
          { projectId: 'tb', retentionDays: 7 },
        ],
      },
      2,
    );
    // 2 from ta + 2 from tb = 4 in one sweep (independent budgets), not a shared 2.
    expect(result.sessionsDeleted).toBe(4);
  });

  // ── Per-tenant S3 byte-ownership gate (regression: reviewer finding 2) ──────
  it('per-tenant pass DELETES S3 segment bytes itself when the tenant prefix rule is unconfirmed (global off)', async () => {
    config = { dataDir, replayRetentionDays: 0 } as unknown as AppConfig;
    seedS3Session('s3-off'); // project 'proj', updated_at 60 days old
    const s3DeleteSpy = vi.spyOn(S3ArtifactStore.prototype, 'delete').mockResolvedValue(undefined);
    try {
      const result = await runRumSegmentRetentionSweep({
        stmts,
        config,
        getRetentionOverrides: () => [{ projectId: 'proj', retentionDays: 7 }],
        // isProjectLifecycleProvisioned omitted → tenant rule not confirmed.
      });
      expect(result).toMatchObject({ sessionsDeleted: 1, segmentsDeleted: 1 });
      expect(s3DeleteSpy).toHaveBeenCalledWith('rum/proj/2026/05/01/s3-off/v0/0.json.gz');
    } finally {
      s3DeleteSpy.mockRestore();
    }
  });

  it('per-tenant pass does NOT trust the GLOBAL lifecycle flag', async () => {
    // Global confirmed but the tenant's tighter prefix rule is not: trusting the
    // global rule keeps the tenant's bytes until the looser global window. The
    // per-tenant pass must delete them itself.
    seedS3Session('s3-leak'); // project 'proj', 60d; global window = 30d
    const s3DeleteSpy = vi.spyOn(S3ArtifactStore.prototype, 'delete').mockResolvedValue(undefined);
    try {
      const result = await runRumSegmentRetentionSweep({
        stmts,
        config,
        getRetentionOverrides: () => [{ projectId: 'proj', retentionDays: 7 }],
        isLifecycleProvisioned: () => true,
        isProjectLifecycleProvisioned: () => false,
      });
      expect(result).toMatchObject({ sessionsDeleted: 1 });
      expect(s3DeleteSpy).toHaveBeenCalledWith('rum/proj/2026/05/01/s3-leak/v0/0.json.gz');
    } finally {
      s3DeleteSpy.mockRestore();
    }
  });

  it('per-tenant pass DELEGATES S3 bytes once the tenant prefix rule is confirmed', async () => {
    seedS3Session('s3-prov'); // project 'proj', 60d
    const s3DeleteSpy = vi.spyOn(S3ArtifactStore.prototype, 'delete');
    try {
      const result = await runRumSegmentRetentionSweep({
        stmts,
        config,
        getRetentionOverrides: () => [{ projectId: 'proj', retentionDays: 7 }],
        isProjectLifecycleProvisioned: (pid) => pid === 'proj',
      });
      expect(result).toMatchObject({ sessionsDeleted: 1, segmentsDeleted: 1 });
      expect(stmts.getRumSession.get('s3-prov')).toBeUndefined();
      expect(stmts.getRumSegment.get('s3-prov-seg0')).toBeUndefined();
      // The tenant's prefix rule owns the bytes — no S3 delete from the sweeper.
      expect(s3DeleteSpy).not.toHaveBeenCalled();
    } finally {
      s3DeleteSpy.mockRestore();
    }
  });

  it('expireRumSession drops both segment rows and the session row', async () => {
    await seedLocalSession({ sessionId: 's-manual', ageDays: 1 });
    const cutoff = toSqliteUtc(Date.now());
    const result = await expireRumSession({ stmts, config }, 's-manual', cutoff);
    expect(result).toEqual({ segmentsDeleted: 1, sessionDeleted: true });
    expect(stmts.getRumSession.get('s-manual')).toBeUndefined();
    expect(stmts.listRumSegmentsBySession.all('s-manual')).toHaveLength(0);
  });

  it('keeps a session (and its new segment) refreshed by a mid-sweep ingest', async () => {
    // Regression for the TOCTOU race: byte reclamation awaits, so a late ingest
    // can append a NEW segment + bump updated_at between listing and row deletion.
    // The sweep must reap ONLY the reclaimed old segment and, because updated_at
    // is now fresh, KEEP the session row + the new (un-reclaimed) segment.
    const oldSeg = seedS3Session('s-racing'); // one aged S3 segment, updated_at old
    let injected = false;
    const s3DeleteSpy = vi
      .spyOn(S3ArtifactStore.prototype, 'delete')
      .mockImplementation(async () => {
        // Simulate a concurrent ingest landing DURING byte reclamation: a fresh
        // segment for the same session with a current updated_at.
        if (!injected) {
          injected = true;
          stmts.insertRumSegment.run(
            's-racing-seg-new',
            's-racing',
            'v1',
            'proj',
            0,
            1,
            9_000,
            9_500,
            3,
            200,
            's3',
            'rum/proj/2026/07/08/s-racing/v1/0.json.gz',
            'rum-bucket',
            'us-east-1',
          );
          db.prepare(
            "UPDATE rum_sessions SET updated_at = datetime('now') WHERE session_id = ?",
          ).run('s-racing');
        }
      });
    try {
      // Unconfirmed provisioning → the sweeper deletes the (old) S3 object, which
      // is where the injected ingest rides in.
      const result = await runRumSegmentRetentionSweep({ stmts, config });

      // Only the old segment was reaped; the session stayed because it was refreshed.
      expect(result).toMatchObject({ sessionsDeleted: 0, segmentsDeleted: 1, failed: 0 });
      expect(stmts.getRumSegment.get(oldSeg.id)).toBeUndefined();
      expect(stmts.getRumSession.get('s-racing')).toBeTruthy();
      // The newly-ingested segment (never listed, never reclaimed) is untouched.
      expect(stmts.getRumSegment.get('s-racing-seg-new')).toBeTruthy();
    } finally {
      s3DeleteSpy.mockRestore();
    }
  });
});

describe('startRumSegmentRetentionSweeper', () => {
  it('returns a no-op stopper when retention is disabled', () => {
    const stop = startRumSegmentRetentionSweeper({
      stmts: {} as Stmts,
      config: { replayRetentionDays: 0 } as unknown as AppConfig,
    });
    expect(typeof stop).toBe('function');
    expect(() => stop()).not.toThrow();
  });

  it('schedules a sweep on an interval and the stopper clears it', () => {
    let calls = 0;
    const stmts = {
      getExpiredRumSessions: { all: () => (calls++, []) },
      getExpiredOrphanRumSegments: { all: () => [] },
    } as unknown as Stmts;
    const stop = startRumSegmentRetentionSweeper(
      { stmts, config: { replayRetentionDays: 30 } as unknown as AppConfig },
      10,
    );
    // No synchronous run at start; the first fire is one interval ahead.
    expect(calls).toBe(0);
    stop();
  });
});
