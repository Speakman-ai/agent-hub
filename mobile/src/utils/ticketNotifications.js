/**
 * In-app notification message formatters.
 *
 * Mirror of `client/src/utils/ticketNotifications.js` and the server-side
 * `server/push.ts` formatters — kept in sync so mobile in-app banners use
 * the same wording as desktop notifications and Expo push payloads.
 *
 * Pure functions: no React / Expo imports so the file can be unit-tested
 * under Vitest without native mocks.
 */

/** @typedef {{ title: string, body: string }} NotificationContent */

/**
 * Build content for a merged PR.
 * @param {{ cardTitle: string, prNumber: number, mergedBy?: string }} data
 * @returns {NotificationContent}
 */
export function prMergedNotification({ cardTitle, prNumber, mergedBy }) {
  return {
    title: 'PR Merged',
    body: `PR #${prNumber} merged${mergedBy ? ` by ${mergedBy}` : ''}: "${cardTitle}"`,
  };
}

/**
 * Build content for a session with uncommitted changes awaiting PR.
 * @param {{ agentName?: string, sessionName?: string, branch?: string }} data
 * @returns {NotificationContent}
 */
export function prReadyNotification({ agentName, sessionName, branch }) {
  const parts = [];
  if (agentName) parts.push(agentName);
  if (sessionName) parts.push(`"${sessionName}"`);
  const who = parts.join(' — ');
  const where = branch ? ` on \`${branch}\`` : '';
  const body = who
    ? `${who} has changes${where} awaiting PR creation`
    : `An agent has changes${where} awaiting PR creation`;
  return { title: 'Changes Ready — Create PR?', body };
}

/**
 * Build content for a completed agent session.
 * @param {{ agentName?: string, sessionName?: string, preview?: string }} data
 * @returns {NotificationContent}
 */
export function sessionCompleteNotification({ agentName, sessionName, preview }) {
  const title = `${agentName || 'Agent'} — Done`;
  const parts = [];
  if (sessionName) parts.push(`"${sessionName}"`);
  if (preview) {
    const trimmed = preview.length > 120 ? '…' + preview.slice(-120) : preview;
    parts.push(trimmed);
  }
  return { title, body: parts.join(' — ') || 'Session completed' };
}

/**
 * Build content for a new thread being created.
 * @param {{ threadName: string, threadType: string }} data
 * @returns {NotificationContent}
 */
export function threadCreatedNotification({ threadName, threadType }) {
  const label = threadType === 'heartbeat' ? 'Heartbeat' : 'Cron';
  return { title: 'Thread Created', body: `New ${label} thread: "${threadName}"` };
}

/**
 * Build content for a new thread entry.
 * @param {{ threadName: string, threadType: string, preview?: string, isError?: boolean }} data
 * @returns {NotificationContent}
 */
export function threadEntryNotification({ threadName, threadType, preview, isError }) {
  const label = threadType === 'heartbeat' ? 'Heartbeat' : 'Cron';
  const title = isError ? `${label} Error` : `${label} Update`;
  const trimmed = preview && preview.length > 120 ? preview.substring(0, 120) + '…' : preview;
  const body = trimmed ? `${threadName}: ${trimmed}` : `New entry in "${threadName}"`;
  return { title, body };
}

/**
 * Build content for a dispatch failure.
 * @param {{ message: string }} data
 * @returns {NotificationContent}
 */
export function dispatchFailureNotification({ message }) {
  const trimmed = message && message.length > 160 ? message.slice(0, 160) + '…' : message;
  return {
    title: 'Dispatch Failure',
    body: trimmed || 'An autonomous dispatch failed',
  };
}

/**
 * Pure mapping from a WebSocket broadcast payload → formatted notification
 * content, or `null` when this payload does not warrant a foreground banner.
 *
 * Keep this aligned with `server/push.ts#mapBroadcastToPush` — both maps
 * use the same event taxonomy so server push + mobile in-app banners fire
 * on the same triggers.
 *
 * @param {object} data
 * @returns {({ event: string } & NotificationContent) | null}
 */
export function mapBroadcastToNotification(data) {
  if (!data || typeof data.type !== 'string') return null;

  switch (data.type) {
    case 'done': {
      const preview =
        typeof data.message?.content === 'string'
          ? data.message.content.replace(/\n+/g, ' ').trim()
          : undefined;
      const { title, body } = sessionCompleteNotification({
        agentName: data.agentName,
        sessionName: data.sessionName,
        preview,
      });
      return { event: 'session_complete', title, body };
    }
    case 'changes_ready': {
      const { title, body } = prReadyNotification({
        agentName: data.agentName,
        sessionName: data.sessionName,
        branch: data.branch,
      });
      return { event: 'changes_ready', title, body };
    }
    case 'thread_created': {
      if (!data.thread) return null;
      const { title, body } = threadCreatedNotification({
        threadName: data.thread.name,
        threadType: data.thread.type,
      });
      return { event: 'thread_created', title, body };
    }
    case 'thread_entry_created': {
      const content = data.entry?.content || '';
      const isError = content.startsWith('ERROR:');
      const preview = content.replace(/\n+/g, ' ').trim();
      const { title, body } = threadEntryNotification({
        threadName: data.threadName || 'Thread',
        threadType: data.threadType || 'cron',
        preview,
        isError,
      });
      return { event: 'thread_entry', title, body };
    }
    case 'dispatch_failure': {
      const { title, body } = dispatchFailureNotification({
        message: data.message || data.error || '',
      });
      return { event: 'dispatch_failure', title, body };
    }
    default:
      return null;
  }
}
