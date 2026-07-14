/**
 * SessionEnv backend registry + strict resolution.
 *
 * Layering (config key `sessionEnvAdapter`, env
 * `AGENT_HUB_SESSION_ENV_ADAPTER`, values `auto` | `host` | `sysbox`):
 *
 *   - `sysbox-capability.ts` owns the boot-time capability probe
 *     (`probeSysboxCapability`), config coercion
 *     (`coerceSessionEnvAdapterMode`), and the *availability policy* —
 *     a forced `sysbox` that fails the probe degrades to host with a
 *     loud warning so the Hub never boots a runtime that cannot spawn.
 *   - This module owns the adapter registry, construction
 *     (`createSessionEnv`), and the **pure, strict** resolver below:
 *     explicit `sysbox` + unavailable/unregistered **throws** — an
 *     explicitly requested isolation boundary never silently degrades
 *     here; catching and degrading is the boot layer's decision.
 *
 * The registry decouples selection from adapter availability: both the
 * host and sysbox adapters register here; the capability probe decides
 * whether `auto` may actually pick sysbox on this host.
 */

import { SessionEnv, SessionEnvBackendChoice, SessionEnvKind } from './session-env.js';
import { HostSessionEnv, HostSessionEnvDeps } from './host-session-env.js';
import { SysboxSessionEnv, SysboxSessionEnvDeps } from './sysbox-session-env.js';

export function resolveSessionEnvBackend(opts: {
  configured: SessionEnvBackendChoice;
  /** Typically `probeSysboxCapability().available` (sysbox-capability.ts). */
  sysboxAvailable: boolean;
  /** Backends with a registered adapter. Defaults to the live registry. */
  registeredBackends?: ReadonlySet<SessionEnvKind>;
}): SessionEnvKind {
  const registered = opts.registeredBackends ?? registeredSessionEnvBackends();
  const sysboxUsable = opts.sysboxAvailable && registered.has('sysbox');
  if (opts.configured === 'host') return 'host';
  if (opts.configured === 'sysbox') {
    if (!opts.sysboxAvailable) {
      throw new Error(
        'sessionEnvAdapter is set to "sysbox" but sysbox-runc is not available on this host ' +
          '(needs Linux with the sysbox-runc docker runtime installed). ' +
          'Install sysbox or set sessionEnvAdapter to "host"/"auto".',
      );
    }
    if (!registered.has('sysbox')) {
      throw new Error(
        'sessionEnvAdapter is set to "sysbox" but no sysbox adapter is registered in this build.',
      );
    }
    return 'sysbox';
  }
  return sysboxUsable ? 'sysbox' : 'host';
}

export interface CreateSessionEnvOpts {
  sessionId: string;
  worktreePath: string;
  /** Adapter-specific dependency overrides (tests, custom allocators). */
  hostDeps?: Omit<HostSessionEnvDeps, 'sessionId' | 'worktreePath'>;
  sysboxDeps?: Omit<SysboxSessionEnvDeps, 'sessionId' | 'worktreePath'>;
}

export type SessionEnvFactory = (opts: CreateSessionEnvOpts) => SessionEnv;

const backendRegistry = new Map<SessionEnvKind, SessionEnvFactory>([
  [
    'host',
    (opts) =>
      new HostSessionEnv({
        sessionId: opts.sessionId,
        worktreePath: opts.worktreePath,
        ...opts.hostDeps,
      }),
  ],
  [
    'sysbox',
    (opts) =>
      new SysboxSessionEnv({
        sessionId: opts.sessionId,
        worktreePath: opts.worktreePath,
        ...opts.sysboxDeps,
      }),
  ],
]);

/** Register (or replace) an adapter. */
export function registerSessionEnvBackend(kind: SessionEnvKind, factory: SessionEnvFactory): void {
  backendRegistry.set(kind, factory);
}

/** Remove a registered adapter. The host adapter cannot be removed. */
export function unregisterSessionEnvBackend(kind: Exclude<SessionEnvKind, 'host'>): void {
  backendRegistry.delete(kind);
}

export function registeredSessionEnvBackends(): ReadonlySet<SessionEnvKind> {
  return new Set(backendRegistry.keys());
}

export function createSessionEnv(kind: SessionEnvKind, opts: CreateSessionEnvOpts): SessionEnv {
  const factory = backendRegistry.get(kind);
  if (!factory) {
    throw new Error(`No SessionEnv adapter registered for backend "${kind}"`);
  }
  return factory(opts);
}
