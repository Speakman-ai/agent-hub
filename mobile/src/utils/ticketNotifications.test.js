import { describe, it, expect } from 'vitest';
import {
  cardStartedNotification,
  cardReviewNotification,
  prMergedNotification,
  prReadyNotification,
  sessionCompleteNotification,
  threadCreatedNotification,
  threadEntryNotification,
  dispatchFailureNotification,
  mapBroadcastToNotification,
} from './ticketNotifications.js';

describe('ticketNotification formatters', () => {
  it('formats card started with assignee', () => {
    expect(cardStartedNotification({ cardTitle: 'X', assignee: 'A' })).toEqual({
      title: 'Ticket Started',
      body: '"X" started by A',
    });
    expect(cardStartedNotification({ cardTitle: 'X' }).body).toBe('"X" started');
  });

  it('formats card review, PR merged, prReady variants', () => {
    expect(cardReviewNotification({ cardTitle: 'X', assignee: 'A' }).body).toBe(
      '"X" moved to Review (A)',
    );
    expect(prMergedNotification({ cardTitle: 'X', prNumber: 7 }).body).toBe(
      'PR #7 merged: "X"',
    );
    expect(prReadyNotification({ agentName: 'H', branch: 'f/x' }).body).toContain(
      'H has changes on',
    );
    expect(prReadyNotification({}).body).toMatch(/An agent has changes/);
  });

  it('formats sessionComplete and truncates long preview', () => {
    expect(sessionCompleteNotification({ agentName: 'H', sessionName: 'S' }).title).toBe(
      'H — Done',
    );
    const long = 'x'.repeat(200);
    expect(
      sessionCompleteNotification({ agentName: 'H', preview: long }).body.startsWith('…'),
    ).toBe(true);
    expect(sessionCompleteNotification({}).body).toBe('Session completed');
  });

  it('formats thread events and caps entry preview', () => {
    expect(threadCreatedNotification({ threadName: 'T', threadType: 'heartbeat' }).body).toContain(
      'Heartbeat',
    );
    expect(
      threadEntryNotification({ threadName: 'T', threadType: 'cron', isError: true }).title,
    ).toBe('Cron Error');
    const long = 'y'.repeat(200);
    expect(
      threadEntryNotification({ threadName: 'T', threadType: 'cron', preview: long }).body.endsWith(
        '…',
      ),
    ).toBe(true);
  });

  it('formats dispatch failure and truncates long messages', () => {
    const long = 'z'.repeat(300);
    expect(dispatchFailureNotification({ message: long }).body.endsWith('…')).toBe(true);
    expect(dispatchFailureNotification({ message: '' }).body).toBe(
      'An autonomous dispatch failed',
    );
  });
});

describe('mapBroadcastToNotification', () => {
  it('returns null for irrelevant types / missing data', () => {
    expect(mapBroadcastToNotification(null)).toBeNull();
    expect(mapBroadcastToNotification({})).toBeNull();
    expect(mapBroadcastToNotification({ type: 'stream' })).toBeNull();
  });

  it('maps "done" to session_complete with preview', () => {
    const r = mapBroadcastToNotification({
      type: 'done',
      agentName: 'H',
      sessionName: 'S',
      message: { content: 'All\n\ndone.' },
    });
    expect(r).not.toBeNull();
    expect(r.event).toBe('session_complete');
    expect(r.title).toBe('H — Done');
    expect(r.body).toContain('All done.');
  });

  it('maps changes_ready and card_moved', () => {
    expect(
      mapBroadcastToNotification({ type: 'changes_ready', agentName: 'H', branch: 'f/x' }).event,
    ).toBe('changes_ready');
    expect(
      mapBroadcastToNotification({
        type: 'card_moved',
        columnName: 'In Progress',
        cardTitle: 'T',
      }).event,
    ).toBe('card_started');
    expect(
      mapBroadcastToNotification({
        type: 'card_moved',
        columnName: 'Review',
        cardTitle: 'T',
      }).event,
    ).toBe('card_review');
    expect(
      mapBroadcastToNotification({ type: 'card_moved', columnName: 'Done', cardTitle: 'T' }),
    ).toBeNull();
  });

  it('maps thread events and flags ERROR entries', () => {
    expect(
      mapBroadcastToNotification({
        type: 'thread_created',
        thread: { name: 'Nightly', type: 'cron' },
      }).event,
    ).toBe('thread_created');
    const entry = mapBroadcastToNotification({
      type: 'thread_entry_created',
      threadName: 'Nightly',
      threadType: 'cron',
      entry: { content: 'ERROR: boom' },
    });
    expect(entry.event).toBe('thread_entry');
    expect(entry.title).toBe('Cron Error');
  });

  it('maps dispatch_failure', () => {
    const r = mapBroadcastToNotification({ type: 'dispatch_failure', message: 'boom' });
    expect(r.event).toBe('dispatch_failure');
    expect(r.title).toBe('Dispatch Failure');
    expect(r.body).toContain('boom');
  });
});

describe('mapBroadcastToNotification — account scoping (ownerUserId)', () => {
  const doneEvent = (ownerUserId) => ({
    type: 'done',
    sessionId: 's1',
    agentName: 'H',
    sessionName: 'S',
    ownerUserId,
    message: { content: 'ok' },
  });

  it("suppresses another user's session events", () => {
    expect(mapBroadcastToNotification(doneEvent('kevin'), { currentUserId: 'ryan' })).toBeNull();
    expect(
      mapBroadcastToNotification(
        { type: 'changes_ready', sessionId: 's1', ownerUserId: 'kevin', branch: 'f/x' },
        { currentUserId: 'ryan' },
      ),
    ).toBeNull();
  });

  it("shows the current user's own session events", () => {
    const r = mapBroadcastToNotification(doneEvent('ryan'), { currentUserId: 'ryan' });
    expect(r?.event).toBe('session_complete');
  });

  it('shows unowned events (cron/system sessions) to everyone', () => {
    expect(mapBroadcastToNotification(doneEvent(null), { currentUserId: 'ryan' })?.event).toBe(
      'session_complete',
    );
    expect(mapBroadcastToNotification(doneEvent(undefined), { currentUserId: 'ryan' })?.event).toBe(
      'session_complete',
    );
  });

  it('shows owned events when the caller has no per-user identity (legacy apiKey)', () => {
    expect(mapBroadcastToNotification(doneEvent('kevin'), {})?.event).toBe('session_complete');
    expect(mapBroadcastToNotification(doneEvent('kevin'))?.event).toBe('session_complete');
  });

  it('never scopes non-session events', () => {
    const r = mapBroadcastToNotification(
      { type: 'card_moved', columnName: 'Review', cardTitle: 'T', ownerUserId: 'kevin' },
      { currentUserId: 'ryan' },
    );
    // card_moved carries no session owner semantics today; if a stray
    // ownerUserId shows up it is still honored — this documents that the
    // gate is on the field, not the event type.
    expect(r).toBeNull();
  });
});
