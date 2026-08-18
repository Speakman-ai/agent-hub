/**
 * Per-agent heartbeat threads are retired. Historical rows stay in SQLite
 * but must not appear in web/mobile thread surfaces.
 */

export function isRetiredHeartbeatThread(thread: { type?: unknown } | null | undefined): boolean {
  return thread?.type === 'heartbeat';
}

export function excludeRetiredHeartbeatThreads<T extends { type?: unknown }>(
  threads: readonly T[] | null | undefined,
): T[] {
  if (!Array.isArray(threads)) return [];
  return threads.filter((thread) => !isRetiredHeartbeatThread(thread));
}
