/**
 * Unit tests for `provisionUser` — the shared atomic account-provisioning
 * helper used by both `POST /api/auth/users` and invite acceptance.
 *
 * The regression these lock in: before the helper existed, the direct-create
 * path wrote user + membership + project assignments WITHOUT a transaction,
 * so a failure partway through the project loop left a half-created account
 * (user + membership committed, only a prefix of projects assigned). Every
 * test below drives a failure at a different point and asserts NOTHING
 * persists — full rollback.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { tmpdir } from 'os';
import { mkdtempSync } from 'fs';
import path from 'path';

let TMP_DIR = '';
const mockConfig = {
  apiKey: null as string | null,
  get dataDir() {
    return TMP_DIR;
  },
};
vi.mock('./config.js', () => ({ default: mockConfig }));

// Wrap the real project-members store so a single test can force
// `addProjectMember` to throw mid-loop while every other test uses the real
// implementation.
let failAssignAfter = -1; // throw on the Nth (0-indexed) addProjectMember call; -1 = never
let assignCalls = 0;
vi.mock('./project-members-store.js', async (orig) => {
  const actual = (await orig()) as typeof import('./project-members-store.js');
  return {
    ...actual,
    addProjectMember: (projectId: string, userId: string, addedBy: string | null) => {
      if (failAssignAfter >= 0 && assignCalls === failAssignAfter) {
        assignCalls += 1;
        throw new Error('forced addProjectMember failure');
      }
      assignCalls += 1;
      return actual.addProjectMember(projectId, userId, addedBy);
    },
  };
});

const { setOrgsDbPathForTests, initOrgsDb } = await import('./orgs.js');
const { getUserByUsername } = await import('./users-store.js');
const { getMembershipRole } = await import('./memberships-store.js');
const { assignedProjectIdsForUser, isProjectRestricted } =
  await import('./project-members-store.js');
const { provisionUser } = await import('./provision-user.js');

beforeEach(() => {
  TMP_DIR = mkdtempSync(path.join(tmpdir(), 'provision-user-test-'));
  setOrgsDbPathForTests(path.join(TMP_DIR, 'orgs.db'));
  initOrgsDb();
  failAssignAfter = -1;
  assignCalls = 0;
});

describe('provisionUser', () => {
  it('creates the user, membership, and project assignments atomically', () => {
    const { user, assignedProjectIds } = provisionUser({
      username: 'alice@example.com',
      passwordHash: 'hash',
      orgId: 'default',
      role: 'User',
      projectIds: ['proj-a', 'proj-b'],
      assignedBy: null,
      projectExists: () => true,
    });

    expect(user.username).toBe('alice@example.com');
    expect(assignedProjectIds.sort()).toEqual(['proj-a', 'proj-b']);
    expect(getMembershipRole(user.id, 'default')).toBe('User');
    expect([...assignedProjectIdsForUser(user.id)].sort()).toEqual(['proj-a', 'proj-b']);
  });

  it('skips (does not write) ids whose project no longer exists — the TOCTOU guard', () => {
    // 'gone' was authorized when the request/invite was minted but has since
    // been deleted; projectExists reports it missing at write time.
    const { user, assignedProjectIds } = provisionUser({
      username: 'toctou@example.com',
      passwordHash: 'hash',
      orgId: 'default',
      role: 'User',
      projectIds: ['proj-a', 'gone'],
      assignedBy: null,
      projectExists: (id) => id !== 'gone',
    });

    expect(assignedProjectIds).toEqual(['proj-a']);
    expect([...assignedProjectIdsForUser(user.id)]).toEqual(['proj-a']);
    // No dangling ACL / restriction row for the deleted project.
    expect(isProjectRestricted('gone')).toBe(false);
  });

  it('fails closed: throws if projectIds is non-empty and projectExists is omitted', () => {
    expect(() =>
      provisionUser({
        username: 'noguard@example.com',
        passwordHash: 'hash',
        orgId: 'default',
        role: 'User',
        projectIds: ['proj-a'],
      }),
    ).toThrow(/projectExists is required/);

    // The guard fires before the transaction, so no user is created.
    expect(getUserByUsername('noguard@example.com')).toBeNull();
  });

  it('runs afterCreateUser inside the transaction and rolls back on its throw', () => {
    expect(() =>
      provisionUser({
        username: 'ghost@example.com',
        passwordHash: 'hash',
        orgId: 'default',
        role: 'User',
        projectIds: ['proj-a'],
        projectExists: () => true,
        afterCreateUser: () => {
          throw new Error('race lost');
        },
      }),
    ).toThrow('race lost');

    // Nothing must persist: no user, no membership, no project rows.
    expect(getUserByUsername('ghost@example.com')).toBeNull();
  });

  it('rolls back the user and membership when a project assignment fails mid-loop', () => {
    failAssignAfter = 1; // first assignment succeeds, second throws

    expect(() =>
      provisionUser({
        username: 'partial@example.com',
        passwordHash: 'hash',
        orgId: 'default',
        role: 'User',
        projectIds: ['proj-a', 'proj-b'],
        assignedBy: null,
        projectExists: () => true,
      }),
    ).toThrow('forced addProjectMember failure');

    // The user + membership + the first (already-applied) project row must all
    // be rolled back — no partially-created account survives.
    expect(getUserByUsername('partial@example.com')).toBeNull();
    // The restriction marker written by the first addProjectMember must also
    // be gone (it happened inside the same rolled-back transaction).
    expect(isProjectRestricted('proj-a')).toBe(false);
  });

  it('works with no project assignments', () => {
    const { user, assignedProjectIds } = provisionUser({
      username: 'solo@example.com',
      passwordHash: 'hash',
      orgId: 'default',
      role: 'Admin',
    });
    expect(assignedProjectIds).toEqual([]);
    expect(getMembershipRole(user.id, 'default')).toBe('Admin');
    expect(assignedProjectIdsForUser(user.id).size).toBe(0);
  });
});
