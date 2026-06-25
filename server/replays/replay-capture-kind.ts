// replay-capture-kind.ts — classify a session replay as a CONTINUOUS
// (whole-session) capture vs an ON-ERROR (record-on-error / manual bug-report)
// capture, and derive a best-effort "live" (still being appended) signal for
// the Replays Explorer dashboard.
//
// Capture kind is NOT a stored column; it is derived from the recorder-stamped
// `meta.trigger` (falling back to `reason` / `source`, mirroring the dashboard's
// metaString pluck). The continuous recorder flushes on a fixed interval and on
// the pagehide/visibilitychange tail, so those trigger values mark the
// continuous tier; everything else (uncaught errors, unhandled rejections,
// manual bug-report flushes, or a missing trigger) is the historical
// record-on-error tier.

import type { SessionReplayRow } from '../types.js';

export type ReplayCaptureKind = 'continuous' | 'on-error';

/**
 * Trigger values the continuous (whole-session) recorder stamps on a capture.
 * Kept lower-case; classification lower-cases + trims the incoming value before
 * comparing. This is the single source of truth shared by the TS classifier and
 * the SQL `kind` filter in replay-list-store.ts, so the two never drift.
 */
export const CONTINUOUS_TRIGGERS: readonly string[] = [
  'continuous',
  'interval',
  'flush-interval',
  'pagehide',
  'visibilitychange',
  'tail-flush',
  'unload',
];

/**
 * Meta keys the recorder may stamp the capture reason under, in priority order
 * (mirrors toReplayListItem's metaString(meta, 'trigger', 'reason', 'source')).
 * Exported so the SQL `kind` filter in replay-list-store.ts derives the trigger
 * from the SAME keys, in the SAME order, with the SAME string/non-blank
 * fallback semantics — the two must agree on the resolved trigger.
 */
export const TRIGGER_KEYS = ['trigger', 'reason', 'source'] as const;

/** Pluck the capture trigger string from free-form recorder meta (trimmed). */
export function replayTrigger(meta: Record<string, unknown> | null | undefined): string | null {
  if (!meta) return null;
  for (const k of TRIGGER_KEYS) {
    const v = meta[k];
    if (typeof v === 'string' && v.trim() !== '') return v.trim();
  }
  return null;
}

/** Classify a capture from its recorder meta. Defaults to `on-error` when the
 *  trigger is missing or unrecognized (the historical record-on-error path). */
export function classifyReplayCaptureKind(
  meta: Record<string, unknown> | null | undefined,
): ReplayCaptureKind {
  const trigger = replayTrigger(meta)?.toLowerCase() ?? null;
  if (trigger && CONTINUOUS_TRIGGERS.includes(trigger)) return 'continuous';
  return 'on-error';
}

/** A capture is "finalized" once it's attached to a triage surface (support
 *  ticket or card) — it can no longer receive appends, so it's never live. */
function isFinalizedRow(row: Pick<SessionReplayRow, 'support_ticket_id' | 'card_id'>): boolean {
  return Boolean(row.support_ticket_id) || Boolean(row.card_id);
}

/**
 * Default freshness window for the live signal. The continuous recorder flushes
 * on a ~5-min interval (plus a pagehide/visibilitychange tail), so allow ~3
 * missed flushes before a capture is considered ended rather than streaming.
 */
export const REPLAY_LIVE_FRESHNESS_MS = 15 * 60 * 1000;

/** Parse a SQLite `datetime('now')` UTC string (space-separated, no zone
 *  suffix) — or an ISO string — to epoch ms; null when unparseable. */
export function parseSqliteUtc(ts: string | null | undefined): number | null {
  if (!ts) return null;
  const iso = ts.includes('T') ? ts : ts.replace(' ', 'T') + 'Z';
  const ms = new Date(iso).getTime();
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Best-effort "in progress" signal: a CONTINUOUS capture that is not finalized
 * and was written to within the freshness window. On-error captures are
 * one-shot and never live. Approximate by design — a hard tab close between
 * flushes ends the stream without a final write, so a capture drops out of the
 * live set after `freshnessMs`.
 */
export function isReplayLive(
  row: Pick<SessionReplayRow, 'support_ticket_id' | 'card_id' | 'updated_at' | 'created_at'>,
  kind: ReplayCaptureKind,
  nowMs: number,
  freshnessMs: number = REPLAY_LIVE_FRESHNESS_MS,
): boolean {
  if (kind !== 'continuous') return false;
  if (isFinalizedRow(row)) return false;
  const updated = parseSqliteUtc(row.updated_at ?? row.created_at);
  if (updated == null) return false;
  return nowMs - updated <= freshnessMs && nowMs - updated >= -freshnessMs;
}
