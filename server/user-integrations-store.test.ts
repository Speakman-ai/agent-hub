import { describe, it, expect, beforeEach, vi } from 'vitest';
import { tmpdir } from 'os';
import { mkdtempSync, mkdirSync } from 'fs';
import path from 'path';

let TMP_DIR = '';
vi.mock('./config.js', () => ({
  default: {
    apiKey: null,
    get dataDir() {
      return TMP_DIR;
    },
  },
}));

const { initOrgsDb, setOrgsDbPathForTests, getOrgsDb } = await import('./orgs.js');
const { createUser } = await import('./users-store.js');
const userIntegrations = await import('./user-integrations-store.js');

function freshDb() {
  TMP_DIR = mkdtempSync(path.join(tmpdir(), 'user-integrations-store-test-'));
  mkdirSync(TMP_DIR, { recursive: true });
  setOrgsDbPathForTests(path.join(TMP_DIR, 'orgs.db'));
  initOrgsDb();
}

describe('user-integrations-store — schema migration', () => {
  beforeEach(() => {
    freshDb();
  });

  it('initOrgsDb creates the user_integrations table and index', () => {
    const db = getOrgsDb();
    const table = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='user_integrations'")
      .get() as { name: string } | undefined;
    expect(table?.name).toBe('user_integrations');

    const index = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_user_integrations_user'",
      )
      .get() as { name: string } | undefined;
    expect(index?.name).toBe('idx_user_integrations_user');
  });

  it('migration is idempotent — running initOrgsDb a second time does not throw', () => {
    // First call already happened in beforeEach. Running again on the
    // same physical DB simulates a server restart on an existing
    // install: the IF NOT EXISTS guards in the schema must be honoured.
    expect(() => initOrgsDb()).not.toThrow();

    const db = getOrgsDb();
    const table = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='user_integrations'")
      .get();
    expect(table).toBeTruthy();
  });

  it('upsert succeeds for arbitrary user_id strings — the table has no FK to users', () => {
    // Deliberately not creating a `users` row first. The schema spec
    // does not declare a foreign key, so writes for unknown users
    // should still succeed — useful when the integration row is
    // written from a webhook before user provisioning catches up.
    const row = userIntegrations.upsert({
      userId: 'never-provisioned',
      app: 'slack',
      connectionId: 'conn-1',
    });
    expect(row.userId).toBe('never-provisioned');
  });
});

describe('user-integrations-store — upsert', () => {
  beforeEach(() => {
    freshDb();
  });

  it('inserts a new row with default PENDING status when status is omitted', () => {
    const user = createUser({ username: 'alice', passwordHash: 'x' });
    const row = userIntegrations.upsert({
      userId: user.id,
      app: 'slack',
      connectionId: 'conn-abc',
    });
    expect(row.userId).toBe(user.id);
    expect(row.app).toBe('slack');
    expect(row.connectionId).toBe('conn-abc');
    expect(row.status).toBe('PENDING');
    expect(row.metadata).toBeNull();
    expect(row.createdAt).toBeTruthy();
    expect(row.updatedAt).toBeTruthy();
  });

  it('persists explicit status and metadata, round-tripping JSON', () => {
    const user = createUser({ username: 'alice', passwordHash: 'x' });
    const row = userIntegrations.upsert({
      userId: user.id,
      app: 'google-drive',
      connectionId: 'conn-1',
      status: 'CONNECTED',
      metadata: { providerConfigKey: 'google-drive', scopes: ['drive.readonly'] },
    });
    expect(row.status).toBe('CONNECTED');
    expect(row.metadata).toEqual({
      providerConfigKey: 'google-drive',
      scopes: ['drive.readonly'],
    });
  });

  it('replaces an existing (user, app) row on second call (composite PK)', () => {
    const user = createUser({ username: 'alice', passwordHash: 'x' });
    userIntegrations.upsert({
      userId: user.id,
      app: 'slack',
      connectionId: 'conn-1',
      status: 'PENDING',
      metadata: { initial: true },
    });
    const updated = userIntegrations.upsert({
      userId: user.id,
      app: 'slack',
      connectionId: 'conn-2',
      status: 'CONNECTED',
      metadata: { initial: false, team: 'T123' },
    });
    expect(updated.connectionId).toBe('conn-2');
    expect(updated.status).toBe('CONNECTED');
    expect(updated.metadata).toEqual({ initial: false, team: 'T123' });

    // Only one row total for that (user, app) pair.
    const all = userIntegrations.listForUser(user.id);
    expect(all).toHaveLength(1);
    expect(all[0]!.connectionId).toBe('conn-2');
  });

  it('upsert with metadata=null clears a previously-stored metadata blob', () => {
    const user = createUser({ username: 'alice', passwordHash: 'x' });
    userIntegrations.upsert({
      userId: user.id,
      app: 'slack',
      connectionId: 'conn-1',
      metadata: { keep: 'me' },
    });
    expect(userIntegrations.getForUser(user.id, 'slack')!.metadata).toEqual({ keep: 'me' });
    userIntegrations.upsert({
      userId: user.id,
      app: 'slack',
      connectionId: 'conn-1',
      metadata: null,
    });
    expect(userIntegrations.getForUser(user.id, 'slack')!.metadata).toBeNull();
  });

  it('allows the same app for two different users without collision', () => {
    const alice = createUser({ username: 'alice', passwordHash: 'x' });
    const bob = createUser({ username: 'bob', passwordHash: 'x' });
    userIntegrations.upsert({ userId: alice.id, app: 'slack', connectionId: 'a-conn' });
    userIntegrations.upsert({ userId: bob.id, app: 'slack', connectionId: 'b-conn' });

    expect(userIntegrations.getForUser(alice.id, 'slack')!.connectionId).toBe('a-conn');
    expect(userIntegrations.getForUser(bob.id, 'slack')!.connectionId).toBe('b-conn');
  });
});

describe('user-integrations-store — listForUser', () => {
  beforeEach(() => {
    freshDb();
  });

  it('returns [] for a user with no integrations', () => {
    const user = createUser({ username: 'alice', passwordHash: 'x' });
    expect(userIntegrations.listForUser(user.id)).toEqual([]);
  });

  it('returns [] for a missing-user query (no row exists)', () => {
    // No createUser call — the userId never existed. Cross-user
    // isolation is enforced by the query parameter, not by app code,
    // so this must yield an empty array rather than throwing.
    expect(userIntegrations.listForUser('does-not-exist')).toEqual([]);
  });

  it('returns only the requested user’s rows even when other users have integrations', () => {
    const alice = createUser({ username: 'alice', passwordHash: 'x' });
    const bob = createUser({ username: 'bob', passwordHash: 'x' });
    userIntegrations.upsert({ userId: alice.id, app: 'slack', connectionId: 'a-slack' });
    userIntegrations.upsert({ userId: alice.id, app: 'google-drive', connectionId: 'a-gd' });
    userIntegrations.upsert({ userId: bob.id, app: 'slack', connectionId: 'b-slack' });
    userIntegrations.upsert({ userId: bob.id, app: 'github', connectionId: 'b-gh' });

    const aliceRows = userIntegrations.listForUser(alice.id);
    expect(aliceRows).toHaveLength(2);
    expect(aliceRows.map((r) => r.app).sort()).toEqual(['google-drive', 'slack']);
    for (const row of aliceRows) {
      expect(row.userId).toBe(alice.id);
    }
    // Spot-check no bob rows leaked
    expect(aliceRows.find((r) => r.connectionId === 'b-slack')).toBeUndefined();
    expect(aliceRows.find((r) => r.connectionId === 'b-gh')).toBeUndefined();
  });

  it('returns rows ordered by app for stable consumers', () => {
    const user = createUser({ username: 'alice', passwordHash: 'x' });
    userIntegrations.upsert({ userId: user.id, app: 'slack', connectionId: 's' });
    userIntegrations.upsert({ userId: user.id, app: 'github', connectionId: 'g' });
    userIntegrations.upsert({ userId: user.id, app: 'google-drive', connectionId: 'd' });

    const apps = userIntegrations.listForUser(user.id).map((r) => r.app);
    expect(apps).toEqual(['github', 'google-drive', 'slack']);
  });
});

describe('user-integrations-store — getForUser', () => {
  beforeEach(() => {
    freshDb();
  });

  it('returns null when no row exists for (user, app)', () => {
    const user = createUser({ username: 'alice', passwordHash: 'x' });
    expect(userIntegrations.getForUser(user.id, 'slack')).toBeNull();
  });

  it('does not surface another user’s row (cross-user read isolation)', () => {
    const alice = createUser({ username: 'alice', passwordHash: 'x' });
    const bob = createUser({ username: 'bob', passwordHash: 'x' });
    userIntegrations.upsert({ userId: bob.id, app: 'slack', connectionId: 'b-slack' });
    expect(userIntegrations.getForUser(alice.id, 'slack')).toBeNull();
    // Bob can still see his own row
    expect(userIntegrations.getForUser(bob.id, 'slack')!.connectionId).toBe('b-slack');
  });
});

describe('user-integrations-store — delete', () => {
  beforeEach(() => {
    freshDb();
  });

  it('removes a (user, app) row and returns true on first call, false on retry', () => {
    const user = createUser({ username: 'alice', passwordHash: 'x' });
    userIntegrations.upsert({ userId: user.id, app: 'slack', connectionId: 'conn-1' });
    expect(userIntegrations.getForUser(user.id, 'slack')).not.toBeNull();

    expect(userIntegrations.delete(user.id, 'slack')).toBe(true);
    expect(userIntegrations.getForUser(user.id, 'slack')).toBeNull();

    // Idempotent
    expect(userIntegrations.delete(user.id, 'slack')).toBe(false);
  });

  it('only deletes the targeted row, leaving other apps and other users intact', () => {
    const alice = createUser({ username: 'alice', passwordHash: 'x' });
    const bob = createUser({ username: 'bob', passwordHash: 'x' });
    userIntegrations.upsert({ userId: alice.id, app: 'slack', connectionId: 'a-slack' });
    userIntegrations.upsert({ userId: alice.id, app: 'github', connectionId: 'a-gh' });
    userIntegrations.upsert({ userId: bob.id, app: 'slack', connectionId: 'b-slack' });

    userIntegrations.delete(alice.id, 'slack');

    expect(userIntegrations.getForUser(alice.id, 'slack')).toBeNull();
    expect(userIntegrations.getForUser(alice.id, 'github')!.connectionId).toBe('a-gh');
    expect(userIntegrations.getForUser(bob.id, 'slack')!.connectionId).toBe('b-slack');
  });

  it('returns false (not throw) for a missing user', () => {
    expect(userIntegrations.delete('does-not-exist', 'slack')).toBe(false);
  });
});
