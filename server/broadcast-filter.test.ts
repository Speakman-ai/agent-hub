import { describe, it, expect, vi } from 'vitest';
import {
  shouldDeliverBroadcast,
  shouldDeliverSessionScopedBroadcast,
  type BroadcastFilterDeps,
} from './broadcast-filter.js';
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
    getSessionOwner: () => null,
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
  it('SKIPS background-shell events for a non-owner who can view the project', () => {
    // The shared-project default means "can view the project" is nearly the
    // whole org. The shell payload carries another user's command line, cwd,
    // pid, and log path, and the REST surface gates all of it on
    // `userOwnsSession` — the WebSocket must not be the way around that.
    const stamp: WsVisibilityStamp = { userId: 'u2', role: 'User' };
    const data = { type: 'background_shell_update', sessionId: 's1', shell: { id: 'sh1' } };
    const deps = makeDeps({
      resolveProjectId: () => 'proj-1',
      findProject: () => makeProject({ id: 'proj-1', visibility: 'shared' }),
      getSessionOwner: () => 'u1',
    });
    expect(shouldDeliverBroadcast(data, stamp, deps)).toBe(false);
  });

  it('SKIPS background-shell events for an org Owner who does not own the session', () => {
    // No admin override: `userOwnsSession` does not grant one either.
    const stamp: WsVisibilityStamp = { userId: 'u-admin', role: 'Owner' };
    const data = { type: 'background_shell_update', sessionId: 's1', shell: { id: 'sh1' } };
    const deps = makeDeps({
      resolveProjectId: () => 'proj-1',
      findProject: () => makeProject({ id: 'proj-1', visibility: 'shared' }),
      getSessionOwner: () => 'u1',
    });
    expect(shouldDeliverBroadcast(data, stamp, deps)).toBe(false);
  });

  it('delivers background-shell events to the session owner', () => {
    const stamp: WsVisibilityStamp = { userId: 'u1', role: 'User' };
    const data = { type: 'background_shell_update', sessionId: 's1', shell: { id: 'sh1' } };
    const deps = makeDeps({
      resolveProjectId: () => 'proj-1',
      findProject: () => makeProject({ id: 'proj-1', visibility: 'shared' }),
      getSessionOwner: () => 'u1',
    });
    expect(shouldDeliverBroadcast(data, stamp, deps)).toBe(true);
  });

  it('still applies project visibility to the session owner', () => {
    // Ownership is an extra gate, not a bypass of the project check.
    const stamp: WsVisibilityStamp = { userId: 'u1', role: 'User' };
    const data = { type: 'background_shell_update', sessionId: 's1', shell: { id: 'sh1' } };
    const deps = makeDeps({
      resolveProjectId: () => 'proj-priv',
      findProject: () =>
        makeProject({ id: 'proj-priv', visibility: 'private', ownerUserId: 'u-other' }),
      getSessionOwner: () => 'u1',
    });
    expect(shouldDeliverBroadcast(data, stamp, deps)).toBe(false);
  });

  it('SKIPS background-shell events for unowned sessions (cron / heartbeat spawns)', () => {
    // NULL-owner rows belong to nobody, and `userOwnsSession` grants them to
    // no one — `GET /api/sessions/:id/background-shells` already 404s here for
    // every human. Fanning the rows out anyway would leak the command line,
    // cwd, pid, and log path org-wide and light a pill for a panel that
    // cannot load.
    const stamp: WsVisibilityStamp = { userId: 'u2', role: 'User' };
    const data = { type: 'background_shell_update', sessionId: 's1', shell: { id: 'sh1' } };
    const deps = makeDeps({
      resolveProjectId: () => 'proj-1',
      findProject: () => makeProject({ id: 'proj-1', visibility: 'shared' }),
      getSessionOwner: () => null,
    });
    expect(shouldDeliverBroadcast(data, stamp, deps)).toBe(false);
  });

  it('SKIPS a session-private event that carries no session id', () => {
    // Cannot attribute it, so cannot safely broadcast it. The runtime always
    // stamps `sessionId`; this is the malformed-event guard.
    const stamp: WsVisibilityStamp = { userId: 'u1', role: 'User' };
    const data = { type: 'background_shell_update', shell: { id: 'sh1' } };
    const deps = makeDeps({
      resolveProjectId: () => 'proj-1',
      findProject: () => makeProject({ id: 'proj-1', visibility: 'shared' }),
      getSessionOwner: () => 'u1',
    });
    expect(shouldDeliverBroadcast(data, stamp, deps)).toBe(false);
  });

  it('leaves other session-scoped event types on project visibility alone', () => {
    const stamp: WsVisibilityStamp = { userId: 'u2', role: 'User' };
    const data = { type: 'done', sessionId: 's1' };
    const deps = makeDeps({
      resolveProjectId: () => 'proj-1',
      findProject: () => makeProject({ id: 'proj-1', visibility: 'shared' }),
      getSessionOwner: vi.fn(() => 'u1'),
    });
    expect(shouldDeliverBroadcast(data, stamp, deps)).toBe(true);
    expect(deps.getSessionOwner).not.toHaveBeenCalled();
  });
});

describe('shouldDeliverSessionScopedBroadcast', () => {
  const owned = { getSessionOwner: () => 'u1' };

  it('delivers to the owner and skips everyone else', () => {
    expect(shouldDeliverSessionScopedBroadcast('s1', { userId: 'u1', role: 'User' }, owned)).toBe(
      true,
    );
    expect(shouldDeliverSessionScopedBroadcast('s1', { userId: 'u2', role: 'User' }, owned)).toBe(
      false,
    );
  });

  it('delivers to the callers `userOwnsSession` itself waves through', () => {
    // No stamp (test harness / pre-visibility connection) and localBypass
    // (no auth configured, x-api-key break-glass, bundled-local) are exactly
    // the branches where `userOwnsSession` returns true unconditionally.
    expect(shouldDeliverSessionScopedBroadcast('s1', undefined, owned)).toBe(true);
    expect(
      shouldDeliverSessionScopedBroadcast(
        's1',
        { userId: null, role: 'Owner', localBypass: true },
        owned,
      ),
    ).toBe(true);
  });

  it('fails closed when ownership cannot be established', () => {
    // Unowned session — no user may read it over REST, so none may over WS.
    expect(
      shouldDeliverSessionScopedBroadcast(
        's1',
        { userId: 'u2', role: 'User' },
        { getSessionOwner: () => null },
      ),
    ).toBe(false);
    // Unattributable payload.
    expect(shouldDeliverSessionScopedBroadcast(null, { userId: 'u2', role: 'User' }, owned)).toBe(
      false,
    );
    // A stamped recipient with no user id cannot match any owner.
    expect(
      shouldDeliverSessionScopedBroadcast(
        's1',
        { userId: null, role: 'User', localBypass: false },
        owned,
      ),
    ).toBe(false);
  });
});
