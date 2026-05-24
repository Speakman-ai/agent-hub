/**
 * Notification message formatters.
 *
 * Pure functions that build notification titles and body text
 * for card-moved, PR-merged, and session-complete WebSocket events.
 */

/**
 * Build notification content for a card moved to "In Progress".
 * @param {{ cardTitle: string, assignee?: string }} data
 * @returns {{ title: string, body: string }}
 */
export function cardStartedNotification({ cardTitle, assignee }) {
  const body = `"${cardTitle}" started${assignee ? ` by ${assignee}` : ''}`;
  return { title: 'Ticket Started', body };
}

/**
 * Build notification content for a card moved to "Review".
 * @param {{ cardTitle: string, assignee?: string }} data
 * @returns {{ title: string, body: string }}
 */
export function cardReviewNotification({ cardTitle, assignee }) {
  const body = `"${cardTitle}" moved to Review${assignee ? ` (${assignee})` : ''}`;
  return { title: 'PR Ready for Review', body };
}

/**
 * Build notification content for a merged PR.
 * @param {{ cardTitle: string, prNumber: number, mergedBy?: string }} data
 * @returns {{ title: string, body: string }}
 */
export function prMergedNotification({ cardTitle, prNumber, mergedBy }) {
  const body = `PR #${prNumber} merged${mergedBy ? ` by ${mergedBy}` : ''}: "${cardTitle}"`;
  return { title: 'PR Merged', body };
}

/**
 * Build notification content for a session whose agent is prompting to create a PR.
 * Fires when the server broadcasts `changes_ready` — the agent completed work in
 * a worktree with uncommitted/unpushed changes and the user needs to decide
 * whether to create a ticket + PR.
 *
 * @param {{ agentName?: string, sessionName?: string, branch?: string }} data
 * @returns {{ title: string, body: string }}
 */
export function prReadyNotification({ agentName, sessionName, branch }) {
  const title = 'Changes Ready — Create PR?';
  const parts = [];
  if (agentName) parts.push(agentName);
  if (sessionName) parts.push(`"${sessionName}"`);
  const who = parts.join(' — ');
  const where = branch ? ` on \`${branch}\`` : '';
  const body = who
    ? `${who} has changes${where} awaiting PR creation`
    : `An agent has changes${where} awaiting PR creation`;
  return { title, body };
}

/**
 * Build notification content for a completed agent session.
 * @param {{ agentName: string, sessionName?: string, preview?: string }} data
 * @returns {{ title: string, body: string }}
 */
/**
 * Build notification content for a new thread being created.
 * @param {{ threadName: string, threadType: string }} data
 * @returns {{ title: string, body: string }}
 */
export function threadCreatedNotification({ threadName, threadType }) {
  const label = threadType === 'heartbeat' ? 'Heartbeat' : 'Cron';
  const body = `New ${label} thread: "${threadName}"`;
  return { title: 'Thread Created', body };
}

/**
 * Build notification content for a new thread entry.
 * @param {{ threadName: string, threadType: string, preview?: string, isError?: boolean }} data
 * @returns {{ title: string, body: string }}
 */
export function threadEntryNotification({ threadName, threadType, preview, isError }) {
  const label = threadType === 'heartbeat' ? 'Heartbeat' : 'Cron';
  const title = isError ? `${label} Error` : `${label} Update`;
  const trimmed = preview && preview.length > 120 ? preview.substring(0, 120) + '…' : preview;
  const body = trimmed ? `${threadName}: ${trimmed}` : `New entry in "${threadName}"`;
  return { title, body };
}

/**
 * Build notification content for a session that has just stopped to ask the
 * user a multi-choice question (`agenthub:ask` picker) or is otherwise blocked
 * on user input. Fires when the server broadcasts `awaiting_input` with
 * `waiting: true` and the affected session is not the one the user is
 * currently viewing.
 *
 * @param {{ agentName?: string, sessionName?: string, askCount?: number }} data
 * @returns {{ title: string, body: string }}
 */
export function awaitingInputNotification({ agentName, sessionName, askCount }) {
  const title = 'Agent Waiting for You';
  const parts = [];
  if (agentName) parts.push(agentName);
  if (sessionName) parts.push(`"${sessionName}"`);
  const who = parts.join(' — ');
  const question =
    askCount && askCount > 1 ? `${askCount} questions need answers` : 'is waiting on your input';
  const body = who ? `${who} ${question}` : `An agent ${question}`;
  return { title, body };
}

export function sessionCompleteNotification({ agentName, sessionName, preview }) {
  const title = `${agentName} — Done`;
  const parts = [];
  if (sessionName) parts.push(`"${sessionName}"`);
  if (preview) {
    const trimmed = preview.length > 120 ? '…' + preview.slice(-120) : preview;
    parts.push(trimmed);
  }
  const body = parts.join(' — ') || 'Session completed';
  return { title, body };
}
