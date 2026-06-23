export type BrowserScreensBySession = Record<string, Record<string, Record<string, string>>>;

export function mergeBrowserActivityScreenshot(
  prev: BrowserScreensBySession,
  sessionId: string,
  messageId: string,
  actionId: string,
  screenshotDataUrl: string,
): BrowserScreensBySession {
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
