import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import {
  ensureOwnerUserFromAuthRecord,
  migrateAuthRecordIfNeeded,
  getUserByUsername,
  createUser,
  countUsers,
} from './users-store.js';
import { getMembershipRole } from './memberships-store.js';
import { initOrgsDb, setOrgsDbPathForTests, getActiveOrgId } from './orgs.js';
import { setAuthFilePathForTests, reloadAuthRecord, saveAuthRecord } from './auth-store.js';
import { getOrCreateSyntheticLocalOrgUser } from './github-connection-user.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'ah-owner-seed-'));
  mkdirSync(dir, { recursive: true });
  setOrgsDbPathForTests(path.join(dir, 'orgs.db'));
  initOrgsDb();
  setAuthFilePathForTests(path.join(dir, 'auth.json'));
  reloadAuthRecord();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('ensureOwnerUserFromAuthRecord', () => {
  it('creates the Owner user + membership when the users table is empty', () => {
    saveAuthRecord({
      username: 'owner@example.com',
      passwordHash: 'hash',
      jwtSecret: 'secret',
      role: 'Owner',
    });
    reloadAuthRecord();

    const user = ensureOwnerUserFromAuthRecord();
    expect(user?.username).toBe('owner@example.com');
    expect(user?.id).toBeTruthy();
    expect(getMembershipRole(user!.id, getActiveOrgId())).toBe('Owner');
  });

  it('still seeds the Owner when a synthetic local-<orgId> user already exists', () => {
    // Regression: GitHub/connect flows can create `local-default` before
    // /api/auth/setup finishes. migrateAuthRecordIfNeeded then no-ops.
    const syntheticId = getOrCreateSyntheticLocalOrgUser('default');
    expect(syntheticId).toBeTruthy();
    expect(countUsers()).toBe(1);
    expect(migrateAuthRecordIfNeeded()).toBeNull();

    saveAuthRecord({
      username: 'owner@example.com',
      passwordHash: 'hash',
      jwtSecret: 'secret',
      role: 'Owner',
    });
    reloadAuthRecord();

    expect(migrateAuthRecordIfNeeded()).toBeNull(); // still blocked
    const user = ensureOwnerUserFromAuthRecord();
    expect(user?.username).toBe('owner@example.com');
    expect(user!.id).not.toBe(syntheticId);
    expect(getUserByUsername('local-default')?.id).toBe(syntheticId);
    expect(getMembershipRole(user!.id, 'default')).toBe('Owner');
    expect(countUsers()).toBe(2);
  });

  it('is idempotent when the Owner already exists', () => {
    saveAuthRecord({
      username: 'owner@example.com',
      passwordHash: 'hash',
      jwtSecret: 'secret',
      role: 'Owner',
    });
    reloadAuthRecord();
    const first = ensureOwnerUserFromAuthRecord();
    const second = ensureOwnerUserFromAuthRecord();
    expect(second?.id).toBe(first?.id);
    expect(countUsers()).toBe(1);
  });
});
