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
