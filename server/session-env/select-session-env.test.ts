import { afterEach, describe, expect, it } from 'vitest';
import { HostSessionEnv } from './host-session-env.js';
import {
  createSessionEnv,
  registerSessionEnvBackend,
  registeredSessionEnvBackends,
  resolveSessionEnvBackend,
  unregisterSessionEnvBackend,
} from './select-session-env.js';
import { SessionEnv, type SessionEnvKind } from './session-env.js';
import { SysboxSessionEnv } from './sysbox-session-env.js';

// Config coercion (`coerceSessionEnvAdapterMode`) and the capability probe
// live in sysbox-capability.ts and are tested in sysbox-capability.test.ts.

afterEach(() => {
  // Tests may remove or replace the process-global registry entry. Restore
  // the production built-in so cases never depend on file execution order.
  registerSessionEnvBackend(
    'sysbox',
    (opts) =>
      new SysboxSessionEnv({
        sessionId: opts.sessionId,
        worktreePath: opts.worktreePath,
        ...opts.sysboxDeps,
      }),
  );
});

describe('resolveSessionEnvBackend', () => {
  const registered = (kinds: Array<'host' | 'sysbox'>) =>
    new Set(kinds) as ReadonlySet<'host' | 'sysbox'>;

  it('explicit host always resolves to host', () => {
    expect(
      resolveSessionEnvBackend({
        configured: 'host',
        sysboxAvailable: true,
        registeredBackends: registered(['host', 'sysbox']),
      }),
    ).toBe('host');
  });

  it('explicit sysbox throws when sysbox-runc is absent (no silent degrade)', () => {
    expect(() =>
      resolveSessionEnvBackend({
        configured: 'sysbox',
        sysboxAvailable: false,
        registeredBackends: registered(['host', 'sysbox']),
      }),
    ).toThrow(/sessionEnvAdapter is set to "sysbox" but sysbox-runc is not available/);
  });

  it('explicit sysbox throws when no adapter is registered', () => {
    expect(() =>
      resolveSessionEnvBackend({
        configured: 'sysbox',
        sysboxAvailable: true,
        registeredBackends: registered(['host']),
      }),
    ).toThrow(/sessionEnvAdapter is set to "sysbox" but no sysbox adapter is registered/);
  });

  it('explicit sysbox resolves when available and registered', () => {
    expect(
      resolveSessionEnvBackend({
        configured: 'sysbox',
        sysboxAvailable: true,
        registeredBackends: registered(['host', 'sysbox']),
      }),
    ).toBe('sysbox');
  });

  it('auto prefers sysbox when available + registered, else host', () => {
    expect(
      resolveSessionEnvBackend({
        configured: 'auto',
        sysboxAvailable: true,
        registeredBackends: registered(['host', 'sysbox']),
      }),
    ).toBe('sysbox');
    expect(
      resolveSessionEnvBackend({
        configured: 'auto',
        sysboxAvailable: true,
        registeredBackends: registered(['host']),
      }),
    ).toBe('host');
    expect(
      resolveSessionEnvBackend({
        configured: 'auto',
        sysboxAvailable: false,
        registeredBackends: registered(['host', 'sysbox']),
      }),
    ).toBe('host');
  });

  it('defaults registeredBackends to the live registry (host + sysbox)', () => {
    expect(resolveSessionEnvBackend({ configured: 'auto', sysboxAvailable: true })).toBe('sysbox');
  });

  const withFirecracker = (kinds: SessionEnvKind[]): ReadonlySet<SessionEnvKind> => new Set(kinds);

  it('auto prefers a microVM over every container tier', () => {
    // Ordering is the whole point: a microVM is the only tier where the
    // session gets its own kernel instead of a namespaced view of the host's.
    expect(
      resolveSessionEnvBackend({
        configured: 'auto',
        sysboxAvailable: true,
        dockerAvailable: true,
        containerRoutingUsable: true,
        firecrackerAvailable: true,
        registeredBackends: withFirecracker(['host', 'sysbox', 'container', 'firecracker']),
      }),
    ).toBe('firecracker');
  });

  it('auto falls through to sysbox when the host cannot boot VMs', () => {
    expect(
      resolveSessionEnvBackend({
        configured: 'auto',
        sysboxAvailable: true,
        firecrackerAvailable: false,
        registeredBackends: withFirecracker(['host', 'sysbox', 'firecracker']),
      }),
    ).toBe('sysbox');
  });

  it('auto ignores firecracker when the adapter is not registered', () => {
    // Registration is conditional on the capability probe, so an unregistered
    // backend means a VM would not actually start here.
    expect(
      resolveSessionEnvBackend({
        configured: 'auto',
        sysboxAvailable: true,
        firecrackerAvailable: true,
        registeredBackends: withFirecracker(['host', 'sysbox']),
      }),
    ).toBe('sysbox');
  });

  it('explicit firecracker throws rather than silently degrading', () => {
    expect(() =>
      resolveSessionEnvBackend({
        configured: 'firecracker',
        sysboxAvailable: true,
        firecrackerAvailable: false,
        registeredBackends: withFirecracker(['host', 'sysbox', 'firecracker']),
      }),
    ).toThrow(/cannot run microVMs/);

    expect(() =>
      resolveSessionEnvBackend({
        configured: 'firecracker',
        sysboxAvailable: true,
        firecrackerAvailable: true,
        registeredBackends: withFirecracker(['host', 'sysbox']),
      }),
    ).toThrow(/no firecracker adapter is registered/);
  });

  it('explicit firecracker resolves when available and registered', () => {
    expect(
      resolveSessionEnvBackend({
        configured: 'firecracker',
        sysboxAvailable: false,
        firecrackerAvailable: true,
        registeredBackends: withFirecracker(['host', 'firecracker']),
      }),
    ).toBe('firecracker');
  });
});

describe('backend registry / createSessionEnv', () => {
  it('creates a host env with the built-in adapter', () => {
    const env = createSessionEnv('host', {
      sessionId: 'sess-42',
      worktreePath: '/wt/sess-42',
      hostDeps: { isDirectory: async () => true, baseEnv: {} },
    });
    expect(env).toBeInstanceOf(HostSessionEnv);
    expect(env.kind).toBe('host');
    expect(env.sessionId).toBe('sess-42');
  });

  it('creates a sysbox env with the built-in adapter', () => {
    const env = createSessionEnv('sysbox', {
      sessionId: 'sess-43',
      worktreePath: '/wt/sess-43',
      sysboxDeps: { isDirectory: async () => true, baseEnv: {} },
    });
    expect(env).toBeInstanceOf(SysboxSessionEnv);
    expect(env.kind).toBe('sysbox');
    expect(env.sessionId).toBe('sess-43');
  });

  it('throws for a backend with no registered adapter', () => {
    unregisterSessionEnvBackend('sysbox');
    expect(() => createSessionEnv('sysbox', { sessionId: 's', worktreePath: '/wt' })).toThrow(
      /No SessionEnv adapter registered/,
    );
  });

  it('registered backends feed resolution: auto flips to sysbox once an adapter registers', () => {
    unregisterSessionEnvBackend('sysbox');
    expect(registeredSessionEnvBackends().has('sysbox')).toBe(false);
    const fake = { kind: 'sysbox', sessionId: 's' } as unknown as SessionEnv;
    registerSessionEnvBackend('sysbox', () => fake);
    expect(registeredSessionEnvBackends().has('sysbox')).toBe(true);
    expect(resolveSessionEnvBackend({ configured: 'auto', sysboxAvailable: true })).toBe('sysbox');
    expect(createSessionEnv('sysbox', { sessionId: 's', worktreePath: '/wt' })).toBe(fake);
  });
});
