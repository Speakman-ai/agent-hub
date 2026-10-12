import type { Request } from 'express';
import type { AuthenticatedRequest } from './auth.js';
import { enrichSessionForClient } from './session-checkpoint-rewind.js';
import type { BroadcastFn, SessionRow, Stmts } from './types.js';
import { collapseSessionIdList, isSingleSessionId } from './session-id-list.js';

export { collapseSessionIdList, isSingleSessionId };

/** Header agents may send when the JSON body omits `sessionId`. */
export const AGENT_HUB_SESSION_ID_HEADER = 'x-agent-hub-session-id';

/**
 * Read `X-Agent-Hub-Session-Id`, undoing Node's join of a header sent more
 * than once (`"id, id"`). Identical copies collapse to one id. Copies that
 * disagree come back joined as before, so callers that only test "is this an
 * agent call" keep working; callers that store the id must check
 * `isSingleSessionId` first.
 */
export function readSessionIdHeader(req: Pick<Request, 'get'>): string | null {
  const raw = req.get(AGENT_HUB_SESSION_ID_HEADER);
  if (typeof raw !== 'string') return null;
  return collapseSessionIdList(raw);
}

/** Extract the chat session id from a spawn-creds API key name (`spawn:<id>`). */
export function sessionIdFromSpawnKeyName(name: string): string | null {
  const prefix = 'spawn:';
  if (!name.startsWith(prefix)) return null;
  const id = name.slice(prefix.length).trim();
  return id || null;
}

/**
 * True when the session id a card create would link names more than one
 * distinct session: a body value like `"s1, s2"`, or (body key omitted) a
 * header sent with two different ids. The route must refuse these rather than
 * guess which session the caller meant.
 */
export function cardSessionIdConflicts(
  req: Pick<Request, 'get'>,
  bodySessionId: string | null | undefined,
): boolean {
  const raw = bodySessionId !== undefined ? bodySessionId : readSessionIdHeader(req);
  if (typeof raw !== 'string') return false;
  const collapsed = collapseSessionIdList(raw);
  return collapsed !== null && !isSingleSessionId(collapsed);
}

/**
 * Resolve the kanban card's `session_id` for POST /board/cards.
 *
 * Precedence uses `!== undefined` (not `||`) so an explicit body
 * `"sessionId": null` opts out and the header never overrides it.
 *
 *   1. Body key present (`string | null`) — null clears; empty string → null
 *   2. Body key omitted (`undefined`) — `X-Agent-Hub-Session-Id` header
 *   3. Spawn-creds API key (`spawn:<sessionId>`) from auth middleware
 */
export function resolveCardSessionId(
  req: Request,
  bodySessionId: string | null | undefined,
): string | null {
  if (bodySessionId !== undefined) {
    if (bodySessionId === null) return null;
    const collapsed = collapseSessionIdList(bodySessionId);
    return isSingleSessionId(collapsed) ? collapsed : null;
  }

  // Never store a joined list. The create route rejects conflicting ids with
  // `cardSessionIdConflicts` before calling this.
  const header = readSessionIdHeader(req);
  if (isSingleSessionId(header)) return header;

  const authed = req as AuthenticatedRequest;
  if (authed.authSpawnSessionId?.trim()) return authed.authSpawnSessionId.trim();

  return null;
}

/** Rename a placeholder session title when a card links mid-flight. */
export function maybeRenameSessionForLinkedCard(
  stmts: Stmts,
  broadcast: BroadcastFn,
  sessionId: string,
  cardTitle: string,
): void {
  const session = stmts.getSession.get(sessionId) as SessionRow | undefined;
  if (!session) return;
  const title = cardTitle.trim();
  if (!title) return;
  // Mirror chat.ts first-message rename: only overwrite default placeholders.
  if (!session.name.startsWith('Session ')) return;

  stmts.updateSessionName.run(title, sessionId);
  const updated = stmts.getSession.get(sessionId) as SessionRow | undefined;
  if (!updated) return;
  broadcast({ type: 'session-updated', session: enrichSessionForClient(updated, stmts) });
}
