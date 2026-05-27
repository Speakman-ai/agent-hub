/**
 * Parse persisted attachment JSON from a queued user message row for re-send
 * (e.g. interrupt-now) without re-uploading.
 *
 * @param {{ attachments?: string | unknown[] | null } | null | undefined} message
 * @returns {unknown[]}
 */
export function attachmentsFromQueuedMessage(message) {
  if (!message?.attachments) return [];
  try {
    const parsed =
      typeof message.attachments === 'string'
        ? JSON.parse(message.attachments)
        : message.attachments;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
