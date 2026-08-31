// rum-session-list-store.ts — the read/query surface that backs the RUM
// Session Explorer (the Datadog-parity, session-grain dashboard table).
//
// `rum-session-store.ts` maintains one `rum_sessions` row per client-minted
// session id, rolled forward as segments ingest. This module adds the *list*
// surface the dashboard needs: a tenant-scoped, paginated query with the same
// facets Datadog's Session Explorer exposes — user (email/name/id), device,
// browser, os, geo country, duration, view/action/error/frustration counts, and
// a started-at time range.
//
// Every filter maps to a first-class indexed column on `rum_sessions` (see the
// `idx_rum_sessions_*` indexes in rum-events-db.ts): exact-match text facets are
// `col = ?`, count/duration filters are `>=` / `<=` range predicates, and the
// time range is an inclusive `started_at BETWEEN` bounded by the composite
// (project_id, started_at) index. Filters compose as ANDed WHERE fragments with
// positional binds, the same way `replay-list-store.ts` and the support-ticket
// queue build their dynamic WHERE.
//
// `rum_sessions` lives in the dedicated `rum.db` file (hot-write isolation), so
// this module resolves the RUM events handle, NOT the primary `getDb()`.
import { getRumEventsDb } from './rum-events-db.js';
import type { RumSessionRow } from '../types.js';

export const RUM_SESSION_LIST_MAX_LIMIT = 200;
export const RUM_SESSION_LIST_DEFAULT_LIMIT = 50;

/** Exact-match text facets (indexed). A whitespace-only / empty value is treated
 *  as "no filter" so a blank query param never collapses the result set. */
export interface RumSessionTextFilters {
  usrEmail?: string;
  usrName?: string;
  usrId?: string;
  deviceType?: string;
  browser?: string;
  os?: string;
  geoCountry?: string;
}

/** Numeric range facets. Count filters are lower bounds (`>=`), matching the
 *  Datadog ">0 errors" style; duration is a `[min, max]` window on time_spent. */
export interface RumSessionRangeFilters {
  /** `time_spent >= durationMinMs` (session duration, ms). */
  durationMinMs?: number;
  /** `time_spent <= durationMaxMs` (session duration, ms). */
  durationMaxMs?: number;
  viewCountMin?: number;
  actionCountMin?: number;
  errorCountMin?: number;
  frustrationCountMin?: number;
}

/** Inclusive started-at window, epoch ms. A session with no `started_at`
 *  (never saw a usable timestamp) is excluded once EITHER bound is set — it
 *  can't be placed on the timeline. */
export interface RumSessionTimeRange {
  from?: number;
  to?: number;
}

export interface ListRumSessionsOpts
  extends RumSessionTextFilters, RumSessionRangeFilters, RumSessionTimeRange {
  projectId: string;
  limit?: number;
  offset?: number;
}

export interface ListRumSessionsResult {
  sessions: RumSessionRow[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

/** Clamp a requested page size into `[1, RUM_SESSION_LIST_MAX_LIMIT]`, defaulting
 *  a missing / non-finite value to `RUM_SESSION_LIST_DEFAULT_LIMIT`. */
export function clampRumSessionLimit(raw: number | undefined): number {
  if (raw == null || !Number.isFinite(raw)) return RUM_SESSION_LIST_DEFAULT_LIMIT;
  return Math.min(RUM_SESSION_LIST_MAX_LIMIT, Math.max(1, Math.floor(raw)));
}

/** A trimmed, non-empty string, else undefined — so a blank facet value is a
 *  no-op filter rather than a `col = ''` predicate that matches nothing. */
function cleanText(v: string | undefined): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t.length ? t : undefined;
}

/** A finite number, else undefined (so a missing / NaN range bound is skipped). */
function cleanNumber(v: number | undefined): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

const TEXT_FACET_COLUMNS: Array<[keyof RumSessionTextFilters, string]> = [
  ['usrEmail', 'usr_email'],
  ['usrName', 'usr_name'],
  ['usrId', 'usr_id'],
  ['deviceType', 'device_type'],
  ['browser', 'browser'],
  ['os', 'os'],
  ['geoCountry', 'geo_country'],
];

/**
 * List a project's RUM sessions for the Session Explorer, most-recent first.
 *
 * All facets are optional and AND together; an omitted / blank facet is a no-op.
 * `total` is the unpaginated count for the active filter set so the UI can render
 * a page count, and `hasMore` says whether another page exists past this one.
 */
export function listRumSessions(opts: ListRumSessionsOpts): ListRumSessionsResult {
  const limit = clampRumSessionLimit(opts.limit);
  const offset = Math.max(0, Math.floor(opts.offset ?? 0));

  const where: string[] = ['project_id = ?'];
  const params: unknown[] = [opts.projectId];

  for (const [key, column] of TEXT_FACET_COLUMNS) {
    const value = cleanText(opts[key]);
    if (value !== undefined) {
      where.push(`${column} = ?`);
      params.push(value);
    }
  }

  const pushRange = (column: string, op: '>=' | '<=', raw: number | undefined): void => {
    const value = cleanNumber(raw);
    if (value !== undefined) {
      where.push(`${column} ${op} ?`);
      params.push(value);
    }
  };
  pushRange('time_spent', '>=', opts.durationMinMs);
  pushRange('time_spent', '<=', opts.durationMaxMs);
  pushRange('view_count', '>=', opts.viewCountMin);
  pushRange('action_count', '>=', opts.actionCountMin);
  pushRange('error_count', '>=', opts.errorCountMin);
  pushRange('frustration_count', '>=', opts.frustrationCountMin);

  // Inclusive time window on started_at; a NULL started_at is excluded once
  // either bound is present (it can't be ordered on the timeline). The NULL
  // guard is pushed once — not per-bound — so a from+to window doesn't emit a
  // redundant predicate.
  const from = cleanNumber(opts.from);
  const to = cleanNumber(opts.to);
  if (from !== undefined || to !== undefined) {
    where.push('started_at IS NOT NULL');
  }
  if (from !== undefined) {
    where.push('started_at >= ?');
    params.push(from);
  }
  if (to !== undefined) {
    where.push('started_at <= ?');
    params.push(to);
  }

  const whereClause = `WHERE ${where.join(' AND ')}`;
  const db = getRumEventsDb();

  const total = (
    db.prepare(`SELECT COUNT(*) AS n FROM rum_sessions ${whereClause}`).get(...params) as {
      n: number;
    }
  ).n;

  const sessions = db
    .prepare(
      `SELECT * FROM rum_sessions
         ${whereClause}
         ORDER BY started_at DESC, session_id DESC
         LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset) as RumSessionRow[];

  return { sessions, total, limit, offset, hasMore: offset + sessions.length < total };
}
