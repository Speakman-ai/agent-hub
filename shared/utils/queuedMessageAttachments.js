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

/**
 * True when `att` is already on the server (`/api/upload` response shape) and
 * must not be passed through the composer upload loop again.
 *
 * @param {unknown} att
 * @returns {boolean}
 */
export function isPersistedUploadAttachment(att) {
  if (!att || typeof att !== 'object') return false;
  const row = /** @type {Record<string, unknown>} */ (att);
  return Boolean(
    row.url && row.contentType && !row.dataUrl && !row.uri && !row.file,
  );
}

/**
 * WS `chat` frame for interrupt-now on an **existing** queued row. The server
 * dequeues, kills the in-flight turn, then re-enters with `_fromQueue: true`.
 * Do **not** set `_fromQueue` on this initial frame — that bypasses the busy
 * guard and leaves the kill path unreachable. Persisted `images`, no re-upload.
 *
 * @param {{ message: { id: string; content?: string | null; attachments?: string | unknown[] | null }; agentId: string; sessionId: string }} params
 */
export function buildInterruptQueuedChatWsMessage({ message, agentId, sessionId }) {
  const images = attachmentsFromQueuedMessage(message);
  return {
    type: 'chat',
    agentId,
    sessionId,
    content: message?.content || '',
    ...(images.length > 0 ? { images } : {}),
    interrupt: true,
    _existingMsgId: message.id,
  };
}

/**
 * WS frame for interrupt-now (single `chat` message; server owns dequeue).
 *
 * @param {{ message: { id: string; content?: string | null; attachments?: string | unknown[] | null }; agentId: string; sessionId: string }} params
 */
export function buildInterruptQueuedMessageDispatch({ message, agentId, sessionId }) {
  return {
    chat: buildInterruptQueuedChatWsMessage({ message, agentId, sessionId }),
  };
}
