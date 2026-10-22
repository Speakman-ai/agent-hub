/**
 * Notification-tap routing.
 *
 * @typedef {{ kind: 'chat', agentId: string | null, sessionId: string, openPane?: 'browser' }} ChatRoute
 * @typedef {{ kind: 'kanban', projectId: string | null, cardId: string | null }} KanbanRoute
 * @typedef {{ kind: 'support', projectId: string, ticketId: string | null }} SupportRoute
 * @typedef {{ kind: 'pulls', projectId: string | null, prNumber: number | null }} PullsRoute
 * @typedef {{ kind: 'infra', projectId: string, alertId: string | null }} InfraRoute
 * @typedef {{ kind: 'hubChat', channelId: string }} HubChatRoute
 * @typedef {{ kind: 'deployments', projectId: string }} DeploymentsRoute
 * @typedef {{ kind: 'crons', projectId: string }} CronsRoute
 * @typedef {{ kind: 'reminders' }} RemindersRoute
 * @typedef {ChatRoute | KanbanRoute | SupportRoute | PullsRoute | InfraRoute | HubChatRoute | DeploymentsRoute | CronsRoute | RemindersRoute} Route
 */
import type { InboxNotification } from '@shared/utils/notificationInbox';
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
  const chat = () => {
    const sessionId = resolveSessionId(null, data);
    if (!sessionId) return null;
    const payloadAgentId = typeof data.agentId === 'string' ? data.agentId : null;
    const agentId = payloadAgentId || resolveAgentIdForSession(sessionId, sessions);
    return { kind: 'chat' as const, agentId, sessionId };
  };
  switch (event) {
    case 'awaiting_feedback':
    case 'approval_requested':
    case 'session_completed':
    case 'ready_to_push':
    case 'pushed':
    case 'finalize_failed':
      return chat();
    case 'routine_run': {
      // A run that failed before it got a session points at the cron log.
      const route = chat();
      if (route) return route;
      const projectId = typeof data.projectId === 'string' ? data.projectId : null;
      return projectId ? { kind: 'crons' as const, projectId } : null;
    }
    case 'browser_sign_in': {
      // The agent is parked on a sign-in: open its session with the browser view.
      const route = chat();
      return route ? { ...route, openPane: 'browser' as const } : null;
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
    case 'review_assigned_to_you':
    case 'escalation': {
      const projectId = typeof data.projectId === 'string' ? data.projectId : null;
      const cardId = typeof data.cardId === 'string' ? data.cardId : null;
      const prNumber = typeof data.prNumber === 'number' ? data.prNumber : null;
      if (cardId) return { kind: 'kanban', projectId, cardId };
      if (prNumber != null && projectId) return { kind: 'pulls', projectId, prNumber };
      if (projectId) return { kind: 'kanban', projectId, cardId: null };
      return null;
    }
    case 'pr_environment_ready': {
      const projectId = typeof data.projectId === 'string' ? data.projectId : null;
      const prNumber = typeof data.prNumber === 'number' ? data.prNumber : null;
      return projectId && prNumber != null ? { kind: 'pulls', projectId, prNumber } : null;
    }
    case 'pr_merged':
    case 'card_assigned_to_you':
    case 'default_branch_ci_failed': {
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
    case 'chat_message':
    case 'dm':
    case 'mention': {
      // An Agent Hub chat push: open that channel on the Hub's Chat tab.
      const channelId = typeof data.channelId === 'string' ? data.channelId : null;
      if (!channelId) return null;
      return { kind: 'hubChat', channelId };
    }
    case 'reminder':
      return { kind: 'reminders' as const };
    case 'deploy_outcome': {
      const projectId = typeof data.projectId === 'string' ? data.projectId : null;
      if (!projectId) return null;
      return { kind: 'deployments', projectId };
    }
    default:
      // Inbox rows of a category this build doesn't know still open their
      // session when they carry one, like the web bell.
      return ctx.sessionFallback ? chat() : null;
  }
}

/**
 * The tap payload for a bell inbox row, so a row and a push banner for the
 * same event route identically. The row's category is the event key; its
 * project id fills in when `data` doesn't carry one. A string PR number
 * (the web bell accepts those) is normalized to the number the router needs.
 */
export function inboxNotificationTapData(n: InboxNotification): Record<string, unknown> {
  const data: Record<string, unknown> = { ...(n.data ?? {}) };
  const out: Record<string, unknown> = { ...data, event: n.category, type: n.category };
  if (typeof data.projectId !== 'string' || !data.projectId) {
    if (n.projectId) out.projectId = n.projectId;
  }
  if (typeof data.prNumber === 'string') {
    const pr = Number.parseInt(data.prNumber, 10);
    out.prNumber = Number.isFinite(pr) && pr > 0 ? pr : null;
  }
  return out;
}

function linkSegment(v: string | null | undefined): string | null {
  const s = typeof v === 'string' ? v.trim() : '';
  return s || null;
}

function linkPositiveInt(v: string | null | undefined): number | null {
  const n = Number.parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Parse a web deep link (an inbox row's `route`) into a mobile route. Accepts
 * the web hash grammar (`#/pulls/<project>?pr=3`, `#/support/<project>?ticket=t`,
 * `#/deployments/<project>`, `#/kanban:<project>?card=c`, `#/infra:<project>`,
 * `#/hub/chat?channel=c`) and the shareable path form
 * (`/projects/<project>/board?card=c`, `/projects/<project>/pulls/3`). Returns
 * null for anything with no mobile screen, so the caller falls back to the
 * category and data payload.
 */
export function routeFromWebLink(link: unknown) {
  if (typeof link !== 'string') return null;
  let raw = link.trim();
  if (raw.startsWith('#')) raw = raw.slice(1);
  if (raw.startsWith('/')) raw = raw.slice(1);
  if (!raw) return null;
  const [path, query = ''] = raw.split('?');
  const params = new URLSearchParams(query);
  const segs = path
    .split('/')
    .map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        return '';
      }
    })
    .filter(Boolean);
  if (segs.length === 0) return null;

  let view = segs[0];
  let projectId: string | null = null;
  let rest = segs.slice(1);
  if (view === 'projects' && segs[1] && segs[2]) {
    projectId = segs[1];
    view = segs[2] === 'board' || segs[2] === 'kanban' ? 'kanban' : segs[2];
    rest = segs.slice(3);
  } else if (view === 'view' && segs[1]) {
    view = segs[1];
    rest = segs.slice(2);
  } else {
    const colon = view.indexOf(':');
    if (colon > 0) {
      projectId = linkSegment(view.slice(colon + 1));
      view = view.slice(0, colon);
    } else if (view !== 'hub' && segs[1]) {
      projectId = segs[1];
      rest = segs.slice(2);
    }
  }
  projectId = linkSegment(params.get('project')) ?? projectId;

  switch (view) {
    case 'kanban':
      return projectId
        ? { kind: 'kanban' as const, projectId, cardId: linkSegment(params.get('card')) }
        : null;
    case 'pulls':
      return projectId
        ? {
            kind: 'pulls' as const,
            projectId,
            prNumber: linkPositiveInt(params.get('pr') ?? rest[0]),
          }
        : null;
    case 'support':
      return projectId
        ? { kind: 'support' as const, projectId, ticketId: linkSegment(params.get('ticket')) }
        : null;
    case 'deployments':
      return projectId ? { kind: 'deployments' as const, projectId } : null;
    case 'infra':
      return projectId
        ? { kind: 'infra' as const, projectId, alertId: linkSegment(params.get('alert')) }
        : null;
    case 'hub': {
      if (segs[1] === 'reminders') return { kind: 'reminders' as const };
      const channelId = segs[1] === 'chat' ? linkSegment(params.get('channel')) : null;
      return channelId ? { kind: 'hubChat' as const, channelId } : null;
    }
    default:
      return null;
  }
}

/**
 * Where tapping a bell inbox row goes, or null when it carries nothing to
 * open. An explicit `route` the app can open wins, like the web bell;
 * otherwise the category and its data payload decide.
 */
export function routeInboxNotification(n: InboxNotification, ctx: any = {}) {
  return (
    routeFromWebLink(n.route) ??
    routeNotificationTap(inboxNotificationTapData(n), { ...ctx, sessionFallback: true })
  );
}
/**
 * Map a routed notification tap to a React Navigation `(screen, params)`
 * pair for the navigator-driven kinds (kanban, support, pulls, infra, hubChat).
 *
 * `applyNotificationRoute` used to build these params inline, where a dropped
 * field (e.g. the `pulls` PR number) was invisible. The `chat` kind is handled
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
    case 'hubChat':
      return { screen: 'Hub', params: { tab: 'chat', channelId: route.channelId } };
    case 'deployments':
      return { screen: 'Deployments', params: { projectId: route.projectId } };
    case 'crons':
      return { screen: 'ProjectCrons', params: { projectId: route.projectId } };
    case 'reminders':
      return { screen: 'Hub', params: { tab: 'reminders' } };
    default:
      return null;
  }
}
