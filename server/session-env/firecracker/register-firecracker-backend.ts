/**
 * Registers the microVM backend with the SessionEnv registry.
 *
 * Unlike the host and container adapters, this one is registered
 * *conditionally* — only after the capability probe confirms the host can
 * boot a VM and the boot sweep has prepared the bridge. That makes
 * `registeredBackends.has('firecracker')` mean "a VM would actually start
 * here", so `auto` can prefer it without a second availability check, and an
 * explicit `sessionEnvAdapter: firecracker` on an incapable host fails loudly
 * at boot instead of on a user's first preview.
 *
 * The per-session caller only knows a session id and a worktree; the slot
 * pool and the staged guest artifacts are host-wide, so they are bound here.
 */

import { registerSessionEnvBackend, unregisterSessionEnvBackend } from '../select-session-env.js';
import {
  FirecrackerSessionEnv,
  type FirecrackerSessionEnvDeps,
  type FirecrackerPaths,
  type FirecrackerSlotPool,
} from './firecracker-session-env.js';
import { InMemorySlotPool } from './firecracker-slots.js';

export type FirecrackerBackendDefaults = Omit<
  FirecrackerSessionEnvDeps,
  'sessionId' | 'worktreePath' | 'slots' | 'paths'
> & {
  paths: FirecrackerPaths;
  /** Defaults to a fresh in-memory pool covering the whole slot range. */
  slots?: FirecrackerSlotPool;
};

export function registerFirecrackerBackend(defaults: FirecrackerBackendDefaults): void {
  const slots = defaults.slots ?? new InMemorySlotPool();
  registerSessionEnvBackend(
    'firecracker',
    (opts) =>
      new FirecrackerSessionEnv({
        ...defaults,
        slots,
        sessionId: opts.sessionId,
        worktreePath: opts.worktreePath,
        ...(opts.firecrackerDeps as Partial<FirecrackerSessionEnvDeps> | undefined),
      }),
  );
}

/** Test-only: drop the backend so `auto` stops considering it. */
export function unregisterFirecrackerBackend(): void {
  unregisterSessionEnvBackend('firecracker');
}
