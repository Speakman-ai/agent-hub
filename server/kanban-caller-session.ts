import type { Request } from 'express';
import type { AuthenticatedRequest } from './auth.js';
import { enrichSessionForClient } from './session-checkpoint-rewind.js';
import type { BroadcastFn, SessionRow, Stmts } from './types.js';

/** Header agents may send when the JSON body omits `sessionId`. */
export const AGENT_HUB_SESSION_ID_HEADER = 'x-agent-hub-session-id';

/** Extract the chat session id from a spawn-creds API key name (`spawn:<id>`). */
export function sessionIdFromSpawnKeyName(name: string): string | null {
  const prefix = 'spawn:';
  if (!name.startsWith(prefix)) return null;
  const id = name.slice(prefix.length).trim();
  return id || null;
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
    const trimmed = bodySessionId.trim();
    return trimmed || null;
  }

  const header =
    req.get(AGENT_HUB_SESSION_ID_HEADER) ??
    req.get('X-Agent-Hub-Session-Id') ??
    req.get('X-AGENT-HUB-SESSION-ID');
  if (header?.trim()) return header.trim();

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
  broadcast({ type: 'session-updated', session: enrichSessionForClient(updated) });
}
