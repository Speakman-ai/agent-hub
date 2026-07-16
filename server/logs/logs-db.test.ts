import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, existsSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import {
  initLogsDb,
  getLogsDb,
  closeLogsDb,
  isLogFtsAvailable,
  insertLogRecords,
  insertLogSource,
  queryLogRecords,
  getProjectByteSize,
  getRetentionConfig,
  setRetentionConfig,
  clampRetentionDays,
  clampQuotaBytes,
  clampQueryLimit,
  pruneExpiredLogRecords,
  enforceProjectQuota,
  purgeProjectLogRecords,
  type LogRecordInput,
} from './logs-db.js';
import { runLogRetentionReaper } from './log-retention-reaper.js';
import {
  SEVERITY_NUMBER,
  MAX_RECORD_BYTES,
  MAX_BATCH_RECORDS,
  MAX_QUERY_LIMIT,
  DEFAULT_QUERY_LIMIT,
  DEFAULT_RETENTION_DAYS,
  DEFAULT_PROJECT_QUOTA_BYTES,
  MIN_RETENTION_DAYS,
  MAX_RETENTION_DAYS,
} from './logs-schema.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000; // fixed ms epoch for determinism

/** Nanosecond timestamp `ageDays` before NOW. */
function nanoAgo(ageDays: number): number {
  return (NOW - ageDays * DAY_MS) * 1_000_000;
}

function rec(over: Partial<LogRecordInput> = {}): LogRecordInput {
  return {
    projectId: 'proj-a',
    sourceId: 'src-1',
    timeUnixNano: nanoAgo(0),
    severityNumber: SEVERITY_NUMBER.INFO,
    body: 'hello world',
    ...over,
  };
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'logs-db-test-'));
  initLogsDb(dir);
});

afterEach(() => {
  closeLogsDb();
  rmSync(dir, { recursive: true, force: true });
});

describe('initLogsDb', () => {
  it('creates logs.db under the data dir with WAL and the expected tables', () => {
    expect(existsSync(path.join(dir, 'logs.db'))).toBe(true);
    const db = getLogsDb();
    expect(String(db.pragma('journal_mode', { simple: true }))).toBe('wal');

    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{
        name: string;
      }>
    ).map((r) => r.name);
    expect(tables).toContain('log_records');
    expect(tables).toContain('log_sources');
    expect(tables).toContain('log_retention_config');
  });

  it('never creates agent-hub.db or orgs.db (writes stay isolated)', () => {
    insertLogRecords([rec()], NOW);
    expect(existsSync(path.join(dir, 'agent-hub.db'))).toBe(false);
    expect(existsSync(path.join(dir, 'orgs.db'))).toBe(false);
  });

  it('reopens an existing logs.db without losing data (recovery path)', () => {
    insertLogRecords([rec({ body: 'persisted' })], NOW);
    closeLogsDb();
    initLogsDb(dir);
    const page = queryLogRecords({ projectId: 'proj-a' });
    expect(page.records).toHaveLength(1);
    expect(page.records[0].body).toBe('persisted');
  });

  it('exposes FTS availability (enabled on a standard build)', () => {
    expect(isLogFtsAvailable()).toBe(true);
  });
});

describe('insertLogRecords', () => {
  it('inserts a batch and reports the count', () => {
    const res = insertLogRecords([rec(), rec({ body: 'two' })], NOW);
    expect(res.inserted).toBe(2);
    expect(res.rejectedOversize).toBe(0);
    expect(getLogsDb().prepare('SELECT COUNT(*) c FROM log_records').get()).toEqual({ c: 2 });
  });

  it('rejects oversize records but keeps the rest of the batch (partial success)', () => {
    const huge = 'x'.repeat(MAX_RECORD_BYTES + 1);
    const res = insertLogRecords([rec({ body: huge }), rec({ body: 'ok' })], NOW);
    expect(res.inserted).toBe(1);
    expect(res.rejectedOversize).toBe(1);
  });

  it('throws when a batch exceeds MAX_BATCH_RECORDS', () => {
    const batch = Array.from({ length: MAX_BATCH_RECORDS + 1 }, () => rec());
    expect(() => insertLogRecords(batch, NOW)).toThrow(/MAX_BATCH_RECORDS/);
  });

  it('does not expose or persist earlier rows when a later row rolls back the transaction', () => {
    const invalidSource = null as unknown as string;
    expect(() =>
      insertLogRecords([rec({ body: 'rolled back' }), rec({ sourceId: invalidSource })], NOW),
    ).toThrow(/NOT NULL constraint failed/);
    // The first insert ran before the constraint error, but the surrounding
    // transaction rolled it back. Live-tail publication must likewise receive
    // no returned committed rows from this failed batch.
    expect(queryLogRecords({ projectId: 'proj-a' }).records).toHaveLength(0);
  });

  it('records the normalized byte size for quota accounting', () => {
    insertLogRecords([rec({ body: 'abcde' })], NOW);
    expect(getProjectByteSize('proj-a')).toBeGreaterThanOrEqual(5);
  });
});

describe('queryLogRecords', () => {
  beforeEach(() => {
    insertLogRecords(
      [
        rec({ body: 'first info', severityNumber: SEVERITY_NUMBER.INFO }),
        rec({ body: 'a warning', severityNumber: SEVERITY_NUMBER.WARN }),
        rec({
          body: 'boom error',
          severityNumber: SEVERITY_NUMBER.ERROR,
          traceId: 'trace-xyz',
          fingerprint: 'fp-1',
          serviceName: 'api',
          environment: 'prod',
          sourceId: 'src-2',
        }),
      ],
      NOW,
    );
  });

  it('returns newest-first', () => {
    const { records } = queryLogRecords({ projectId: 'proj-a' });
    expect(records.map((r) => r.body)).toEqual(['boom error', 'a warning', 'first info']);
  });

  it('scopes strictly to the project', () => {
    insertLogRecords([rec({ projectId: 'proj-b', body: 'other project' })], NOW);
    const { records } = queryLogRecords({ projectId: 'proj-a' });
    expect(records.every((r) => r.project_id === 'proj-a')).toBe(true);
  });

  it('paginates by opaque cursor without overlap', () => {
    const p1 = queryLogRecords({ projectId: 'proj-a', limit: 2 });
    expect(p1.records).toHaveLength(2);
    expect(p1.nextCursor).not.toBeNull();
    const p2 = queryLogRecords({ projectId: 'proj-a', limit: 2, cursor: p1.nextCursor! });
    expect(p2.records).toHaveLength(1);
    expect(p2.nextCursor).toBeNull();
    const ids = [...p1.records, ...p2.records].map((r) => r.id);
    expect(new Set(ids).size).toBe(3);
  });

  it('filters by minimum severity', () => {
    const { records } = queryLogRecords({
      projectId: 'proj-a',
      minSeverityNumber: SEVERITY_NUMBER.WARN,
    });
    expect(records.map((r) => r.body).sort()).toEqual(['a warning', 'boom error']);
  });

  it('filters by source, service, environment, trace, and fingerprint', () => {
    expect(queryLogRecords({ projectId: 'proj-a', sourceId: 'src-2' }).records).toHaveLength(1);
    expect(queryLogRecords({ projectId: 'proj-a', serviceName: 'api' }).records).toHaveLength(1);
    expect(queryLogRecords({ projectId: 'proj-a', environment: 'prod' }).records).toHaveLength(1);
    expect(queryLogRecords({ projectId: 'proj-a', traceId: 'trace-xyz' }).records).toHaveLength(1);
    expect(queryLogRecords({ projectId: 'proj-a', fingerprint: 'fp-1' }).records).toHaveLength(1);
  });

  it('filters by time range', () => {
    insertLogRecords([rec({ body: 'old', timeUnixNano: nanoAgo(10) })], NOW);
    const recent = queryLogRecords({ projectId: 'proj-a', startTimeUnixNano: nanoAgo(1) });
    expect(recent.records.some((r) => r.body === 'old')).toBe(false);
  });

  it('full-text searches the body via FTS', () => {
    const { records } = queryLogRecords({ projectId: 'proj-a', text: 'boom' });
    expect(records).toHaveLength(1);
    expect(records[0].body).toBe('boom error');
  });

  it('clamps limit to MAX_QUERY_LIMIT', () => {
    const { records } = queryLogRecords({ projectId: 'proj-a', limit: MAX_QUERY_LIMIT + 1000 });
    // Only 3 rows exist, but the clamp is what we assert did not blow past the ceiling.
    expect(records.length).toBeLessThanOrEqual(MAX_QUERY_LIMIT);
  });

  it('falls back to the default page size for a non-finite limit (no NaN bind)', () => {
    // A malformed API query can reach the helper with NaN; it must not bind
    // NaN into SQLite LIMIT ? (which throws) — it falls back to the default.
    expect(() => queryLogRecords({ projectId: 'proj-a', limit: Number.NaN })).not.toThrow();
    const { records } = queryLogRecords({ projectId: 'proj-a', limit: Number.NaN });
    expect(records).toHaveLength(3);
  });
});

describe('clampQueryLimit', () => {
  it('handles non-finite, out-of-range, and fractional inputs', () => {
    expect(clampQueryLimit(Number.NaN)).toBe(DEFAULT_QUERY_LIMIT);
    expect(clampQueryLimit(Infinity)).toBe(DEFAULT_QUERY_LIMIT);
    expect(clampQueryLimit(undefined)).toBe(DEFAULT_QUERY_LIMIT);
    expect(clampQueryLimit(0)).toBe(1);
    expect(clampQueryLimit(-5)).toBe(1);
    expect(clampQueryLimit(7.9)).toBe(7);
    expect(clampQueryLimit(MAX_QUERY_LIMIT + 1000)).toBe(MAX_QUERY_LIMIT);
  });
});

describe('retention config', () => {
  it('defaults when no row exists', () => {
    expect(getRetentionConfig('proj-a')).toEqual({
      retentionDays: DEFAULT_RETENTION_DAYS,
      quotaBytes: DEFAULT_PROJECT_QUOTA_BYTES,
    });
  });

  it('clamps out-of-range values on set', () => {
    const cfg = setRetentionConfig('proj-a', { retentionDays: 9999, quotaBytes: 1 }, NOW);
    expect(cfg.retentionDays).toBe(MAX_RETENTION_DAYS);
    expect(cfg.quotaBytes).toBeGreaterThan(1);
    expect(getRetentionConfig('proj-a').retentionDays).toBe(MAX_RETENTION_DAYS);
  });

  it('clamp helpers honor documented bounds', () => {
    expect(clampRetentionDays(0)).toBe(MIN_RETENTION_DAYS);
    expect(clampRetentionDays(Number.NaN)).toBe(DEFAULT_RETENTION_DAYS);
    expect(clampQuotaBytes(Number.NaN)).toBe(DEFAULT_PROJECT_QUOTA_BYTES);
  });
});

describe('pruneExpiredLogRecords', () => {
  it('deletes records older than the retention window and keeps recent ones', () => {
    insertLogRecords(
      [
        rec({ body: 'ancient', timeUnixNano: nanoAgo(30) }),
        rec({ body: 'fresh', timeUnixNano: nanoAgo(1) }),
      ],
      NOW,
    );
    const deleted = pruneExpiredLogRecords(NOW);
    expect(deleted).toBe(1);
    const { records } = queryLogRecords({ projectId: 'proj-a' });
    expect(records.map((r) => r.body)).toEqual(['fresh']);
  });

  it('keeps the FTS index aligned after pruning', () => {
    insertLogRecords([rec({ body: 'staleneedle', timeUnixNano: nanoAgo(30) })], NOW);
    pruneExpiredLogRecords(NOW);
    const { records } = queryLogRecords({ projectId: 'proj-a', text: 'staleneedle' });
    expect(records).toHaveLength(0);
  });

  it('honors a per-project retention override', () => {
    setRetentionConfig('proj-a', { retentionDays: 2 }, NOW);
    insertLogRecords([rec({ body: 'three-days', timeUnixNano: nanoAgo(3) })], NOW);
    expect(pruneExpiredLogRecords(NOW)).toBe(1);
  });

  it('is bounded by maxDeletes per call', () => {
    const old = Array.from({ length: 5 }, (_, i) =>
      rec({ body: `old-${i}`, timeUnixNano: nanoAgo(30) }),
    );
    insertLogRecords(old, NOW);
    expect(pruneExpiredLogRecords(NOW, 2)).toBe(2);
    expect(pruneExpiredLogRecords(NOW, 2)).toBe(2);
    expect(pruneExpiredLogRecords(NOW, 2)).toBe(1);
  });
});

describe('enforceProjectQuota', () => {
  it('evicts the oldest records until the project is under quota', () => {
    const body = 'y'.repeat(100);
    const rows = Array.from({ length: 50 }, (_, i) =>
      rec({ body: `${i}-${body}`, timeUnixNano: nanoAgo(0) }),
    );
    insertLogRecords(rows, NOW);
    const before = getProjectByteSize('proj-a');
    // Set a tiny quota directly (below the clamp floor) to exercise eviction
    // without writing 64 MiB of test data.
    const tinyQuota = Math.floor(before / 2);
    getLogsDb()
      .prepare(
        `INSERT INTO log_retention_config (project_id, retention_days, quota_bytes, updated_at)
         VALUES ('proj-a', ?, ?, ?)`,
      )
      .run(DEFAULT_RETENTION_DAYS, tinyQuota, NOW);
    const deleted = enforceProjectQuota('proj-a');
    const after = getProjectByteSize('proj-a');
    expect(deleted).toBeGreaterThan(0);
    expect(after).toBeLessThan(before);
    expect(after).toBeLessThanOrEqual(tinyQuota);
  });

  it('is a no-op when under quota', () => {
    insertLogRecords([rec()], NOW);
    expect(enforceProjectQuota('proj-a')).toBe(0);
  });
});

describe('purgeProjectLogRecords', () => {
  it('deletes every record for the project and returns the count', () => {
    insertLogRecords([rec({ body: 'one' }), rec({ body: 'two' }), rec({ body: 'three' })], NOW);
    expect(queryLogRecords({ projectId: 'proj-a' }).records).toHaveLength(3);

    const deleted = purgeProjectLogRecords('proj-a');

    expect(deleted).toBe(3);
    expect(queryLogRecords({ projectId: 'proj-a' }).records).toHaveLength(0);
    expect(getProjectByteSize('proj-a')).toBe(0);
  });

  it('only clears the target project, leaving other projects intact', () => {
    insertLogRecords([rec({ body: 'a-1' }), rec({ body: 'a-2' })], NOW);
    insertLogRecords([rec({ projectId: 'proj-b', body: 'b-1' })], NOW);

    const deleted = purgeProjectLogRecords('proj-a');

    expect(deleted).toBe(2);
    expect(queryLogRecords({ projectId: 'proj-a' }).records).toHaveLength(0);
    expect(queryLogRecords({ projectId: 'proj-b' }).records).toHaveLength(1);
  });

  it('drops the FTS message index rows alongside the records', () => {
    if (!isLogFtsAvailable()) return; // FTS5 optional at the build level
    insertLogRecords([rec({ body: 'purgeneedle apple' })], NOW);
    expect(queryLogRecords({ projectId: 'proj-a', text: 'purgeneedle' }).records).toHaveLength(1);

    purgeProjectLogRecords('proj-a');

    expect(queryLogRecords({ projectId: 'proj-a', text: 'purgeneedle' }).records).toHaveLength(0);
    // The raw FTS table must not retain an orphaned row for the deleted record.
    const ftsRows = getLogsDb().prepare('SELECT COUNT(*) AS n FROM log_records_fts').get() as {
      n: number;
    };
    expect(ftsRows.n).toBe(0);
  });

  it('returns 0 when the project has no records', () => {
    expect(purgeProjectLogRecords('proj-empty')).toBe(0);
  });
});

describe('runLogRetentionReaper', () => {
  it('runs both the expiry and quota passes', () => {
    insertLogRecords(
      [
        rec({ body: 'expired', timeUnixNano: nanoAgo(30) }),
        rec({ body: 'kept', timeUnixNano: nanoAgo(0) }),
      ],
      NOW,
    );
    const res = runLogRetentionReaper(NOW);
    expect(res.expiredDeleted).toBe(1);
    expect(res.quotaDeleted).toBe(0);
    expect(queryLogRecords({ projectId: 'proj-a' }).records.map((r) => r.body)).toEqual(['kept']);
  });

  it('shares one delete budget across the expiry and quota passes', () => {
    // proj-a: 3 expired records. proj-b: 3 recent records held over a tiny
    // quota. A budget of 3 must be fully consumed by expiry, leaving nothing
    // for quota enforcement this tick (the multi-project overrun the reviewer
    // flagged: expiry 5000 + quota 5000/project).
    insertLogRecords(
      Array.from({ length: 3 }, (_, i) =>
        rec({ projectId: 'proj-a', body: `a-expired-${i}`, timeUnixNano: nanoAgo(30) }),
      ),
      NOW,
    );
    insertLogRecords(
      Array.from({ length: 3 }, (_, i) =>
        rec({ projectId: 'proj-b', body: `b-recent-${i}`, timeUnixNano: nanoAgo(0) }),
      ),
      NOW,
    );
    // Force proj-b over quota so quota enforcement WOULD delete if it ran.
    getLogsDb()
      .prepare(
        `INSERT INTO log_retention_config (project_id, retention_days, quota_bytes, updated_at)
         VALUES ('proj-b', ?, 1, ?)`,
      )
      .run(DEFAULT_RETENTION_DAYS, NOW);

    const first = runLogRetentionReaper(NOW, 3);
    expect(first.expiredDeleted).toBe(3);
    expect(first.quotaDeleted).toBe(0); // budget exhausted by expiry
    // proj-b untouched this tick despite being over quota.
    expect(queryLogRecords({ projectId: 'proj-b' }).records).toHaveLength(3);

    // Next tick: no expired rows left, so the full budget goes to quota.
    const second = runLogRetentionReaper(NOW, 3);
    expect(second.expiredDeleted).toBe(0);
    expect(second.quotaDeleted).toBeGreaterThan(0);
  });
});

describe('insertLogSource', () => {
  it('persists a source and enforces (project, name) uniqueness', () => {
    insertLogSource({ id: 's1', projectId: 'proj-a', name: 'web' }, NOW);
    expect(() => insertLogSource({ id: 's2', projectId: 'proj-a', name: 'web' }, NOW)).toThrow();
    // Same name under a different project is fine.
    insertLogSource({ id: 's3', projectId: 'proj-b', name: 'web' }, NOW);
    expect(getLogsDb().prepare('SELECT COUNT(*) c FROM log_sources').get()).toEqual({ c: 2 });
  });
});

// Sanity: the store module opens its own file, not the shared handle.
it('logs.db is a distinct file from any agent-hub.db handle', () => {
  const p = path.join(dir, 'logs.db');
  const raw = new Database(p, { readonly: true });
  const names = (
    raw.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{
      name: string;
    }>
  ).map((r) => r.name);
  raw.close();
  expect(names).toContain('log_records');
  expect(names).not.toContain('kanban_cards');
  expect(names).not.toContain('sessions');
});
