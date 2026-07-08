import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'os';
import path from 'path';
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { gunzipSync } from 'zlib';
import Database from 'better-sqlite3';
import {
  computeDurationMs,
  encodeReplayBlob,
  decodeReplayBlob,
  paginateEvents,
  storeReplay,
  readReplayEventsPage,
  deleteReplay,
  parseReplayIdFromRef,
  linkReplay,
  ReplaySegmentedLayoutError,
  DEFAULT_EVENTS_PAGE,
  MAX_EVENTS_PAGE,
  type ReplayEvent,
} from './replay-store.js';
import { resetArtifactStoreCache } from '../artifacts/artifact-store.js';
import type { AppConfig, SessionReplayRow, Stmts } from '../types.js';

const EVENTS: ReplayEvent[] = [
  { type: 4, timestamp: 1000, data: {} },
  { type: 2, timestamp: 1001, data: { node: {} } },
  { type: 3, timestamp: 1500, data: { source: 2 } },
];

describe('computeDurationMs', () => {
  it('returns the span between min and max timestamps', () => {
    expect(computeDurationMs(EVENTS)).toBe(500);
  });

  it('returns 0 for an empty array', () => {
    expect(computeDurationMs([])).toBe(0);
  });

  it('never returns a negative span when events are out of order', () => {
    const reordered: ReplayEvent[] = [
      { type: 3, timestamp: 5000 },
      { type: 2, timestamp: 1000 },
    ];
    expect(computeDurationMs(reordered)).toBe(4000);
  });

  it('ignores non-numeric timestamps', () => {
    const dirty = [
      { type: 2, timestamp: 1000 },
      { type: 3, timestamp: NaN as unknown as number },
      { type: 3, timestamp: 2000 },
    ];
    expect(computeDurationMs(dirty)).toBe(1000);
  });
});

describe('encodeReplayBlob / decodeReplayBlob', () => {
  it('round-trips events and meta through gzip', async () => {
    const { buffer, uncompressedSize } = await encodeReplayBlob(EVENTS, { trigger: 'bug-report' });
    expect(Buffer.isBuffer(buffer)).toBe(true);
    expect(uncompressedSize).toBeGreaterThan(buffer.length); // compression helps
    // gzip magic bytes
    expect(buffer[0]).toBe(0x1f);
    expect(buffer[1]).toBe(0x8b);

    const decoded = await decodeReplayBlob(buffer);
    expect(decoded.events).toHaveLength(3);
    expect(decoded.events[1]).toMatchObject({ type: 2, timestamp: 1001 });
    expect(decoded.meta).toEqual({ trigger: 'bug-report' });
  });

  it('normalizes missing meta to null', async () => {
    const { buffer } = await encodeReplayBlob(EVENTS, undefined);
    const raw = JSON.parse(gunzipSync(buffer).toString('utf-8'));
    expect(raw.meta).toBeNull();
    expect((await decodeReplayBlob(buffer)).meta).toBeNull();
  });
});

describe('paginateEvents', () => {
  const many: ReplayEvent[] = Array.from({ length: 100 }, (_, i) => ({ type: 3, timestamp: i }));

  it('applies the default page size when limit is omitted', () => {
    const page = paginateEvents(many);
    expect(page.limit).toBe(DEFAULT_EVENTS_PAGE);
    expect(page.events).toHaveLength(100); // fewer than the default page
    expect(page.hasMore).toBe(false);
    expect(page.total).toBe(100);
  });

  it('slices by offset and reports hasMore', () => {
    const page = paginateEvents(many, 0, 20);
    expect(page.events).toHaveLength(20);
    expect(page.offset).toBe(0);
    expect(page.hasMore).toBe(true);

    const tail = paginateEvents(many, 90, 20);
    expect(tail.events).toHaveLength(10);
    expect(tail.hasMore).toBe(false);
  });

  it('clamps a negative offset to 0 and an over-large offset to total', () => {
    expect(paginateEvents(many, -5, 10).offset).toBe(0);
    const past = paginateEvents(many, 500, 10);
    expect(past.offset).toBe(100);
    expect(past.events).toHaveLength(0);
    expect(past.hasMore).toBe(false);
  });

  it('caps limit at MAX_EVENTS_PAGE and floors it at 1', () => {
    expect(paginateEvents(many, 0, 10_000).limit).toBe(MAX_EVENTS_PAGE);
    expect(paginateEvents(many, 0, 0).limit).toBe(1);
    expect(paginateEvents(many, 0, -3).limit).toBe(1);
  });
});

describe('storeReplay / readReplayEventsPage / deleteReplay (local store)', () => {
  let dataDir: string;
  let deps: { stmts: Stmts; config: AppConfig };

  function makeStmts(): Stmts {
    const db = new Database(':memory:');
    db.exec(`
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
        meta TEXT
      );
      CREATE TABLE replay_playlist_items (
        playlist_id TEXT NOT NULL,
        replay_id TEXT NOT NULL,
        position INTEGER NOT NULL DEFAULT 0,
        added_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (playlist_id, replay_id)
      );
    `);
    return {
      insertSessionReplay: db.prepare(
        `INSERT INTO session_replays
           (id, project_id, duration_ms, event_count, size, uncompressed_size,
            storage_kind, storage_key, storage_bucket, storage_region,
            support_ticket_id, card_id, meta)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ),
      getSessionReplay: db.prepare('SELECT * FROM session_replays WHERE id = ?'),
      linkSessionReplay: db.prepare(
        `UPDATE session_replays
            SET project_id        = COALESCE(project_id, ?),
                support_ticket_id = COALESCE(support_ticket_id, ?),
                card_id           = COALESCE(card_id, ?)
          WHERE id = ?
            AND (project_id IS NULL OR project_id = ?)`,
      ),
      deleteSessionReplay: db.prepare('DELETE FROM session_replays WHERE id = ?'),
      deleteReplayPlaylistItemsByReplay: db.prepare(
        'DELETE FROM replay_playlist_items WHERE replay_id = ?',
      ),
    } as unknown as Stmts;
  }

  beforeEach(() => {
    dataDir = path.join(
      os.tmpdir(),
      `agent-hub-replay-store-${process.pid}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(dataDir, { recursive: true });
    resetArtifactStoreCache();
    deps = { stmts: makeStmts(), config: { dataDir } as unknown as AppConfig };
  });

  afterEach(() => {
    try {
      if (existsSync(dataDir)) rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* noop */
    }
  });

  it('writes a gzipped blob + metadata row, then reads events back', async () => {
    const row = await storeReplay(deps, {
      events: EVENTS,
      meta: { trigger: 'error' },
      projectId: 'proj-1',
      supportTicketId: 'ticket-9',
    });

    expect(row.storage_kind).toBe('local');
    expect(row.event_count).toBe(3);
    expect(row.duration_ms).toBe(500);
    expect(row.size).toBeGreaterThan(0);
    expect(row.uncompressed_size).toBeGreaterThan(row.size);
    expect(row.project_id).toBe('proj-1');
    expect(row.support_ticket_id).toBe('ticket-9');

    const blobPath = path.join(dataDir, 'artifacts', row.storage_key);
    expect(existsSync(blobPath)).toBe(true);

    const page = await readReplayEventsPage(deps, row);
    expect(page.total).toBe(3);
    expect(page.events).toHaveLength(3);
    expect(page.events[2]).toMatchObject({ type: 3, timestamp: 1500 });
  });

  it('reads a monolithic (or NULL-layout legacy) row from the blob', async () => {
    // storeReplay defaults to the monolithic blob path; a legacy row created
    // before the storage_layout column is NULL and takes the same path.
    const row = await storeReplay(deps, { id: 'mono', events: EVENTS });
    for (const layout of [null, 'monolithic'] as const) {
      const page = await readReplayEventsPage(deps, { ...row, storage_layout: layout });
      expect(page.total).toBe(3);
    }
  });

  it('refuses to paginate a segmented row via the monolithic read path', async () => {
    // A segmented capture's bytes live in rum_segments, not the row's blob, so
    // the monolithic paginated read must reject rather than gunzip a placeholder.
    const segmentedRow = {
      id: 'seg',
      storage_layout: 'segmented',
      storage_kind: 'local',
      storage_key: 'unused',
      storage_bucket: null,
      storage_region: null,
    } as unknown as SessionReplayRow;
    await expect(readReplayEventsPage(deps, segmentedRow)).rejects.toBeInstanceOf(
      ReplaySegmentedLayoutError,
    );
  });

  it('honors a caller-supplied id', async () => {
    const row = await storeReplay(deps, { id: 'fixed-id', events: EVENTS });
    expect(row.id).toBe('fixed-id');
    expect(row.storage_key).toBe('replays/fixed-id.json.gz');
  });

  it('paginates a large capture without loading it all in one page', async () => {
    const events: ReplayEvent[] = [{ type: 2, timestamp: 0 }];
    for (let i = 1; i <= 60; i++) events.push({ type: 3, timestamp: i });
    const row = await storeReplay(deps, { events });

    const page = await readReplayEventsPage(deps, row, 0, 25);
    expect(page.events).toHaveLength(25);
    expect(page.total).toBe(61);
    expect(page.hasMore).toBe(true);
  });

  it('deletes the blob and the metadata row', async () => {
    const row = await storeReplay(deps, { events: EVENTS });
    const blobPath = path.join(dataDir, 'artifacts', row.storage_key);
    expect(existsSync(blobPath)).toBe(true);

    await deleteReplay(deps, row);
    expect(existsSync(blobPath)).toBe(false);
    expect(deps.stmts.getSessionReplay.get(row.id)).toBeUndefined();
  });

  it('writes no blob when the metadata insert (row claim) fails', async () => {
    // The row is claimed first, so a failing insert never reaches store.put.
    (deps.stmts as unknown as Record<string, unknown>).insertSessionReplay = {
      run() {
        throw new Error('insert boom');
      },
    };
    await expect(storeReplay(deps, { id: 'rollback-1', events: EVENTS })).rejects.toThrow(
      'insert boom',
    );
    const blobPath = path.join(dataDir, 'artifacts', 'replays', 'rollback-1.json.gz');
    expect(existsSync(blobPath)).toBe(false);
  });

  it('does not overwrite or delete an existing replay when the id is reused', async () => {
    const first = await storeReplay(deps, { id: 'dup', events: EVENTS });
    const blobPath = path.join(dataDir, 'artifacts', first.storage_key);
    const original = readFileSync(blobPath);

    // A second store with the SAME id (retry / internal caller) must fail on the
    // primary key WITHOUT touching the existing row or blob.
    const other: ReplayEvent[] = [
      { type: 2, timestamp: 9000, data: { node: { tag: 'other' } } },
      { type: 3, timestamp: 9500 },
    ];
    await expect(storeReplay(deps, { id: 'dup', events: other })).rejects.toThrow();

    // Original blob bytes + row are intact (not overwritten, not deleted).
    expect(existsSync(blobPath)).toBe(true);
    expect(readFileSync(blobPath).equals(original)).toBe(true);
    expect(deps.stmts.getSessionReplay.get('dup')).toBeDefined();
  });

  it('rolls the claimed row back when the blob write fails (no dangling row)', async () => {
    // Make the artifacts root a FILE so the local store's mkdir(...) throws on
    // put, after the row has been claimed.
    writeFileSync(path.join(dataDir, 'artifacts'), 'x');
    await expect(storeReplay(deps, { id: 'blobfail', events: EVENTS })).rejects.toThrow();
    // No metadata row left pointing at a blob that was never written.
    expect(deps.stmts.getSessionReplay.get('blobfail')).toBeUndefined();
  });

  it('links an unattributed replay to a project + ticket via its ref', async () => {
    const row = await storeReplay(deps, { id: 'r1', events: EVENTS }); // project_id NULL
    expect(row.project_id).toBeNull();

    const linked = await linkReplay(deps.stmts, '/uploads/replay-r1.json', {
      projectId: 'proj-7',
      supportTicketId: 'ticket-3',
    });
    expect(linked?.project_id).toBe('proj-7');
    expect(linked?.support_ticket_id).toBe('ticket-3');
    expect(linked?.card_id).toBeNull();
  });

  it('fills a still-NULL field on a same-project later link (convert-to-card)', async () => {
    await storeReplay(deps, { id: 'r2', events: EVENTS });
    await linkReplay(deps.stmts, '/uploads/replay-r2.json', {
      projectId: 'proj-1',
      supportTicketId: 'ticket-1',
    });
    // Convert-to-card within the SAME project adds only the card id;
    // project/ticket must survive. (Real callers always pass projectId.)
    const after = await linkReplay(deps.stmts, '/uploads/replay-r2.json', {
      projectId: 'proj-1',
      cardId: 'card-9',
    });
    expect(after?.project_id).toBe('proj-1');
    expect(after?.support_ticket_id).toBe('ticket-1');
    expect(after?.card_id).toBe('card-9');
  });

  it('no-ops on EVERY field for a cross-project caller (no steal, no poison)', async () => {
    await storeReplay(deps, { id: 'r-steal', events: EVENTS });
    // Legitimate first link → project A's ticket (card_id still NULL).
    await linkReplay(deps.stmts, '/uploads/replay-r-steal.json', {
      projectId: 'proj-A',
      supportTicketId: 'ticket-A',
    });
    // Attacker in project B references the same ref to try to steal / poison it.
    const after = await linkReplay(deps.stmts, '/uploads/replay-r-steal.json', {
      projectId: 'proj-B',
      supportTicketId: 'ticket-B',
      cardId: 'card-B',
    });
    // Nothing the attacker passed lands — project/ticket unchanged AND card_id
    // stays NULL so project A's own convert can still record it later.
    expect(after?.project_id).toBe('proj-A');
    expect(after?.support_ticket_id).toBe('ticket-A');
    expect(after?.card_id).toBeNull();

    // Project A's later convert still fills the card id.
    const converted = await linkReplay(deps.stmts, '/uploads/replay-r-steal.json', {
      projectId: 'proj-A',
      cardId: 'card-A',
    });
    expect(converted?.card_id).toBe('card-A');
  });

  it('returns null for an unparseable ref or a missing row', async () => {
    await storeReplay(deps, { id: 'r3', events: EVENTS });
    expect(
      await linkReplay(deps.stmts, 'https://evil.example/x.json', { projectId: 'p' }),
    ).toBeNull();
    expect(
      await linkReplay(deps.stmts, '/uploads/replay-unknown.json', { projectId: 'p' }),
    ).toBeNull();
    expect(await linkReplay(deps.stmts, null, { projectId: 'p' })).toBeNull();
  });
});

describe('parseReplayIdFromRef', () => {
  it('extracts the id from a canonical uploads ref', () => {
    expect(parseReplayIdFromRef('/uploads/replay-abc-123.json')).toBe('abc-123');
  });

  it('rejects non-canonical refs', () => {
    expect(parseReplayIdFromRef('/uploads/other-abc.json')).toBeNull();
    expect(parseReplayIdFromRef('/uploads/replay-abc.txt')).toBeNull();
    expect(parseReplayIdFromRef('https://x/uploads/replay-abc.json')).toBeNull();
    expect(parseReplayIdFromRef(null)).toBeNull();
    expect(parseReplayIdFromRef(undefined)).toBeNull();
  });
});
