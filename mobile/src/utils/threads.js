/**
 * Pure helpers for the mobile Threads screen. Kept in `src/utils/` so they
 * live under the vitest include pattern and can be unit tested without a
 * React / React Native runtime.
 */

/**
 * Format an ISO-8601 / SQLite timestamp as "HH:MM:SS · <relative>".
 * Handles SQLite datetimes without a trailing "Z" by treating them as UTC,
 * matching the web client's ThreadView behavior.
 *
 * @param {string} ts - timestamp string
 * @param {Date} [now] - reference "now" for testing
 * @returns {string}
 */
export function formatEntryTimestamp(ts, now = new Date()) {
  if (!ts) return '';
  const d = ts.includes('T') ? new Date(ts) : new Date(ts + 'Z');
  const diffMs = now - d;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHrs = Math.floor(diffMs / 3600000);
  let relative;
  if (diffMins < 1) relative = 'just now';
  else if (diffMins < 60) relative = `${diffMins}m ago`;
  else if (diffHrs < 24) relative = `${diffHrs}h ago`;
  else relative = d.toLocaleDateString();
  const time = d.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  return `${time} · ${relative}`;
}

/**
 * Return true if a date separator should render above `entry` relative to
 * `prevEntry`. Two entries on different calendar days (local tz) => true.
 *
 * @param {{timestamp?: string} | null} prevEntry
 * @param {{timestamp?: string}} entry
 * @returns {boolean}
 */
export function shouldShowDateSeparator(prevEntry, entry) {
  if (!entry?.timestamp) return false;
  const parse = (ts) => new Date(ts.includes('T') ? ts : ts + 'Z');
  const entryDate = parse(entry.timestamp);
  if (!prevEntry?.timestamp) return true;
  const prevDate = parse(prevEntry.timestamp);
  return entryDate.toDateString() !== prevDate.toDateString();
}

/**
 * Merge a live WebSocket-delivered thread into an existing list, prepending
 * it unless it's already present (by id).
 *
 * @template {{id: string}} T
 * @param {T[]} existing
 * @param {T} thread
 * @returns {T[]}
 */
export function mergeLiveThread(existing, thread) {
  if (!thread?.id) return existing;
  if (existing.some((t) => t.id === thread.id)) return existing;
  return [thread, ...existing];
}

/**
 * Merge a live WebSocket-delivered entry into an existing entries array,
 * appending it unless it's already present (by id).
 *
 * @template {{id: string}} E
 * @param {E[]} existing
 * @param {E} entry
 * @returns {E[]}
 */
export function mergeLiveEntry(existing, entry) {
  if (!entry?.id) return existing;
  if (existing.some((e) => e.id === entry.id)) return existing;
  return [...existing, entry];
}

/**
 * Build the `unread` count map update after a `thread_entry_created` event.
 * Returns a new map (does not mutate). When `viewingThreadId === event.threadId`
 * the map is returned unchanged (the user is already looking at the entry).
 *
 * @param {Record<string, number>} counts
 * @param {{projectId?: string, threadId?: string}} event
 * @param {string|null} viewingThreadId
 * @returns {Record<string, number>}
 */
export function applyEntryUnread(counts, event, viewingThreadId) {
  if (!event?.projectId) return counts;
  if (event.threadId && viewingThreadId === event.threadId) return counts;
  return {
    ...counts,
    [event.projectId]: (counts[event.projectId] || 0) + 1,
  };
}

/**
 * Remove the unread counter for a given project (e.g. when the user opens
 * that project's threads list).
 *
 * @param {Record<string, number>} counts
 * @param {string} projectId
 * @returns {Record<string, number>}
 */
export function clearProjectUnread(counts, projectId) {
  if (!projectId || !counts[projectId]) return counts;
  const next = { ...counts };
  delete next[projectId];
  return next;
}
