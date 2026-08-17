import type { SessionEnvKind } from '../session-env.js';

let firecrackerBackendRegistered = false;

/** Keep the lightweight UI/route capability signal in sync with the registry. */
export function setFirecrackerBackendRegistered(registered: boolean): void {
  firecrackerBackendRegistered = registered;
}

/**
 * Whether Firecracker is ready to accept sessions on this host.
 *
 * The optional set keeps adapter-resolution tests pure. Production callers use
 * the status toggled by registerFirecrackerBackend / unregisterFirecrackerBackend.
 */
export function isFirecrackerBackendRegistered(registered?: ReadonlySet<SessionEnvKind>): boolean {
  return registered ? registered.has('firecracker') : firecrackerBackendRegistered;
}
