/**
 * Builder for the `session-event` WebSocket envelope.
 *
 * Kept as a pure function (and out of the 5k-line `chat.ts`) so the envelope
 * shape is testable without spawning a turn.
 *
 * The `timestamp` is the point of this module. Persisted rows get a wall clock
 * from SQLite's `datetime('now')` default and `GET /api/messages/:id/events`
 * reads it back, but the live broadcast used to carry none. Clients that need
 * to resolve a *relative* tool argument into an absolute time — ScheduleWakeup's
 * `delaySeconds` — had nothing to anchor on during a live turn, and would have
 * had to substitute their own receive time, which drifts and silently re-anchors
 * on every reload.
 */

export interface SessionEventBroadcast<TEvent> {
  type: 'session-event';
  sessionId: string;
  messageId: string;
  seq: number;
  event: TEvent;
  /** ISO-8601 UTC. Replay returns SQLite `datetime('now')`; both parse client-side. */
  timestamp: string;
  /** `broadcast()` takes a `Record<string, unknown>`; this keeps it assignable. */
  [key: string]: unknown;
}

export function buildSessionEventBroadcast<TEvent>(args: {
  sessionId: string;
  messageId: string;
  seq: number;
  event: TEvent;
  /** Injectable for tests; defaults to now. */
  now?: Date;
}): SessionEventBroadcast<TEvent> {
  return {
    type: 'session-event',
    sessionId: args.sessionId,
    messageId: args.messageId,
    seq: args.seq,
    event: args.event,
    timestamp: (args.now ?? new Date()).toISOString(),
  };
}
