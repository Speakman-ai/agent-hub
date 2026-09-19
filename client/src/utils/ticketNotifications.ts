/**
 * Notification titles and bodies for card-moved, PR-merged, and session-complete events.
 */

export function cardStartedNotification({ cardTitle, assignee }: any) {
  const body = `"${cardTitle}" started${assignee ? ` by ${assignee}` : ''}`;
  return { title: 'Ticket Started', body };
}

export function cardReviewNotification({ cardTitle, assignee }: any) {
  const body = `"${cardTitle}" moved to Review${assignee ? ` (${assignee})` : ''}`;
  return { title: 'PR Ready for Review', body };
}

export function prMergedNotification({ cardTitle, prNumber, mergedBy }: any) {
  const body = `PR #${prNumber} merged${mergedBy ? ` by ${mergedBy}` : ''}: "${cardTitle}"`;
  return { title: 'PR Merged', body };
}

/**
 * `changes_ready`: worktree has uncommitted/unpushed changes; user decides
 * whether to create a ticket + PR.
 */
export function prReadyNotification({ agentName, sessionName, branch }: any) {
  const title = 'Changes Ready — Create PR?';
  const parts: any[] = [];
  if (agentName) parts.push(agentName);
  if (sessionName) parts.push(`"${sessionName}"`);
  const who = parts.join(' — ');
  const where = branch ? ` on \`${branch}\`` : '';
  const body = who
    ? `${who} has changes${where} awaiting PR creation`
    : `An agent has changes${where} awaiting PR creation`;
  return { title, body };
}

export function threadCreatedNotification({ threadName, threadType }: any) {
  const label = threadType === 'heartbeat' ? 'Heartbeat' : 'Cron';
  const body = `New ${label} thread: "${threadName}"`;
  return { title: 'Thread Created', body };
}

export function threadEntryNotification({ threadName, threadType, preview, isError }: any) {
  const label = threadType === 'heartbeat' ? 'Heartbeat' : 'Cron';
  const title = isError ? `${label} Error` : `${label} Update`;
  const trimmed = preview && preview.length > 120 ? preview.substring(0, 120) + '…' : preview;
  const body = trimmed ? `${threadName}: ${trimmed}` : `New entry in "${threadName}"`;
  return { title, body };
}

/**
 * `awaiting_input` with `waiting: true` while the user is not viewing that session.
 */
export function awaitingInputNotification({ agentName, sessionName, askCount }: any) {
  const title = 'Agent Waiting for You';
  const parts: any[] = [];
  if (agentName) parts.push(agentName);
  if (sessionName) parts.push(`"${sessionName}"`);
  const who = parts.join(' — ');
  const question =
    askCount && askCount > 1 ? `${askCount} questions need answers` : 'is waiting on your input';
  const body = who ? `${who} ${question}` : `An agent ${question}`;
  return { title, body };
}

export function sessionCompleteNotification({ agentName, sessionName, preview }: any) {
  const title = `${agentName} — Done`;
  const parts: any[] = [];
  if (sessionName) parts.push(`"${sessionName}"`);
  if (preview) {
    const trimmed = preview.length > 120 ? '…' + preview.slice(-120) : preview;
    parts.push(trimmed);
  }
  const body = parts.join(' — ') || 'Session completed';
  return { title, body };
}
