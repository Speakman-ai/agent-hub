import { describe, it, expect } from 'vitest';
import {
  resolveEventKey,
  resolveAgentIdForSession,
  routeNotificationTap,
  notificationRouteToNavigation,
} from './notificationRouting';

describe('resolveEventKey', () => {
  it('prefers `event` over `type` when both are present', () => {
    expect(resolveEventKey({ event: 'awaiting_feedback', type: 'awaiting_input' })).toBe(
      'awaiting_feedback',
    );
  });
  it('falls back to `type` for server-pushed payloads', () => {
    expect(resolveEventKey({ type: 'thread_message' })).toBe('thread_message');
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
    const sessions = [{ id: 's1', agent_id: 'a1' }, { id: 's2', agent_id: 'a2' }];
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
    (event) => {
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

describe('routeNotificationTap — thread events', () => {
  it('routes thread_message to the Threads screen for the project', () => {
    const data = { event: 'thread_message', projectId: 'p1', threadId: 't1' };
    expect(routeNotificationTap(data)).toEqual({
      kind: 'threads',
      projectId: 'p1',
      threadId: 't1',
    });
  });

  it('returns null when thread events lack projectId — no screen to open', () => {
    expect(routeNotificationTap({ event: 'thread_message', threadId: 't1' })).toBeNull();
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

  it('maps kanban / threads / support kinds to their screens', () => {
    expect(
      notificationRouteToNavigation({ kind: 'kanban', projectId: 'p1', cardId: 'c1' }),
    ).toEqual({ screen: 'Kanban', params: { projectId: 'p1', cardId: 'c1' } });

    expect(
      notificationRouteToNavigation({ kind: 'threads', projectId: 'p1', threadId: 't1' }),
    ).toEqual({ screen: 'Threads', params: { projectId: 'p1', threadId: 't1' } });

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

  it('returns null for the chat kind and for null/garbage', () => {
    expect(
      notificationRouteToNavigation({ kind: 'chat', agentId: 'a1', sessionId: 's1' }),
    ).toBeNull();
    expect(notificationRouteToNavigation(null)).toBeNull();
    expect(notificationRouteToNavigation(undefined)).toBeNull();
    expect(notificationRouteToNavigation('nope')).toBeNull();
  });
});
