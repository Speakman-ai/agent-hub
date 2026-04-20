// Usage-stat aggregation for the /api/usage dashboard.
//
// ── Background: why this module exists ─────────────────────────────────
// The Claude Code CLI sometimes emits MULTIPLE `result` events under the
// same `parent_id` (i.e. within the same assistant message / CLI process).
// The Anthropic Agent SDK docs describe `total_cost_usd` on the result
// message as a *cumulative estimate* for the whole query:
//   "the cumulative estimated cost across all steps in that call"
//   — https://code.claude.com/docs/en/agent-sdk/cost-tracking
//
// Observed production data (Apr 2026) confirms that when the CLI emits
// multiple result events for one parent_id, the `total_cost_usd` is
// MONOTONICALLY INCREASING — each event reports the running total, not
// just its own incremental spend. Example (parent df840a36…):
//     seq 485 → 106 turns, 32 min, $27.97
//     seq 492 →   1 turn,  2.8s,  $29.12
//     seq 498 →   1 turn,  2.2s,  $29.26
//     seq 504 →   1 turn,  2.3s,  $29.40
// Booked naively (SUM): $115.75. Actual (MAX): $29.40. ~4× over-count.
//
// Across a 14-day window this inflated booked spend by ~$450 (~11%).
//
// ── Aggregation rule ────────────────────────────────────────────────────
//   cost     → MAX per parent_id, then SUM across parents   (cumulative)
//   duration → SUM across all result events                 (per-emission)
//   turns    → SUM across all result events                 (per-emission)
//   count    → raw COUNT of result events (= invocations)   (per-emission)
//
// The split is intentional: observed data shows `costUsd` is cumulative
// across the whole CLI process while `durationMs` and `numTurns` are
// per-emission (seq 485 reports 106 turns / 32 min; the three follow-ups
// each report 1 turn / ~2s — clearly NOT cumulative for those fields).
//
// If Anthropic ever normalizes the CLI so it emits exactly one result per
// invocation — or if `total_cost_usd` changes from cumulative to
// per-emission — this module (and the stream-parser contract comment)
// must be revisited.

import type Database from 'better-sqlite3';

export interface UsageTotals {
  count: number;
  total_cost: number;
  total_duration_ms: number;
  total_turns: number;
}

export interface UsageByAgent {
  agent_id: string;
  count: number;
  total_cost: number;
  total_duration_ms: number;
  total_turns: number;
}

export interface UsageByDay {
  day: string;
  count: number;
  cost: number;
  duration_ms: number;
  turns: number;
}

export interface UsageRecentSession {
  id: string;
  agent_id: string;
  session_name: string | null;
  message_count: number;
  cost: number;
  duration_ms: number;
  last_activity: string;
}

/**
 * Per-parent cost picker used by all grouped queries.
 *
 * For every `result` event we compute a row_number ordered by descending
 * `costUsd`. The max-cost row (rn=1) is the one that represents the true
 * cumulative cost of that parent; all other rows contribute 0 to the cost
 * total but still contribute to count/duration/turns sums.
 *
 * Wrapping in a subquery with `ROW_NUMBER()` (rather than a separate
 * `GROUP BY parent_id, MAX(...)` CTE joined back in) avoids the fan-out
 * that would otherwise multiply the per-parent max by the number of raw
 * rows for that parent.
 */
const RANKED_RESULT_EVENTS_SQL = `
  SELECT se.*,
         json_extract(se.payload, '$.costUsd')     AS _cost,
         json_extract(se.payload, '$.durationMs')  AS _duration_ms,
         json_extract(se.payload, '$.numTurns')    AS _num_turns,
         ROW_NUMBER() OVER (
           PARTITION BY se.parent_id
           ORDER BY json_extract(se.payload, '$.costUsd') DESC, se.seq DESC
         ) AS _rn
  FROM session_events se
  WHERE se.event_type = 'result'
`;

export function computeUsageTotals(db: Database.Database): UsageTotals {
  return db
    .prepare(
      `
      SELECT COUNT(*)                                                        AS count,
             COALESCE(SUM(CASE WHEN _rn = 1 THEN _cost ELSE 0 END), 0)        AS total_cost,
             COALESCE(SUM(_duration_ms), 0)                                   AS total_duration_ms,
             COALESCE(SUM(_num_turns), 0)                                     AS total_turns
      FROM (${RANKED_RESULT_EVENTS_SQL})
    `,
    )
    .get() as UsageTotals;
}

export function computeUsageByAgent(db: Database.Database): UsageByAgent[] {
  return db
    .prepare(
      `
      SELECT s.agent_id                                                       AS agent_id,
             COUNT(*)                                                         AS count,
             COALESCE(SUM(CASE WHEN r._rn = 1 THEN r._cost ELSE 0 END), 0)    AS total_cost,
             COALESCE(SUM(r._duration_ms), 0)                                 AS total_duration_ms,
             COALESCE(SUM(r._num_turns), 0)                                   AS total_turns
      FROM (${RANKED_RESULT_EVENTS_SQL} AND se.parent_kind = 'message') r
      JOIN messages m ON r.parent_id = m.id
      JOIN sessions s ON m.session_id = s.id
      GROUP BY s.agent_id
      ORDER BY total_cost DESC
    `,
    )
    .all() as UsageByAgent[];
}

export function computeUsageByDay(db: Database.Database): UsageByDay[] {
  // For the "day" bucket we attribute cost to the day of the max-cost row
  // (the row that would have been counted anyway), which keeps the bucket
  // stable even when follow-up result events cross a date boundary.
  return db
    .prepare(
      `
      SELECT date(r.timestamp, 'localtime')                                   AS day,
             COUNT(*)                                                         AS count,
             COALESCE(SUM(CASE WHEN r._rn = 1 THEN r._cost ELSE 0 END), 0)    AS cost,
             COALESCE(SUM(r._duration_ms), 0)                                 AS duration_ms,
             COALESCE(SUM(r._num_turns), 0)                                   AS turns
      FROM (${RANKED_RESULT_EVENTS_SQL} AND se.timestamp >= datetime('now', '-30 days')) r
      GROUP BY date(r.timestamp, 'localtime')
      ORDER BY day DESC
    `,
    )
    .all() as UsageByDay[];
}

export function computeRecentSessions(db: Database.Database): UsageRecentSession[] {
  return db
    .prepare(
      `
      SELECT s.id                                                             AS id,
             s.agent_id                                                       AS agent_id,
             s.name                                                           AS session_name,
             COUNT(*)                                                         AS message_count,
             COALESCE(SUM(CASE WHEN r._rn = 1 THEN r._cost ELSE 0 END), 0)    AS cost,
             COALESCE(SUM(r._duration_ms), 0)                                 AS duration_ms,
             MAX(r.timestamp)                                                 AS last_activity
      FROM (${RANKED_RESULT_EVENTS_SQL} AND se.parent_kind = 'message') r
      JOIN messages m ON r.parent_id = m.id
      JOIN sessions s ON m.session_id = s.id
      GROUP BY s.id
      ORDER BY last_activity DESC
      LIMIT 20
    `,
    )
    .all() as UsageRecentSession[];
}
