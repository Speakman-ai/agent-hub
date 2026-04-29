/**
 * Runner transport selector — picks `LocalSpawnTransport` or
 * `RemoteRunnerTransport` based on a project's `runnerId`. Lives apart
 * from `runner-transport.ts` so the transport implementations don't
 * depend on `runners-ws.ts` (and circular-import the dispatcher).
 *
 * Selection rule:
 *   - `project.runnerId` null/absent → `LocalSpawnTransport`
 *   - `project.runnerId` set + runner online → `RemoteRunnerTransport`
 *   - `project.runnerId` set + runner offline → `RemoteRunnerTransport`
 *     anyway; the call to `.spawn()` will reject with `RUNNER_OFFLINE`
 *     so the caller can surface the toast-then-block UX without having
 *     to second-guess the connection state at selection time.
 */

import {
  LocalSpawnTransport,
  RemoteRunnerTransport,
  type RunnerTransport,
} from './runner-transport.js';
import { getRunnerSender, subscribeToRunner, subscribeToRunnerDisconnect } from './runners-ws.js';
import type { Project } from './types.js';

let cachedLocal: LocalSpawnTransport | null = null;

/**
 * Resolve the transport for a given project. Local instance is cached
 * because it has no per-project state — keeps allocation off the hot
 * path.
 */
export function getRunnerTransport(project: Pick<Project, 'runnerId'>): RunnerTransport {
  if (project.runnerId) {
    return new RemoteRunnerTransport(project.runnerId, {
      getSender: getRunnerSender,
      subscribe: subscribeToRunner,
      subscribeDisconnect: subscribeToRunnerDisconnect,
    });
  }
  if (!cachedLocal) cachedLocal = new LocalSpawnTransport();
  return cachedLocal;
}

/**
 * Test-only hook to clear the cached `LocalSpawnTransport`. Useful when
 * a test wants to assert allocation behaviour or swap the spawn impl.
 */
export function _resetRunnerTransportCacheForTests(): void {
  cachedLocal = null;
}
