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

  it('falls back to global when isolated but FC is not registered', () => {
    expect(
      resolveSessionEnvAdapterForSession({
        project: project('dev'),
        session: { session_mode: 'isolated' },
        globalAdapter: 'host',
        registeredBackends: registered('host'),
      }),
    ).toBe('host');
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
        globalAdapter: 'firecracker',
        registeredBackends: registered('host', 'firecracker'),
      }),
    ).toBe('firecracker');
  });
});
