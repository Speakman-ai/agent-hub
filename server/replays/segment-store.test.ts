import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'os';
import path from 'path';
import { mkdirSync, rmSync, existsSync } from 'fs';
import Database from 'better-sqlite3';
import {
  buildSegmentKey,
  segmentTimeBounds,
  appendSegment,
  listSessionSegments,
  listViewSegments,
  readSegment,
  readSessionEvents,
  deleteSessionSegments,
  SegmentNeedsSnapshotError,
  type SegmentStoreDeps,
} from './segment-store.js';
import { storeReplay, readReplayEventsPage, type ReplayEvent } from './replay-store.js';
import { LocalArtifactStore, resetArtifactStoreCache } from '../artifacts/artifact-store.js';
import type { AppConfig, Stmts } from '../types.js';

const SNAPSHOT: ReplayEvent = { type: 2, timestamp: 1000, data: { node: {} } };

function seg(...events: ReplayEvent[]): ReplayEvent[] {
  return events;
}

describe('buildSegmentKey', () => {
  it('lays segments out under rum/<project>/<yyyy>/<mm>/<dd>/<session>/<view>/<index>.json.gz', () => {
    // 2026-07-07T12:00:00Z
    const startTs = Date.UTC(2026, 6, 7, 12, 0, 0);
    const key = buildSegmentKey({
      projectId: 'proj-1',
      sessionId: 'sess-1',
      viewId: 'view-1',
      indexInView: 3,
      startTs,
    });
    expect(key).toBe('rum/proj-1/2026/07/07/sess-1/view-1/3.json.gz');
  });

  it('partitions anonymous captures under _anon', () => {
    const key = buildSegmentKey({
      projectId: null,
      sessionId: 's',
      viewId: 'v',
      indexInView: 0,
      startTs: Date.UTC(2026, 0, 1),
    });
    expect(key).toBe('rum/_anon/2026/01/01/s/v/0.json.gz');
  });

  it('sanitizes path-traversal attempts in client-minted ids', () => {
    const key = buildSegmentKey({
      projectId: '../../etc',
      sessionId: 'a/b',
      viewId: 'c\\d',
      indexInView: 0,
      startTs: 0,
    });
    expect(key).not.toContain('..');
    expect(key).toBe('rum/____etc/1970/01/01/a_b/c_d/0.json.gz');
  });
});

describe('segmentTimeBounds', () => {
  it('returns min/max event timestamps', () => {
    expect(segmentTimeBounds(seg({ type: 3, timestamp: 500 }, SNAPSHOT))).toEqual({
      start: 500,
      end: 1000,
    });
  });

  it('returns 0/0 for an empty or timestamp-less segment', () => {
    expect(segmentTimeBounds([])).toEqual({ start: 0, end: 0 });
    expect(segmentTimeBounds([{ type: 3, timestamp: NaN as unknown as number }])).toEqual({
      start: 0,
      end: 0,
    });
  });
});

describe('segment-store (append-only backend)', () => {
  let dataDir: string;
  let deps: SegmentStoreDeps;

  function makeStmts(): Stmts {
    const db = new Database(':memory:');
    db.exec(`
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
        storage_layout TEXT NOT NULL DEFAULT 'monolithic',
        support_ticket_id TEXT,
        card_id TEXT,
        meta TEXT
      );
    `);
    return {
      insertRumSegment: db.prepare(
        `INSERT INTO rum_segments
           (id, session_id, view_id, project_id, index_in_view, has_full_snapshot,
            start_ts, end_ts, event_count, byte_size,
            storage_kind, storage_key, storage_bucket, storage_region)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ),
      getRumSegment: db.prepare('SELECT * FROM rum_segments WHERE id = ?'),
      listRumSegmentsBySession: db.prepare(
        `SELECT * FROM rum_segments
          WHERE session_id = ?
          ORDER BY start_ts ASC, index_in_view ASC, id ASC`,
      ),
      listRumSegmentsByView: db.prepare(
        `SELECT * FROM rum_segments
          WHERE session_id = ? AND view_id = ?
          ORDER BY index_in_view ASC`,
      ),
      deleteRumSegment: db.prepare('DELETE FROM rum_segments WHERE id = ?'),
      deleteRumSegmentsBySession: db.prepare('DELETE FROM rum_segments WHERE session_id = ?'),
      // Reused by the back-compat monolithic test.
      insertSessionReplay: db.prepare(
        `INSERT INTO session_replays
           (id, project_id, duration_ms, event_count, size, uncompressed_size,
            storage_kind, storage_key, storage_bucket, storage_region,
            support_ticket_id, card_id, meta)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ),
      getSessionReplay: db.prepare('SELECT * FROM session_replays WHERE id = ?'),
    } as unknown as Stmts;
  }

  beforeEach(() => {
    dataDir = path.join(
      os.tmpdir(),
      `agent-hub-segment-store-${process.pid}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(dataDir, { recursive: true });
    resetArtifactStoreCache();
    vi.restoreAllMocks();
    deps = { stmts: makeStmts(), config: { dataDir } as unknown as AppConfig };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    try {
      if (existsSync(dataDir)) rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* noop */
    }
  });

  it('appends N segments with exactly N PUTs and never re-gzips prior data', async () => {
    const putSpy = vi.spyOn(LocalArtifactStore.prototype, 'put');

    // A view: index 0 opens with a full snapshot, then 4 incremental segments.
    const N = 5;
    for (let i = 0; i < N; i++) {
      const events =
        i === 0
          ? seg(SNAPSHOT, { type: 3, timestamp: 1001 })
          : seg({ type: 3, timestamp: 1000 + i * 100 });
      const row = await appendSegment(deps, {
        sessionId: 'sess',
        viewId: 'view',
        indexInView: i,
        projectId: 'proj',
        events,
      });
      expect(row.index_in_view).toBe(i);
    }

    // O(1) append: one PUT per segment, no re-write of earlier segments.
    expect(putSpy).toHaveBeenCalledTimes(N);

    // Each stored object holds ONLY its own segment's events — proof that a
    // later append never re-gzipped the concatenation of prior segments.
    const segments = listSessionSegments(deps.stmts, 'sess');
    expect(segments).toHaveLength(N);
    for (let i = 0; i < N; i++) {
      const blob = await readSegment(deps, segments[i]!);
      const expected = i === 0 ? 2 : 1;
      expect(blob.events).toHaveLength(expected);
    }

    // Only index 0 carries the full snapshot.
    expect(segments[0]!.has_full_snapshot).toBe(1);
    expect(segments.slice(1).every((s) => s.has_full_snapshot === 0)).toBe(true);
  });

  it('orders the session manifest chronologically across views, sequentially within a view', async () => {
    // view-A (starts t=1000): two segments. view-B (starts t=5000): two segments.
    // Append them interleaved / out of order to prove ordering is by (start_ts,
    // index_in_view), not insertion order.
    await appendSegment(deps, {
      sessionId: 's',
      viewId: 'view-B',
      indexInView: 1,
      events: seg({ type: 3, timestamp: 5100 }),
    });
    await appendSegment(deps, {
      sessionId: 's',
      viewId: 'view-A',
      indexInView: 0,
      events: seg({ ...SNAPSHOT, timestamp: 1000 }),
    });
    await appendSegment(deps, {
      sessionId: 's',
      viewId: 'view-B',
      indexInView: 0,
      events: seg({ ...SNAPSHOT, timestamp: 5000 }),
    });
    await appendSegment(deps, {
      sessionId: 's',
      viewId: 'view-A',
      indexInView: 1,
      events: seg({ type: 3, timestamp: 1100 }),
    });

    const manifest = listSessionSegments(deps.stmts, 's');
    expect(manifest.map((m) => [m.view_id, m.index_in_view])).toEqual([
      ['view-A', 0],
      ['view-A', 1],
      ['view-B', 0],
      ['view-B', 1],
    ]);

    // Per-view manifest is by index within the view.
    const viewB = listViewSegments(deps.stmts, 's', 'view-B');
    expect(viewB.map((m) => m.index_in_view)).toEqual([0, 1]);

    // Flattened playback stream is the concatenation in manifest order.
    const { events, segmentCount } = await readSessionEvents(deps, 's');
    expect(segmentCount).toBe(4);
    expect(events.map((e) => e.timestamp)).toEqual([1000, 1100, 5000, 5100]);
  });

  it('defensively stable-sorts the merged timeline when view spans overlap', async () => {
    // view-A opens first (start 1000) but has a long trailing event (t=6000)
    // that overruns view-B's start (5000). Manifest order is by start_ts —
    // [view-A seg0, view-B seg0] — so a naive concat would yield a
    // non-monotonic 1000,6000,5000 stream. readSessionEvents must repair it.
    await appendSegment(deps, {
      sessionId: 'ov',
      viewId: 'view-A',
      indexInView: 0,
      events: seg({ ...SNAPSHOT, timestamp: 1000 }, { type: 3, timestamp: 6000 }),
    });
    await appendSegment(deps, {
      sessionId: 'ov',
      viewId: 'view-B',
      indexInView: 0,
      events: seg({ ...SNAPSHOT, timestamp: 5000 }),
    });

    const { events } = await readSessionEvents(deps, 'ov');
    // Non-decreasing after the defensive sort.
    expect(events.map((e) => e.timestamp)).toEqual([1000, 5000, 6000]);
  });

  it('rejects a view-opening segment (index 0) without a full snapshot', async () => {
    await expect(
      appendSegment(deps, {
        sessionId: 's',
        viewId: 'v',
        indexInView: 0,
        events: seg({ type: 3, timestamp: 10 }),
      }),
    ).rejects.toBeInstanceOf(SegmentNeedsSnapshotError);
    // Nothing persisted.
    expect(listSessionSegments(deps.stmts, 's')).toHaveLength(0);
  });

  it('refuses to clobber an already-written index slot (UNIQUE guard, no PUT)', async () => {
    await appendSegment(deps, {
      sessionId: 's',
      viewId: 'v',
      indexInView: 0,
      events: seg(SNAPSHOT),
    });
    const putSpy = vi.spyOn(LocalArtifactStore.prototype, 'put');
    // Same (session, view, index) → UNIQUE violation before any object write.
    await expect(
      appendSegment(deps, {
        sessionId: 's',
        viewId: 'v',
        indexInView: 0,
        events: seg({ ...SNAPSHOT, timestamp: 9999 }),
      }),
    ).rejects.toThrow();
    expect(putSpy).not.toHaveBeenCalled();
    expect(listSessionSegments(deps.stmts, 's')).toHaveLength(1);
  });

  it('rolls the manifest row back when the object PUT fails', async () => {
    vi.spyOn(LocalArtifactStore.prototype, 'put').mockRejectedValueOnce(new Error('put boom'));
    await expect(
      appendSegment(deps, {
        sessionId: 's',
        viewId: 'v',
        indexInView: 0,
        events: seg(SNAPSHOT),
      }),
    ).rejects.toThrow('put boom');
    // No manifest row left pointing at an object that was never written.
    expect(listSessionSegments(deps.stmts, 's')).toHaveLength(0);
  });

  it('deletes every object + manifest row for a session', async () => {
    await appendSegment(deps, {
      sessionId: 's',
      viewId: 'v',
      indexInView: 0,
      events: seg(SNAPSHOT),
    });
    const seg0 = listSessionSegments(deps.stmts, 's')[0]!;
    const blobPath = path.join(dataDir, 'artifacts', seg0.storage_key);
    expect(existsSync(blobPath)).toBe(true);

    await deleteSessionSegments(deps, 's');
    expect(existsSync(blobPath)).toBe(false);
    expect(listSessionSegments(deps.stmts, 's')).toHaveLength(0);
  });

  it('reads back a legacy monolithic row unchanged (storage_layout back-compat)', async () => {
    // A monolithic capture written by the existing store still round-trips: the
    // segmented backend is additive and does not disturb the legacy read path.
    const events = seg(SNAPSHOT, { type: 3, timestamp: 1500 });
    const row = await storeReplay(deps, { id: 'legacy', events, projectId: 'proj' });
    // The migration/default stamps 'monolithic'.
    expect(row.storage_layout).toBe('monolithic');

    const page = await readReplayEventsPage(deps, row);
    expect(page.total).toBe(2);
    expect(page.events[0]).toMatchObject({ type: 2, timestamp: 1000 });

    // And it does NOT appear in the segment manifest — different backend.
    expect(listSessionSegments(deps.stmts, 'legacy')).toHaveLength(0);
  });
});
