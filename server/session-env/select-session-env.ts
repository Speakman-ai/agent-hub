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
  /**
   * Typically `probeFirecrackerCapability().available`. Requires `/dev/kvm`,
   * the VMM binary, and staged guest artifacts — see
   * `firecracker/firecracker-capability.ts`.
   */
  firecrackerAvailable?: boolean;
  /** Whether a usable docker daemon was found (`container` backend). */
  dockerAvailable?: boolean;
  /**
   * Whether the Hub can dial container IPs (`container-ip` routing). When it
   * cannot, a container env has to publish ports, which reintroduces the
   * shared host pool and the declare-ports-before-start rule that the
   * container backend exists to remove — so `auto` declines it. An explicit
   * `container` still honors the request.
   */
  containerRoutingUsable?: boolean;
  /** Backends with a registered adapter. Defaults to the live registry. */
  registeredBackends?: ReadonlySet<SessionEnvKind>;
}): SessionEnvKind {
  const registered = opts.registeredBackends ?? registeredSessionEnvBackends();
  const sysboxUsable = opts.sysboxAvailable && registered.has('sysbox');
  const firecrackerUsable = opts.firecrackerAvailable === true && registered.has('firecracker');
  const containerUsable =
    opts.dockerAvailable === true &&
    opts.containerRoutingUsable === true &&
    registered.has('container');
  if (opts.configured === 'host') return 'host';
  if (opts.configured === 'firecracker') {
    if (opts.firecrackerAvailable !== true) {
      throw new Error(
        'sessionEnvAdapter is set to "firecracker" but this host cannot run microVMs ' +
          '(needs /dev/kvm, the firecracker binary, and staged guest artifacts). ' +
          'Enable nested virtualization on the instance or set sessionEnvAdapter to "auto".',
      );
    }
    if (!registered.has('firecracker')) {
      throw new Error(
        'sessionEnvAdapter is set to "firecracker" but no firecracker adapter is registered in this build.',
      );
    }
    return 'firecracker';
  }
  if (opts.configured === 'container') {
    if (opts.dockerAvailable !== true) {
      throw new Error(
        'sessionEnvAdapter is set to "container" but no usable docker daemon was found. ' +
          'Start docker or set sessionEnvAdapter to "host"/"auto".',
      );
    }
    if (!registered.has('container')) {
      throw new Error(
        'sessionEnvAdapter is set to "container" but no container adapter is registered in this build.',
      );
    }
    return 'container';
  }
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
  // `auto`, in descending order of isolation strength. A microVM leads
  // because it is the only tier where the session gets its own kernel rather
  // than a namespaced view of the host's. Falling to `host` means sessions
  // share the Hub machine, so it is the last resort rather than the default
  // it used to be on any box without sysbox.
  if (firecrackerUsable) return 'firecracker';
  if (sysboxUsable) return 'sysbox';
  if (containerUsable) return 'container';
  return 'host';
}

export interface CreateSessionEnvOpts {
  sessionId: string;
  worktreePath: string;
  /** Adapter-specific dependency overrides (tests, custom allocators). */
  hostDeps?: Omit<HostSessionEnvDeps, 'sessionId' | 'worktreePath'>;
  sysboxDeps?: Omit<SysboxSessionEnvDeps, 'sessionId' | 'worktreePath'>;
  /**
   * Layered over the defaults bound at registration time. The microVM backend
   * needs host-wide resources (a slot pool, staged guest artifacts) that no
   * per-session caller can supply, so unlike the other adapters it is
   * registered with its dependencies already attached — see
   * `firecracker/register-firecracker-backend.ts`.
   */
  firecrackerDeps?: Record<string, unknown>;
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
        isolation: 'sysbox-runc',
        ...opts.sysboxDeps,
      }),
  ],
  [
    'container',
    (opts) =>
      new SysboxSessionEnv({
        sessionId: opts.sessionId,
        worktreePath: opts.worktreePath,
        isolation: 'privileged',
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
