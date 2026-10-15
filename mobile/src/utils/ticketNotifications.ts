/**
 * In-app notification message formatters.
 *
 * Mirror of `server/push.ts` formatters — kept in sync so mobile in-app
 * banners use the same wording as Expo push payloads.
 */
import {
  shouldDeliverProjectNotification,
  shouldNotifyUserForProject,
} from '@shared/utils/notificationProjectScope';
/** @typedef {{ title: string, body: string }} NotificationContent */
export function awaitingFeedbackNotification({ sessionName }: any) {
  const subject = sessionName ? `"${sessionName}"` : 'A session';
  return { title: 'Awaiting feedback', body: `${subject} is waiting for your input` };
}
export function readyToPushNotification({ sessionName }: any) {
  const subject = sessionName ? `"${sessionName}"` : 'A session';
  return {
    title: 'Ready to push',
    body: `${subject} passed review and checks — ready to push`,
  };
}
export function pushedNotification({ sessionName, prNumber }: any) {
  const subject = sessionName ? `"${sessionName}"` : 'A session';
  const pr = typeof prNumber === 'number' && prNumber > 0 ? ` (PR #${prNumber})` : '';
  return { title: 'Pushed', body: `${subject} was pushed${pr}` };
}
export function supportTicketCreatedNotification({ subject, ticketType }: any) {
  const label = ticketType ? `${ticketType}: ` : '';
  return {
    title: 'Support ticket created',
    body: `${label}${subject || 'New ticket'}`,
  };
}
export function reviewAssignedNotification({ cardTitle, prNumber }: any) {
  const title = cardTitle || 'Ticket';
  const pr = typeof prNumber === 'number' && prNumber > 0 ? `PR #${prNumber}: ` : '';
  return {
    title: 'Review assigned to you',
    body: `${pr}"${title}" needs your review`,
  };
}
export function prMergedNotification({ cardTitle, prNumber, mergedBy }: any) {
  return {
    title: 'PR merged',
    body: `PR #${prNumber} merged${mergedBy ? ` by ${mergedBy}` : ''}: "${cardTitle}"`,
  };
}
export function infraAlertNotification({
  severity,
  ruleName,
  resourceId,
  fromState,
  toState,
}: any) {
  const label = severity ? `${severity[0].toUpperCase()}${severity.slice(1)}` : 'Infrastructure';
  const transition = toState ? `: ${fromState || 'state'} → ${toState}` : '';
  return {
    title: `${label} infrastructure alert`,
    body: `${ruleName || 'Alert'} on ${resourceId || 'resource'}${transition}`,
  };
}
/**
 * @param {object} data
 * @param {{
 *   currentUserId?: string | null,
 *   projects?: Array<{ id: string, ownerUserId?: string | null }>,
 *   agents?: Array<{ id: string, projectId?: string }>,
 *   localBypass?: boolean,
 * }} [opts] `localBypass` MUST come from an actual local/bundled-server
 *   signal (the server has no auth configured → single-user, mirrors the
 *   server's `isLocalBundledServer()`). It is NOT inferred from a missing
 *   `currentUserId`: an API-key / unattributed client on a multi-user server
 *   has no local bypass and must be subject to the strict owner check.
 * @returns {({ event: string } & NotificationContent) | null}
 */
export function mapBroadcastToNotification(data: any, opts: any = {}) {
  if (!data || typeof data.type !== 'string') return null;
  const owner = typeof data.ownerUserId === 'string' && data.ownerUserId ? data.ownerUserId : null;
  const me =
    typeof opts.currentUserId === 'string' && opts.currentUserId ? opts.currentUserId : null;
  const localBypass = Boolean(opts.localBypass);
  // Session-scoped owner gate. A broadcast can carry `ownerUserId` with no
  // resolvable project (session-only events), which the project gate below
  // can't catch. Such an event belongs to that user only: suppress for anyone
  // else — INCLUDING an unattributed / API-key client (`me === null`) on a
  // multi-user server — unless a real local/bundled single-user `localBypass`
  // is set. Same strict semantics as the project gate.
  if (!shouldNotifyUserForProject(owner, me, { localBypass })) return null;
  if (
    !shouldDeliverProjectNotification(data, me, opts.projects || [], opts.agents || [], {
      localBypass,
    })
  ) {
    return null;
  }
  switch (data.type) {
    case 'awaiting_input': {
      if (data.waiting !== true) return null;
      const { title, body } = awaitingFeedbackNotification({
        sessionName: data.sessionName,
      });
      return { event: 'awaiting_feedback', title, body };
    }
    case 'finalize_run_completed': {
      if (data.status === 'ready_to_push') {
        const { title, body } = readyToPushNotification({ sessionName: data.sessionName });
        return { event: 'ready_to_push', title, body };
      }
      if (data.status === 'pushed') {
        const { title, body } = pushedNotification({
          sessionName: data.sessionName,
          prNumber: data.prNumber,
        });
        return { event: 'pushed', title, body };
      }
      return null;
    }
    case 'support_ticket_created': {
      const ticket = data.ticket || {};
      const { title, body } = supportTicketCreatedNotification({
        subject: ticket.subject,
        ticketType: ticket.type,
      });
      return { event: 'support_ticket_created', title, body };
    }
    case 'card_moved': {
      const col = (data.columnName || '').toLowerCase();
      if (col !== 'review') return null;
      const { title, body } = reviewAssignedNotification({ cardTitle: data.cardTitle });
      return { event: 'review_assigned_to_you', title, body };
    }
    case 'native_pr_update': {
      if (data.action !== 'review_requested') return null;
      const { title, body } = reviewAssignedNotification({ prNumber: data.prNumber });
      return { event: 'review_assigned_to_you', title, body };
    }
    case 'webhook_pr_merged': {
      const { title, body } = prMergedNotification({
        cardTitle: data.cardTitle || 'PR',
        prNumber: data.prNumber || 0,
        mergedBy: data.mergedBy,
      });
      return { event: 'pr_merged', title, body };
    }
    case 'browser_login_requested': {
      const domain =
        typeof data.request?.domain === 'string' && data.request.domain
          ? data.request.domain
          : 'a site';
      const who =
        typeof data.agentName === 'string' && data.agentName ? data.agentName : 'An agent';
      return {
        event: 'browser_sign_in',
        title: `Sign in to ${domain}`,
        body: `${who} is waiting for you to sign in to ${domain} in its browser`,
      };
    }
    case 'infra_alert_transition': {
      const { title, body } = infraAlertNotification(data);
      return { event: 'infra_alert', title, body };
    }
    default:
      return null;
  }
}
