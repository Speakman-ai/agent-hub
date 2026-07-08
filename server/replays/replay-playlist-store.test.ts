import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import {
  toPlaylistView,
  toPlaylistItemView,
  normalizePlaylistName,
  normalizePlaylistDescription,
  isReplayInProject,
  createPlaylist,
  listPlaylists,
  listPlaylistItems,
  countPlaylistItems,
  addPlaylistItem,
} from './replay-playlist-store.js';
import type {
  ReplayPlaylistRow,
  ReplayPlaylistWithCountRow,
  ReplayPlaylistItemRow,
  SessionReplayRow,
  Stmts,
} from '../types.js';

const basePlaylist: ReplayPlaylistRow = {
  id: 'pl-1',
  project_id: 'proj-1',
  name: 'Checkout bugs',
  description: 'Repros for the broken checkout',
  extended_retention: 0,
  retained_until: null,
  retention_flagged_at: null,
  created_at: '2026-07-08 10:00:00',
  created_by: 'user-1',
  updated_at: '2026-07-08 10:00:00',
};

describe('toPlaylistView', () => {
  it('maps a plain row and takes an explicit item count', () => {
    const view = toPlaylistView(basePlaylist, 3);
    expect(view).toMatchObject({
      id: 'pl-1',
      projectId: 'proj-1',
      name: 'Checkout bugs',
      description: 'Repros for the broken checkout',
      itemCount: 3,
      extendedRetention: false,
      retainedUntil: null,
      createdBy: 'user-1',
    });
  });

  it('reads item_count off a joined row when no explicit count is given', () => {
    const row: ReplayPlaylistWithCountRow = { ...basePlaylist, item_count: 5 };
    expect(toPlaylistView(row).itemCount).toBe(5);
  });

  it('surfaces the extended-retention flag as a boolean', () => {
    const flagged: ReplayPlaylistRow = {
      ...basePlaylist,
      extended_retention: 1,
      retained_until: '2027-10-08 10:00:00',
      retention_flagged_at: '2026-07-08 10:00:00',
    };
    const view = toPlaylistView(flagged, 1);
    expect(view.extendedRetention).toBe(true);
    expect(view.retainedUntil).toBe('2027-10-08 10:00:00');
    expect(view.retentionFlaggedAt).toBe('2026-07-08 10:00:00');
  });
});

describe('toPlaylistItemView', () => {
  it('maps join columns + capture metadata and builds the events URL', () => {
    const item = {
      // join columns
      replay_id: 'rep-9',
      position: 2,
      added_at: '2026-07-08 11:00:00',
      // session_replays columns (partial — only the mapped ones matter)
      id: 'rep-9',
      created_at: '2026-07-01 09:00:00',
      duration_ms: 4200,
      event_count: 88,
      size: 1234,
      support_ticket_id: 'tkt-1',
      card_id: null,
      retained_until: '2027-10-08 10:00:00',
      retention_flagged_at: '2026-07-08 10:00:00',
    } as unknown as ReplayPlaylistItemRow;
    const view = toPlaylistItemView(item);
    expect(view).toMatchObject({
      replayId: 'rep-9',
      position: 2,
      addedAt: '2026-07-08 11:00:00',
      createdAt: '2026-07-01 09:00:00',
      durationMs: 4200,
      eventCount: 88,
      size: 1234,
      supportTicketId: 'tkt-1',
      cardId: null,
      retainedUntil: '2027-10-08 10:00:00',
      eventsUrl: '/api/replays/rep-9/events',
    });
  });
});

describe('normalizePlaylistName', () => {
  it('trims and accepts a valid name', () => {
    expect(normalizePlaylistName('  My List  ')).toBe('My List');
  });
  it('rejects empty / whitespace / non-string', () => {
    expect(normalizePlaylistName('')).toBeNull();
    expect(normalizePlaylistName('   ')).toBeNull();
    expect(normalizePlaylistName(42)).toBeNull();
    expect(normalizePlaylistName(undefined)).toBeNull();
  });
  it('rejects an over-long name', () => {
    expect(normalizePlaylistName('x'.repeat(201))).toBeNull();
    expect(normalizePlaylistName('x'.repeat(200))).toHaveLength(200);
  });
});

describe('normalizePlaylistDescription', () => {
  it('coerces empty / absent to null and caps length', () => {
    expect(normalizePlaylistDescription(undefined)).toBeNull();
    expect(normalizePlaylistDescription(null)).toBeNull();
    expect(normalizePlaylistDescription('   ')).toBeNull();
    expect(normalizePlaylistDescription('hi')).toBe('hi');
    expect(normalizePlaylistDescription('y'.repeat(3000))).toHaveLength(2000);
  });
});

describe('isReplayInProject', () => {
  const row = { id: 'r1', project_id: 'proj-1' } as SessionReplayRow;
  it('accepts a same-project capture', () => {
    expect(isReplayInProject(row, 'proj-1')).toBe(true);
  });
  it('rejects a cross-project or unattributed capture', () => {
    expect(isReplayInProject(row, 'proj-2')).toBe(false);
    expect(isReplayInProject({ id: 'r2', project_id: null } as SessionReplayRow, 'proj-1')).toBe(
      false,
    );
    expect(isReplayInProject(undefined, 'proj-1')).toBe(false);
  });
});

/**
 * Regression (reviewer feedback): a hard-deleted member capture must NOT cause
 * the LIST count (join-based) and the GET count (items.length) to disagree, and
 * the orphan-cleanup statement must reap the stranded membership row. Built
 * against a real in-memory DB with the exact db.ts SQL so the join semantics are
 * exercised, not mocked.
 */
describe('itemCount consistency + orphan cleanup', () => {
  function makeStmts(): { stmts: Stmts; db: Database.Database } {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE session_replays (
        id TEXT PRIMARY KEY,
        project_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        duration_ms INTEGER NOT NULL DEFAULT 0,
        event_count INTEGER NOT NULL DEFAULT 0,
        size INTEGER NOT NULL DEFAULT 0,
        support_ticket_id TEXT,
        card_id TEXT,
        retained_until TEXT,
        retention_flagged_at TEXT
      );
      CREATE TABLE replay_playlists (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        extended_retention INTEGER NOT NULL DEFAULT 0,
        retained_until TEXT,
        retention_flagged_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        created_by TEXT,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE replay_playlist_items (
        playlist_id TEXT NOT NULL,
        replay_id TEXT NOT NULL,
        position INTEGER NOT NULL DEFAULT 0,
        added_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (playlist_id, replay_id)
      );
    `);
    const stmts = {
      insertReplayPlaylist: db.prepare(
        `INSERT INTO replay_playlists (id, project_id, name, description, created_by)
         VALUES (?, ?, ?, ?, ?)`,
      ),
      getReplayPlaylist: db.prepare('SELECT * FROM replay_playlists WHERE id = ?'),
      listReplayPlaylistsByProject: db.prepare(
        `SELECT p.*, COUNT(r.id) AS item_count
           FROM replay_playlists p
           LEFT JOIN replay_playlist_items i ON i.playlist_id = p.id
           LEFT JOIN session_replays r ON r.id = i.replay_id
          WHERE p.project_id = ?
          GROUP BY p.id
          ORDER BY p.created_at DESC`,
      ),
      insertReplayPlaylistItem: db.prepare(
        `INSERT OR IGNORE INTO replay_playlist_items (playlist_id, replay_id, position)
         VALUES (?, ?, ?)`,
      ),
      listReplayPlaylistItems: db.prepare(
        `SELECT i.replay_id, i.position, i.added_at, r.*
           FROM replay_playlist_items i
           JOIN session_replays r ON r.id = i.replay_id
          WHERE i.playlist_id = ?
          ORDER BY i.position ASC, i.added_at ASC`,
      ),
      countReplayPlaylistItems: db.prepare(
        `SELECT COUNT(*) AS n
           FROM replay_playlist_items i
           JOIN session_replays r ON r.id = i.replay_id
          WHERE i.playlist_id = ?`,
      ),
      maxReplayPlaylistItemPosition: db.prepare(
        'SELECT COALESCE(MAX(position), -1) AS max_pos FROM replay_playlist_items WHERE playlist_id = ?',
      ),
      deleteReplayPlaylistItemsByReplay: db.prepare(
        'DELETE FROM replay_playlist_items WHERE replay_id = ?',
      ),
    } as unknown as Stmts;
    return { stmts, db };
  }

  function insertReplay(db: Database.Database, id: string, projectId: string): void {
    db.prepare('INSERT INTO session_replays (id, project_id) VALUES (?, ?)').run(id, projectId);
  }

  it('LIST and GET itemCounts agree after a member capture is hard-deleted', () => {
    const { stmts, db } = makeStmts();
    const deps = { stmts };
    insertReplay(db, 'rep-a', 'proj-1');
    insertReplay(db, 'rep-b', 'proj-1');
    const playlist = createPlaylist(deps, {
      projectId: 'proj-1',
      name: 'List',
      description: null,
      createdBy: null,
    });
    addPlaylistItem(deps, playlist, 'rep-a');
    addPlaylistItem(deps, playlist, 'rep-b');

    // Both counts see 2 members.
    expect(listPlaylists(deps, 'proj-1')[0]!.item_count).toBe(2);
    expect(listPlaylistItems(deps, playlist.id)).toHaveLength(2);
    expect(countPlaylistItems(deps, playlist.id)).toBe(2);

    // Hard-delete one capture WITHOUT touching membership (orphan row remains).
    db.prepare('DELETE FROM session_replays WHERE id = ?').run('rep-a');

    // The orphan membership row is still physically present...
    expect(db.prepare('SELECT COUNT(*) AS n FROM replay_playlist_items').get()).toEqual({ n: 2 });
    // ...but every count path joins session_replays, so all three AGREE on 1.
    expect(listPlaylists(deps, 'proj-1')[0]!.item_count).toBe(1);
    expect(listPlaylistItems(deps, playlist.id)).toHaveLength(1);
    expect(countPlaylistItems(deps, playlist.id)).toBe(1);
  });

  it('deleteReplayPlaylistItemsByReplay reaps stranded membership rows', () => {
    const { stmts, db } = makeStmts();
    const deps = { stmts };
    insertReplay(db, 'rep-a', 'proj-1');
    const playlist = createPlaylist(deps, {
      projectId: 'proj-1',
      name: 'List',
      description: null,
      createdBy: null,
    });
    addPlaylistItem(deps, playlist, 'rep-a');
    expect(db.prepare('SELECT COUNT(*) AS n FROM replay_playlist_items').get()).toEqual({ n: 1 });

    // The cleanup wired at each deleteSessionReplay site removes the membership.
    stmts.deleteReplayPlaylistItemsByReplay.run('rep-a');
    expect(db.prepare('SELECT COUNT(*) AS n FROM replay_playlist_items').get()).toEqual({ n: 0 });
  });
});
