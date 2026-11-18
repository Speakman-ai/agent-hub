/**
 * Server idempotency key for one session forward card: the chat, the message
 * and the card's position in it. Unlike the local storage key it has no
 * device or tab in it, so every tab and device showing the card sends the
 * same key and the server starts one session between them. Null when the
 * card is not tied to a saved message.
 */
export function sessionForwardDispatchKey(args: {
  sessionId: string | null | undefined;
  messageId: string | number | null | undefined;
  forwardId: string;
  occurrence: number;
}): string | null {
  const { sessionId, messageId, forwardId, occurrence } = args;
  if (!sessionId || messageId == null || messageId === '') return null;
  return ['session-forward', sessionId, String(messageId), forwardId, String(occurrence)].join(':');
}

const KEY_TAG = 'session-forward';

/**
 * Prefix shared by the dispatch keys of every forward card in one message,
 * so the server can ask whether any card there has started a session.
 */
export function sessionForwardDispatchKeyPrefix(
  sessionId: string,
  messageId: string | number,
): string {
  return [KEY_TAG, sessionId, String(messageId), ''].join(':');
}

/** The chat session and message a forward card's dispatch key belongs to, or null. */
export function parseSessionForwardDispatchKey(
  key: string | null | undefined,
): { sessionId: string; messageId: string } | null {
  if (typeof key !== 'string') return null;
  const parts = key.split(':');
  if (parts.length < 5 || parts[0] !== KEY_TAG || !parts[1] || !parts[2]) return null;
  return { sessionId: parts[1], messageId: parts[2] };
}
