/**
 * Pure routing decisions for notification-tap handling.
 *
 * Invoked from `AppContext.js` when the user taps either:
 *   - a foreground banner we presented locally via `presentLocalNotification`
 *     (payload shape: `{ event, ...broadcast }` — the whole WS broadcast is
 *     spread, so every id is typically present), or
 *   - a remote Expo push delivered by `server/push.ts#mapBroadcastToPush`
 *     (payload shape: `{ type, ...narrow }` — only the minimal fields needed
 *     for navigation are forwarded).
 *
 * The two sources use different discriminator keys (`event` vs `type`), so
 * `resolveEventKey` normalizes both.
 *
 * This file is a pure-function module — no React / Expo imports — so it runs
 * under Vitest without native mocks. All side effects (navigation, state
 * updates) happen in the caller, which inspects the returned `Route` tag.
 *
 * @typedef {'session_complete'|'changes_ready'|'pr_creation_stale'|'card_started'|'card_review'|'pr_merged'|'thread_created'|'thread_entry'|'dispatch_failure'} EventKey
 *
 * @typedef {{ kind: 'chat', agentId: string | null, sessionId: string }} ChatRoute
 * @typedef {{ kind: 'kanban', projectId: string | null, cardId: string | null }} KanbanRoute
 * @typedef {{ kind: 'threads', projectId: string, threadId: string | null }} ThreadsRoute
 * @typedef {ChatRoute | KanbanRoute | ThreadsRoute} Route
 */

/**
 * Return the event discriminator from either foreground (`event`) or remote
 * push (`type`) payloads. Foreground banners prefix a mapped `event` name
 * alongside the original broadcast `type`, so we prefer `event` when both
 * are present.
 *
 * @param {Record<string, unknown> | null | undefined} data
 * @returns {string | null}
 */
export function resolveEventKey(data) {
  if (!data || typeof data !== 'object') return null;
  if (typeof data.event === 'string' && data.event.length > 0) return data.event;
  if (typeof data.type === 'string' && data.type.length > 0) return data.type;
  return null;
}

/**
 * Find an agent id for a session id by consulting a loaded sessions list.
 * Returns null when the session isn't in the loaded list (e.g. the tap
 * arrived before the sessions endpoint responded for that agent).
 *
 * @param {string} sessionId
 * @param {Array<{ id?: string, agent_id?: string, agentId?: string }>} sessions
 * @returns {string | null}
 */
export function resolveAgentIdForSession(sessionId, sessions) {
  if (!sessionId || !Array.isArray(sessions)) return null;
  const match = sessions.find((s) => s && s.id === sessionId);
  if (!match) return null;
  return match.agent_id || match.agentId || null;
}

/**
 * Decide where a notification tap should navigate based on its payload.
 *
 * Chat events (`session_complete`, `changes_ready`, `pr_creation_stale`) require at minimum a
 * `sessionId`. `agentId` may be absent on server-sent pushes, in which case
 * the caller should consult the current sessions list (we do that here when
 * possible, but the caller may also need to fetch if the session isn't
 * loaded yet — see `ChatRoute.agentId === null`).
 *
 * Kanban events (`card_started`, `card_review`, `pr_merged`) always surface
 * the Kanban screen. `projectId` / `cardId` may be null when the server
 * didn't forward them; the screen should fall back to the default project.
 *
 * Thread events (`thread_created`, `thread_entry`) require `projectId`.
 * Without it we can't know which project's thread list to open, so we
 * return `null` and the caller leaves the current screen alone.
 *
 * `dispatch_failure` routes to Kanban if a `cardId` is known (so the user
 * can see which card the failed dispatch was attached to) and otherwise to
 * Threads if a `projectId` is known.
 *
 * Returning `null` means "no clear destination — stay put". Callers must
 * handle this gracefully (do not crash, do not clear active selection).
 *
 * @param {Record<string, any> | null | undefined} data
 * @param {{ sessions?: Array<{ id?: string, agent_id?: string, agentId?: string }> }} [ctx]
 * @returns {Route | null}
 */
export function routeNotificationTap(data, ctx = {}) {
  const event = resolveEventKey(data);
  if (!event) return null;

  const sessions = Array.isArray(ctx.sessions) ? ctx.sessions : [];

  switch (event) {
    case 'session_complete':
    case 'changes_ready':
    case 'pr_creation_stale': {
      const sessionId = typeof data.sessionId === 'string' ? data.sessionId : null;
      if (!sessionId) return null;
      const payloadAgentId = typeof data.agentId === 'string' ? data.agentId : null;
      const agentId = payloadAgentId || resolveAgentIdForSession(sessionId, sessions);
      return { kind: 'chat', agentId, sessionId };
    }

    case 'card_started':
    case 'card_review':
    case 'pr_merged': {
      return {
        kind: 'kanban',
        projectId: typeof data.projectId === 'string' ? data.projectId : null,
        cardId: typeof data.cardId === 'string' ? data.cardId : null,
      };
    }

    case 'thread_created':
    case 'thread_entry': {
      const projectId = typeof data.projectId === 'string' ? data.projectId : null;
      if (!projectId) return null;
      return {
        kind: 'threads',
        projectId,
        threadId: typeof data.threadId === 'string' ? data.threadId : null,
      };
    }

    case 'dispatch_failure': {
      const cardId = typeof data.cardId === 'string' ? data.cardId : null;
      const projectId = typeof data.projectId === 'string' ? data.projectId : null;
      if (cardId) return { kind: 'kanban', projectId, cardId };
      if (projectId) return { kind: 'threads', projectId, threadId: null };
      return null;
    }

    default:
      return null;
  }
}
