/**
 * Notification titles and bodies for card-moved and PR-merged events.
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
