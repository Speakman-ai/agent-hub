/**
 * Pure decision for what a WebSocket ping-interval tick should do, given the
 * socket's open-ness and whether the previous ping is still unanswered.
 * Extracted from `useWebSocket` so the half-open-detection state machine is
 * unit-testable without a live socket.
 *
 *  - not open          → 'noop'  (socket is closing/closed; nothing to do)
 *  - open, awaiting     → 'close' (prior ping never answered → link is dead;
 *                                  force a close so onclose → reconnect runs)
 *  - open, not awaiting → 'ping'  (send a fresh keepalive, now awaiting a pong)
 */
export type PingTickAction = 'noop' | 'close' | 'ping';

export function pingTickAction(readyStateOpen: boolean, awaitingPong: boolean): PingTickAction {
  if (!readyStateOpen) return 'noop';
  if (awaitingPong) return 'close';
  return 'ping';
}
