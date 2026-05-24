/** Max boot-log lines retained client-side for session preview pane + WS `preview_log`. */
export const PREVIEW_LOG_TAIL_MAX = 4_000;

export function appendPreviewLogTail(prev, line) {
  const tail = Array.isArray(prev) ? [...prev, line] : [line];
  if (tail.length <= PREVIEW_LOG_TAIL_MAX) return tail;
  return tail.slice(-PREVIEW_LOG_TAIL_MAX);
}

export function mergePreviewEventLogTail(incoming, previous) {
  if (Array.isArray(incoming) && incoming.length > 0) {
    return incoming.length <= PREVIEW_LOG_TAIL_MAX
      ? incoming
      : incoming.slice(-PREVIEW_LOG_TAIL_MAX);
  }
  if (Array.isArray(previous) && previous.length > 0) {
    return previous.length <= PREVIEW_LOG_TAIL_MAX
      ? previous
      : previous.slice(-PREVIEW_LOG_TAIL_MAX);
  }
  return Array.isArray(incoming) ? incoming : [];
}
