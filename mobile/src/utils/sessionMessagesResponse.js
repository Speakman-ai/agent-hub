/**
 * Normalizes GET /api/sessions/:id/messages — bare array or truncated envelope.
 */
export function normalizeSessionMessagesResponse(data) {
  if (Array.isArray(data)) {
    return { messages: data, truncated: false, omitted: 0, total: data.length };
  }
  if (data && Array.isArray(data.messages)) {
    return {
      messages: data.messages,
      truncated: !!data.truncated,
      omitted: data.omitted ?? 0,
      total: data.total ?? data.messages.length,
    };
  }
  return { messages: [], truncated: false, omitted: 0, total: 0 };
}
