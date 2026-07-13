import { describe, it, expect, beforeEach, vi } from 'vitest';
import { tmpdir } from 'os';
import { mkdtempSync } from 'fs';
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
const { createUser, deleteUser } = await import('./users-store.js');
const {
  addProjectMember,
  removeProjectMember,
  isProjectMember,
  isProjectRestricted,
  listProjectMembers,
  assignedProjectIdsForUser,
  restrictedProjectIds,
  removeAllProjectMembers,
} = await import('./project-members-store.js');

function freshDb() {
  TMP_DIR = mkdtempSync(path.join(tmpdir(), 'project-members-test-'));
  setOrgsDbPathForTests(path.join(TMP_DIR, 'orgs.db'));
  initOrgsDb();
}

describe('project-members-store', () => {
  let alice: string;
  let bob: string;
  beforeEach(() => {
    freshDb();
    alice = createUser({ username: 'alice', passwordHash: 'h' }).id;
    bob = createUser({ username: 'bob', passwordHash: 'h' }).id;
  });

  it('adds a member and reads it back', () => {
    expect(isProjectRestricted('proj-a')).toBe(false);
    expect(isProjectMember('proj-a', alice)).toBe(false);
    addProjectMember('proj-a', alice, bob);
    expect(isProjectRestricted('proj-a')).toBe(true);
    expect(isProjectMember('proj-a', alice)).toBe(true);
    const members = listProjectMembers('proj-a');
    expect(members).toHaveLength(1);
    expect(members[0]).toMatchObject({ userId: alice, username: 'alice', addedBy: bob });
  });

  it('addProjectMember is idempotent (re-assign is a no-op)', () => {
    addProjectMember('proj-a', alice, null);
    addProjectMember('proj-a', alice, bob);
    expect(listProjectMembers('proj-a')).toHaveLength(1);
    // First writer's addedBy is preserved (ON CONFLICT DO NOTHING).
    expect(listProjectMembers('proj-a')[0].addedBy).toBeNull();
  });

  it('removeProjectMember deletes and reports whether a row existed', () => {
    addProjectMember('proj-a', alice, null);
    expect(removeProjectMember('proj-a', alice)).toBe(true);
    expect(removeProjectMember('proj-a', alice)).toBe(false);
    expect(isProjectMember('proj-a', alice)).toBe(false);
    expect(isProjectRestricted('proj-a')).toBe(true);
    expect(restrictedProjectIds()).toEqual(new Set(['proj-a']));
  });

  it('assignedProjectIdsForUser returns just that user’s projects', () => {
    addProjectMember('proj-a', alice, null);
    addProjectMember('proj-b', alice, null);
    addProjectMember('proj-b', bob, null);
    expect(assignedProjectIdsForUser(alice)).toEqual(new Set(['proj-a', 'proj-b']));
    expect(assignedProjectIdsForUser(bob)).toEqual(new Set(['proj-b']));
    expect(assignedProjectIdsForUser('nobody')).toEqual(new Set());
  });

  it('restrictedProjectIds returns projects with an active assignment ACL', () => {
    expect(restrictedProjectIds()).toEqual(new Set());
    addProjectMember('proj-a', alice, null);
    addProjectMember('proj-a', bob, null);
    addProjectMember('proj-b', alice, null);
    expect(restrictedProjectIds()).toEqual(new Set(['proj-a', 'proj-b']));
  });

  it('removeAllProjectMembers clears an ACL and returns the count', () => {
    addProjectMember('proj-a', alice, null);
    addProjectMember('proj-a', bob, null);
    expect(removeAllProjectMembers('proj-a')).toBe(2);
    expect(isProjectRestricted('proj-a')).toBe(false);
    expect(restrictedProjectIds()).toEqual(new Set());
  });

  it('deleting a user cascades their assignment but preserves project restriction state', () => {
    addProjectMember('proj-a', alice, null);
    deleteUser(alice);
    // better-sqlite3 needs foreign_keys pragma ON — orgs.ts sets it.
    getOrgsDb();
    expect(isProjectMember('proj-a', alice)).toBe(false);
    expect(listProjectMembers('proj-a')).toEqual([]);
    expect(isProjectRestricted('proj-a')).toBe(true);
    expect(restrictedProjectIds()).toEqual(new Set(['proj-a']));
  });
});
