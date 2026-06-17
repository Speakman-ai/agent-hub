/**
 * Display helper for session ids in the TopBar — mirrors
 * client/src/components/TopBar.jsx `truncateSessionId`.
 */
export function truncateSessionId(id, tailLen = 8) {
  if (!id || id.length <= tailLen) return id;
  return `…${id.slice(-tailLen)}`;
}
