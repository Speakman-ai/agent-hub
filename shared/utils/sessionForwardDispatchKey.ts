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
