import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { recoverActiveSessionsAfterSetup } from './spawn-creds-setup-recovery.js';
import { spawnCredsPath } from './spawn-creds-file.js';

// We mock `createApiKey` so the test doesn't have to bring up the full
// orgs.db. The unit under test is the iteration logic and file writer
// wiring — the apiKey minting itself is tested in api-keys-store.test.ts.
vi.mock('./api-keys-store.js', () => {
  const calls: Array<{ userId: string; name: string }> = [];
  return {
    __calls: calls,
    createApiKey: vi.fn((userId: string, name: string) => {
      calls.push({ userId, name });
      const token = `ahub_test_${calls.length.toString().padStart(40, '0')}`;
      return {
        id: `key-${calls.length}`,
        userId,
        name,
        prefix: token.slice(0, 12),
        token,
        createdAt: '2026-05-12T19:00:00.000Z',
        lastUsedAt: null,
        revokedAt: null,
        expiresAt: null,
      };
    }),
  };
});

describe('recoverActiveSessionsAfterSetup', () => {
  let tmp: string;
  let db: Database.Database;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'spawn-recovery-test-'));
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  });

  afterEach(() => {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  function insertSession(id: string, updatedAt: string): void {
    db.prepare(
      "INSERT INTO sessions (id, agent_id, name, created_at, updated_at) VALUES (?, 'a', 'n', ?, ?)",
    ).run(id, updatedAt, updatedAt);
  }

  it('writes a spawn-creds file for every recently-active session', () => {
    insertSession('sess-recent-1', '2026-05-12 18:00:00');
    insertSession('sess-recent-2', '2026-05-12 18:30:00');
    const result = recoverActiveSessionsAfterSetup({
      db,
      dataDir: tmp,
      ownerUserId: 'owner-uid',
      now: () => new Date('2026-05-12T19:00:00Z'),
    });
    expect(result.candidates).toBe(2);
    expect(result.recovered).toBe(2);
    expect(result.failed).toBe(0);
    expect(existsSync(spawnCredsPath('sess-recent-1', tmp))).toBe(true);
    expect(existsSync(spawnCredsPath('sess-recent-2', tmp))).toBe(true);
    // Each file contains the minted token (mocked).
    expect(readFileSync(spawnCredsPath('sess-recent-1', tmp), 'utf8')).toMatch(/^ahub_/);
  });

  it('skips sessions older than the 24h active window', () => {
    insertSession('sess-old', '2026-05-10 18:00:00'); // 2 days ago
    insertSession('sess-recent', '2026-05-12 18:00:00');
    const result = recoverActiveSessionsAfterSetup({
      db,
      dataDir: tmp,
      ownerUserId: 'owner-uid',
      now: () => new Date('2026-05-12T19:00:00Z'),
    });
    expect(result.candidates).toBe(1);
    expect(result.recovered).toBe(1);
    expect(existsSync(spawnCredsPath('sess-old', tmp))).toBe(false);
    expect(existsSync(spawnCredsPath('sess-recent', tmp))).toBe(true);
  });

  it('returns zero counts when no sessions exist', () => {
    const result = recoverActiveSessionsAfterSetup({
      db,
      dataDir: tmp,
      ownerUserId: 'owner-uid',
    });
    expect(result.candidates).toBe(0);
    expect(result.recovered).toBe(0);
  });

  it('logs and continues on per-session failure', async () => {
    const apiKeysModule = await import('./api-keys-store.js');
    // Make the third call throw.
    let count = 0;
    (apiKeysModule.createApiKey as ReturnType<typeof vi.fn>).mockImplementation(
      (userId: string, name: string) => {
        count += 1;
        if (count === 2) throw new Error('synthetic mint failure');
        const token = `ahub_test_${count.toString().padStart(40, '0')}`;
        return {
          id: `key-${count}`,
          userId,
          name,
          prefix: token.slice(0, 12),
          token,
          createdAt: '2026-05-12T19:00:00.000Z',
          lastUsedAt: null,
          revokedAt: null,
          expiresAt: null,
        };
      },
    );
    insertSession('s1', '2026-05-12 18:00:00');
    insertSession('s2', '2026-05-12 18:30:00');
    insertSession('s3', '2026-05-12 18:45:00');
    const logs: Array<[string, string]> = [];
    const result = recoverActiveSessionsAfterSetup({
      db,
      dataDir: tmp,
      ownerUserId: 'owner-uid',
      log: (lvl, msg) => logs.push([lvl, msg]),
      now: () => new Date('2026-05-12T19:00:00Z'),
    });
    expect(result.candidates).toBe(3);
    expect(result.recovered).toBe(2);
    expect(result.failed).toBe(1);
    expect(
      logs.some(([lvl, msg]) => lvl === 'warn' && msg.includes('synthetic mint failure')),
    ).toBe(true);
  });

  it('handles a missing sessions table gracefully (legacy DBs)', () => {
    const emptyDb = new Database(':memory:');
    try {
      const logs: Array<[string, string]> = [];
      const result = recoverActiveSessionsAfterSetup({
        db: emptyDb,
        dataDir: tmp,
        ownerUserId: 'owner-uid',
        log: (lvl, msg) => logs.push([lvl, msg]),
      });
      expect(result.candidates).toBe(0);
      expect(logs.some(([lvl]) => lvl === 'warn')).toBe(true);
    } finally {
      emptyDb.close();
    }
  });
});
