/**
 * "Needs your input": the one session state for every way a session can stop
 * and wait on a human. Sources:
 *
 *   - question:        an unanswered `agenthub:ask` picker
 *   - credential:      an unsubmitted `agenthub:credential-request` card
 *   - approval:        a turn parked on an approval request
 *   - sign_in:         a turn parked on a browser `request_login` hand-off
 *   - review_disputed: Finalize stopped because the reviewer upheld a finding
 *                      the agent disputed
 *
 * Approvals and sign-ins pause a live turn, so they count while the CLI is
 * running. The rest only exist once the turn has ended: while a turn runs the
 * session is working, not waiting.
 *
 * Clients learn about changes through `session_needs_input` broadcasts, sent
 * by {@link noteBroadcastForNeedsInput} whenever an event that can change the
 * answer passes through the WebSocket broadcast.
 */
import type { BroadcastFn, MessageRow, Stmts } from './types.js';
import { isAwaitingUserReply, findCredentialRequestIds } from '../shared/utils/userInputRequest.js';
import { hasPendingApprovalForSession } from './approval-requests.js';
import { getPendingBrowserLogin } from './browser-login-handoff.js';
import type { NeedsInputKind } from '../shared/utils/sessionState.js';

export type { NeedsInputKind };

export const SESSION_NEEDS_INPUT_EVENT = 'session_needs_input';

/** Enough tail to find the latest user/assistant turn past trailing system rows. */
const RECENT_MESSAGE_WINDOW = 25;

function recentMessages(stmts: Stmts, sessionId: string): MessageRow[] {
  const rows = stmts.getMessagesPageLatest.all(sessionId, RECENT_MESSAGE_WINDOW) as MessageRow[];
  return rows.slice().reverse();
}

function latestAssistant(messages: readonly MessageRow[]): MessageRow | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'assistant') return messages[i];
  }
  return null;
}

/** What the session is waiting on the human for, or null. Best-effort: errors read as null. */
export function computeSessionNeedsInput(stmts: Stmts, sessionId: string): NeedsInputKind | null {
  try {
    if (getPendingBrowserLogin(sessionId)) return 'sign_in';
    if (hasPendingApprovalForSession(sessionId)) return 'approval';
    if (stmts.getActiveTask.get(sessionId)) return null;

    const messages = recentMessages(stmts, sessionId);
    if (isAwaitingUserReply(messages)) {
      const last = latestAssistant(messages);
      return findCredentialRequestIds(last?.content).length > 0 ? 'credential' : 'question';
    }

    const run = stmts.getLatestFinalizeRunForSession.get(sessionId) as
      | { status?: string }
      | undefined;
    if (run?.status === 'disputed') return 'review_disputed';
    return null;
  } catch {
    return null;
  }
}

/**
 * Events after which a session's needs-input answer can change. `done` and the
 * user-message path both emit `awaiting_input`, so turn boundaries are covered
 * through it.
 */
const TRIGGER_EVENTS = new Set([
  'awaiting_input',
  'approval_requested',
  'approval_resolved',
  'browser_login_requested',
  'browser_login_resolved',
  'finalize_run_created',
  'finalize_run_completed',
]);

const lastSent = new Map<string, NeedsInputKind | null>();
const LAST_SENT_CAP = 5_000;

function sessionIdOf(data: Record<string, unknown>): string | null {
  const id = data.sessionId ?? data.session_id;
  return typeof id === 'string' && id ? id : null;
}

/**
 * Broadcast tap. Recomputes needs-input for the event's session after the
 * current task (so the state that produced the event has settled) and
 * broadcasts `session_needs_input` when the answer changed.
 */
export function noteBroadcastForNeedsInput(
  data: Record<string, unknown>,
  deps: { stmts: Stmts | null | undefined; broadcast: BroadcastFn },
): void {
  if (!data || typeof data.type !== 'string' || !TRIGGER_EVENTS.has(data.type)) return;
  const sessionId = sessionIdOf(data);
  const stmts = deps.stmts;
  if (!sessionId || !stmts) return;
  queueMicrotask(() => publishSessionNeedsInput(sessionId, stmts, deps.broadcast));
}

/** Recompute and broadcast when changed. Exported for tests and direct callers. */
export function publishSessionNeedsInput(
  sessionId: string,
  stmts: Stmts,
  broadcast: BroadcastFn,
): NeedsInputKind | null {
  // Stamped before computing: clients keep a live value over any session
  // payload computed earlier, and let a later payload replace it.
  const at = Date.now();
  const kind = computeSessionNeedsInput(stmts, sessionId);
  if (lastSent.has(sessionId) && lastSent.get(sessionId) === kind) return kind;
  if (lastSent.size >= LAST_SENT_CAP) lastSent.clear();
  lastSent.set(sessionId, kind);
  const session = stmts.getSession.get(sessionId) as
    | { agent_id?: string; owner_user_id?: string | null; name?: string | null }
    | undefined;
  try {
    broadcast({
      type: SESSION_NEEDS_INPUT_EVENT,
      sessionId,
      agentId: session?.agent_id ?? null,
      ownerUserId: session?.owner_user_id ?? null,
      sessionName: session?.name ?? null,
      needsInput: kind,
      at,
    });
  } catch {
    // best-effort live update; the session payload re-resolves on read.
  }
  return kind;
}

export const SESSION_NEEDS_INPUT_SNAPSHOT_EVENT = 'session-needs-input-snapshot';

/**
 * Connect-time snapshot: the current answer for every recently touched live
 * session, null included. Clients replace their live map with it, so a
 * request raised or cleared while the socket was down is reconciled instead
 * of a stale entry winning. Lenient: a DB failure yields an empty list.
 */
export function buildNeedsInputSnapshot(
  stmts: Stmts,
): Array<{ sessionId: string; needsInput: NeedsInputKind | null; at: number }> {
  try {
    const sessions = stmts.getRecentLiveSessions.all() as Array<{ id: string }>;
    return sessions.map((s) => {
      const at = Date.now();
      return { sessionId: s.id, needsInput: computeSessionNeedsInput(stmts, s.id), at };
    });
  } catch {
    return [];
  }
}

export function __resetNeedsInputForTests(): void {
  lastSent.clear();
}
