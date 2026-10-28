/**
 * Killable handle for an in-flight chat CLI turn.
 *
 * Host turns wrap a `ChildProcess` (process-group kill). Guest / SessionEnv
 * turns wrap a {@link SessionEnvProcess}-shaped kill. Cancel and interrupt
 * paths only need {@link ActiveChatProcess.kill}.
 */

import type { ChildProcess } from 'child_process';
import { killProcessGroup } from './process-groups.js';

export interface ActiveChatProcess {
  readonly kind: 'host' | 'guest';
  kill(signal?: NodeJS.Signals): void;
  /** Host child only — used for `trackChild` / process-group bookkeeping. */
  readonly hostChild?: ChildProcess;
}

export function wrapHostChildProcess(proc: ChildProcess): ActiveChatProcess {
  return {
    kind: 'host',
    hostChild: proc,
    kill(signal: NodeJS.Signals = 'SIGTERM') {
      killProcessGroup(proc, signal);
    },
  };
}

export function wrapGuestChatProcess(kill: (signal?: NodeJS.Signals) => void): ActiveChatProcess {
  return {
    kind: 'guest',
    kill(signal: NodeJS.Signals = 'SIGTERM') {
      kill(signal);
    },
  };
}

/**
 * Register `handle` as the session's active process only when the slot is
 * free. A side process (the in-session Finalize reviewer) must not displace a
 * chat turn that is still running: the turn's close handler treats a
 * displaced handle as superseded and skips its cleanup, which strands its
 * `active_tasks` row and leaves the session reading as `working` forever.
 */
export function claimSessionProcessSlot(
  map: Map<string, ActiveChatProcess>,
  sessionId: string,
  handle: ActiveChatProcess,
): boolean {
  if (map.has(sessionId)) return false;
  map.set(sessionId, handle);
  return true;
}

/** Remove the session's entry only if it is still `handle`. */
export function releaseSessionProcessSlot(
  map: Map<string, ActiveChatProcess>,
  sessionId: string,
  handle: ActiveChatProcess,
): void {
  if (map.get(sessionId) === handle) map.delete(sessionId);
}
