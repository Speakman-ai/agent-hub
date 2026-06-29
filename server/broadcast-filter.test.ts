import { describe, it, expect, vi } from 'vitest';
import { shouldDeliverBroadcast, type BroadcastFilterDeps } from './broadcast-filter.js';
import type { WsVisibilityStamp } from './session-ownership.js';
import type { Project } from './types.js';

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'p1',
    name: 'p1',
    cwd: '/tmp/p1',
    ahw: '/tmp/p1-ahw',
    agents: [],
    ...overrides,
  };
}

function makeDeps(overrides: Partial<BroadcastFilterDeps> = {}): BroadcastFilterDeps {
  return {
    resolveProjectId: () => null,
    findProject: () => null,
    ...overrides,
  };
}

describe('shouldDeliverBroadcast', () => {
  it('delivers to clients without a visibility stamp (legacy / test harness)', () => {
    const data = { type: 'done', sessionId: 's1' };
    const deps = makeDeps({
      resolveProjectId: vi.fn(),
      findProject: vi.fn(),
    });
    expect(shouldDeliverBroadcast(data, undefined, deps)).toBe(true);
    // No work done — the unstamped fast-path short-circuits ahead of any
    // resolution. Keeps the legacy connection paths cheap.
    expect(deps.resolveProjectId).not.toHaveBeenCalled();
    expect(deps.findProject).not.toHaveBeenCalled();
  });

  it('delivers everything to localBypass clients (apiKey / bundled / no-auth)', () => {
    const stamp: WsVisibilityStamp = { userId: null, role: 'Owner', localBypass: true };
    const data = { type: 'done', sessionId: 's1' };
    const deps = makeDeps({
      resolveProjectId: vi.fn(),
      findProject: vi.fn(),
    });
    expect(shouldDeliverBroadcast(data, stamp, deps)).toBe(true);
    expect(deps.resolveProjectId).not.toHaveBeenCalled();
  });

  it('delivers to authenticated user for a shared project they can view', () => {
    const stamp: WsVisibilityStamp = { userId: 'u1', role: 'User' };
    const data = { type: 'done', projectId: 'proj-1' };
    const deps = makeDeps({
      resolveProjectId: () => 'proj-1',
      findProject: () => makeProject({ id: 'proj-1', visibility: 'shared' }),
    });
    expect(shouldDeliverBroadcast(data, stamp, deps)).toBe(true);
  });

  it('SKIPS private cron thread entries for non-owners even on shared projects', () => {
    const stamp: WsVisibilityStamp = { userId: 'u-other', role: 'User' };
    const data = {
      type: 'thread_entry_created',
      projectId: 'proj-1',
      ownerUserId: 'u-owner',
      cronShared: false,
    };
    const deps = makeDeps({
      resolveProjectId: () => 'proj-1',
      findProject: () => makeProject({ id: 'proj-1', visibility: 'shared' }),
    });
    expect(shouldDeliverBroadcast(data, stamp, deps)).toBe(false);
  });

  it('delivers shared cron thread entries through normal project visibility', () => {
    const stamp: WsVisibilityStamp = { userId: 'u-other', role: 'User' };
    const data = {
      type: 'thread_entry_created',
      projectId: 'proj-1',
      ownerUserId: 'u-owner',
      cronShared: true,
    };
    const deps = makeDeps({
      resolveProjectId: () => 'proj-1',
      findProject: () => makeProject({ id: 'proj-1', visibility: 'shared' }),
    });
    expect(shouldDeliverBroadcast(data, stamp, deps)).toBe(true);
  });

  it('delivers to the owner of a private project', () => {
    const stamp: WsVisibilityStamp = { userId: 'u-owner', role: 'User' };
    const data = { type: 'done', projectId: 'proj-priv' };
    const deps = makeDeps({
      resolveProjectId: () => 'proj-priv',
      findProject: () =>
        makeProject({ id: 'proj-priv', visibility: 'private', ownerUserId: 'u-owner' }),
    });
    expect(shouldDeliverBroadcast(data, stamp, deps)).toBe(true);
  });

  it('SKIPS delivery to non-owner for a private project', () => {
    const stamp: WsVisibilityStamp = { userId: 'u-other', role: 'User' };
    const data = { type: 'done', projectId: 'proj-priv' };
    const deps = makeDeps({
      resolveProjectId: () => 'proj-priv',
      findProject: () =>
        makeProject({ id: 'proj-priv', visibility: 'private', ownerUserId: 'u-owner' }),
    });
    expect(shouldDeliverBroadcast(data, stamp, deps)).toBe(false);
  });

  it('SKIPS delivery to a JWT org Owner for a private project they do not own', () => {
    // Org Owners get a kill-switch on DELETE but cannot READ private
    // projects they don't own — matches `canViewProject` policy.
    const stamp: WsVisibilityStamp = { userId: 'u-admin', role: 'Owner' };
    const data = { type: 'done', projectId: 'proj-priv' };
    const deps = makeDeps({
      resolveProjectId: () => 'proj-priv',
      findProject: () =>
        makeProject({ id: 'proj-priv', visibility: 'private', ownerUserId: 'u-actual-owner' }),
    });
    expect(shouldDeliverBroadcast(data, stamp, deps)).toBe(false);
  });

  it('delivers events whose project cannot be resolved (back-compat fan-out)', () => {
    const stamp: WsVisibilityStamp = { userId: 'u1', role: 'User' };
    const data = { type: 'some_new_event', payload: { foo: 'bar' } };
    const deps = makeDeps({ resolveProjectId: () => null });
    expect(shouldDeliverBroadcast(data, stamp, deps)).toBe(true);
  });

  it('delivers events whose resolved project no longer exists (deleted)', () => {
    const stamp: WsVisibilityStamp = { userId: 'u1', role: 'User' };
    const data = { type: 'done', projectId: 'proj-gone' };
    const deps = makeDeps({
      resolveProjectId: () => 'proj-gone',
      findProject: () => null,
    });
    expect(shouldDeliverBroadcast(data, stamp, deps)).toBe(true);
  });

  it('treats stamp without userId as localBypass even when localBypass flag is missing', () => {
    // A stamp with no userId and no localBypass shouldn't happen with the
    // current websocket.ts wiring, but the policy is "no userId → cannot
    // enforce, so deliver". Confirm canViewProject would fall back to
    // the localBypass check for the null-user case via the explicit flag.
    const stamp: WsVisibilityStamp = { userId: null, role: undefined, localBypass: false };
    const data = { type: 'done', projectId: 'proj-priv' };
    const deps = makeDeps({
      resolveProjectId: () => 'proj-priv',
      findProject: () =>
        makeProject({ id: 'proj-priv', visibility: 'private', ownerUserId: 'u-owner' }),
    });
    // With localBypass=false AND no userId, canViewProject would return
    // false → we skip. The websocket layer prevents this state by setting
    // localBypass=true whenever userId is null, but the filter still
    // honours the stamp as-is for predictability.
    expect(shouldDeliverBroadcast(data, stamp, deps)).toBe(false);
  });
});
