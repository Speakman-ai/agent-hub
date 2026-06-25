// replay-list-store.ts — read/aggregation queries that back the Replays
// Explorer dashboard (a Datadog-RUM-Explorer-style table of session replays).
//
// The single-replay read path lives in replay-store.ts; this module adds the
// *list* surface the dashboard needs: a project-scoped, paginated, filterable
// query that LEFT JOINs the linked support ticket so each row can show whether
// (and to which ticket) a capture is attached. Filters compose the same way the
// support-ticket queue's dynamic WHERE does (see support-tickets-store.ts).
//
// Orphaned captures (`project_id IS NULL`, the anonymous-ingest default) are
// reachable via the dedicated `orphans` filter — the dashboard surfaces them so
// an operator can link a stranded replay to a project + support ticket. The
// route layer gates that filter to privileged callers, mirroring `canViewReplay`
// for unattributed rows.
import { getDb } from '../db.js';
import type { SessionReplayRow } from '../types.js';
import { CONTINUOUS_TRIGGERS, TRIGGER_KEYS } from './replay-capture-kind.js';

export const REPLAY_LIST_FILTERS = ['all', 'linked', 'unlinked', 'orphans'] as const;
export type ReplayListFilter = (typeof REPLAY_LIST_FILTERS)[number];

/** Capture-kind facet, orthogonal to the ticket-link `filter`: a continuous
 *  replay can be linked or unlinked. `all` is the no-op default. */
export const REPLAY_LIST_KINDS = ['all', 'continuous', 'on-error'] as const;
export type ReplayListKind = (typeof REPLAY_LIST_KINDS)[number];

export const REPLAY_LIST_MAX_LIMIT = 200;
export const REPLAY_LIST_DEFAULT_LIMIT = 50;

export function isReplayListFilter(v: unknown): v is ReplayListFilter {
  return typeof v === 'string' && (REPLAY_LIST_FILTERS as readonly string[]).includes(v);
}

export function isReplayListKind(v: unknown): v is ReplayListKind {
  return typeof v === 'string' && (REPLAY_LIST_KINDS as readonly string[]).includes(v);
}

/**
 * Per-key SQL: resolve `meta.<key>` to its lower-cased, trimmed value, but ONLY
 * when it is a non-blank STRING — `json_type(...) = 'text'` rejects numbers /
 * booleans / objects, and the trim check rejects blanks. This is the exact
 * predicate `replayTrigger()` applies (`typeof v === 'string' && v.trim() !==
 * ''`), so a non-string / empty key falls through to the next instead of
 * short-circuiting the coalesce on a non-null-but-unusable value. Yields NULL
 * when the key is absent/unusable so the surrounding coalesce moves on.
 */
function triggerKeySql(key: string): string {
  const path = `'$.${key}'`;
  return (
    `CASE WHEN json_type(r.meta, ${path}) = 'text' ` +
    `AND trim(json_extract(r.meta, ${path})) <> '' ` +
    `THEN lower(trim(json_extract(r.meta, ${path}))) END`
  );
}

/**
 * SQL fragment that resolves a row's capture trigger with the SAME key priority
 * (trigger → reason → source) and SAME string/non-blank fallback semantics as
 * `replayTrigger()`, so SQL `kind` filtering and the TS `captureKind` classifier
 * can never disagree (e.g. `{ "trigger": "", "reason": "interval" }` resolves to
 * `interval` in both). Guarded by json_valid so a legacy/malformed `meta` blob
 * yields NULL instead of throwing and breaking the whole list query.
 */
const TRIGGER_SQL =
  'CASE WHEN json_valid(r.meta) THEN coalesce(' +
  TRIGGER_KEYS.map(triggerKeySql).join(', ') +
  ') END';

/** Build the WHERE predicate (and push its bind params) for a capture-kind
 *  facet. Returns null for `all` (no constraint). `continuous` keeps rows whose
 *  trigger is in CONTINUOUS_TRIGGERS; `on-error` keeps the complement (including
 *  rows with a missing/unrecognized trigger). */
function captureKindClause(kind: ReplayListKind, params: unknown[]): string | null {
  if (kind === 'all') return null;
  const placeholders = CONTINUOUS_TRIGGERS.map(() => '?').join(', ');
  if (kind === 'continuous') {
    for (const t of CONTINUOUS_TRIGGERS) params.push(t);
    return `${TRIGGER_SQL} IN (${placeholders})`;
  }
  // on-error: trigger absent OR not a continuous-tier trigger.
  for (const t of CONTINUOUS_TRIGGERS) params.push(t);
  return `(${TRIGGER_SQL} IS NULL OR ${TRIGGER_SQL} NOT IN (${placeholders}))`;
}

/** Clamp a requested page size into `[1, REPLAY_LIST_MAX_LIMIT]`, defaulting a
 *  missing/non-finite value to `REPLAY_LIST_DEFAULT_LIMIT`. */
export function clampReplayLimit(raw: number | undefined): number {
  if (raw == null || !Number.isFinite(raw)) return REPLAY_LIST_DEFAULT_LIMIT;
  return Math.min(REPLAY_LIST_MAX_LIMIT, Math.max(1, Math.floor(raw)));
}

/** A `session_replays` row enriched with the linked support ticket's display
 *  fields (NULL when the replay isn't linked to a ticket). */
export interface ReplayListRow extends SessionReplayRow {
  ticket_subject: string | null;
  ticket_status: string | null;
}

export interface ListProjectReplaysResult {
  replays: ReplayListRow[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

/**
 * List replays for the Replays Explorer.
 *
 *   - `all` | `linked` | `unlinked` — scoped to `projectId`. `linked` keeps only
 *     rows already attached to a support ticket; `unlinked` the inverse.
 *   - `orphans` — global unattributed captures (`project_id IS NULL`),
 *     independent of `projectId`. Privileged-only at the route layer.
 *
 * Pagination is offset/limit (the table is newest-first and small per project);
 * `total` is the unpaginated count for the active filter so the UI can render a
 * page count, and `hasMore` says whether another page exists.
 */
export function listProjectReplays(opts: {
  projectId: string;
  filter?: ReplayListFilter;
  kind?: ReplayListKind;
  limit?: number;
  offset?: number;
}): ListProjectReplaysResult {
  const filter: ReplayListFilter = opts.filter ?? 'all';
  const kind: ReplayListKind = opts.kind ?? 'all';
  const limit = clampReplayLimit(opts.limit);
  const offset = Math.max(0, Math.floor(opts.offset ?? 0));

  const where: string[] = [];
  const params: unknown[] = [];
  if (filter === 'orphans') {
    where.push('r.project_id IS NULL');
  } else {
    where.push('r.project_id = ?');
    params.push(opts.projectId);
    if (filter === 'linked') where.push('r.support_ticket_id IS NOT NULL');
    else if (filter === 'unlinked') where.push('r.support_ticket_id IS NULL');
  }
  // Capture-kind facet (continuous vs on-error), appended after the link-filter
  // params so the combined bind order stays positional.
  const kindClause = captureKindClause(kind, params);
  if (kindClause) where.push(kindClause);
  const whereClause = `WHERE ${where.join(' AND ')}`;

  const db = getDb();
  const total = (
    db.prepare(`SELECT COUNT(*) AS n FROM session_replays r ${whereClause}`).get(...params) as {
      n: number;
    }
  ).n;

  const replays = db
    .prepare(
      `SELECT r.*, t.subject AS ticket_subject, t.status AS ticket_status
         FROM session_replays r
         LEFT JOIN support_tickets t ON r.support_ticket_id = t.id
         ${whereClause}
         ORDER BY r.created_at DESC, r.id DESC
         LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset) as ReplayListRow[];

  return { replays, total, limit, offset, hasMore: offset + replays.length < total };
}

/**
 * Clear the support-ticket link on a replay, scoped to the owning project so a
 * caller can only unlink captures that belong to their project. Leaves
 * `project_id` intact (the replay stays attributed; only the ticket association
 * is removed). Returns the number of rows changed (0 if the replay isn't this
 * project's, or already had no ticket).
 */
export function unlinkReplayTicket(replayId: string, projectId: string): number {
  return getDb()
    .prepare(
      `UPDATE session_replays
          SET support_ticket_id = NULL
        WHERE id = ? AND project_id = ? AND support_ticket_id IS NOT NULL`,
    )
    .run(replayId, projectId).changes;
}
