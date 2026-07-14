/** Shared wire/state helpers for the Logs issue Analyze and Fix actions. */

export type LogIssueAction = 'analyze' | 'fix';
export type LogIssueActionStatus = 'in_flight' | 'completed' | 'failed';

export interface LogIssueActionEvent {
  type: 'log_issue_action';
  projectId: string;
  issueId: string;
  action: LogIssueAction;
  status: LogIssueActionStatus;
  sessionId?: string | null;
  agentId?: string | null;
  cardId?: string | null;
  error?: string | null;
}

export interface LogIssueActionLinks {
  sessionId: string | null;
  cardId: string | null;
}

export function logIssueActionKey(issueId: string, action: LogIssueAction): string {
  return `${issueId}:${action}`;
}

export function logIssueActionLinks(
  issue: {
    analyzeSessionId?: string | null;
    fixSessionId?: string | null;
    fixCardId?: string | null;
  },
  action: LogIssueAction,
): LogIssueActionLinks {
  return action === 'analyze'
    ? { sessionId: issue.analyzeSessionId ?? null, cardId: null }
    : { sessionId: issue.fixSessionId ?? null, cardId: issue.fixCardId ?? null };
}

/**
 * A failed event may arrive after an explicitly started replacement workflow.
 * Protect that newer canonical link, while allowing every in-flight/completed
 * event to replace an older link as the server intends.
 */
export function logIssueActionEventIsStale(
  links: LogIssueActionLinks,
  event: Pick<LogIssueActionEvent, 'status' | 'sessionId' | 'cardId'>,
): boolean {
  if (event.status !== 'failed') return false;
  return Boolean(
    (event.sessionId && links.sessionId && event.sessionId !== links.sessionId) ||
    (event.cardId && links.cardId && event.cardId !== links.cardId),
  );
}

/** Ignore a terminal event from a workflow superseded by the latest lifecycle event. */
export function logIssueActionEventIsOutOfOrder(
  previousEvent: Pick<LogIssueActionEvent, 'status' | 'sessionId' | 'cardId'> | undefined,
  event: Pick<LogIssueActionEvent, 'status' | 'sessionId' | 'cardId'>,
): boolean {
  if (!previousEvent || event.status === 'in_flight') return false;
  return Boolean(
    (previousEvent.sessionId && event.sessionId && previousEvent.sessionId !== event.sessionId) ||
    (previousEvent.cardId && event.cardId && previousEvent.cardId !== event.cardId),
  );
}

export function logIssueActionLabel(action: LogIssueAction): string {
  return action === 'analyze' ? 'Analyze' : 'Fix';
}
