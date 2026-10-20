import { describe, it, expect } from 'vitest';
import { notificationTarget, type InboxNotification } from './notificationTarget';

function row(over: Partial<InboxNotification>): InboxNotification {
  return {
    id: 'n1',
    userId: 'u1',
    orgId: null,
    projectId: 'acme',
    category: 'awaiting_feedback',
    title: 't',
    body: 'b',
    route: null,
    data: null,
    sourceKey: 'k',
    createdAt: '2026-10-15T12:00:00.000Z',
    readAt: null,
    ...over,
  };
}

describe('notificationTarget', () => {
  it('opens the session for session categories', () => {
    expect(
      notificationTarget(
        row({ category: 'finalize_failed', data: { sessionId: 's1', agentId: 'a1' } }),
      ),
    ).toEqual({ kind: 'session', sessionId: 's1', agentId: 'a1' });
    expect(
      notificationTarget(row({ category: 'session_completed', data: { sessionId: 's2' } })),
    ).toEqual({ kind: 'session', sessionId: 's2', agentId: null });
  });

  it('opens the Reminders pane for reminders, even ones set from a session', () => {
    expect(
      notificationTarget(
        row({ category: 'reminder', data: { reminderId: 'r1', sessionId: 's1', agentId: 'a1' } }),
      ),
    ).toEqual({ kind: 'route', route: { view: 'hub', hubPane: 'reminders' } });
  });

  it('opens the card on the board for card assignments', () => {
    expect(
      notificationTarget(
        row({ category: 'card_assigned_to_you', data: { projectId: 'acme', cardId: 'c1' } }),
      ),
    ).toEqual({ kind: 'route', route: { view: 'kanban:acme', cardId: 'c1' } });
  });

  it('prefers the card over the PR for reviews, and falls back to the PR', () => {
    expect(
      notificationTarget(
        row({ category: 'review_assigned_to_you', data: { cardId: 'c1', prNumber: 7 } }),
      ),
    ).toEqual({ kind: 'route', route: { view: 'kanban:acme', cardId: 'c1' } });
    expect(
      notificationTarget(row({ category: 'pr_merged', data: { projectId: 'acme', prNumber: 7 } })),
    ).toEqual({ kind: 'route', route: { view: 'pulls', projectId: 'acme', prNumber: 7 } });
  });

  it('opens the support ticket', () => {
    expect(
      notificationTarget(
        row({ category: 'support_ticket_created', data: { projectId: 'acme', ticketId: 't9' } }),
      ),
    ).toEqual({ kind: 'route', route: { view: 'support', projectId: 'acme', ticketId: 't9' } });
  });

  it('opens the Hub Chat channel at the message for DMs and mentions', () => {
    expect(
      notificationTarget(
        row({ category: 'mention', projectId: null, data: { channelId: 'ch1', messageId: 'm1' } }),
      ),
    ).toEqual({
      kind: 'route',
      route: { view: 'hub', hubPane: 'chat', chatChannelId: 'ch1', chatMessageId: 'm1' },
    });
    expect(notificationTarget(row({ category: 'dm', projectId: null, data: {} }))).toBeNull();
  });

  it('opens infra and deployments per project', () => {
    expect(notificationTarget(row({ category: 'infra_alert', data: {} }))).toEqual({
      kind: 'route',
      route: { view: 'infra:acme' },
    });
    expect(notificationTarget(row({ category: 'deploy_outcome', data: {} }))).toEqual({
      kind: 'route',
      route: { view: 'deployments', projectId: 'acme' },
    });
  });

  it('opens the PR when its preview is ready', () => {
    expect(
      notificationTarget(row({ category: 'pr_environment_ready', data: { prNumber: 12 } })),
    ).toEqual({ kind: 'route', route: { view: 'pulls', projectId: 'acme', prNumber: 12 } });
  });

  it('opens a routine run session, or the cron jobs when the run never got one', () => {
    expect(
      notificationTarget(
        row({ category: 'routine_run', data: { sessionId: 's9', agentId: 'ops' } }),
      ),
    ).toEqual({ kind: 'session', sessionId: 's9', agentId: 'ops' });
    expect(notificationTarget(row({ category: 'routine_run', data: { cronId: 7 } }))).toEqual({
      kind: 'route',
      route: { view: 'project-crons:acme' },
    });
  });

  it('honors an explicit route hash', () => {
    const t = notificationTarget(row({ route: '#/projects/acme/pulls/12', data: null }));
    expect(t?.kind).toBe('route');
  });

  it('returns null when nothing is openable', () => {
    expect(notificationTarget(row({ category: 'awaiting_feedback', data: {} }))).toBeNull();
  });
});

describe('notificationTarget — browser sign-in', () => {
  it('opens the session with the Agent browser pane', () => {
    expect(
      notificationTarget(
        row({ category: 'browser_sign_in', data: { sessionId: 's1', agentId: 'a1' } }),
      ),
    ).toEqual({ kind: 'session', sessionId: 's1', agentId: 'a1', pane: 'browser' });
    expect(notificationTarget(row({ category: 'browser_sign_in', data: {} }))).toBeNull();
  });
});

describe('notificationTarget — approval requested', () => {
  it('opens the session that is waiting on the approval', () => {
    expect(
      notificationTarget(
        row({
          category: 'approval_requested',
          data: { sessionId: 's1', agentId: 'a1', approvalId: 'ap1' },
        }),
      ),
    ).toEqual({ kind: 'session', sessionId: 's1', agentId: 'a1' });
    expect(notificationTarget(row({ category: 'approval_requested', data: {} }))).toBeNull();
  });
});
