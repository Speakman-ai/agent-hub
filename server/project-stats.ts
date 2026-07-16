/**
 * Per-project Stats aggregation.
 *
 * Backs `GET /api/projects/:projectId/stats` — daily / weekly / monthly time
 * series for six product metrics:
 *
 *   - prs_merged                → pull_requests.merged_at (epoch ms)
 *   - support_tickets_resolved  → support_tickets.resolved_at
 *   - tickets_made              → kanban_cards.created_at
 *   - tickets_completed         → kanban_cards.completed_at
 *   - epics_completed           → kanban_epics.completed_at
 *   - model_usage / top_model   → messages.model over the project's agents
 *
 * The three completion metrics rely on the timestamps maintained by the
 * triggers in stats-completion.ts. Counts are grouped per UTC day in SQL and
 * folded into day/week/month buckets in JS, so we never depend on SQLite's
 * fiddly weekday arithmetic and the bucketing stays unit-testable in isolation.
 */

import type BetterSqlite3 from 'better-sqlite3';

export type StatGranularity = 'day' | 'week' | 'month';

export const STAT_GRANULARITIES: readonly StatGranularity[] = ['day', 'week', 'month'];

/** Default / max bucket counts per granularity (max guards against abuse). */
export const STAT_BUCKET_DEFAULTS: Record<StatGranularity, number> = {
  day: 30,
  week: 12,
  month: 12,
};
export const STAT_BUCKET_MAX: Record<StatGranularity, number> = {
  day: 90,
  week: 52,
  month: 24,
};

export interface StatBucket {
  /** Bucket start date as `YYYY-MM-DD` (UTC). Also the map key. */
  start: string;
  /** Human label — same as `start` for day/month; week uses the Monday date. */
  label: string;
}

export interface ProjectStatsResponse {
  granularity: StatGranularity;
  buckets: StatBucket[];
  series: {
    prs_merged: number[];
    support_tickets_resolved: number[];
    tickets_made: number[];
    tickets_completed: number[];
    epics_completed: number[];
  };
  totals: {
    prs_merged: number;
    support_tickets_resolved: number;
    tickets_made: number;
    tickets_completed: number;
    epics_completed: number;
  };
  model_usage: Array<{ model: string; count: number }>;
  top_model: string | null;
}

// ─── UTC date helpers ────────────────────────────────────────────────────────

function fmtDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function parseDay(dayStr: string): Date {
  return new Date(`${dayStr}T00:00:00.000Z`);
}

function addDaysUTC(d: Date, n: number): Date {
  return new Date(d.getTime() + n * 86_400_000);
}

/** Monday (UTC) of the week containing `d`. */
function mondayOfUTC(d: Date): Date {
  const base = parseDay(fmtDay(d));
  const dow = base.getUTCDay(); // 0=Sun … 6=Sat
  const offset = (dow + 6) % 7; // days since Monday
  return addDaysUTC(base, -offset);
}

/** First day (UTC) of the month containing `d`. */
function firstOfMonthUTC(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

function addMonthsUTC(d: Date, n: number): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
}

/** Clamp a requested bucket count into `[1, max]`, falling back to the default. */
export function normalizeBucketCount(
  granularity: StatGranularity,
  requested: number | undefined,
): number {
  const fallback = STAT_BUCKET_DEFAULTS[granularity];
  const max = STAT_BUCKET_MAX[granularity];
  if (requested === undefined || !Number.isFinite(requested)) return fallback;
  const n = Math.floor(requested);
  if (n < 1) return 1;
  if (n > max) return max;
  return n;
}

/**
 * Build the ordered (oldest → newest) list of buckets ending at the period
 * containing `now`. Pure + deterministic given `now`, so it's unit-testable.
 */
export function buildStatBuckets(
  granularity: StatGranularity,
  count: number,
  now: Date,
): StatBucket[] {
  const buckets: StatBucket[] = [];
  if (granularity === 'day') {
    const today = parseDay(fmtDay(now));
    for (let i = count - 1; i >= 0; i--) {
      const start = fmtDay(addDaysUTC(today, -i));
      buckets.push({ start, label: start });
    }
  } else if (granularity === 'week') {
    const monday = mondayOfUTC(now);
    for (let i = count - 1; i >= 0; i--) {
      const start = fmtDay(addDaysUTC(monday, -i * 7));
      buckets.push({ start, label: start });
    }
  } else {
    const first = firstOfMonthUTC(now);
    for (let i = count - 1; i >= 0; i--) {
      const start = fmtDay(addMonthsUTC(first, -i));
      buckets.push({ start, label: start.slice(0, 7) });
    }
  }
  return buckets;
}

/** Map a UTC day string to the start key of its enclosing bucket. */
function bucketStartForDay(dayStr: string, granularity: StatGranularity): string {
  if (granularity === 'day') return dayStr;
  const d = parseDay(dayStr);
  if (granularity === 'week') return fmtDay(mondayOfUTC(d));
  return fmtDay(firstOfMonthUTC(d));
}

type DayCountRow = { day: string | null; n: number };

/** Fold per-day `(day, count)` rows into the fixed bucket array. */
function foldIntoBuckets(
  rows: DayCountRow[],
  buckets: StatBucket[],
  granularity: StatGranularity,
): { series: number[]; total: number } {
  const indexByStart = new Map(buckets.map((b, i) => [b.start, i]));
  const series = new Array(buckets.length).fill(0);
  let total = 0;
  for (const row of rows) {
    if (!row.day) continue;
    const startKey = bucketStartForDay(row.day, granularity);
    const idx = indexByStart.get(startKey);
    if (idx === undefined) continue;
    series[idx] += row.n;
    total += row.n;
  }
  return { series, total };
}

// ─── Main aggregation ────────────────────────────────────────────────────────

export interface ComputeProjectStatsOptions {
  projectId: string;
  /** Agent ids in the project — scopes model usage (messages → sessions). */
  agentIds: string[];
  granularity: StatGranularity;
  count: number;
  now: Date;
}

export function computeProjectStats(
  db: BetterSqlite3.Database,
  opts: ComputeProjectStatsOptions,
): ProjectStatsResponse {
  const { projectId, agentIds, granularity, count, now } = opts;
  const buckets = buildStatBuckets(granularity, count, now);
  const windowStartDay = buckets[0]?.start ?? fmtDay(now);
  const windowStartMs = parseDay(windowStartDay).getTime();

  const cardsMade = db
    .prepare(
      `SELECT date(c.created_at) AS day, COUNT(*) AS n
         FROM kanban_cards c
         JOIN kanban_boards b ON b.id = c.board_id
        WHERE b.project_id = ? AND c.created_at >= ?
        GROUP BY day`,
    )
    .all(projectId, windowStartDay) as DayCountRow[];

  const cardsCompleted = db
    .prepare(
      `SELECT date(c.completed_at) AS day, COUNT(*) AS n
         FROM kanban_cards c
         JOIN kanban_boards b ON b.id = c.board_id
        WHERE b.project_id = ? AND c.completed_at IS NOT NULL AND c.completed_at >= ?
        GROUP BY day`,
    )
    .all(projectId, windowStartDay) as DayCountRow[];

  const epicsCompleted = db
    .prepare(
      `SELECT date(e.completed_at) AS day, COUNT(*) AS n
         FROM kanban_epics e
         JOIN kanban_boards b ON b.id = e.board_id
        WHERE b.project_id = ? AND e.completed_at IS NOT NULL AND e.completed_at >= ?
        GROUP BY day`,
    )
    .all(projectId, windowStartDay) as DayCountRow[];

  const ticketsResolved = db
    .prepare(
      `SELECT date(resolved_at) AS day, COUNT(*) AS n
         FROM support_tickets
        WHERE project_id = ? AND resolved_at IS NOT NULL AND resolved_at >= ?
        GROUP BY day`,
    )
    .all(projectId, windowStartDay) as DayCountRow[];

  // pull_requests.merged_at is INTEGER epoch **milliseconds** — convert to a UTC
  // day and filter with the epoch-ms window bound.
  const prsMerged = db
    .prepare(
      `SELECT date(merged_at / 1000, 'unixepoch') AS day, COUNT(*) AS n
         FROM pull_requests
        WHERE project_id = ? AND status = 'merged' AND merged_at IS NOT NULL
          AND merged_at >= ?
        GROUP BY day`,
    )
    .all(projectId, windowStartMs) as DayCountRow[];

  const madeF = foldIntoBuckets(cardsMade, buckets, granularity);
  const completedF = foldIntoBuckets(cardsCompleted, buckets, granularity);
  const epicsF = foldIntoBuckets(epicsCompleted, buckets, granularity);
  const resolvedF = foldIntoBuckets(ticketsResolved, buckets, granularity);
  const prsF = foldIntoBuckets(prsMerged, buckets, granularity);

  // Model usage over the window, scoped to the project's agents.
  //
  // Scoping caveat: `sessions` carries no project column — the only link from a
  // message to a project is message → session → agent → project, and `agentIds`
  // is resolved from the CURRENT roster (projects.json) by the caller. Agent ids
  // are globally unique and each agent belongs to exactly one project, so this
  // is correct for live data. The one imperfection is temporal: if an agent id
  // were deleted and later re-created under a different project, that agent's
  // historical messages would attribute to the new owner. There is no
  // per-session project/ownership field to disambiguate that today; fixing it
  // properly needs a `sessions.project_id` column (+ historical backfill), which
  // is out of scope here. Documented so the limitation is explicit, not silent.
  let modelUsage: Array<{ model: string; count: number }> = [];
  if (agentIds.length > 0) {
    const placeholders = agentIds.map(() => '?').join(', ');
    modelUsage = db
      .prepare(
        `SELECT m.model AS model, COUNT(*) AS count
           FROM messages m
           JOIN sessions s ON s.id = m.session_id
          WHERE m.model IS NOT NULL AND m.model != '' AND m.created_at >= ?
            AND s.agent_id IN (${placeholders})
          GROUP BY m.model
          ORDER BY count DESC, m.model ASC`,
      )
      .all(windowStartDay, ...agentIds) as Array<{ model: string; count: number }>;
  }
  const topModel = modelUsage.length > 0 ? modelUsage[0].model : null;

  return {
    granularity,
    buckets,
    series: {
      prs_merged: prsF.series,
      support_tickets_resolved: resolvedF.series,
      tickets_made: madeF.series,
      tickets_completed: completedF.series,
      epics_completed: epicsF.series,
    },
    totals: {
      prs_merged: prsF.total,
      support_tickets_resolved: resolvedF.total,
      tickets_made: madeF.total,
      tickets_completed: completedF.total,
      epics_completed: epicsF.total,
    },
    model_usage: modelUsage,
    top_model: topModel,
  };
}
