import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdirSync, rmSync, existsSync, writeFileSync } from 'fs';
import path from 'path';
import os from 'os';
import Database from 'better-sqlite3';
import {
  createSnapshot,
  createSeedDb,
  listSnapshots,
  getSnapshotDetail,
  deleteSnapshot,
  getSnapshotDir,
  type SnapshotResult,
  type SnapshotInfo,
  type SeedRow,
} from './preview-db.js';

const TEST_DIR = path.join(os.tmpdir(), `preview-db-test-${process.pid}`);
const SNAP_DIR = path.join(TEST_DIR, 'snapshots');
const SOURCE_DB_PATH = path.join(TEST_DIR, 'source.db');

let sourceDb: Database.Database;

beforeEach(() => {
  // Clean up and recreate test directories
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DIR, { recursive: true });
  mkdirSync(SNAP_DIR, { recursive: true });

  // Create a source database with some data
  sourceDb = new Database(SOURCE_DB_PATH);
  sourceDb.pragma('journal_mode = WAL');
  sourceDb.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE posts (id INTEGER PRIMARY KEY, user_id INTEGER, title TEXT);
    INSERT INTO users VALUES (1, 'Alice'), (2, 'Bob');
    INSERT INTO posts VALUES (1, 1, 'Hello World'), (2, 2, 'Testing');
  `);
});

afterAll(() => {
  try {
    sourceDb?.close();
  } catch {
    // Already closed
  }
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('createSnapshot', () => {
  it('creates a snapshot of the source database', async () => {
    const result = await createSnapshot(sourceDb, { destDir: SNAP_DIR });

    expect(result.mode).toBe('snapshot');
    expect(result.sizeBytes).toBeGreaterThan(0);
    expect(result.tables).toContain('users');
    expect(result.tables).toContain('posts');
    expect(existsSync(result.path)).toBe(true);
  });

  it('snapshot contains the source data', async () => {
    const result = await createSnapshot(sourceDb, { destDir: SNAP_DIR });

    // Open the snapshot and verify data
    const snapDb = new Database(result.path, { readonly: true });
    const users = snapDb.prepare('SELECT * FROM users ORDER BY id').all() as {
      id: number;
      name: string;
    }[];
    expect(users).toHaveLength(2);
    expect(users[0].name).toBe('Alice');
    expect(users[1].name).toBe('Bob');

    const posts = snapDb.prepare('SELECT * FROM posts ORDER BY id').all() as {
      id: number;
      title: string;
    }[];
    expect(posts).toHaveLength(2);
    snapDb.close();
  });

  it('uses custom filename when provided', async () => {
    const result = await createSnapshot(sourceDb, {
      destDir: SNAP_DIR,
      filename: 'custom-snap.db',
    });

    expect(path.basename(result.path)).toBe('custom-snap.db');
  });

  it('snapshot is independent of source', async () => {
    const result = await createSnapshot(sourceDb, { destDir: SNAP_DIR });

    // Modify source after snapshot
    sourceDb.prepare("INSERT INTO users VALUES (3, 'Charlie')").run();

    // Snapshot should still have only 2 users
    const snapDb = new Database(result.path, { readonly: true });
    const users = snapDb.prepare('SELECT COUNT(*) as count FROM users').get() as { count: number };
    expect(users.count).toBe(2);
    snapDb.close();
  });

  it('prunes old snapshots beyond the limit', async () => {
    // Create 7 snapshots (limit is 5)
    for (let i = 0; i < 7; i++) {
      await createSnapshot(sourceDb, {
        destDir: SNAP_DIR,
        filename: `preview-${1000 + i}.db`,
      });
    }

    const snapshots = listSnapshots(SNAP_DIR);
    expect(snapshots.length).toBeLessThanOrEqual(5);
  });

  it('rejects filenames with path traversal', async () => {
    await expect(
      createSnapshot(sourceDb, {
        destDir: SNAP_DIR,
        filename: '../../etc/evil.db',
      }),
    ).rejects.toThrow('Invalid snapshot filename');
  });

  it('rejects filenames without .db extension', async () => {
    await expect(
      createSnapshot(sourceDb, {
        destDir: SNAP_DIR,
        filename: 'snapshot.txt',
      }),
    ).rejects.toThrow('Invalid snapshot filename');
  });
});

describe('createSeedDb', () => {
  it('creates a seed database with default data (fallback schema)', () => {
    const result = createSeedDb({ destDir: SNAP_DIR });

    expect(result.mode).toBe('seed');
    expect(result.sizeBytes).toBeGreaterThan(0);
    expect(result.tables).toContain('sessions');
    expect(result.tables).toContain('messages');
    expect(existsSync(result.path)).toBe(true);
  });

  it('seed database contains default seed data', () => {
    const result = createSeedDb({ destDir: SNAP_DIR });

    const seedDb = new Database(result.path, { readonly: true });
    const sessions = seedDb.prepare('SELECT * FROM sessions').all() as { id: string }[];
    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe('preview-session-1');

    const messages = seedDb.prepare('SELECT * FROM messages').all() as { id: string }[];
    expect(messages).toHaveLength(2);
    seedDb.close();
  });

  it('accepts custom seed data', () => {
    const customSeed: SeedRow[] = [
      {
        table: 'sessions',
        columns: ['id', 'agent_id', 'name'],
        rows: [
          ['s1', 'agent-1', 'Custom Session 1'],
          ['s2', 'agent-2', 'Custom Session 2'],
        ],
      },
    ];

    const result = createSeedDb({ destDir: SNAP_DIR }, customSeed);

    const seedDb = new Database(result.path, { readonly: true });
    const sessions = seedDb.prepare('SELECT * FROM sessions ORDER BY id').all() as {
      name: string;
    }[];
    expect(sessions).toHaveLength(2);
    expect(sessions[0].name).toBe('Custom Session 1');
    seedDb.close();
  });

  it('uses custom filename when provided', () => {
    const result = createSeedDb({
      destDir: SNAP_DIR,
      filename: 'my-seed.db',
    });

    expect(path.basename(result.path)).toBe('my-seed.db');
  });

  it('extracts schema from source DB when provided', () => {
    // Pass empty seed data so default seed (which references 'sessions') isn't used
    const result = createSeedDb({ destDir: SNAP_DIR, sourceDb }, []);

    // Should have the source DB's tables (users, posts) not the fallback schema
    expect(result.tables).toContain('users');
    expect(result.tables).toContain('posts');
  });

  it('can insert custom data when using extracted schema', () => {
    const customSeed: SeedRow[] = [
      {
        table: 'users',
        columns: ['id', 'name'],
        rows: [[99, 'Preview User']],
      },
    ];

    const result = createSeedDb({ destDir: SNAP_DIR, sourceDb }, customSeed);

    const seedDb = new Database(result.path, { readonly: true });
    const users = seedDb.prepare('SELECT * FROM users').all() as { name: string }[];
    expect(users).toHaveLength(1);
    expect(users[0].name).toBe('Preview User');
    seedDb.close();
  });

  it('rejects seed data referencing unknown tables', () => {
    const badSeed: SeedRow[] = [
      {
        table: 'nonexistent_table',
        columns: ['id', 'name'],
        rows: [['1', 'test']],
      },
    ];

    expect(() => createSeedDb({ destDir: SNAP_DIR }, badSeed)).toThrow(
      'unknown table: nonexistent_table',
    );
  });

  it('rejects seed data with SQL injection in column names', () => {
    const badSeed: SeedRow[] = [
      {
        table: 'sessions',
        columns: ['id; DROP TABLE sessions--', 'name'],
        rows: [['1', 'test']],
      },
    ];

    expect(() => createSeedDb({ destDir: SNAP_DIR }, badSeed)).toThrow('Invalid column name');
  });

  it('rejects filenames with path traversal', () => {
    expect(() =>
      createSeedDb({
        destDir: SNAP_DIR,
        filename: '../../../tmp/evil.db',
      }),
    ).toThrow('Invalid snapshot filename');
  });
});

describe('listSnapshots', () => {
  it('returns empty array for non-existent directory', () => {
    const result = listSnapshots('/tmp/does-not-exist-preview-test');
    expect(result).toEqual([]);
  });

  it('lists snapshots sorted by newest first', async () => {
    await createSnapshot(sourceDb, {
      destDir: SNAP_DIR,
      filename: 'preview-100.db',
    });
    createSeedDb({ destDir: SNAP_DIR, filename: 'preview-seed-200.db' });

    const snapshots = listSnapshots(SNAP_DIR);
    expect(snapshots.length).toBe(2);
    // Most recent should come first
    expect(snapshots[0].createdAt >= snapshots[1].createdAt).toBe(true);
  });

  it('returns lightweight info without tables (no DB connection per file)', async () => {
    await createSnapshot(sourceDb, {
      destDir: SNAP_DIR,
      filename: 'preview-100.db',
    });

    const snapshots = listSnapshots(SNAP_DIR);
    expect(snapshots.length).toBe(1);
    expect(snapshots[0].filename).toBe('preview-100.db');
    expect(snapshots[0].sizeBytes).toBeGreaterThan(0);
    // SnapshotInfo does not include tables — that's what getSnapshotDetail is for
    expect((snapshots[0] as unknown as Record<string, unknown>).tables).toBeUndefined();
  });

  it('correctly identifies snapshot vs seed mode', async () => {
    await createSnapshot(sourceDb, {
      destDir: SNAP_DIR,
      filename: 'preview-100.db',
    });
    createSeedDb({ destDir: SNAP_DIR, filename: 'preview-seed-200.db' });

    const snapshots = listSnapshots(SNAP_DIR);
    const modes = snapshots.map((s) => s.mode);
    expect(modes).toContain('snapshot');
    expect(modes).toContain('seed');
  });

  it('ignores non-preview files', () => {
    writeFileSync(path.join(SNAP_DIR, 'other.db'), '');
    writeFileSync(path.join(SNAP_DIR, 'readme.txt'), '');
    createSeedDb({ destDir: SNAP_DIR, filename: 'preview-seed-1.db' });

    const snapshots = listSnapshots(SNAP_DIR);
    expect(snapshots).toHaveLength(1);
  });
});

describe('getSnapshotDetail', () => {
  it('returns null for non-existent file', () => {
    const result = getSnapshotDetail(path.join(SNAP_DIR, 'preview-nope.db'));
    expect(result).toBeNull();
  });

  it('returns null for non-preview file', () => {
    const otherPath = path.join(SNAP_DIR, 'important.db');
    writeFileSync(otherPath, 'data');
    const result = getSnapshotDetail(otherPath);
    expect(result).toBeNull();
  });

  it('returns full detail with tables for a snapshot', async () => {
    const snap = await createSnapshot(sourceDb, {
      destDir: SNAP_DIR,
      filename: 'preview-detail.db',
    });

    const detail = getSnapshotDetail(snap.path);
    expect(detail).not.toBeNull();
    expect(detail!.tables).toContain('users');
    expect(detail!.tables).toContain('posts');
    expect(detail!.mode).toBe('snapshot');
    expect(detail!.sizeBytes).toBeGreaterThan(0);
  });

  it('returns full detail with tables for a seed', () => {
    const seed = createSeedDb({ destDir: SNAP_DIR, filename: 'preview-seed-detail.db' });

    const detail = getSnapshotDetail(seed.path);
    expect(detail).not.toBeNull();
    expect(detail!.tables).toContain('sessions');
    expect(detail!.tables).toContain('messages');
    expect(detail!.mode).toBe('seed');
  });
});

describe('deleteSnapshot', () => {
  it('deletes an existing snapshot', async () => {
    const result = await createSnapshot(sourceDb, {
      destDir: SNAP_DIR,
      filename: 'preview-to-delete.db',
    });

    expect(existsSync(result.path)).toBe(true);
    const deleted = deleteSnapshot(result.path);
    expect(deleted).toBe(true);
    expect(existsSync(result.path)).toBe(false);
  });

  it('returns false for non-existent file', () => {
    const deleted = deleteSnapshot(path.join(SNAP_DIR, 'preview-nope.db'));
    expect(deleted).toBe(false);
  });

  it('refuses to delete non-preview files', () => {
    const otherPath = path.join(SNAP_DIR, 'important.db');
    writeFileSync(otherPath, 'data');

    const deleted = deleteSnapshot(otherPath);
    expect(deleted).toBe(false);
    expect(existsSync(otherPath)).toBe(true);
  });
});

describe('getSnapshotDir', () => {
  it('returns snapshots subdirectory of dataDir', () => {
    expect(getSnapshotDir('/data')).toBe('/data/snapshots');
    expect(getSnapshotDir('/home/user/.agent-hub/data')).toBe(
      '/home/user/.agent-hub/data/snapshots',
    );
  });
});
