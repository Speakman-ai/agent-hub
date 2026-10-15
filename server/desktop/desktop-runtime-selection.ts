/**
 * Pick the DesktopRuntime backend for this host.
 *
 * `auto` prefers Firecracker (stronger isolation) when its backend is
 * registered and falls back to the container backend, which works on every
 * deployment. An explicit `firecracker` never degrades: it fails closed with
 * an operator-facing error, matching the isolated session mode rule.
 */
import type { DesktopRuntimeKind, DesktopRuntimeMode } from './desktop-runtime.js';

/** Where the container backend runs its desktops. */
export type DesktopContainerPlacement = 'runner-fleet' | 'hub-docker';

export interface DesktopRuntimeHostState {
  configured: DesktopRuntimeMode;
  firecrackerRegistered: boolean;
  /** Value of FINALIZE_RUNNER_BACKEND; `remote` sends containers to the runner fleet. */
  finalizeRunnerBackend?: string | null;
}

export type DesktopRuntimeSelection =
  | {
      available: true;
      configured: DesktopRuntimeMode;
      kind: DesktopRuntimeKind;
      /** Set only for the container backend. */
      containerPlacement: DesktopContainerPlacement | null;
      reason: string;
    }
  | {
      available: false;
      configured: DesktopRuntimeMode;
      kind: null;
      containerPlacement: null;
      reason: string;
    };

export const FIRECRACKER_DESKTOP_UNAVAILABLE_REASON =
  'desktopRuntime is set to firecracker, but the Firecracker backend is not registered on this host ' +
  '(needs Linux with /dev/kvm, the firecracker binary, and staged guest artifacts). ' +
  'Fix the host or set desktopRuntime to auto or container.';

export class DesktopRuntimeUnavailableError extends Error {
  readonly code = 'desktop_runtime_unavailable';
  constructor(message: string) {
    super(message);
    this.name = 'DesktopRuntimeUnavailableError';
  }
}

function containerPlacement(backend: string | null | undefined): DesktopContainerPlacement {
  return (backend ?? '').trim().toLowerCase() === 'remote' ? 'runner-fleet' : 'hub-docker';
}

function containerWhere(placement: DesktopContainerPlacement): string {
  return placement === 'runner-fleet'
    ? 'on the runner fleet (FINALIZE_RUNNER_BACKEND=remote)'
    : 'in Docker on the Hub host';
}

/** Never throws; the status endpoint reports a fail-closed result as `available: false`. */
export function describeDesktopRuntimeSelection(
  host: DesktopRuntimeHostState,
): DesktopRuntimeSelection {
  const { configured, firecrackerRegistered } = host;

  if (configured === 'firecracker') {
    if (firecrackerRegistered) {
      return {
        available: true,
        configured,
        kind: 'firecracker',
        containerPlacement: null,
        reason: 'desktopRuntime is set to firecracker and the Firecracker backend is registered.',
      };
    }
    return {
      available: false,
      configured,
      kind: null,
      containerPlacement: null,
      reason: FIRECRACKER_DESKTOP_UNAVAILABLE_REASON,
    };
  }

  if (configured === 'auto' && firecrackerRegistered) {
    return {
      available: true,
      configured,
      kind: 'firecracker',
      containerPlacement: null,
      reason:
        'auto: the Firecracker backend is registered on this host, so desktops run in microVMs.',
    };
  }

  const placement = containerPlacement(host.finalizeRunnerBackend);
  const reason =
    configured === 'container'
      ? `desktopRuntime is set to container; desktops run ${containerWhere(placement)}.`
      : `auto: the Firecracker backend is not registered, so desktops run in containers ${containerWhere(placement)}.`;
  return {
    available: true,
    configured,
    kind: 'container',
    containerPlacement: placement,
    reason,
  };
}

/** Resolve the backend to use, throwing when the configured one is unavailable. */
export function selectDesktopRuntime(
  host: DesktopRuntimeHostState,
): Extract<DesktopRuntimeSelection, { available: true }> {
  const selection = describeDesktopRuntimeSelection(host);
  if (!selection.available) throw new DesktopRuntimeUnavailableError(selection.reason);
  return selection;
}
