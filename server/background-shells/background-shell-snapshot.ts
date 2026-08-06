/**
 * Connect-time background-shell snapshot for the WebSocket handshake.
 *
 * The live `background_shell_update` events that would have told a client
 * about its running shells fired while its socket was down, and a shell can
 * run for hours — long enough for a laptop suspend to lose every one of them.
 * So a reconnecting client gets one replace-the-world payload instead, which
 * also lets it *clear* sessions whose shells finished while it was away.
 *
 * Split out of `websocket.ts` for the same reason `preview-snapshot.ts` and
 * `finalize-snapshot.ts` are: the interesting part is the per-recipient
 * filtering, and it has to be testable without standing up a socket.
 *
 * Two gates, both required. Project visibility keeps a user off projects they
 * can't see; session ownership keeps them off other users' sessions on a
 * project they *can* see. The second one is not optional here — the rows carry
 * the command line, cwd, pid, and log path of whatever an agent parked in
 * someone's session, and the REST surface gates all of it on `userOwnsSession`.
 */

import {
  shouldDeliverBroadcast,
  shouldDeliverSessionScopedBroadcast,
  type BroadcastFilterDeps,
} from '../broadcast-filter.js';
import type { WsVisibilityStamp } from '../session-ownership.js';
import type { BackgroundShellRow } from './background-shell-runtime.js';

export interface BackgroundShellSnapshotRuntime {
  listRunning: () => BackgroundShellRow[];
}

export interface BackgroundShellSnapshotSession {
  sessionId: string;
  shells: BackgroundShellRow[];
}

export interface BackgroundShellSnapshotEvent {
  type: 'background-shells-snapshot';
  sessions: BackgroundShellSnapshotSession[];
}

/**
 * Build the snapshot one recipient should receive. Returns an event with an
 * empty `sessions` array when nothing is visible — the client still needs it
 * to clear stale state.
 */
export function buildBackgroundShellSnapshot(
  runtime: BackgroundShellSnapshotRuntime,
  stamp: WsVisibilityStamp | undefined,
  deps: BroadcastFilterDeps,
): BackgroundShellSnapshotEvent {
  const bySession = new Map<string, BackgroundShellRow[]>();
  for (const shell of runtime.listRunning()) {
    const existing = bySession.get(shell.session_id);
    if (existing) existing.push(shell);
    else bySession.set(shell.session_id, [shell]);
  }
  const sessions = [...bySession.entries()]
    .filter(
      ([sessionId]) =>
        shouldDeliverBroadcast({ sessionId }, stamp, deps) &&
        shouldDeliverSessionScopedBroadcast(sessionId, stamp, deps),
    )
    .map(([sessionId, shells]) => ({ sessionId, shells }));
  return { type: 'background-shells-snapshot', sessions };
}
