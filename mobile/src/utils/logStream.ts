/**
 * Pure helpers for the mobile Logs module (LOG-QUERY live tail + Issues).
 *
 * Mirrors `client/src/utils/logStream.ts` so web and mobile bucket severity,
 * merge the reconnect-safe tail, filter, and parse untrusted structured fields
 * identically. Transport-free and UI-free: no WebSocket, no React, no RN
 * primitives, so every function here is unit-testable in the `node` env.
 *
 * Every value that originates from an ingested log record is UNTRUSTED
 * (decision LOG-TRUST). This module never builds markup from log text — callers
 * render the returned strings as React Native <Text>. `parseAttributes`
 * tolerates malformed JSON and never throws.
 */

/** OpenTelemetry severity numbers we bucket against (mirrors logs-schema.ts). */
export const SEVERITY_NUMBER = {
  UNSPECIFIED: 0,
  TRACE: 1,
  DEBUG: 5,
  INFO: 9,
  WARN: 13,
  ERROR: 17,
  FATAL: 21,
} as const;

/** Records at or above this number are eligible for issue grouping. */
export const ERROR_SEVERITY_FLOOR = SEVERITY_NUMBER.ERROR;

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

/** Client-side filter over an in-memory tail (Live view). */
export interface LogFilter {
  /** Inclusive minimum OpenTelemetry severity number. */
  minSeverityNumber?: number | null;
  sourceId?: string | null;
  serviceName?: string | null;
  environment?: string | null;
  /** Case-insensitive substring over body + service + severity text. */
  text?: string | null;
}

/** Severity buckets, ascending, for a "minimum severity" picker. */
export const SEVERITY_BUCKETS: ReadonlyArray<{ label: string; value: number }> = [
  { label: 'All', value: SEVERITY_NUMBER.UNSPECIFIED },
  { label: 'Trace+', value: SEVERITY_NUMBER.TRACE },
  { label: 'Debug+', value: SEVERITY_NUMBER.DEBUG },
  { label: 'Info+', value: SEVERITY_NUMBER.INFO },
  { label: 'Warn+', value: SEVERITY_NUMBER.WARN },
  { label: 'Error+', value: SEVERITY_NUMBER.ERROR },
  { label: 'Fatal', value: SEVERITY_NUMBER.FATAL },
];

/**
 * Selectable time windows for the Live tail. `value` is the window width in
 * milliseconds; `0` means "All time" (no lower bound). Defaulting to 24h keeps
 * the Live view seeded with recent records instead of replaying the entire
 * retained history oldest-first.
 */
export const TIME_RANGES: ReadonlyArray<{ label: string; value: number }> = [
  { label: 'Last hour', value: 3_600_000 },
  { label: 'Last 6 hours', value: 21_600_000 },
  { label: 'Last 24 hours', value: 86_400_000 },
  { label: 'Last 7 days', value: 604_800_000 },
  { label: 'All time', value: 0 },
];

/** Default Live-tail window: the last 24 hours. */
export const DEFAULT_TIME_RANGE_MS = 86_400_000;

/**
 * Resolve a time-window width (ms) + a `now` anchor (ms epoch) to a lower-bound
 * `time_unix_nano` for the log query / subscription. Returns `undefined` for
 * "All time" (`rangeMs <= 0`) or a non-positive/degenerate boundary, meaning no
 * lower bound. Nanosecond epochs exceed `Number.MAX_SAFE_INTEGER`; the ~256ns
 * double coarseness is irrelevant for a window boundary.
 */
export function resolveSinceUnixNano(rangeMs: number, nowMs: number): number | undefined {
  if (!Number.isFinite(rangeMs) || rangeMs <= 0) return undefined;
  if (!Number.isFinite(nowMs)) return undefined;
  const sinceMs = nowMs - rangeMs;
  if (sinceMs <= 0) return undefined;
  return sinceMs * 1e6;
}

/** Coarse label for a severity number (falls back to the raw number). */
export function severityLabel(severityNumber: number, severityText?: string | null): string {
  if (severityText && severityText.trim()) return severityText.trim().toUpperCase();
  if (severityNumber >= SEVERITY_NUMBER.FATAL) return 'FATAL';
  if (severityNumber >= SEVERITY_NUMBER.ERROR) return 'ERROR';
  if (severityNumber >= SEVERITY_NUMBER.WARN) return 'WARN';
  if (severityNumber >= SEVERITY_NUMBER.INFO) return 'INFO';
  if (severityNumber >= SEVERITY_NUMBER.DEBUG) return 'DEBUG';
  if (severityNumber >= SEVERITY_NUMBER.TRACE) return 'TRACE';
  return 'UNSET';
}

/** Semantic tone key for a severity number — the screen maps it to theme colors. */
export type SeverityTone = 'error' | 'warn' | 'info' | 'muted';
export function severityToneKey(severityNumber: number): SeverityTone {
  if (severityNumber >= SEVERITY_NUMBER.ERROR) return 'error';
  if (severityNumber >= SEVERITY_NUMBER.WARN) return 'warn';
  if (severityNumber >= SEVERITY_NUMBER.INFO) return 'info';
  return 'muted';
}

/** Nanosecond epoch → millisecond epoch (display precision only). */
export function nanoToMillis(timeUnixNano: number): number {
  if (!Number.isFinite(timeUnixNano)) return 0;
  return Math.floor(timeUnixNano / 1e6);
}

/**
 * Merge incoming records into an existing tail: dedupe by `id`, keep ascending
 * id order, and bound the result to the newest `cap` records.
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
  const merged = Array.from(byId.values()).sort((a, b) => a.id - b.id);
  const bounded = merged.length > cap ? merged.slice(merged.length - cap) : merged;
  return bounded;
}

/** Does a record pass the client-side Live filter? */
export function recordMatchesFilter(record: LogRecord, filter: LogFilter): boolean {
  if (
    filter.minSeverityNumber != null &&
    filter.minSeverityNumber > 0 &&
    record.severityNumber < filter.minSeverityNumber
  ) {
    return false;
  }
  if (filter.sourceId && record.sourceId !== filter.sourceId) return false;
  if (filter.serviceName && record.serviceName !== filter.serviceName) return false;
  if (filter.environment && record.environment !== filter.environment) return false;
  const needle = filter.text?.trim().toLowerCase();
  if (needle) {
    const haystack = [record.body, record.serviceName, record.severityText]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    if (!haystack.includes(needle)) return false;
  }
  return true;
}

/** Filter an in-memory tail without mutating the input. */
export function filterLogRecords(records: readonly LogRecord[], filter: LogFilter): LogRecord[] {
  return records.filter((r) => recordMatchesFilter(r, filter));
}

/** Scroll geometry of a FlatList (subset of a RN scroll `nativeEvent`). */
export interface ListScrollGeometry {
  /** `contentOffset.y` — how far the content is scrolled. */
  offsetY: number;
  /** `contentSize.height` — total scrollable content height. */
  contentHeight: number;
  /** `layoutMeasurement.height` — visible viewport height. */
  viewportHeight: number;
}

/**
 * Is the tail scrolled to (or within `threshold` px of) the bottom? The live
 * tail renders oldest→newest, so "pinned to bottom" means the newest record is
 * on screen and the list should keep auto-scrolling to the end as records
 * arrive. A small threshold absorbs sub-pixel rounding and the height a
 * just-appended row adds between the scroll event and the content-size change.
 */
export function isNearBottom(geom: ListScrollGeometry, threshold = 24): boolean {
  return geom.contentHeight - geom.offsetY - geom.viewportHeight <= threshold;
}

/** Distinct non-empty values of a field across a tail, sorted, for facet menus. */
export function distinctValues(
  records: readonly LogRecord[],
  field: 'sourceId' | 'serviceName' | 'environment',
): string[] {
  const set = new Set<string>();
  for (const r of records) {
    const v = r[field];
    if (typeof v === 'string' && v.trim()) set.add(v);
  }
  return Array.from(set).sort((a, b) => a.localeCompare(b));
}

/**
 * Safe-parse a JSON object column (`attributesJson`, `resourceJson`, …) into a
 * flat list of `{ key, value }` display rows. Never throws; returns `[]` for
 * null / non-object / malformed input. Nested values are JSON-stringified so
 * the caller only ever renders a string.
 */
export function parseAttributes(json: string | null | undefined): Array<{
  key: string;
  value: string;
}> {
  if (!json || typeof json !== 'string') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
  const out: Array<{ key: string; value: string }> = [];
  for (const [key, raw] of Object.entries(parsed as Record<string, unknown>)) {
    let value: string;
    if (raw == null) value = 'null';
    else if (typeof raw === 'string') value = raw;
    else if (typeof raw === 'number' || typeof raw === 'boolean') value = String(raw);
    else {
      try {
        value = JSON.stringify(raw);
      } catch {
        value = String(raw);
      }
    }
    out.push({ key, value });
  }
  return out;
}

/**
 * Pull a human stack trace out of an attributes blob. OpenTelemetry uses the
 * `exception.stacktrace` attribute; we also accept a couple of common aliases.
 * Returns the raw multi-line string for whitespace-preserving text rendering.
 */
export function extractStackTrace(attributesJson: string | null | undefined): string | null {
  const attrs = parseAttributes(attributesJson);
  const keys = ['exception.stacktrace', 'exception.stack_trace', 'stack', 'stacktrace'];
  for (const k of keys) {
    const hit = attrs.find((a) => a.key === k);
    if (hit && hit.value.trim()) return hit.value;
  }
  return null;
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

/** Does a record carry expandable structured detail (attrs/resource/trace ids)? */
export function recordHasDetail(record: LogRecord): boolean {
  return (
    Boolean(record.attributesJson) ||
    Boolean(record.resourceJson) ||
    Boolean(record.traceId) ||
    Boolean(record.spanId)
  );
}
