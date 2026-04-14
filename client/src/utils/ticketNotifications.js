/**
 * Ticket lifecycle notification message formatters.
 *
 * Pure functions that build notification titles and body text
 * for card-moved and PR-merged WebSocket events.
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
