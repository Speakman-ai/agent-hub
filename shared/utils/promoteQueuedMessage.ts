/** Mirror queue promotion even when the prompt is outside the loaded history page. */
export function promoteQueuedMessage<T extends { id: string; queued?: boolean }>(
  messages: T[],
  messageId: string,
  persisted?: T,
): T[] {
  const existing = messages.find((message) => message.id === messageId);
  if (!existing && !persisted) return messages;
  const message = { ...existing, ...persisted, queued: false } as T;
  return [...messages.filter((entry) => entry.id !== messageId), message];
}
