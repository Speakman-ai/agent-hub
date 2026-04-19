import { describe, it, expect, beforeEach, vi } from 'vitest';
import { tmpdir } from 'os';
import { mkdtempSync, mkdirSync } from 'fs';
import path from 'path';

// Point auth + orgs stores at tmp dirs so these tests own the DB.
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
const {
  createUser,
  getUserById,
  getUserByUsername,
  listUsers,
  countUsers,
  deleteUser,
  updateUserPassword,
  migrateAuthRecordIfNeeded,
} = await import('./users-store.js');
const { getMembershipRole, createMembership, listMembershipsForUser } =
  await import('./memberships-store.js');
const { saveAuthRecord, setAuthFilePathForTests, reloadAuthRecord } =
  await import('./auth-store.js');

function freshDb() {
  TMP_DIR = mkdtempSync(path.join(tmpdir(), 'users-store-test-'));
  mkdirSync(TMP_DIR, { recursive: true });
  setOrgsDbPathForTests(path.join(TMP_DIR, 'orgs.db'));
  setAuthFilePathForTests(path.join(TMP_DIR, 'auth.json'));
  reloadAuthRecord();
  initOrgsDb();
}

describe('users-store — basic CRUD', () => {
  beforeEach(() => {
    freshDb();
  });

  it('creates a user and looks it up by id and username', () => {
    const user = createUser({
      username: 'alice',
      passwordHash: 'scrypt$ignored',
    });
    expect(user.id).toBeTruthy();
    expect(user.username).toBe('alice');
    expect(getUserById(user.id)?.username).toBe('alice');
    expect(getUserByUsername('alice')?.id).toBe(user.id);
    expect(getUserByUsername('bob')).toBeNull();
  });

  it('rejects duplicate usernames via the UNIQUE constraint', () => {
    createUser({ username: 'alice', passwordHash: 'h1' });
    expect(() => createUser({ username: 'alice', passwordHash: 'h2' })).toThrow();
  });

  it('listUsers returns all users ordered by created_at', () => {
    createUser({ username: 'a', passwordHash: 'h', createdAt: '2026-04-01T00:00:00Z' });
    createUser({ username: 'b', passwordHash: 'h', createdAt: '2026-04-02T00:00:00Z' });
    const users = listUsers();
    expect(users.map((u) => u.username)).toEqual(['a', 'b']);
    expect(countUsers()).toBe(2);
  });

  it('deleteUser removes the row and cascades to memberships', () => {
    const user = createUser({ username: 'alice', passwordHash: 'h' });
    createMembership(user.id, 'default', 'Admin');
    expect(getMembershipRole(user.id, 'default')).toBe('Admin');
    deleteUser(user.id);
    expect(getUserById(user.id)).toBeNull();
    // ON DELETE CASCADE on memberships should have dropped this too.
    expect(getMembershipRole(user.id, 'default')).toBeNull();
  });

  it('updateUserPassword updates the stored hash', () => {
    const user = createUser({ username: 'alice', passwordHash: 'old' });
    updateUserPassword(user.id, 'new');
    expect(getUserById(user.id)?.password_hash).toBe('new');
  });

  it('supports per-org roles via memberships', () => {
    const user = createUser({ username: 'multi', passwordHash: 'h' });
    // Our default org is seeded; membership in it + its data is fine.
    createMembership(user.id, 'default', 'User');
    expect(getMembershipRole(user.id, 'default')).toBe('User');
    expect(listMembershipsForUser(user.id)).toHaveLength(1);
  });
});

describe('users-store — migration from auth.json', () => {
  beforeEach(() => {
    freshDb();
  });

  it('is a no-op when users already exist', () => {
    createUser({ username: 'already-there', passwordHash: 'h' });
    const result = migrateAuthRecordIfNeeded();
    expect(result).toBeNull();
  });

  it('is a no-op when auth.json is missing', () => {
    expect(migrateAuthRecordIfNeeded()).toBeNull();
    expect(countUsers()).toBe(0);
  });

  it('seeds a user + Owner membership for the default org from auth.json', () => {
    // Simulate a pre-Phase-3 single-user install.
    saveAuthRecord({
      username: 'legacy-owner',
      passwordHash: 'scrypt$existing',
      jwtSecret: 'secret',
      role: 'Owner',
    });
    reloadAuthRecord();

    const result = migrateAuthRecordIfNeeded();
    expect(result).not.toBeNull();
    expect(result?.migratedUserId).toBeTruthy();

    const user = getUserByUsername('legacy-owner');
    expect(user).not.toBeNull();
    expect(user?.password_hash).toBe('scrypt$existing');
    expect(getMembershipRole(user!.id, 'default')).toBe('Owner');
  });

  it('seeds memberships for every existing org, not just default', () => {
    // Seed auth.json and then a second org before running the migration.
    saveAuthRecord({
      username: 'legacy',
      passwordHash: 'h',
      jwtSecret: 's',
      role: 'Owner',
    });
    reloadAuthRecord();

    // Direct INSERT rather than via the org routes (no Express stack here).
    getOrgsDb()
      .prepare(
        "INSERT INTO orgs (id, name, mode, color, remote_url, api_key, position) VALUES ('team-b', 'Team B', 'local', '#000', '', '', 1)",
      )
      .run();

    const result = migrateAuthRecordIfNeeded();
    expect(result).not.toBeNull();
    const user = getUserByUsername('legacy');
    expect(user).not.toBeNull();
    expect(getMembershipRole(user!.id, 'default')).toBe('Owner');
    expect(getMembershipRole(user!.id, 'team-b')).toBe('Owner');
  });
});
