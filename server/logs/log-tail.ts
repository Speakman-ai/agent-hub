/**
 * In-process handoff from the committed log writer to live-tail transports.
 *
 * The write queue publishes only after SQLite commits, so a tail cursor always
 * names a durable row that can be recovered through `queryLogRecordsSince`.
 * Keeping this tiny publisher separate from WebSocket wiring lets the writer
 * remain transport-agnostic and gives tests an injectable subscription seam.
 */
import type { LogRecordRow } from './logs-db.js';

export type LogTailListener = (records: readonly LogRecordRow[]) => void;

const listeners = new Set<LogTailListener>();

export function subscribeLogTail(listener: LogTailListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function publishLogTail(records: readonly LogRecordRow[]): void {
  if (records.length === 0) return;
  for (const listener of listeners) {
    try {
      listener(records);
    } catch (err) {
      // A slow/broken UI transport must never fail the committed writer.
      console.warn('[log-tail] listener failed:', err instanceof Error ? err.message : err);
    }
  }
}

/** Test hook: removes stale subscribers from standalone WebSocket tests. */
export function resetLogTailListenersForTests(): void {
  listeners.clear();
}
