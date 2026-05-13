import { describe, it, expect } from 'vitest';
import {
  getVisibility,
  canViewProject,
  canDeleteProject,
  filterVisibleProjects,
  canChangeVisibility,
  classifyVisibilityTransition,
} from './project-visibility.js';
import type { Project } from './types.js';

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: overrides.id ?? 'p1',
    name: 'p1',
    cwd: '/tmp/p1',
    ahw: '/tmp/p1-ahw',
    agents: [],
    ...overrides,
  };
}

describe('project-visibility', () => {
  describe('getVisibility', () => {
    it('defaults to shared when unset', () => {
      expect(getVisibility(makeProject())).toBe('shared');
    });

    it('returns shared when explicitly shared', () => {
      expect(getVisibility(makeProject({ visibility: 'shared' }))).toBe('shared');
    });

    it('returns private when explicitly private', () => {
      expect(getVisibility(makeProject({ visibility: 'private' }))).toBe('private');
    });

    it('treats unknown values as shared (defensive)', () => {
      // simulate a bad JSON write that slipped past validation
      expect(getVisibility(makeProject({ visibility: 'bogus' as 'shared' }))).toBe('shared');
    });
  });

  describe('canViewProject', () => {
    it('shared project: any authenticated user can view', () => {
      const p = makeProject({ visibility: 'shared' });
      expect(canViewProject(p, { userId: 'u1' })).toBe(true);
      expect(canViewProject(p, { userId: 'u2', role: 'User' })).toBe(true);
    });

    it('shared project: anonymous caller can also view (back-compat for default)', () => {
      const p = makeProject({ visibility: 'shared' });
      expect(canViewProject(p, { userId: null })).toBe(true);
    });

    it('private project: only the owner can view', () => {
      const p = makeProject({ visibility: 'private', ownerUserId: 'u1' });
      expect(canViewProject(p, { userId: 'u1' })).toBe(true);
      expect(canViewProject(p, { userId: 'u2' })).toBe(false);
    });

    it('private project: org Owner CANNOT view if not the owner', () => {
      // Owners get the kill switch via canDeleteProject, NOT read access.
      const p = makeProject({ visibility: 'private', ownerUserId: 'u1' });
      expect(canViewProject(p, { userId: 'u2', role: 'Owner' })).toBe(false);
    });

    it('private project: caller with no userId is denied', () => {
      const p = makeProject({ visibility: 'private', ownerUserId: 'u1' });
      expect(canViewProject(p, { userId: null })).toBe(false);
      expect(canViewProject(p, { userId: undefined })).toBe(false);
    });

    it('local bundled mode: bypass sees every project', () => {
      const priv = makeProject({ visibility: 'private', ownerUserId: 'someone-else' });
      const shared = makeProject({ visibility: 'shared' });
      expect(canViewProject(priv, { userId: null, localBypass: true })).toBe(true);
      expect(canViewProject(shared, { userId: null, localBypass: true })).toBe(true);
    });

    it('private project with no ownerUserId set is denied to all non-bypass callers', () => {
      // Defensive: a private project without an owner is unowned-and-locked.
      // The user-delete cascade should have removed it, but if it survived,
      // we fail closed rather than opening it to everyone.
      const p = makeProject({ visibility: 'private', ownerUserId: null });
      expect(canViewProject(p, { userId: 'u1' })).toBe(false);
      expect(canViewProject(p, { userId: 'u2', role: 'Owner' })).toBe(false);
    });
  });

  describe('canDeleteProject', () => {
    it('owners can delete their own private project', () => {
      const p = makeProject({ visibility: 'private', ownerUserId: 'u1' });
      expect(canDeleteProject(p, { userId: 'u1', role: 'User' })).toBe(true);
    });

    it('non-owner User cannot delete a private project they did not create', () => {
      const p = makeProject({ visibility: 'private', ownerUserId: 'u1' });
      expect(canDeleteProject(p, { userId: 'u2', role: 'User' })).toBe(false);
    });

    it('non-owner Admin cannot delete a private project they did not create', () => {
      const p = makeProject({ visibility: 'private', ownerUserId: 'u1' });
      expect(canDeleteProject(p, { userId: 'u2', role: 'Admin' })).toBe(false);
    });

    it('org Owner CAN delete a private project they did not create (kill switch)', () => {
      const p = makeProject({ visibility: 'private', ownerUserId: 'u1' });
      expect(canDeleteProject(p, { userId: 'u2', role: 'Owner' })).toBe(true);
    });

    it('shared project: any authenticated user can delete (matches view permission)', () => {
      // Existing pre-feature behavior — DELETE is auth-gated but not
      // ownership-gated for shared projects. If that changes, this test
      // changes with it.
      const p = makeProject({ visibility: 'shared' });
      expect(canDeleteProject(p, { userId: 'u1', role: 'User' })).toBe(true);
    });

    it('local bypass can delete anything', () => {
      const p = makeProject({ visibility: 'private', ownerUserId: 'someone' });
      expect(canDeleteProject(p, { userId: null, localBypass: true })).toBe(true);
    });
  });

  describe('filterVisibleProjects', () => {
    it('returns only the projects the caller can view', () => {
      const projects: Project[] = [
        makeProject({ id: 'shared', visibility: 'shared' }),
        makeProject({ id: 'mine', visibility: 'private', ownerUserId: 'u1' }),
        makeProject({ id: 'theirs', visibility: 'private', ownerUserId: 'u2' }),
        makeProject({ id: 'legacy' /* no visibility field → shared */ }),
      ];
      const visible = filterVisibleProjects(projects, { userId: 'u1', role: 'User' });
      expect(visible.map((p) => p.id).sort()).toEqual(['legacy', 'mine', 'shared']);
    });

    it('local bypass sees everything', () => {
      const projects: Project[] = [
        makeProject({ id: 'a', visibility: 'private', ownerUserId: 'someone' }),
        makeProject({ id: 'b', visibility: 'shared' }),
      ];
      const visible = filterVisibleProjects(projects, { userId: null, localBypass: true });
      expect(visible.map((p) => p.id).sort()).toEqual(['a', 'b']);
    });

    it('returns shared-only when caller has no userId and no bypass', () => {
      const projects: Project[] = [
        makeProject({ id: 'a', visibility: 'private', ownerUserId: 'u1' }),
        makeProject({ id: 'b', visibility: 'shared' }),
      ];
      const visible = filterVisibleProjects(projects, { userId: null });
      expect(visible.map((p) => p.id)).toEqual(['b']);
    });
  });

  describe('classifyVisibilityTransition', () => {
    it('returns noop when source === target', () => {
      expect(classifyVisibilityTransition('shared', 'shared')).toBe('noop');
      expect(classifyVisibilityTransition('private', 'private')).toBe('noop');
    });
    it('classifies shared → private as claim', () => {
      expect(classifyVisibilityTransition('shared', 'private')).toBe('shared->private');
    });
    it('classifies private → shared as publish', () => {
      expect(classifyVisibilityTransition('private', 'shared')).toBe('private->shared');
    });
  });

  describe('canChangeVisibility', () => {
    const shared = makeProject({ visibility: 'shared' });
    const privOwnedByU1 = makeProject({ visibility: 'private', ownerUserId: 'u1' });

    it('noop transitions: any authenticated caller is allowed', () => {
      expect(canChangeVisibility(shared, 'noop', { userId: 'u1', role: 'User' })).toBe(true);
      expect(canChangeVisibility(privOwnedByU1, 'noop', { userId: 'u1', role: 'User' })).toBe(true);
    });

    it('anonymous (no userId, no bypass) is always denied for real transitions', () => {
      expect(canChangeVisibility(shared, 'shared->private', { userId: null })).toBe(false);
      expect(canChangeVisibility(privOwnedByU1, 'private->shared', { userId: null })).toBe(false);
    });

    it('localBypass collapses to allow for any transition', () => {
      expect(
        canChangeVisibility(shared, 'shared->private', { userId: null, localBypass: true }),
      ).toBe(true);
      expect(
        canChangeVisibility(privOwnedByU1, 'private->shared', {
          userId: null,
          localBypass: true,
        }),
      ).toBe(true);
    });

    describe('shared -> private (claim)', () => {
      it('allows org Owner', () => {
        expect(
          canChangeVisibility(shared, 'shared->private', { userId: 'u1', role: 'Owner' }),
        ).toBe(true);
      });
      it('denies Admin', () => {
        expect(
          canChangeVisibility(shared, 'shared->private', { userId: 'u1', role: 'Admin' }),
        ).toBe(false);
      });
      it('denies User', () => {
        expect(canChangeVisibility(shared, 'shared->private', { userId: 'u1', role: 'User' })).toBe(
          false,
        );
      });
    });

    describe('private -> shared (publish)', () => {
      it('allows the current ownerUserId', () => {
        expect(
          canChangeVisibility(privOwnedByU1, 'private->shared', { userId: 'u1', role: 'User' }),
        ).toBe(true);
      });
      it('allows org Owner even if they are not the project owner', () => {
        expect(
          canChangeVisibility(privOwnedByU1, 'private->shared', { userId: 'u2', role: 'Owner' }),
        ).toBe(true);
      });
      it('denies Admin who is not the project owner', () => {
        expect(
          canChangeVisibility(privOwnedByU1, 'private->shared', { userId: 'u2', role: 'Admin' }),
        ).toBe(false);
      });
      it('denies User who is not the project owner', () => {
        expect(
          canChangeVisibility(privOwnedByU1, 'private->shared', { userId: 'u2', role: 'User' }),
        ).toBe(false);
      });
    });
  });
});
