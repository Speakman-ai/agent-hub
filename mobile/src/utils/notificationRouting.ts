/**
 * Pure routing decisions for notification-tap handling.
 *
 * @typedef {'awaiting_feedback'|'ready_to_push'|'pushed'|'support_ticket_created'|'thread_message'|'review_assigned_to_you'|'pr_merged'|'infra_alert'} EventKey
 *
 * @typedef {{ kind: 'chat', agentId: string | null, sessionId: string }} ChatRoute
 * @typedef {{ kind: 'kanban', projectId: string | null, cardId: string | null }} KanbanRoute
 * @typedef {{ kind: 'threads', projectId: string, threadId: string | null }} ThreadsRoute
 * @typedef {{ kind: 'support', projectId: string, ticketId: string | null }} SupportRoute
 * @typedef {{ kind: 'pulls', projectId: string | null, prNumber: number | null }} PullsRoute
 * @typedef {{ kind: 'infra', projectId: string, alertId: string | null }} InfraRoute
 * @typedef {ChatRoute | KanbanRoute | ThreadsRoute | SupportRoute | PullsRoute | InfraRoute} Route
 */
/**
 * @param {Record<string, unknown> | null | undefined} data
 * @returns {string | null}
 */
export function resolveEventKey(data: any) {
  if (!data || typeof data !== 'object') return null;
  if (typeof data.event === 'string' && data.event.length > 0) return data.event;
  if (typeof data.type === 'string' && data.type.length > 0) return data.type;
  return null;
}
/**
 * @param {string} sessionId
 * @param {Array<{ id?: string, agent_id?: string, agentId?: string }>} sessions
 * @returns {string | null}
 */
export function resolveAgentIdForSession(sessionId: any, sessions: any) {
  if (!sessionId || !Array.isArray(sessions)) return null;
  const match = sessions.find((s: any) => s && s.id === sessionId);
  if (!match) return null;
  return match.agent_id || match.agentId || null;
}
/**
 * @param {string | null | undefined} sessionId
 * @param {Record<string, any>} data
 * @returns {string | null}
 */
function resolveSessionId(sessionId: any, data: any) {
  if (sessionId) return sessionId;
  if (typeof data.sessionId === 'string' && data.sessionId) return data.sessionId;
  if (typeof data.session_id === 'string' && data.session_id) return data.session_id;
  return null;
}
/**
 * @param {Record<string, any> | null | undefined} data
 * @param {{ sessions?: Array<{ id?: string, agent_id?: string, agentId?: string }> }} [ctx]
 * @returns {Route | null}
 */
export function routeNotificationTap(data: any, ctx: any = {}) {
  const event = resolveEventKey(data);
  if (!event) return null;
  const sessions = Array.isArray(ctx.sessions) ? ctx.sessions : [];
  switch (event) {
    case 'awaiting_feedback':
    case 'ready_to_push':
    case 'pushed': {
      const sessionId = resolveSessionId(null, data);
      if (!sessionId) return null;
      const payloadAgentId = typeof data.agentId === 'string' ? data.agentId : null;
      const agentId = payloadAgentId || resolveAgentIdForSession(sessionId, sessions);
      return { kind: 'chat', agentId, sessionId };
    }
    case 'support_ticket_created': {
      const projectId = typeof data.projectId === 'string' ? data.projectId : null;
      if (!projectId) return null;
      const ticketId =
        typeof data.ticketId === 'string'
          ? data.ticketId
          : typeof data.ticket?.id === 'string'
            ? data.ticket.id
            : null;
      return { kind: 'support', projectId, ticketId };
    }
    case 'thread_message': {
      const projectId = typeof data.projectId === 'string' ? data.projectId : null;
      if (!projectId) return null;
      return {
        kind: 'threads',
        projectId,
        threadId: typeof data.threadId === 'string' ? data.threadId : null,
      };
    }
    case 'review_assigned_to_you': {
      const projectId = typeof data.projectId === 'string' ? data.projectId : null;
      const cardId = typeof data.cardId === 'string' ? data.cardId : null;
      const prNumber = typeof data.prNumber === 'number' ? data.prNumber : null;
      if (cardId) return { kind: 'kanban', projectId, cardId };
      if (prNumber != null && projectId) return { kind: 'pulls', projectId, prNumber };
      if (projectId) return { kind: 'kanban', projectId, cardId: null };
      return null;
    }
    case 'pr_merged': {
      return {
        kind: 'kanban',
        projectId: typeof data.projectId === 'string' ? data.projectId : null,
        cardId: typeof data.cardId === 'string' ? data.cardId : null,
      };
    }
    case 'infra_alert': {
      // Infrastructure is a per-project screen, so without a project id
      // there is nothing to open — drop the tap rather than landing the
      // user on an arbitrary project's monitoring.
      const projectId = typeof data.projectId === 'string' ? data.projectId : null;
      if (!projectId) return null;
      return {
        kind: 'infra',
        projectId,
        // Absent when the alert row could not be recorded; the screen then
        // opens the Alerts tab without preselecting one.
        alertId: typeof data.alertId === 'string' ? data.alertId : null,
      };
    }
    default:
      return null;
  }
}
/**
 * Map a routed notification tap to a React Navigation `(screen, params)`
 * pair for the navigator-driven kinds (kanban, threads, support, pulls).
 *
 * Pure so the param plumbing is unit-testable — `applyNotificationRoute` in
 * AppContext used to build these params inline, where a dropped field (e.g.
 * the `pulls` PR number) was invisible to tests. The `chat` kind is handled
 * via active-agent/session state rather than navigation, so it returns null.
 *
 * @param {Route | null | undefined} route
 * @returns {{ screen: string, params: Record<string, unknown> } | null}
 */
export function notificationRouteToNavigation(route: any) {
  if (!route || typeof route !== 'object') return null;
  switch (route.kind) {
    case 'kanban':
      return {
        screen: 'Kanban',
        params: {
          projectId: route.projectId || undefined,
          cardId: route.cardId || undefined,
        },
      };
    case 'threads':
      return {
        screen: 'Threads',
        params: {
          projectId: route.projectId,
          threadId: route.threadId || undefined,
        },
      };
    case 'support':
      return {
        screen: 'CustomerSupport',
        params: {
          projectId: route.projectId,
          // Carry the triggering ticket id so the screen can open that ticket
          // directly instead of dropping the user on the list.
          ticketId: route.ticketId || undefined,
        },
      };
    case 'pulls':
      return {
        screen: 'PullRequests',
        params: {
          projectId: route.projectId || undefined,
          // Carry the resolved PR number so the screen opens that PR's detail
          // directly instead of dropping the user on the list.
          prNumber: route.prNumber ?? undefined,
        },
      };
    case 'infra':
      return {
        screen: 'Infrastructure',
        params: {
          projectId: route.projectId,
          // Opens straight onto the Alerts tab with this alert focused,
          // rather than the default Overview — the banner was about one
          // alert, so the tap should land on it.
          alertId: route.alertId || undefined,
          initialTab: 'alerts',
        },
      };
    default:
      return null;
  }
}
