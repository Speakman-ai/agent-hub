/**
 * session_events helpers — payload size cap and orphan sweep.
 *
 * Why this module exists:
 *
 *   `session_events` is a high-volume telemetry table (one row per
 *   stream-json event from Claude Code / Cursor Agent: tool_use,
 *   tool_result, assistant_text streaming chunks, checkpoint, etc.).
 *   Two failure modes were observed on prod:
 *
 *   1. **Unbounded row size.** A single huge `tool_result` (large file
 *      read, multi-megabyte command output) lands in one row's `payload`
 *      column verbatim and dominates the table. We clamp inserts at
 *      `MAX_PAYLOAD_BYTES` with a head/tail truncation marker so any
 *      one tool output cannot blow up the file size.
 *
 *   2. **Orphans.** `session_events.parent_id` references `messages.id`
 *      (when `parent_kind='message'`), `heartbeat_logs.id`, or
 *      `cron_logs.id` — but the table has no foreign keys. When the
 *      parent rows are deleted (manual session delete, archived-session
 *      hard-delete via FK CASCADE on `messages`, cron_log retention),
 *      the corresponding `session_events` rows are stranded forever and
 *      accumulate. On 2026-05-07 the prod DB held 659,649 orphan rows
 *      (2.36 GiB) vs. only 16,654 live rows (53 MiB). The orphan sweep
 *      below reclaims that space and runs from the existing daily
 *      `runWorkspacePurge` tick.
 *
 * Both helpers are pure functions over a `better-sqlite3` Database
 * handle so they can be unit-tested against an in-memory DB without
 * spinning up the full server.
 */

import type Database from 'better-sqlite3';

/**
 * Maximum bytes (UTF-8) of a single `payload` column we will persist.
 * Above this, the payload is replaced by a JSON envelope containing the
 * head and tail of the original plus a truncation marker — see
 * `clampPayload` for the exact shape. 64 KiB chosen as the smallest
 * threshold that preserves typical streaming chunks and edit diffs
 * verbatim while clamping the long tail of multi-MB tool outputs.
 */
export const MAX_PAYLOAD_BYTES = 64 * 1024;

/**
 * Bytes of head/tail we preserve when clamping. 4 KiB each = 8 KiB of
 * preserved content + the JSON envelope overhead, well under the cap.
 */
const PRESERVE_BYTES = 4 * 1024;

/**
 * Marker the UI / snapshot aggregator can detect to know a row was
 * truncated. Embedded in the JSON envelope under `__truncated`.
 */
export const TRUNCATION_MARKER = '__session_event_truncated__';

interface TruncatedEnvelope {
  /** Human-readable label so transcripts surfacing the row know it's clamped. */
  __truncated: typeof TRUNCATION_MARKER;
  /** Original payload byte length before clamp. */
  originalBytes: number;
  /** First `PRESERVE_BYTES` of the original payload (UTF-8 safe-ish slice). */
  head: string;
  /** Last `PRESERVE_BYTES` of the original payload. */
  tail: string;
}

/**
 * Clamp a serialized payload to at most `MAX_PAYLOAD_BYTES` bytes.
 *
 * - If the payload is already small enough, returns it unchanged (zero
 *   allocation in the common case — the call is a single `Buffer.byteLength`).
 * - If it's larger, returns a JSON envelope with head/tail slices and a
 *   `__truncated` marker the UI can render specially.
 *
 * Note on slicing: we slice on JS string indices, not byte indices, so a
 * head of N chars may land in the middle of a multi-byte character. We
 * accept that — the result is still valid JSON, and the truncation
 * envelope is purely informational; the underlying tool output has been
 * lost the moment we decided not to persist it.
 */
export function clampPayload(payload: string): string {
  const byteLen = Buffer.byteLength(payload, 'utf8');
  if (byteLen <= MAX_PAYLOAD_BYTES) return payload;

  // Use string-length slicing for a reasonable approximation of bytes —
  // for ASCII-heavy tool output this is exact; for UTF-8 with multi-byte
  // codepoints the head/tail will be a touch under PRESERVE_BYTES bytes,
  // never over.
  const head = payload.slice(0, PRESERVE_BYTES);
  const tail = payload.slice(-PRESERVE_BYTES);

  const envelope: TruncatedEnvelope = {
    __truncated: TRUNCATION_MARKER,
    originalBytes: byteLen,
    head,
    tail,
  };
  return JSON.stringify(envelope);
}

/**
 * Type guard for callers (snapshot aggregator, UI) that want to detect
 * a clamped row without hard-coding the marker string.
 */
export function isTruncatedPayload(parsed: unknown): parsed is TruncatedEnvelope {
  return (
    typeof parsed === 'object' &&
    parsed !== null &&
    (parsed as { __truncated?: unknown }).__truncated === TRUNCATION_MARKER
  );
}

export interface OrphanSweepResult {
  /** Rows deleted whose `parent_kind='message'` parent message is gone. */
  messageOrphans: number;
  /** Rows deleted whose `parent_kind='heartbeat'` parent log is gone. */
  heartbeatOrphans: number;
  /** Rows deleted whose `parent_kind='cron'` parent log is gone. */
  cronOrphans: number;
  /** Sum of the three above. */
  totalDeleted: number;
}

/**
 * Delete every `session_events` row whose parent no longer exists.
 *
 * Three sweeps, one per `parent_kind`:
 *
 *   - `'message'`:   join LEFT against `messages.id`
 *   - `'heartbeat'`: join LEFT against `heartbeat_logs.id` (cast to TEXT
 *                    because `heartbeat_logs.id` is INTEGER but
 *                    `session_events.parent_id` is TEXT)
 *   - `'cron'`:      join LEFT against `cron_logs.id` (same TEXT/INTEGER
 *                    coercion)
 *
 * Each sweep runs in its own statement so a single bad parent_kind
 * doesn't block the others. Returns counters per kind for logging.
 *
 * Designed to be safe to call repeatedly — a second call is a no-op
 * once the orphans are gone.
 */
export function pruneOrphanSessionEvents(db: Database.Database): OrphanSweepResult {
  const messageStmt = db.prepare(
    `DELETE FROM session_events
     WHERE parent_kind = 'message'
       AND parent_id NOT IN (SELECT id FROM messages)`,
  );
  const heartbeatStmt = db.prepare(
    `DELETE FROM session_events
     WHERE parent_kind = 'heartbeat'
       AND parent_id NOT IN (SELECT CAST(id AS TEXT) FROM heartbeat_logs)`,
  );
  const cronStmt = db.prepare(
    `DELETE FROM session_events
     WHERE parent_kind = 'cron'
       AND parent_id NOT IN (SELECT CAST(id AS TEXT) FROM cron_logs)`,
  );

  const messageOrphans = messageStmt.run().changes;
  const heartbeatOrphans = heartbeatStmt.run().changes;
  const cronOrphans = cronStmt.run().changes;

  return {
    messageOrphans,
    heartbeatOrphans,
    cronOrphans,
    totalDeleted: messageOrphans + heartbeatOrphans + cronOrphans,
  };
}
