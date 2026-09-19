/**
 * LOG-QUERY live tail wire: record shape, subscribe frame, reconnect-safe merge.
 * Presentation stays per platform.
 */

/** Wire shape of a serialized log record (server `serializeLogRecord`). */
export interface LogRecord {
  id: number;
  projectId: string;
  sourceId: string;
  timeUnixNano: number;
  observedTimeUnixNano: number | null;
  severityNumber: number;
  severityText: string | null;
  body: string | null;
  serviceName: string | null;
  environment: string | null;
  traceId: string | null;
  spanId: string | null;
  fingerprint: string | null;
  resourceJson: string | null;
  attributesJson: string | null;
  scopeJson: string | null;
  byteSize: number;
  ingestedAt: number;
}

export interface LogSubscribeFrameInput {
  projectId: string;
  /** Last durably-accepted record id; 0 when none. */
  cursor: number;
  /** Has this subscription ever accepted a record? */
  hasRecords: boolean;
  /** Lower bound (ns) of the selected time window; undefined = "All time". */
  sinceUnixNano?: number;
}

/**
 * Build a `logs_subscribe` frame. Seed is lossy (newest page, no continue-token);
 * request it only when we hold no records. `cursor === 0` is also a valid empty
 * resume, so the server must not infer seed from that. `sinceUnixNano` goes on
 * every subscribe: ingest id and event time can disagree (delayed batches).
 */
export function buildLogSubscribeFrame(input: LogSubscribeFrameInput): Record<string, unknown> {
  const seed = !input.hasRecords;
  const frame: Record<string, unknown> = {
    type: 'logs_subscribe',
    projectId: input.projectId,
    cursor: input.cursor,
    seed,
  };
  if (input.sinceUnixNano != null) frame.sinceUnixNano = input.sinceUnixNano;
  return frame;
}

/** Event time first, ingest id as tiebreak. `id` alone is ingest order, not event order. */
export function compareLogRecords(a: LogRecord, b: LogRecord): number {
  const at = Number.isFinite(a.timeUnixNano) ? a.timeUnixNano : 0;
  const bt = Number.isFinite(b.timeUnixNano) ? b.timeUnixNano : 0;
  return at === bt ? a.id - b.id : at - bt;
}

/** Dedupe by id, keep chronological order, bound to newest `cap`. Backfill can replay ids. */
export function mergeTailRecords(
  existing: readonly LogRecord[],
  incoming: readonly LogRecord[],
  cap: number,
): LogRecord[] {
  if (incoming.length === 0) {
    return existing.length > cap ? existing.slice(existing.length - cap) : existing.slice();
  }
  const byId = new Map<number, LogRecord>();
  for (const r of existing) byId.set(r.id, r);
  for (const r of incoming) byId.set(r.id, r);
  const merged = Array.from(byId.values()).sort(compareLogRecords);
  const bounded = merged.length > cap ? merged.slice(merged.length - cap) : merged;
  return bounded;
}

/** Keyset position of a record in the chronological order: (event time, id). */
export interface LogCursor {
  timeUnixNano: number;
  id: number;
}

/**
 * Durable resubscribe cursor. Prefer `nextCursor` on backfill; fall back to
 * `cursor` (final page / live frames). Keep `current` on keepalive.
 */
export function resolveTailCursor(
  frame: { cursor?: unknown; nextCursor?: unknown },
  current: number,
): number {
  if (typeof frame.nextCursor === 'number') return frame.nextCursor;
  if (typeof frame.cursor === 'number') return frame.cursor;
  return current;
}
