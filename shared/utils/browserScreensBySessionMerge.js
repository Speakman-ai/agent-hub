/**
 * Nested map: sessionId → assistant messageId → browser actionId → screenshot data URL.
 * Keeps WS screenshot previews partitioned so inactive sessions don't share one flat
 * message-keyed map across the tab lifetime (web + mobile parity).
 */

/**
 * Merge one WebSocket `browser_activity_screenshot` row into immutable state.
 * @param {Record<string, Record<string, Record<string, string>>>} prev
 * @returns {typeof prev}
 */
export function mergeBrowserActivityScreenshot(prev, sessionId, messageId, actionId, screenshotDataUrl) {
  if (
    typeof sessionId !== 'string' ||
    typeof messageId !== 'string' ||
    typeof actionId !== 'string' ||
    typeof screenshotDataUrl !== 'string' ||
    sessionId.length === 0 ||
    messageId.length === 0 ||
    actionId.length === 0 ||
    screenshotDataUrl.length === 0
  ) {
    return prev;
  }
  const byMsg = prev[sessionId] || {};
  return {
    ...prev,
    [sessionId]: {
      ...byMsg,
      [messageId]: { ...(byMsg[messageId] || {}), [actionId]: screenshotDataUrl },
    },
  };
}
