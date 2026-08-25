/**
 * Normalizes `GET /api/sessions/:id/messages`, shared by the web and mobile API
 * clients. The endpoint answers with either a bare array (small sessions) or a
 * truncated envelope, so every caller needs the same collapse to one shape.
 */

export interface SessionMessagesResponse<T = unknown> {
  messages: T[];
  truncated: boolean;
  omitted: number;
  total: number;
}

export function normalizeSessionMessagesResponse<T = unknown>(
  data: unknown,
): SessionMessagesResponse<T> {
  if (Array.isArray(data)) {
    return { messages: data as T[], truncated: false, omitted: 0, total: data.length };
  }
  if (
    data &&
    typeof data === 'object' &&
    Array.isArray((data as { messages?: unknown }).messages)
  ) {
    const envelope = data as {
      messages: T[];
      truncated?: unknown;
      omitted?: number;
      total?: number;
    };
    return {
      messages: envelope.messages,
      truncated: !!envelope.truncated,
      omitted: envelope.omitted ?? 0,
      total: envelope.total ?? envelope.messages.length,
    };
  }
  return { messages: [], truncated: false, omitted: 0, total: 0 };
}
