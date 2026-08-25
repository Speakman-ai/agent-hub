/**
 * Pure helpers for the mobile Threads screen. Kept in `src/utils/` so they
 * live under the vitest include pattern and can be unit tested without a
 * React / React Native runtime.
 */
import { isRetiredHeartbeatThread } from '@shared/utils/retiredHeartbeatThread';
export {
  excludeRetiredHeartbeatThreads,
  isRetiredHeartbeatThread,
} from '@shared/utils/retiredHeartbeatThread';
/**
 * Format an ISO-8601 / SQLite timestamp as "HH:MM:SS · <relative>".
 * Handles SQLite datetimes without a trailing "Z" by treating them as UTC,
 * matching the web client's ThreadView behavior.
 *
 * @param {string} ts - timestamp string
 * @param {Date} [now] - reference "now" for testing
 * @returns {string}
 */
export function formatEntryTimestamp(ts: any, now: any = new Date()) {
  if (!ts) return '';
  const d = ts.includes('T') ? new Date(ts) : new Date(ts + 'Z');
  const diffMs = now.getTime() - d.getTime();
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
export function shouldShowDateSeparator(prevEntry: any, entry: any) {
  if (!entry?.timestamp) return false;
  const parse = (ts: any) => new Date(ts.includes('T') ? ts : ts + 'Z');
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
export function mergeLiveThread(existing: any, thread: any) {
  if (!thread?.id) return existing;
  if (existing.some((t: any) => t.id === thread.id)) return existing;
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
export function mergeLiveEntry(existing: any, entry: any) {
  if (!entry?.id) return existing;
  if (existing.some((e: any) => e.id === entry.id)) return existing;
  return [...existing, entry];
}
/**
 * Build the `unread` count map update after a `thread_entry_created` event.
 * Returns a new map (does not mutate). When `viewingThreadId === event.threadId`
 * the map is returned unchanged (the user is already looking at the entry).
 *
 * @param {Record<string, number>} counts
 * @param {{projectId?: string, threadId?: string, threadType?: string}} event
 * @param {string|null} viewingThreadId
 * @returns {Record<string, number>}
 */
export function applyEntryUnread(counts: any, event: any, viewingThreadId: any) {
  if (isRetiredHeartbeatThread({ type: event?.threadType })) return counts;
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
export function clearProjectUnread(counts: any, projectId: any) {
  if (!projectId || !counts[projectId]) return counts;
  const next = { ...counts };
  delete (next as any)[projectId];
  return next;
}
