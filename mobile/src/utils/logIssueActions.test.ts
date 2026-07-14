import { describe, expect, it } from 'vitest';
import {
  logIssueActionKey,
  logIssueActionLabel,
  logIssueActionEventIsStale,
  logIssueActionEventIsOutOfOrder,
  logIssueActionLinks,
  type LogIssueActionEvent,
} from '@shared/utils/logIssueActions';

describe('mobile Logs action state helpers', () => {
  it('maps REST links to the canonical session/card controls', () => {
    const issue = {
      analyzeSessionId: 'analysis-1',
      fixSessionId: 'fix-1',
      fixCardId: 'card-1',
    };
    expect(logIssueActionLinks(issue, 'analyze')).toEqual({
      sessionId: 'analysis-1',
      cardId: null,
    });
    expect(logIssueActionLinks(issue, 'fix')).toEqual({
      sessionId: 'fix-1',
      cardId: 'card-1',
    });
  });

  it('keeps explicit action events project/issue scoped', () => {
    const event: LogIssueActionEvent = {
      type: 'log_issue_action',
      projectId: 'p1',
      issueId: 'i1',
      action: 'fix',
      status: 'completed',
      sessionId: 's1',
      cardId: 'c1',
    };
    expect(logIssueActionKey(event.issueId, event.action)).toBe('i1:fix');
    expect(logIssueActionLabel(event.action)).toBe('Fix');
  });

  it('accepts start-another lifecycle events over the old canonical link', () => {
    const oldLinks = { sessionId: 'old-session', cardId: 'old-card' };
    expect(
      logIssueActionEventIsStale(oldLinks, {
        status: 'in_flight',
        sessionId: 'new-session',
        cardId: 'new-card',
      }),
    ).toBe(false);
    expect(
      logIssueActionEventIsStale(oldLinks, {
        status: 'completed',
        sessionId: 'new-session',
        cardId: 'new-card',
      }),
    ).toBe(false);
    expect(
      logIssueActionEventIsStale(oldLinks, {
        status: 'failed',
        sessionId: 'other-session',
        cardId: 'other-card',
      }),
    ).toBe(true);
  });

  it('rejects a delayed terminal event from the replaced workflow', () => {
    expect(
      logIssueActionEventIsOutOfOrder(
        { status: 'in_flight', sessionId: 'new-session', cardId: 'new-card' },
        { status: 'completed', sessionId: 'old-session', cardId: 'old-card' },
      ),
    ).toBe(true);
    expect(
      logIssueActionEventIsOutOfOrder(
        { status: 'in_flight', sessionId: 'new-session', cardId: 'new-card' },
        { status: 'completed', sessionId: 'new-session', cardId: 'new-card' },
      ),
    ).toBe(false);
  });
});
