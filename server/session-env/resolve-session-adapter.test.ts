import { describe, expect, it } from 'vitest';
import type { Project } from '../types.js';
import {
  isFirecrackerBackendRegistered,
  resolveSessionEnvAdapterForSession,
} from './resolve-session-adapter.js';
import type { SessionEnvKind } from './session-env.js';

function project(mode?: string): Project {
  return {
    id: 'p1',
    name: 'p1',
    cwd: '/tmp/p1',
    mode: mode as Project['mode'],
  } as Project;
}

function registered(...kinds: SessionEnvKind[]): ReadonlySet<SessionEnvKind> {
  return new Set(kinds);
}

describe('isFirecrackerBackendRegistered', () => {
  it('is true only when firecracker is in the set', () => {
    expect(isFirecrackerBackendRegistered(registered('host', 'firecracker'))).toBe(true);
    expect(isFirecrackerBackendRegistered(registered('host'))).toBe(false);
  });
});

describe('resolveSessionEnvAdapterForSession', () => {
  it('forces host for workflow projects even when isolated + FC registered', () => {
    expect(
      resolveSessionEnvAdapterForSession({
        project: project('workflow'),
        session: { session_mode: 'isolated' },
        globalAdapter: 'firecracker',
        registeredBackends: registered('host', 'firecracker'),
      }),
    ).toBe('host');
  });

  it('forces firecracker for isolated when FC is registered (global host)', () => {
    expect(
      resolveSessionEnvAdapterForSession({
        project: project('dev'),
        session: { session_mode: 'isolated' },
        globalAdapter: 'host',
        registeredBackends: registered('host', 'firecracker'),
      }),
    ).toBe('firecracker');
  });

  it('fails closed on firecracker for isolated when FC is not registered (global host)', () => {
    // A persisted isolated row must not silently resume on host when the
    // firecracker backend was unregistered at boot (NAT/bridge failure). It
    // resolves to firecracker so createSessionEnv fails closed at launch.
    expect(
      resolveSessionEnvAdapterForSession({
        project: project('dev'),
        session: { session_mode: 'isolated' },
        globalAdapter: 'host',
        registeredBackends: registered('host'),
      }),
    ).toBe('firecracker');
  });

  it('fails closed on firecracker for isolated + global firecracker + FC unregistered', () => {
    // The stale-global-pin host fallback must not apply to isolated sessions:
    // even with the global adapter still pinned to firecracker and the backend
    // absent, an isolated session keeps its requested VM boundary and fails
    // closed rather than downgrading to host.
    expect(
      resolveSessionEnvAdapterForSession({
        project: project('dev'),
        session: { session_mode: 'isolated' },
        globalAdapter: 'firecracker',
        registeredBackends: registered('host'),
      }),
    ).toBe('firecracker');
  });

  it('uses the global adapter for chat / non-isolated modes', () => {
    expect(
      resolveSessionEnvAdapterForSession({
        project: project('dev'),
        session: { session_mode: 'chat' },
        globalAdapter: 'host',
        registeredBackends: registered('host', 'firecracker'),
      }),
    ).toBe('host');
    expect(
      resolveSessionEnvAdapterForSession({
        project: project('dev'),
        session: { session_mode: 'design' },
        globalAdapter: 'sysbox',
        registeredBackends: registered('host', 'sysbox', 'firecracker'),
      }),
    ).toBe('sysbox');
  });

  it('does not boot a VM for chat when the global adapter is firecracker', () => {
    expect(
      resolveSessionEnvAdapterForSession({
        project: project('dev'),
        session: { session_mode: 'chat' },
        globalAdapter: 'firecracker',
        registeredBackends: registered('host', 'firecracker'),
      }),
    ).toBe('host');
    expect(
      resolveSessionEnvAdapterForSession({
        project: project('dev'),
        session: { session_mode: 'design' },
        globalAdapter: 'firecracker',
        registeredBackends: registered('host', 'firecracker'),
      }),
    ).toBe('host');
  });
});
