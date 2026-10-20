// @ts-nocheck
import { describe, it, expect } from 'vitest';
import {
  resolveEventKey,
  resolveAgentIdForSession,
  routeNotificationTap,
  notificationRouteToNavigation,
  routeInboxNotification,
  routeFromWebLink,
  inboxNotificationTapData,
} from './notificationRouting';
describe('resolveEventKey', () => {
  it('prefers `event` over `type` when both are present', () => {
    expect(resolveEventKey({ event: 'awaiting_feedback', type: 'awaiting_input' })).toBe(
      'awaiting_feedback',
    );
  });
  it('falls back to `type` for server-pushed payloads', () => {
    expect(resolveEventKey({ type: 'chat_message' })).toBe('chat_message');
  });
  it('returns null for empty / malformed input', () => {
    expect(resolveEventKey(null)).toBeNull();
    expect(resolveEventKey(undefined)).toBeNull();
    expect(resolveEventKey({})).toBeNull();
    expect(resolveEventKey({ event: '' })).toBeNull();
    expect(resolveEventKey({ event: 42 })).toBeNull();
  });
});
describe('resolveAgentIdForSession', () => {
  it('finds agent_id (snake_case, server shape)', () => {
    const sessions = [
      { id: 's1', agent_id: 'a1' },
      { id: 's2', agent_id: 'a2' },
    ];
    expect(resolveAgentIdForSession('s2', sessions)).toBe('a2');
  });
  it('falls back to agentId (camelCase)', () => {
    expect(resolveAgentIdForSession('s1', [{ id: 's1', agentId: 'a1' }])).toBe('a1');
  });
  it('returns null for missing session / missing list', () => {
    expect(resolveAgentIdForSession('sX', [{ id: 's1', agent_id: 'a1' }])).toBeNull();
    expect(resolveAgentIdForSession('s1', [])).toBeNull();
    expect(resolveAgentIdForSession('s1', null)).toBeNull();
    expect(resolveAgentIdForSession('', [{ id: '', agent_id: 'a1' }])).toBeNull();
  });
});
describe('routeNotificationTap — chat events', () => {
  it.each(['awaiting_feedback', 'ready_to_push', 'pushed'])(
    'routes %s (foreground payload shape) to chat',
    (event: any) => {
      const data = { event, sessionId: 's1', agentId: 'a1' };
      expect(routeNotificationTap(data)).toEqual({
        kind: 'chat',
        agentId: 'a1',
        sessionId: 's1',
      });
    },
  );
  it('routes ready_to_push (server push shape) and resolves agentId from sessions', () => {
    const data = { type: 'ready_to_push', sessionId: 's1' };
    const sessions = [{ id: 's1', agent_id: 'a1' }];
    expect(routeNotificationTap(data, { sessions })).toEqual({
      kind: 'chat',
      agentId: 'a1',
      sessionId: 's1',
    });
  });
  it('returns chat with agentId=null when session is not loaded yet', () => {
    const data = { type: 'pushed', sessionId: 's1' };
    expect(routeNotificationTap(data, { sessions: [] })).toEqual({
      kind: 'chat',
      agentId: null,
      sessionId: 's1',
    });
  });
  it('returns null for chat events missing sessionId', () => {
    expect(routeNotificationTap({ event: 'awaiting_feedback' })).toBeNull();
    expect(routeNotificationTap({ type: 'ready_to_push' })).toBeNull();
  });
  it('accepts session_id from server payloads', () => {
    const data = { type: 'awaiting_feedback', session_id: 's9' };
    expect(routeNotificationTap(data, { sessions: [{ id: 's9', agent_id: 'a9' }] })).toEqual({
      kind: 'chat',
      agentId: 'a9',
      sessionId: 's9',
    });
  });
});
describe('routeNotificationTap — support', () => {
  it('routes support_ticket_created to support screen', () => {
    const data = {
      event: 'support_ticket_created',
      projectId: 'p1',
      ticketId: 't1',
    };
    expect(routeNotificationTap(data)).toEqual({
      kind: 'support',
      projectId: 'p1',
      ticketId: 't1',
    });
  });
  it('returns null when projectId is missing', () => {
    expect(routeNotificationTap({ event: 'support_ticket_created', ticketId: 't1' })).toBeNull();
  });
});
describe('routeNotificationTap — kanban and pulls', () => {
  it('routes review_assigned_to_you with cardId to kanban', () => {
    const data = { event: 'review_assigned_to_you', cardId: 'c1', projectId: 'p1' };
    expect(routeNotificationTap(data)).toEqual({
      kind: 'kanban',
      projectId: 'p1',
      cardId: 'c1',
    });
  });
  it('routes review_assigned_to_you with prNumber to pulls', () => {
    const data = { event: 'review_assigned_to_you', projectId: 'p1', prNumber: 42 };
    expect(routeNotificationTap(data)).toEqual({
      kind: 'pulls',
      projectId: 'p1',
      prNumber: 42,
    });
  });
  it('routes pr_merged to kanban', () => {
    const data = { event: 'pr_merged', cardId: 'c1', projectId: 'p1' };
    expect(routeNotificationTap(data)).toEqual({
      kind: 'kanban',
      projectId: 'p1',
      cardId: 'c1',
    });
  });
});
describe('routeNotificationTap — removed thread events', () => {
  it('no longer routes thread_message taps', () => {
    expect(
      routeNotificationTap({ event: 'thread_message', projectId: 'p1', threadId: 't1' }),
    ).toBeNull();
  });
});
describe('routeNotificationTap — infra alerts', () => {
  it('routes an infra_alert tap to the alert it was about', () => {
    // Regression: the mobile push formatter emitted `infra_alert` banners
    // before any route handled them, so tapping one did nothing.
    const data = { event: 'infra_alert', projectId: 'p1', alertId: 'al1', severity: 'critical' };
    expect(routeNotificationTap(data)).toEqual({
      kind: 'infra',
      projectId: 'p1',
      alertId: 'al1',
    });
  });
  it('still opens the module when the payload carries no alert id', () => {
    expect(routeNotificationTap({ event: 'infra_alert', projectId: 'p1' })).toEqual({
      kind: 'infra',
      projectId: 'p1',
      alertId: null,
    });
  });
  it('returns null without a projectId — Infrastructure is per-project', () => {
    expect(routeNotificationTap({ event: 'infra_alert', alertId: 'al1' })).toBeNull();
  });
  it('resolves the event key from `type` as well as `event`', () => {
    // The push payload the server builds carries `type: 'infra_alert'`.
    expect(routeNotificationTap({ type: 'infra_alert', projectId: 'p1', alertId: 'al1' })).toEqual({
      kind: 'infra',
      projectId: 'p1',
      alertId: 'al1',
    });
  });
});
describe('routeNotificationTap — unknown / malformed', () => {
  it('returns null for unknown event keys', () => {
    expect(routeNotificationTap({ event: 'something_new', sessionId: 's1' })).toBeNull();
    expect(routeNotificationTap({ event: 'session_complete', sessionId: 's1' })).toBeNull();
  });
  it('returns null for null / undefined / missing discriminator', () => {
    expect(routeNotificationTap(null)).toBeNull();
    expect(routeNotificationTap(undefined)).toBeNull();
    expect(routeNotificationTap({})).toBeNull();
    expect(routeNotificationTap({ sessionId: 's1' })).toBeNull();
  });
});
describe('notificationRouteToNavigation', () => {
  it('carries prNumber into the PullRequests navigation params', () => {
    // Regression: a PR review notification tap resolves to a pulls route with
    // a prNumber, but the navigation params used to drop it — opening the PR
    // list instead of the assigned PR.
    const route = routeNotificationTap({
      event: 'review_assigned_to_you',
      projectId: 'p1',
      prNumber: 42,
    });
    expect(route).toEqual({ kind: 'pulls', projectId: 'p1', prNumber: 42 });
    const nav = notificationRouteToNavigation(route);
    expect(nav).toEqual({
      screen: 'PullRequests',
      params: { projectId: 'p1', prNumber: 42 },
    });
  });
  it('maps kanban / support kinds to their screens', () => {
    expect(
      notificationRouteToNavigation({ kind: 'kanban', projectId: 'p1', cardId: 'c1' }),
    ).toEqual({ screen: 'Kanban', params: { projectId: 'p1', cardId: 'c1' } });
    expect(
      notificationRouteToNavigation({ kind: 'threads', projectId: 'p1', threadId: 't1' }),
    ).toBeNull();
    expect(
      notificationRouteToNavigation({ kind: 'support', projectId: 'p1', ticketId: 'tk1' }),
    ).toEqual({ screen: 'CustomerSupport', params: { projectId: 'p1', ticketId: 'tk1' } });
  });
  it('carries ticketId into the CustomerSupport params (regression)', () => {
    // The support route resolves a ticketId; the navigation mapper used to drop
    // it, so tapping a support_ticket_created push opened the list, not the
    // ticket. End-to-end from the raw payload:
    const route = routeNotificationTap({
      event: 'support_ticket_created',
      projectId: 'p1',
      ticketId: 'tk1',
    });
    expect(route).toEqual({ kind: 'support', projectId: 'p1', ticketId: 'tk1' });
    expect(notificationRouteToNavigation(route)).toEqual({
      screen: 'CustomerSupport',
      params: { projectId: 'p1', ticketId: 'tk1' },
    });
  });
  it('omits ticketId when the support route has none', () => {
    expect(
      notificationRouteToNavigation({ kind: 'support', projectId: 'p1', ticketId: null }),
    ).toEqual({ screen: 'CustomerSupport', params: { projectId: 'p1', ticketId: undefined } });
  });
  it('carries the alert id and lands on the Alerts tab, end to end', () => {
    // The banner was about one alert, so the tap must open that alert rather
    // than dropping the operator on the Overview tab.
    const route = routeNotificationTap({
      event: 'infra_alert',
      projectId: 'p1',
      alertId: 'al1',
    });
    expect(notificationRouteToNavigation(route)).toEqual({
      screen: 'Infrastructure',
      params: { projectId: 'p1', alertId: 'al1', initialTab: 'alerts' },
    });
  });
  it('omits alertId when the infra route has none', () => {
    expect(
      notificationRouteToNavigation({ kind: 'infra', projectId: 'p1', alertId: null }),
    ).toEqual({
      screen: 'Infrastructure',
      params: { projectId: 'p1', alertId: undefined, initialTab: 'alerts' },
    });
  });
  it('returns null for the chat kind and for null/garbage', () => {
    expect(
      notificationRouteToNavigation({ kind: 'chat', agentId: 'a1', sessionId: 's1' }),
    ).toBeNull();
    expect(notificationRouteToNavigation(null)).toBeNull();
    expect(notificationRouteToNavigation(undefined)).toBeNull();
    expect(notificationRouteToNavigation('nope')).toBeNull();
  });
});
describe('routeNotificationTap — Agent Hub chat', () => {
  it('opens the pushed channel on the Hub Chat tab', () => {
    // The server's chat push carries `type: 'chat_message'` and the channel id.
    const data = { type: 'chat_message', channelId: 'ch1', messageId: 'm1' };
    const route = routeNotificationTap(data);
    expect(route).toEqual({ kind: 'hubChat', channelId: 'ch1' });
    expect(notificationRouteToNavigation(route)).toEqual({
      screen: 'Hub',
      params: { tab: 'chat', channelId: 'ch1' },
    });
  });
  it('drops a chat tap without a channel id', () => {
    expect(routeNotificationTap({ event: 'chat_message' })).toBeNull();
  });
});

describe('routeInboxNotification — bell inbox rows', () => {
  const row = (category: string, data: Record<string, unknown> | null, projectId = 'p1') => ({
    id: 'n1',
    userId: 'u1',
    orgId: null,
    projectId,
    category,
    title: 't',
    body: '',
    route: null,
    data,
    sourceKey: 'k',
    createdAt: '2026-10-15T10:00:00Z',
    readAt: null,
  });

  it('opens the session for every session category', () => {
    for (const c of [
      'awaiting_feedback',
      'session_completed',
      'ready_to_push',
      'pushed',
      'finalize_failed',
    ]) {
      expect(routeInboxNotification(row(c, { sessionId: 's1', agentId: 'a1' }))).toEqual({
        kind: 'chat',
        agentId: 'a1',
        sessionId: 's1',
      });
    }
  });

  it('resolves the agent from loaded sessions when the row lacks it', () => {
    const sessions = [{ id: 's1', agent_id: 'a9' }];
    expect(
      routeInboxNotification(row('session_completed', { sessionId: 's1' }), { sessions }),
    ).toEqual({ kind: 'chat', agentId: 'a9', sessionId: 's1' });
  });

  it('falls back to the row project id for card and board categories', () => {
    expect(routeInboxNotification(row('card_assigned_to_you', { cardId: 'c1' }))).toEqual({
      kind: 'kanban',
      projectId: 'p1',
      cardId: 'c1',
    });
    expect(routeInboxNotification(row('escalation', { cardId: 'c2' }))).toEqual({
      kind: 'kanban',
      projectId: 'p1',
      cardId: 'c2',
    });
  });

  it('accepts a string PR number', () => {
    expect(routeInboxNotification(row('review_assigned_to_you', { prNumber: '42' }))).toEqual({
      kind: 'pulls',
      projectId: 'p1',
      prNumber: 42,
    });
  });

  it('opens Hub chat for DMs and mentions', () => {
    for (const c of ['dm', 'mention']) {
      expect(routeInboxNotification(row(c, { channelId: 'ch1', messageId: 'm1' }))).toEqual({
        kind: 'hubChat',
        channelId: 'ch1',
      });
    }
  });

  it('routes a routine run with no session to the project cron jobs', () => {
    const route = routeInboxNotification(row('routine_run', { cronId: 7 }));
    expect(route).toEqual({ kind: 'crons', projectId: 'p1' });
    expect(notificationRouteToNavigation(route)).toEqual({
      screen: 'ProjectCrons',
      params: { projectId: 'p1' },
    });
    expect(routeInboxNotification(row('routine_run', { sessionId: 's9', agentId: 'ops' }))).toEqual(
      expect.objectContaining({ kind: 'chat', sessionId: 's9' }),
    );
  });

  it('opens the PR when its preview is ready', () => {
    expect(routeInboxNotification(row('pr_environment_ready', { prNumber: 12 }))).toEqual({
      kind: 'pulls',
      projectId: 'p1',
      prNumber: 12,
    });
  });

  it('opens Deployments for deploy outcomes', () => {
    const route = routeInboxNotification(row('deploy_outcome', {}));
    expect(route).toEqual({ kind: 'deployments', projectId: 'p1' });
    expect(notificationRouteToNavigation(route)).toEqual({
      screen: 'Deployments',
      params: { projectId: 'p1' },
    });
  });

  it('opens infra alerts on the Alerts tab', () => {
    expect(routeInboxNotification(row('infra_alert', { alertId: 'al1' }))).toEqual({
      kind: 'infra',
      projectId: 'p1',
      alertId: 'al1',
    });
  });

  it('opens the session for an unknown category that carries one, else nothing', () => {
    expect(routeInboxNotification(row('something_new', { sessionId: 's1' }))).toEqual({
      kind: 'chat',
      agentId: null,
      sessionId: 's1',
    });
    expect(routeInboxNotification(row('something_new', null))).toBeNull();
  });

  it('keeps push taps of unknown events inert', () => {
    expect(routeNotificationTap({ type: 'something_new', sessionId: 's1' })).toBeNull();
  });

  it('uses the category as the event key even when data carries its own', () => {
    expect(inboxNotificationTapData(row('dm', { event: 'other', channelId: 'c' }))).toMatchObject({
      event: 'dm',
      type: 'dm',
      projectId: 'p1',
    });
  });
});

describe('routeInboxNotification — explicit route', () => {
  const routeOnly = (route: string | null, category = 'something_new') => ({
    id: 'n1',
    userId: 'u1',
    orgId: null,
    projectId: null,
    category,
    title: 't',
    body: '',
    route,
    data: null,
    sourceKey: 'k',
    createdAt: '2026-10-15T10:00:00Z',
    readAt: null,
  });

  it('opens a row whose target lives only in its route', () => {
    expect(routeInboxNotification(routeOnly('#/pulls/p1?pr=7', 'pr_merged'))).toEqual({
      kind: 'pulls',
      projectId: 'p1',
      prNumber: 7,
    });
    expect(routeInboxNotification(routeOnly('#/hub/chat?channel=ch1&message=m1', 'dm'))).toEqual({
      kind: 'hubChat',
      channelId: 'ch1',
    });
  });

  it('prefers the route over the data payload', () => {
    const n = { ...routeOnly('#/support/p2?ticket=t9'), data: { sessionId: 's1' } };
    expect(routeInboxNotification(n)).toEqual({ kind: 'support', projectId: 'p2', ticketId: 't9' });
  });

  it('falls back to category and data when the route has no mobile screen', () => {
    const n = {
      ...routeOnly('#/design?design=d1', 'awaiting_feedback'),
      data: { sessionId: 's1' },
    };
    expect(routeInboxNotification(n)).toEqual({ kind: 'chat', agentId: null, sessionId: 's1' });
  });

  it('parses the web hash and path link forms', () => {
    expect(routeFromWebLink('#/kanban:p1?card=c1')).toEqual({
      kind: 'kanban',
      projectId: 'p1',
      cardId: 'c1',
    });
    expect(routeFromWebLink('/projects/p1/board?card=c2')).toEqual({
      kind: 'kanban',
      projectId: 'p1',
      cardId: 'c2',
    });
    expect(routeFromWebLink('/projects/p1/pulls/306')).toEqual({
      kind: 'pulls',
      projectId: 'p1',
      prNumber: 306,
    });
    expect(routeFromWebLink('#/deployments/p1')).toEqual({ kind: 'deployments', projectId: 'p1' });
    expect(routeFromWebLink('#/infra:p1')).toEqual({
      kind: 'infra',
      projectId: 'p1',
      alertId: null,
    });
    expect(routeFromWebLink('#/hub/chat')).toBeNull();
    expect(routeFromWebLink('#/pulls')).toBeNull();
    expect(routeFromWebLink('')).toBeNull();
    expect(routeFromWebLink(null)).toBeNull();
  });
});

describe('routeNotificationTap — browser sign-in', () => {
  it('opens the session and asks for the browser view', () => {
    expect(
      routeNotificationTap({ event: 'browser_sign_in', sessionId: 's1', agentId: 'a1' }),
    ).toEqual({ kind: 'chat', agentId: 'a1', sessionId: 's1', openPane: 'browser' });
    expect(routeNotificationTap({ event: 'browser_sign_in' })).toBeNull();
  });

  it('routes a sign-in inbox row to the browser view too', () => {
    expect(
      routeInboxNotification({
        id: 'n1',
        userId: 'u1',
        orgId: null,
        projectId: 'p1',
        category: 'browser_sign_in',
        title: 't',
        body: '',
        route: null,
        data: { sessionId: 's1', agentId: 'a1' },
        sourceKey: 'k',
        createdAt: '2026-10-15T10:00:00Z',
        readAt: null,
      }),
    ).toEqual({ kind: 'chat', agentId: 'a1', sessionId: 's1', openPane: 'browser' });
  });
});

describe('routeNotificationTap — approval requested', () => {
  it('opens the waiting session', () => {
    expect(
      routeNotificationTap({ event: 'approval_requested', sessionId: 's1', agentId: 'a1' }),
    ).toEqual({ kind: 'chat', agentId: 'a1', sessionId: 's1' });
    expect(routeNotificationTap({ event: 'approval_requested' })).toBeNull();
  });
});

describe('reminders', () => {
  it('opens the Hub Reminders tab from a push, a bell row, and a web link', () => {
    const route = routeNotificationTap({ event: 'reminder', reminderId: 'r1', sessionId: 's1' });
    expect(route).toEqual({ kind: 'reminders' });
    expect(notificationRouteToNavigation(route)).toEqual({
      screen: 'Hub',
      params: { tab: 'reminders' },
    });
    expect(
      routeInboxNotification({
        id: 'n1',
        userId: 'u',
        orgId: null,
        projectId: null,
        category: 'reminder',
        title: 'Reminder: x',
        body: '',
        route: null,
        data: { reminderId: 'r1' },
        sourceKey: 'reminder:r1:t',
        createdAt: '2026-10-16T00:00:00Z',
        readAt: null,
      }),
    ).toEqual({ kind: 'reminders' });
    expect(routeFromWebLink('#/hub/reminders')).toEqual({ kind: 'reminders' });
  });
});
