/**
 * User-message flags for ChatMessage — kept pure so vitest can cover the
 * in-flight action path without mounting the full RN component tree.
 */
export function getUserMessageFlags(message, inFlightWhileStreaming = false) {
  const isUser = message?.role === 'user';
  const isQueued = !!message?.queued;
  const isInterrupted = !!message?.interrupted;
  const showInFlightActions =
    inFlightWhileStreaming && isUser && (isQueued || isInterrupted);
  return { isUser, isQueued, isInterrupted, showInFlightActions };
}
