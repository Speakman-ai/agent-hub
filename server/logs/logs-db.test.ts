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
  queryLogRecordsSince,
  queryLogTailSeed,
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
  type LogQueryPage,
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

describe('queryLogRecords keyset paging', () => {
  it('orders newest-first by event time, not ingest id', () => {
    insertLogRecords(
      [
        rec({ body: 'old-event-high-id', timeUnixNano: nanoAgo(9) }),
        rec({ body: 'new-event-low-id', timeUnixNano: nanoAgo(0) }),
      ],
      NOW,
    );
    expect(queryLogRecords({ projectId: 'proj-a' }).records.map((r) => r.body)).toEqual([
      'new-event-low-id',
      'old-event-high-id',
    ]);
  });

  it('reaches a delayed high-id record that an id cursor would skip', () => {
    // Regression (review): the client caps its tail by event time, so a delayed
    // batch (high id, old event time) can be evicted while `id < min(id held)`
    // never asks for it again. Paging on (time, id) makes it the next page.
    const recent = insertLogRecords([rec({ body: 'recent', timeUnixNano: nanoAgo(0) })], NOW)
      .records[0]!;
    const delayed = insertLogRecords([rec({ body: 'delayed', timeUnixNano: nanoAgo(5) })], NOW)
      .records[0]!;
    expect(delayed.id).toBeGreaterThan(recent.id); // higher id, older event time

    // An id-only cursor from the record the client still holds cannot see it.
    const idOnly = getLogsDb()
      .prepare('SELECT body FROM log_records WHERE project_id = ? AND id < ?')
      .all('proj-a', recent.id) as Array<{ body: string }>;
    expect(idOnly.map((r) => r.body)).not.toContain('delayed');

    // The keyset cursor does.
    const page = queryLogRecords({
      projectId: 'proj-a',
      cursor: recent.id,
      cursorTimeUnixNano: recent.time_unix_nano,
    });
    expect(page.records.map((r) => r.body)).toEqual(['delayed']);
  });

  it('walks the whole history exactly once with no repeats or gaps', () => {
    // Interleave event times against ingest order so id and time disagree.
    insertLogRecords(
      Array.from({ length: 12 }, (_, i) => rec({ body: `r-${i}`, timeUnixNano: nanoAgo(i % 4) })),
      NOW,
    );
    const seen: string[] = [];
    let cursor: number | null = null;
    let cursorTime: number | null = null;
    for (let guard = 0; guard < 20; guard++) {
      const page: LogQueryPage = queryLogRecords({
        projectId: 'proj-a',
        limit: 5,
        ...(cursor != null ? { cursor, cursorTimeUnixNano: cursorTime ?? undefined } : {}),
      });
      seen.push(...page.records.map((r) => r.body ?? ''));
      if (page.nextCursor == null) break;
      cursor = page.nextCursor;
      cursorTime = page.nextCursorTimeUnixNano;
    }
    expect(seen).toHaveLength(12);
    expect(new Set(seen).size).toBe(12);
  });

  it('resolves a bare id cursor into its keyset so pre-keyset callers stay correct', () => {
    const recent = insertLogRecords([rec({ body: 'recent', timeUnixNano: nanoAgo(0) })], NOW)
      .records[0]!;
    insertLogRecords([rec({ body: 'delayed', timeUnixNano: nanoAgo(5) })], NOW);
    // No cursorTimeUnixNano: the server looks the row's event time up.
    const page = queryLogRecords({ projectId: 'proj-a', cursor: recent.id });
    expect(page.records.map((r) => r.body)).toEqual(['delayed']);
  });

  it('falls back to the id predicate when the cursor row is gone', () => {
    insertLogRecords([rec({ body: 'a' }), rec({ body: 'b' })], NOW);
    const missing = 999_999;
    expect(() => queryLogRecords({ projectId: 'proj-a', cursor: missing })).not.toThrow();
    expect(queryLogRecords({ projectId: 'proj-a', cursor: missing }).records).toHaveLength(2);
  });
});

describe('queryLogRecordsSince', () => {
  it('returns rows newer than the cursor, oldest-first', () => {
    insertLogRecords([rec({ body: 'one' }), rec({ body: 'two' }), rec({ body: 'three' })], NOW);
    const page = queryLogRecordsSince('proj-a', 0);
    expect(page.records.map((r) => r.body)).toEqual(['one', 'two', 'three']);
  });

  it('bounds the initial seed to the sinceUnixNano window (newest window, not full history)', () => {
    // Regression: on the initial subscribe (cursor 0) the live tail replayed the
    // entire retained history oldest-first, so the Live view filled with ancient
    // records before the newest arrived. A time window must exclude old rows.
    insertLogRecords(
      [
        rec({ body: 'ancient', timeUnixNano: nanoAgo(10) }),
        rec({ body: 'recent-a', timeUnixNano: nanoAgo(0) }),
        rec({ body: 'recent-b', timeUnixNano: nanoAgo(0) }),
      ],
      NOW,
    );
    const windowed = queryLogRecordsSince('proj-a', 0, undefined, nanoAgo(1));
    expect(windowed.records.map((r) => r.body)).toEqual(['recent-a', 'recent-b']);
    // Without the window, the ancient row is still replayed from cursor 0.
    const unbounded = queryLogRecordsSince('proj-a', 0);
    expect(unbounded.records.some((r) => r.body === 'ancient')).toBe(true);
  });

  it('scopes strictly to the project even with a window', () => {
    insertLogRecords([rec({ body: 'a-1' })], NOW);
    insertLogRecords([rec({ projectId: 'proj-b', body: 'b-1' })], NOW);
    const page = queryLogRecordsSince('proj-a', 0, undefined, nanoAgo(1));
    expect(page.records.every((r) => r.project_id === 'proj-a')).toBe(true);
  });
});

describe('queryLogTailSeed', () => {
  it('seeds the chronologically newest rows even when a delayed batch has higher ids', () => {
    // Regression (review): selecting the seed by ingest id reopens the very bug
    // the seed exists to fix. Ingest 3 current rows, then a delayed batch of 4
    // older-timestamped rows; `ORDER BY id DESC LIMIT 4` would hand back only
    // the delayed batch and the Live view would open away from the tail again.
    insertLogRecords(
      [
        rec({ body: 'current-1', timeUnixNano: nanoAgo(0) }),
        rec({ body: 'current-2', timeUnixNano: nanoAgo(0) }),
        rec({ body: 'current-3', timeUnixNano: nanoAgo(0) }),
      ],
      NOW,
    );
    insertLogRecords(
      Array.from({ length: 4 }, (_, i) => rec({ body: `delayed-${i}`, timeUnixNano: nanoAgo(5) })),
      NOW,
    );
    const seed = queryLogTailSeed('proj-a', 3);
    expect(seed.records.map((r) => r.body)).toEqual(['current-1', 'current-2', 'current-3']);
    // The delayed rows own the highest ids, so an id-ordered seed would have
    // returned them instead.
    expect(Math.max(...seed.records.map((r) => r.id))).toBeLessThan(
      Math.max(...queryLogRecords({ projectId: 'proj-a' }).records.map((r) => r.id)),
    );
  });

  it('returns the newest rows in the window, oldest-first', () => {
    // Regression: a fresh subscribe seeded from the OLDEST edge of the window,
    // so the Live view opened on hours-old records and only reached the tail
    // after the whole window had replayed page by page.
    insertLogRecords(
      [rec({ body: 'one' }), rec({ body: 'two' }), rec({ body: 'three' }), rec({ body: 'four' })],
      NOW,
    );
    expect(queryLogTailSeed('proj-a', 2).records.map((r) => r.body)).toEqual(['three', 'four']);
  });

  it('excludes rows older than the window and scopes to the project', () => {
    insertLogRecords(
      [
        rec({ body: 'ancient', timeUnixNano: nanoAgo(10) }),
        rec({ body: 'recent', timeUnixNano: nanoAgo(0) }),
      ],
      NOW,
    );
    insertLogRecords([rec({ projectId: 'proj-b', body: 'other-project' })], NOW);
    const seed = queryLogTailSeed('proj-a', MAX_QUERY_LIMIT, nanoAgo(1));
    expect(seed.records.map((r) => r.body)).toEqual(['recent']);
  });

  it('reports the max committed ingest id, not the max id in the seed page', () => {
    // Regression (review): the event-time cutoff excludes rows that can hold far
    // HIGHER ids than anything in the page. Here the newest-by-time rows are the
    // low-id current batch; the delayed batch was ingested later (higher ids)
    // but is older by event time, so it is excluded. Handing back the page's max
    // would leave the client resubscribing below the delayed rows, and the next
    // reconnect would drain `id > cursor` and resurrect them into the live tail.
    const current = insertLogRecords(
      [
        rec({ body: 'current-1', timeUnixNano: nanoAgo(0) }),
        rec({ body: 'current-2', timeUnixNano: nanoAgo(0) }),
      ],
      NOW,
    ).records;
    const delayed = insertLogRecords(
      [
        rec({ body: 'delayed-1', timeUnixNano: nanoAgo(9) }),
        rec({ body: 'delayed-2', timeUnixNano: nanoAgo(9) }),
      ],
      NOW,
    ).records;

    const seed = queryLogTailSeed('proj-a', 2);
    expect(seed.records.map((r) => r.body)).toEqual(['current-1', 'current-2']);

    const pageMaxId = Math.max(...seed.records.map((r) => r.id));
    const committedMaxId = Math.max(...[...current, ...delayed].map((r) => r.id));
    // The excluded delayed batch owns the higher ids...
    expect(committedMaxId).toBeGreaterThan(pageMaxId);
    // ...and the cursor clears them, so no reconnect drain can resurrect them.
    expect(seed.cursor).toBe(committedMaxId);
  });

  it('clears rows outside the time window too, since the reconnect drain has no window', () => {
    insertLogRecords([rec({ body: 'in-window', timeUnixNano: nanoAgo(0) })], NOW);
    const outOfWindow = insertLogRecords(
      [rec({ body: 'out-of-window', timeUnixNano: nanoAgo(30) })],
      NOW,
    ).records[0]!;
    const seed = queryLogTailSeed('proj-a', MAX_QUERY_LIMIT, nanoAgo(1));
    expect(seed.records.map((r) => r.body)).toEqual(['in-window']);
    expect(seed.cursor).toBe(outOfWindow.id);
  });

  it('reports cursor 0 for a project with no records', () => {
    insertLogRecords([rec({ projectId: 'proj-b', body: 'elsewhere' })], NOW);
    const seed = queryLogTailSeed('proj-a');
    expect(seed.records).toHaveLength(0);
    expect(seed.cursor).toBe(0);
  });

  it('clamps the seed size to MAX_QUERY_LIMIT', () => {
    insertLogRecords(
      Array.from({ length: MAX_QUERY_LIMIT + 5 }, (_, i) => rec({ body: `r-${i}` })),
      NOW,
    );
    expect(queryLogTailSeed('proj-a', MAX_QUERY_LIMIT + 500).records).toHaveLength(MAX_QUERY_LIMIT);
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
