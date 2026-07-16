/**
 * Ordering helper for the Settings → Server Logs console.
 *
 * Server-log entries accumulate chronologically: the REST snapshot is oldest →
 * newest and each live `{ type: 'server-log', entry }` frame is appended to the
 * end. The console shows the newest line first, so display order is simply the
 * reverse of insertion order. Returns a new array; the input is never mutated.
 */
export function orderServerLogsNewestFirst<T>(entries: readonly T[]): T[] {
  return entries.slice().reverse();
}
