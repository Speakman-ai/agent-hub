import { parseNavigationHash, type NavigationState } from './navigation';
import type { InboxNotification } from '@shared/utils/notificationInbox';

export type { InboxNotification };

export type NotificationTarget =
  | { kind: 'session'; sessionId: string; agentId: string | null; pane?: 'browser' }
  | { kind: 'route'; route: NavigationState };

function str(v: unknown): string | null {
  return typeof v === 'string' && v ? v : null;
}

function prNumberOf(v: unknown): number | null {
  const n = typeof v === 'number' ? v : Number.parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Where clicking a notification should take the user, or null when the row
 * carries nothing to open. An explicit `route` (a hash path) wins; otherwise
 * the category and its `data` payload decide.
 */
export function notificationTarget(n: InboxNotification): NotificationTarget | null {
  if (n.route) {
    const parsed = parseNavigationHash(n.route);
    if (parsed) return { kind: 'route', route: parsed };
  }

  const data = n.data ?? {};
  const projectId = str(data.projectId) ?? n.projectId;
  const sessionId = str(data.sessionId) ?? str(data.session_id);
  const cardId = str(data.cardId);
  const prNumber = prNumberOf(data.prNumber);

  const card = (): NotificationTarget | null =>
    projectId
      ? { kind: 'route', route: { view: `kanban:${projectId}`, cardId: cardId ?? null } }
      : null;
  const pull = (): NotificationTarget | null =>
    projectId && prNumber ? { kind: 'route', route: { view: 'pulls', projectId, prNumber } } : null;

  switch (n.category) {
    case 'awaiting_feedback':
    case 'session_completed':
    case 'ready_to_push':
    case 'pushed':
    case 'finalize_failed':
      return sessionId ? { kind: 'session', sessionId, agentId: str(data.agentId) } : null;
    case 'browser_sign_in':
      return sessionId
        ? { kind: 'session', sessionId, agentId: str(data.agentId), pane: 'browser' }
        : null;
    case 'review_assigned_to_you':
    case 'pr_merged':
    case 'escalation':
      if (cardId) return card();
      return pull() ?? card();
    case 'card_assigned_to_you':
      return card();
    case 'support_ticket_created':
      return projectId
        ? {
            kind: 'route',
            route: { view: 'support', projectId, ticketId: str(data.ticketId) },
          }
        : null;
    case 'dm':
    case 'mention': {
      const channelId = str(data.channelId);
      if (!channelId) return null;
      return {
        kind: 'route',
        route: {
          view: 'hub',
          hubPane: 'chat',
          chatChannelId: channelId,
          chatMessageId: str(data.messageId),
        },
      };
    }
    case 'infra_alert':
      return projectId ? { kind: 'route', route: { view: `infra:${projectId}` } } : null;
    case 'deploy_outcome':
      return projectId ? { kind: 'route', route: { view: 'deployments', projectId } } : null;
    default:
      return sessionId ? { kind: 'session', sessionId, agentId: str(data.agentId) } : null;
  }
}
