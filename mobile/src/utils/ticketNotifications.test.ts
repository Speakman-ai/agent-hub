// @ts-nocheck
import { describe, it, expect } from 'vitest';
import {
  awaitingFeedbackNotification,
  readyToPushNotification,
  pushedNotification,
  supportTicketCreatedNotification,
  threadMessageNotification,
  reviewAssignedNotification,
  prMergedNotification,
  infraAlertNotification,
  mapBroadcastToNotification,
} from './ticketNotifications';
describe('ticketNotification formatters', () => {
  it('formats awaiting feedback', () => {
    expect(awaitingFeedbackNotification({ sessionName: 'Ship' })).toEqual({
      title: 'Awaiting feedback',
      body: '"Ship" is waiting for your input',
    });
    expect(awaitingFeedbackNotification({}).body).toBe('A session is waiting for your input');
  });
  it('formats ready to push and pushed', () => {
    expect(readyToPushNotification({ sessionName: 'Ship' }).title).toBe('Ready to push');
    expect(pushedNotification({ sessionName: 'Ship', prNumber: 7 }).body).toBe(
      '"Ship" was pushed (PR #7)',
    );
  });
  it('formats support ticket created', () => {
    expect(supportTicketCreatedNotification({ subject: 'Help', ticketType: 'bug' }).body).toBe(
      'bug: Help',
    );
  });
  it('formats thread messages and truncates long preview', () => {
    expect(threadMessageNotification({ threadName: 'T', threadType: 'heartbeat' }).title).toBe(
      'Heartbeat message',
    );
    const long = 'y'.repeat(200);
    expect(
      threadMessageNotification({
        threadName: 'T',
        threadType: 'cron',
        preview: long,
      }).body.endsWith('…'),
    ).toBe(true);
  });
  it('formats review assigned and PR merged', () => {
    expect(reviewAssignedNotification({ cardTitle: 'X' }).body).toBe('"X" needs your review');
    expect(prMergedNotification({ cardTitle: 'X', prNumber: 7, mergedBy: 'dev' }).body).toBe(
      'PR #7 merged by dev: "X"',
    );
  });
  it('formats infrastructure alert transitions', () => {
    expect(
      infraAlertNotification({
        severity: 'critical',
        ruleName: 'CPU high',
        resourceId: 'i-123',
        fromState: 'OK',
        toState: 'ALARM',
      }),
    ).toEqual({
      title: 'Critical infrastructure alert',
      body: 'CPU high on i-123: OK → ALARM',
    });
  });
});
describe('mapBroadcastToNotification', () => {
  it('returns null for irrelevant types / missing data', () => {
    expect(mapBroadcastToNotification(null)).toBeNull();
    expect(mapBroadcastToNotification({})).toBeNull();
    expect(mapBroadcastToNotification({ type: 'stream' })).toBeNull();
    expect(mapBroadcastToNotification({ type: 'done' })).toBeNull();
  });
  it('maps awaiting_input when waiting=true', () => {
    const r = mapBroadcastToNotification({
      type: 'awaiting_input',
      waiting: true,
      sessionName: 'S',
    });
    expect(r).not.toBeNull();
    expect(r.event).toBe('awaiting_feedback');
    expect(r.title).toBe('Awaiting feedback');
  });
  it('maps finalize_run_completed statuses', () => {
    expect(
      mapBroadcastToNotification({
        type: 'finalize_run_completed',
        status: 'ready_to_push',
        sessionName: 'S',
      }).event,
    ).toBe('ready_to_push');
    expect(
      mapBroadcastToNotification({
        type: 'finalize_run_completed',
        status: 'pushed',
        sessionName: 'S',
        prNumber: 3,
      }).event,
    ).toBe('pushed');
    expect(
      mapBroadcastToNotification({ type: 'finalize_run_completed', status: 'failed' }),
    ).toBeNull();
  });
  it('maps card_moved to review_assigned_to_you only for Review', () => {
    expect(
      mapBroadcastToNotification({
        type: 'card_moved',
        columnName: 'Review',
        cardTitle: 'T',
      }).event,
    ).toBe('review_assigned_to_you');
    expect(
      mapBroadcastToNotification({ type: 'card_moved', columnName: 'Done', cardTitle: 'T' }),
    ).toBeNull();
  });
  it('maps thread_entry_created and flags ERROR entries', () => {
    const entry = mapBroadcastToNotification({
      type: 'thread_entry_created',
      threadName: 'Nightly',
      threadType: 'cron',
      entry: { content: 'ERROR: boom' },
    });
    expect(entry.event).toBe('thread_message');
    expect(entry.title).toBe('Thread error');
  });
  it('suppresses retired heartbeat thread entries', () => {
    expect(
      mapBroadcastToNotification({
        type: 'thread_entry_created',
        threadName: 'Daily Check',
        threadType: 'heartbeat',
        entry: { content: 'ok' },
      }),
    ).toBeNull();
  });
  it('maps support_ticket_created and webhook_pr_merged', () => {
    expect(
      mapBroadcastToNotification({
        type: 'support_ticket_created',
        ticket: { subject: 'Help', type: 'bug' },
      }).event,
    ).toBe('support_ticket_created');
    expect(
      mapBroadcastToNotification({
        type: 'webhook_pr_merged',
        cardTitle: 'X',
        prNumber: 5,
      }).event,
    ).toBe('pr_merged');
  });
});
describe('mapBroadcastToNotification — account scoping (ownerUserId)', () => {
  const awaitingEvent = (ownerUserId: any) => ({
    type: 'awaiting_input',
    waiting: true,
    sessionId: 's1',
    sessionName: 'S',
    ownerUserId,
  });
  it("suppresses another user's session events", () => {
    expect(
      mapBroadcastToNotification(awaitingEvent('kevin'), { currentUserId: 'ryan' }),
    ).toBeNull();
    expect(
      mapBroadcastToNotification(
        {
          type: 'finalize_run_completed',
          status: 'ready_to_push',
          sessionId: 's1',
          ownerUserId: 'kevin',
        },
        { currentUserId: 'ryan' },
      ),
    ).toBeNull();
  });
  it("shows the current user's own session events", () => {
    const r = mapBroadcastToNotification(awaitingEvent('ryan'), { currentUserId: 'ryan' });
    expect(r?.event).toBe('awaiting_feedback');
  });
  it('shows unowned events (cron/system sessions) to everyone', () => {
    expect(mapBroadcastToNotification(awaitingEvent(null), { currentUserId: 'ryan' })?.event).toBe(
      'awaiting_feedback',
    );
    expect(
      mapBroadcastToNotification(awaitingEvent(undefined), { currentUserId: 'ryan' })?.event,
    ).toBe('awaiting_feedback');
  });
  it("suppresses another user's owned session event for an unattributed client (no local bypass)", () => {
    // Regression: a session-only broadcast carries `ownerUserId` but no
    // resolvable project, so the project gate can't catch it. An API-key /
    // unauthed client (me === null) on a multi-user server must NOT see it.
    expect(mapBroadcastToNotification(awaitingEvent('kevin'), {})).toBeNull();
    expect(mapBroadcastToNotification(awaitingEvent('kevin'))).toBeNull();
  });
  it('shows owned session events to an unknown caller only with an explicit local bypass', () => {
    // `localBypass` from a real local/bundled single-user signal is the only
    // case that permits an owned event through without a matching user id.
    expect(mapBroadcastToNotification(awaitingEvent('kevin'), { localBypass: true })?.event).toBe(
      'awaiting_feedback',
    );
  });
  it('lets shared cron thread messages notify non-owners but keeps private cron messages scoped', () => {
    const base = {
      type: 'thread_entry_created',
      projectId: 'p1',
      threadName: 'Nightly audit',
      threadType: 'cron',
      ownerUserId: 'kevin',
      entry: { content: 'Done' },
    };
    expect(
      mapBroadcastToNotification({ ...base, cronShared: false }, { currentUserId: 'ryan' }),
    ).toBeNull();
    expect(
      mapBroadcastToNotification({ ...base, cronShared: true }, { currentUserId: 'ryan' })?.event,
    ).toBe('thread_message');
  });
  it('never scopes non-session events without a resolvable project', () => {
    const r = mapBroadcastToNotification(
      { type: 'card_moved', columnName: 'Review', cardTitle: 'T', ownerUserId: 'kevin' },
      { currentUserId: 'ryan' },
    );
    expect(r).toBeNull();
  });
});
describe('mapBroadcastToNotification — project scoping (ownerUserId on project)', () => {
  const projects = [
    { id: 'mine', ownerUserId: 'ryan' },
    { id: 'theirs', ownerUserId: 'kevin' },
  ];
  it("suppresses another user's project events", () => {
    expect(
      mapBroadcastToNotification(
        {
          type: 'thread_entry_created',
          projectId: 'theirs',
          threadName: 'N',
          threadType: 'cron',
          entry: { content: 'ok' },
        },
        { currentUserId: 'ryan', projects },
      ),
    ).toBeNull();
    expect(
      mapBroadcastToNotification(
        { type: 'card_moved', columnName: 'Review', cardTitle: 'T', projectId: 'theirs' },
        { currentUserId: 'ryan', projects },
      ),
    ).toBeNull();
  });
  it('shows events for projects the current user owns', () => {
    const r = mapBroadcastToNotification(
      {
        type: 'thread_entry_created',
        projectId: 'mine',
        threadName: 'Nightly',
        threadType: 'cron',
        entry: { content: 'ok' },
      },
      { currentUserId: 'ryan', projects },
    );
    expect(r?.event).toBe('thread_message');
  });
  it("suppresses another user's project event for an unattributed client without a real local bypass", () => {
    // Regression: a missing currentUserId must NOT be treated as a local
    // bypass. An API-key / unattributed client on a multi-user server has no
    // local single-user boundary, so an owned project's banner is suppressed.
    const r = mapBroadcastToNotification(
      { type: 'card_moved', columnName: 'Review', cardTitle: 'T', projectId: 'theirs' },
      { projects },
    );
    expect(r).toBeNull();
  });
  it('delivers an owned project event only with an explicit local/bundled bypass', () => {
    // `localBypass` comes from a real signal (server has no auth configured →
    // single-user). With it set, the on-device owner scoping is bypassed.
    const r = mapBroadcastToNotification(
      { type: 'card_moved', columnName: 'Review', cardTitle: 'T', projectId: 'theirs' },
      { projects, localBypass: true },
    );
    expect(r?.event).toBe('review_assigned_to_you');
  });
});
