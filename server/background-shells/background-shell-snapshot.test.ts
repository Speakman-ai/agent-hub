import { describe, it, expect } from 'vitest';
import { buildBackgroundShellSnapshot } from './background-shell-snapshot.js';
import type { BackgroundShellRow } from './background-shell-runtime.js';
import type { BroadcastFilterDeps } from '../broadcast-filter.js';
import type { WsVisibilityStamp } from '../session-ownership.js';
import type { Project } from '../types.js';

function row(overrides: Partial<BackgroundShellRow> = {}): BackgroundShellRow {
  return {
    id: 'sh-1',
    session_id: 'sess-a',
    project_id: 'proj-1',
    command: 'npm run deploy -- --token hunter2',
    label: null,
    cwd: '/home/alice/secret-worktree',
    pid: 4242,
    status: 'running',
    exit_code: null,
    log_path: '/var/log/agent-hub/sh-1.log',
    watch: 1,
    watch_resolved_at: null,
    pid_start_time: null,
    timeout_ms: 1_800_000,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function sharedProject(): Project {
  return {
    id: 'proj-1',
    name: 'proj-1',
    cwd: '/tmp/proj-1',
    ahw: '/tmp/proj-1-ahw',
    agents: [],
    visibility: 'shared',
  };
}

function makeDeps(owners: Record<string, string | null>): BroadcastFilterDeps {
  return {
    resolveProjectId: () => 'proj-1',
    findProject: () => sharedProject(),
    getSessionOwner: (sessionId) => owners[sessionId] ?? null,
  };
}

describe('buildBackgroundShellSnapshot', () => {
  it('sends a user only their own sessions on a shared project', () => {
    // The regression: project visibility alone let every org member replay
    // another user's shell rows — command line, cwd, pid, and log path
    // included — even though the REST routes require `userOwnsSession`.
    const runtime = {
      listRunning: () => [
        row({ id: 'mine', session_id: 'sess-a' }),
        row({ id: 'theirs', session_id: 'sess-b' }),
      ],
    };
    const stamp: WsVisibilityStamp = { userId: 'alice', role: 'User' };

    const snapshot = buildBackgroundShellSnapshot(
      runtime,
      stamp,
      makeDeps({ 'sess-a': 'alice', 'sess-b': 'bob' }),
    );

    expect(snapshot.type).toBe('background-shells-snapshot');
    expect(snapshot.sessions.map((s) => s.sessionId)).toEqual(['sess-a']);
    expect(snapshot.sessions[0].shells.map((s) => s.id)).toEqual(['mine']);
  });

  it('gives an org Owner no window into another user session', () => {
    const runtime = { listRunning: () => [row({ session_id: 'sess-b' })] };
    const stamp: WsVisibilityStamp = { userId: 'admin', role: 'Owner' };

    const snapshot = buildBackgroundShellSnapshot(runtime, stamp, makeDeps({ 'sess-b': 'bob' }));

    expect(snapshot.sessions).toEqual([]);
  });

  it('still honours project visibility for a session the caller owns', () => {
    const runtime = { listRunning: () => [row({ session_id: 'sess-a' })] };
    const stamp: WsVisibilityStamp = { userId: 'alice', role: 'User' };

    const snapshot = buildBackgroundShellSnapshot(runtime, stamp, {
      resolveProjectId: () => 'proj-priv',
      findProject: () => ({ ...sharedProject(), id: 'proj-priv' }) as Project,
      getSessionOwner: () => 'alice',
    });
    expect(snapshot.sessions.map((s) => s.sessionId)).toEqual(['sess-a']);

    const hidden = buildBackgroundShellSnapshot(runtime, stamp, {
      resolveProjectId: () => 'proj-priv',
      findProject: () =>
        ({
          ...sharedProject(),
          id: 'proj-priv',
          visibility: 'private',
          ownerUserId: 'bob',
        }) as Project,
      getSessionOwner: () => 'alice',
    });
    expect(hidden.sessions).toEqual([]);
  });

  it('keeps the full fan-out for unstamped and localBypass recipients', () => {
    const runtime = {
      listRunning: () => [row({ session_id: 'sess-a' }), row({ id: 'x', session_id: 'sess-b' })],
    };
    const deps = makeDeps({ 'sess-a': 'alice', 'sess-b': 'bob' });

    expect(buildBackgroundShellSnapshot(runtime, undefined, deps).sessions).toHaveLength(2);
    expect(
      buildBackgroundShellSnapshot(
        runtime,
        { userId: null, role: 'Owner', localBypass: true },
        deps,
      ).sessions,
    ).toHaveLength(2);
  });

  it('withholds unowned sessions from every stamped user', () => {
    // A cron / heartbeat spawn whose owner could not be resolved belongs to
    // nobody. `userOwnsSession` grants NULL-owner rows to no one, so the REST
    // shell list already 404s for these — the snapshot must not be the one
    // place the command line, cwd, pid, and log path escape to the whole org.
    const runtime = {
      listRunning: () => [row({ session_id: 'sess-a' }), row({ id: 'x', session_id: 'sess-cron' })],
    };
    const deps = makeDeps({ 'sess-a': 'alice', 'sess-cron': null });

    expect(
      buildBackgroundShellSnapshot(runtime, { userId: 'alice', role: 'User' }, deps).sessions.map(
        (s) => s.sessionId,
      ),
    ).toEqual(['sess-a']);
    expect(
      buildBackgroundShellSnapshot(runtime, { userId: 'bob', role: 'User' }, deps).sessions,
    ).toEqual([]);
    expect(
      buildBackgroundShellSnapshot(runtime, { userId: 'admin', role: 'Owner' }, deps).sessions,
    ).toEqual([]);
  });

  it('groups every running shell of a session together', () => {
    const runtime = {
      listRunning: () => [
        row({ id: 'a1', session_id: 'sess-a' }),
        row({ id: 'a2', session_id: 'sess-a' }),
      ],
    };
    const snapshot = buildBackgroundShellSnapshot(
      runtime,
      { userId: 'alice', role: 'User' },
      makeDeps({ 'sess-a': 'alice' }),
    );
    expect(snapshot.sessions).toHaveLength(1);
    expect(snapshot.sessions[0].shells.map((s) => s.id)).toEqual(['a1', 'a2']);
  });
});
