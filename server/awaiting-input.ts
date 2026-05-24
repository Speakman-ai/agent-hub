import type { ActiveTaskRow, BroadcastFn, MessageRow, SessionRow, Stmts } from './types.js';
import { findUnansweredAskIds } from '../shared/utils/awaitingInput.js';

export interface AwaitingInputItem {
  sessionId: string;
  agentId: string;
  sessionName: string;
  askIds: string[];
}

/**
 * Compute whether a single session is currently awaiting user input. Returns
 * the unanswered askIds + the session/agent context, or `null` if the session
 * is either actively running (working takes precedence) or has no unanswered
 * pickers.
 *
 * Bounded: at most one `SELECT * FROM messages WHERE session_id = ?` per call.
 * Safe to invoke from the hot `done`-broadcast path.
 */
export function getSessionAwaitingInputState(
  sessionId: string,
  stmts: Stmts,
): AwaitingInputItem | null {
  // A session can't simultaneously be "working" and "waiting on user." If the
  // CLI is in flight the running indicator is the truthful signal — defer the
  // awaiting-input check until the run finishes.
  const activeTask = stmts.getActiveTask.get(sessionId) as ActiveTaskRow | undefined;
  if (activeTask) return null;

  const session = stmts.getSession.get(sessionId) as SessionRow | undefined;
  if (!session) return null;

  const messages = stmts.getMessages.all(sessionId) as MessageRow[];
  const unanswered = findUnansweredAskIds(messages);
  if (unanswered.length === 0) return null;

  return {
    sessionId,
    agentId: session.agent_id,
    sessionName: session.name,
    askIds: unanswered,
  };
}

/**
 * Build the awaiting-input snapshot for the WS connect handshake. Scans the
 * 200 most-recently-touched non-archived sessions (mirrors what fits in the
 * sidebar) and emits an entry for every one that has an unanswered ask.
 *
 * Active sessions are filtered out via the `active_tasks` table so a session
 * whose stream is still running doesn't double-count as both "working" and
 * "waiting."
 *
 * Propagates errors; the lenient wrapper used by the WS connect path swallows
 * them so a transient DB failure can't break the handshake.
 */
export function buildAwaitingInputSnapshot(stmts: Stmts): AwaitingInputItem[] {
  const sessions = stmts.getRecentLiveSessions.all() as SessionRow[];
  if (sessions.length === 0) return [];

  const active = new Set(
    (stmts.getAllActiveTasks.all() as ActiveTaskRow[]).map((t) => t.session_id),
  );

  const out: AwaitingInputItem[] = [];
  for (const sess of sessions) {
    if (active.has(sess.id)) continue;
    const messages = stmts.getMessages.all(sess.id) as MessageRow[];
    const unanswered = findUnansweredAskIds(messages);
    if (unanswered.length === 0) continue;
    out.push({
      sessionId: sess.id,
      agentId: sess.agent_id,
      sessionName: sess.name,
      askIds: unanswered,
    });
  }
  return out;
}

/**
 * Lenient wrapper for the WS connect path. On DB failure returns `[]` and
 * logs — clients still receive a valid (empty) snapshot.
 */
export function buildAwaitingInputSnapshotLenient(stmts: Stmts): AwaitingInputItem[] {
  try {
    return buildAwaitingInputSnapshot(stmts);
  } catch (err) {
    console.error(
      '[awaiting-input] snapshot failed (lenient empty fallback):',
      err instanceof Error ? err.message : err,
    );
    return [];
  }
}

/**
 * Emit a per-session WebSocket update reflecting the current awaiting-input
 * state. Called from the chat `done` path (transition into possibly waiting)
 * and after a user message lands (transition out of waiting). When the state
 * is null we still broadcast `{ waiting: false }` so clients can drop the
 * indicator without having to reconcile against the snapshot.
 *
 * Best-effort: errors are logged and swallowed — the indicator is a UX
 * affordance, not load-bearing for the chat turn.
 */
export function broadcastAwaitingInputForSession(
  sessionId: string,
  stmts: Stmts,
  broadcast: BroadcastFn,
): void {
  try {
    const state = getSessionAwaitingInputState(sessionId, stmts);
    if (state) {
      broadcast({
        type: 'awaiting_input',
        sessionId,
        agentId: state.agentId,
        sessionName: state.sessionName,
        askIds: state.askIds,
        waiting: true,
      });
    } else {
      const sess = stmts.getSession.get(sessionId) as SessionRow | undefined;
      broadcast({
        type: 'awaiting_input',
        sessionId,
        agentId: sess?.agent_id ?? null,
        sessionName: sess?.name ?? null,
        askIds: [],
        waiting: false,
      });
    }
  } catch (err) {
    console.error('[awaiting-input] broadcast failed:', err instanceof Error ? err.message : err);
  }
}
