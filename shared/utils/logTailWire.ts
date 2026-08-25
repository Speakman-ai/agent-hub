/**
 * Wire contract for the LOG-QUERY live tail, shared by the web
 * (`client/src/utils/logStream.ts`) and mobile (`mobile/src/utils/logStream.ts`)
 * Logs modules and by `shared/hooks/useLogTail.ts`.
 *
 * Only the transport-shaped half lives here: the record shape, the
 * `logs_subscribe` frame, the reconnect-safe merge, and the keyset cursor. The
 * presentation helpers (severity tones, filters, scroll geometry) stay per
 * platform because they render to Tailwind classes on web and React Native
 * styles on mobile. Nothing here touches React, the DOM, or a WebSocket, so
 * every function is unit-testable in the `node` env.
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
 * Build a `logs_subscribe` frame.
 *
 * The `seed` flag is the whole point of this helper. A seed makes the server
 * answer with the newest page of the window in one frame. That is **lossy**:
 * everything older than the page is skipped and `nextCursor` comes back null,
 * so the client can never page back for it. Only the subscriber knows whether
 * it holds any tail state, so it must say so explicitly; the server must not
 * infer it from `cursor === 0`, which is also the legitimate resume cursor for
 * a client that has accepted nothing yet.
 *
 * Rule: request a seed only when we hold no records. Any subscription carrying
 * accepted rows drains forward from its cursor, which is lossless.
 *
 * `sinceUnixNano` rides along on EVERY subscribe, seed or reconnect. It used to
 * be sent only on the seed, on the reasoning that every `id > cursor` is already
 * newer than the window. That reasoning silently assumed ingest id and event
 * time agree, which is exactly the assumption this module exists to break: a
 * delayed batch ingested after the cursor carries event times older than the
 * window, so an unbounded reconnect drain replays hours-old rows into a bounded
 * Live view. The window is a property of the subscription, not of the first
 * frame, so the server needs it every time.
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

/**
 * Chronological comparator for the rendered tail: event time first, ingest id
 * as the tiebreak.
 *
 * `id` alone is ingest order, not event order. Two sources (say `production`
 * and `dev`) each POST their own batch, so their rows land in contiguous id
 * runs and the merged stream steps backwards in time every time it crosses
 * from one batch into the next. Sorting on `time_unix_nano` renders what the
 * timestamps actually say; `id` breaks ties inside one timestamp, and the pair
 * is the keyset that "Load older" and the seed query page on, so the rendered
 * order and the pagination order are the same total order.
 */
export function compareLogRecords(a: LogRecord, b: LogRecord): number {
  const at = Number.isFinite(a.timeUnixNano) ? a.timeUnixNano : 0;
  const bt = Number.isFinite(b.timeUnixNano) ? b.timeUnixNano : 0;
  return at === bt ? a.id - b.id : at - bt;
}

/**
 * Merge incoming records into an existing tail: dedupe by `id`, keep ascending
 * chronological order, and bound the result to the newest `cap` records.
 *
 * This is the single reconnect-safe merge used for backfill pages AND live
 * frames. Because backfill can replay ids the client already holds (the server
 * installs the live subscription before draining backfill), dedupe-by-id is
 * what prevents duplicate rows after a reconnect.
 */
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
 * Resolve the durable resubscribe cursor after a live-tail frame.
 *
 * The two frame types the server sends do NOT carry the same cursor semantics
 * (server `websocket.ts`):
 *   - `logs_tail_backfill` carries BOTH `cursor` (the last id of this page, or
 *     the requested cursor when the page is empty) AND `nextCursor` — the
 *     durable continue-token to query from next, `null` on the final page.
 *   - `logs_tail` (live) carries only `cursor` (the last id in the frame).
 *
 * On reconnect the hook must resubscribe from a cursor that reflects the newest
 * record it has durably accepted. Preferring `nextCursor` when present makes
 * backfill paging follow the server's own continue-token instead of assuming
 * `cursor` is that token; the fallback to `cursor` covers the final backfill
 * page (`nextCursor === null` but records remain) and every live frame. When
 * neither is a number (a bare keepalive) the current cursor is retained.
 *
 * The caller still applies a monotonic guard, so a stale/empty frame can never
 * rewind the cursor below `current`.
 */
export function resolveTailCursor(
  frame: { cursor?: unknown; nextCursor?: unknown },
  current: number,
): number {
  if (typeof frame.nextCursor === 'number') return frame.nextCursor;
  if (typeof frame.cursor === 'number') return frame.cursor;
  return current;
}
