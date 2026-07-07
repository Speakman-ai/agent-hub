/**
 * me-dashboard.ts — per-user cross-project aggregation for the User Module
 * dashboard (spec AGGREGATION).
 *
 * One server-side, RBAC-filtered fan-out keyed by the authenticated uid. It
 * gathers, across every board the caller can see:
 *   - assigned cards ("My Work") — cards whose `assigned_user_id` is the caller,
 *   - open personal todos (cross-project, from `user_todos`),
 *   - today's Google calendar + flagged-mail counts (soft-degrading).
 *
 * RBAC: cards are only ever read from projects the caller can view
 * (`filterVisibleProjects`), so a user never sees work on a board they aren't a
 * member of. The rejected alternative (client-side fan-out to per-project
 * endpoints) would duplicate this filter in web + mobile and be chatty on
 * mobile.
 *
 * Caching: the assembled dashboard is cached per `org:uid` for a short TTL. The
 * expensive part is the Google network read; caching the whole payload keeps a
 * dashboard refresh (or two clients for one user) from re-hitting Google every
 * time. Reads only — every mutation goes through the specific todo/card
 * endpoints, which the client pairs with a `?fresh=1` reload.
 */
import { getDb } from './db.js';
import { getActiveOrgId } from './orgs.js';
import { listTodos, type UserTodo } from './user-todos-store.js';
import { canViewProject, type VisibilityCaller } from './project-visibility.js';
import { isColumnDone, isColumnShippedLane } from './kanban-blockers.js';
import {
  readGoogleForDashboard,
  type DashboardGoogle,
  type GoogleReader,
} from './me-dashboard-google.js';
import type { RouteDeps } from './types.js';

export type CardPriority = 'urgent' | 'high' | 'medium' | 'low';

export interface DashboardWorkCard {
  id: string;
  shortId: number | null;
  title: string;
  priority: CardPriority;
  columnId: string;
  columnName: string;
  isDone: boolean;
  projectId: string;
  projectName: string;
  boardId: string;
  epicId: string | null;
  prUrl: string | null;
  reviewStatus: string | null;
  sessionId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DashboardWork {
  cards: DashboardWorkCard[];
  counts: {
    total: number;
    open: number;
    byPriority: Record<CardPriority, number>;
  };
}

export interface MeDashboardPayload {
  generatedAt: string;
  work: DashboardWork;
  todos: {
    open: UserTodo[];
    openCount: number;
  };
  google: DashboardGoogle;
}

/** Row shape from the cross-board assigned-cards join. */
interface AssignedCardRow {
  id: string;
  short_id: number | null;
  title: string;
  priority: string;
  column_id: string;
  column_name: string;
  project_id: string;
  board_id: string;
  epic_id: string | null;
  pr_url: string | null;
  review_status: string | null;
  session_id: string | null;
  created_at: string;
  updated_at: string;
}

function normalizePriority(value: string): CardPriority {
  return value === 'urgent' || value === 'high' || value === 'low' ? value : 'medium';
}

/**
 * Cards assigned to `uid` across every board the caller can view. A single
 * join, filtered to the visible project ids — an empty visible set short-circuits
 * to no query. "Done-ish" columns (Done + shipped lanes) are flagged, not
 * dropped, so the client can show recently-completed work if it wants; counts
 * report open work.
 */
export function buildMyWork(deps: RouteDeps, uid: string, caller: VisibilityCaller): DashboardWork {
  const empty: DashboardWork = {
    cards: [],
    counts: { total: 0, open: 0, byPriority: { urgent: 0, high: 0, medium: 0, low: 0 } },
  };

  const visibleProjects = deps.getProjects().filter((p) => canViewProject(p, caller));
  if (visibleProjects.length === 0) return empty;

  const projectNameById = new Map(visibleProjects.map((p) => [p.id, p.name]));
  const projectIds = [...projectNameById.keys()];
  const placeholders = projectIds.map(() => '?').join(',');

  const rows = getDb()
    .prepare(
      `SELECT k.id, k.short_id, k.title, k.priority, k.column_id,
              c.name AS column_name, b.project_id AS project_id, k.board_id,
              k.epic_id, k.pr_url, k.review_status, k.session_id,
              k.created_at, k.updated_at
       FROM kanban_cards k
       JOIN kanban_columns c ON c.id = k.column_id
       JOIN kanban_boards b ON b.id = k.board_id
       WHERE k.assigned_user_id = ? AND b.project_id IN (${placeholders})
       ORDER BY k.updated_at DESC`,
    )
    .all(uid, ...projectIds) as AssignedCardRow[];

  const byPriority: Record<CardPriority, number> = { urgent: 0, high: 0, medium: 0, low: 0 };
  let open = 0;
  const cards: DashboardWorkCard[] = rows.map((r) => {
    const isDone = isColumnDone(r.column_name) || isColumnShippedLane(r.column_name);
    const priority = normalizePriority(r.priority);
    if (!isDone) {
      open += 1;
      byPriority[priority] += 1;
    }
    return {
      id: r.id,
      shortId: r.short_id,
      title: r.title,
      priority,
      columnId: r.column_id,
      columnName: r.column_name,
      isDone,
      projectId: r.project_id,
      projectName: projectNameById.get(r.project_id) ?? r.project_id,
      boardId: r.board_id,
      epicId: r.epic_id,
      prUrl: r.pr_url,
      reviewStatus: r.review_status,
      sessionId: r.session_id,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  });

  return { cards, counts: { total: cards.length, open, byPriority } };
}

// ─── Per-uid dashboard cache ─────────────────────────────────────────────────

export const ME_DASHBOARD_CACHE_TTL_MS = 15_000;

interface CacheEntry {
  expiresAt: number;
  payload: MeDashboardPayload;
}

/**
 * Hard ceiling on distinct cache entries so the Map can't grow without bound
 * across the process lifetime (one entry per distinct `org:uid:date:tz`).
 * `evictStale` sweeps expired keys first, then drops oldest-inserted entries.
 */
const MAX_CACHE_ENTRIES = 500;

const cache = new Map<string, CacheEntry>();

/** Clear the whole cache. Exported for tests and for forced invalidation. */
export function clearMeDashboardCache(): void {
  cache.clear();
}

/**
 * Bound the cache before inserting: only pays a full scan when at/over the cap,
 * dropping expired entries first, then the oldest (Map preserves insertion
 * order) until back under the ceiling.
 */
function evictStale(nowMs: number): void {
  if (cache.size < MAX_CACHE_ENTRIES) return;
  for (const [k, v] of cache) {
    if (v.expiresAt <= nowMs) cache.delete(k);
  }
  while (cache.size >= MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

export interface BuildDashboardOptions {
  uid: string;
  caller: VisibilityCaller;
  /** Skip (and refresh) the per-uid cache — used after a mutation. */
  fresh?: boolean;
  /** Injectable Google reader (defaults to the live one); tests override it. */
  googleReader?: GoogleReader;
  /** Injectable clock for cache TTL + "today" resolution. */
  now?: Date;
  /** Passthrough day / zone for the calendar read. */
  date?: string;
  timeZone?: string;
}

/**
 * Assemble the full personal dashboard for `uid`, respecting the caller's
 * project visibility. Cached per `org:uid:date:tz` for
 * {@link ME_DASHBOARD_CACHE_TTL_MS} unless `fresh` is set. Never throws on the
 * Google side — the reader degrades.
 *
 * The cache key includes `date` + `timeZone` because both feed the Google
 * calendar window (`computeDayWindow`): changing the requested day is a read,
 * not a mutation, so the client never sends `?fresh=1` for it — a shared key
 * would hand back the wrong day's calendar within the TTL.
 */
export async function buildMeDashboard(
  deps: RouteDeps,
  opts: BuildDashboardOptions,
): Promise<MeDashboardPayload> {
  const { uid, caller, fresh } = opts;
  const nowDate = opts.now ?? new Date();
  const nowMs = nowDate.getTime();
  const key = `${getActiveOrgId()}:${uid}:${opts.date ?? ''}:${opts.timeZone ?? ''}`;

  if (!fresh) {
    const hit = cache.get(key);
    if (hit && hit.expiresAt > nowMs) return hit.payload;
  }

  const reader = opts.googleReader ?? readGoogleForDashboard;
  const work = buildMyWork(deps, uid, caller);
  const openTodos = listTodos(uid, { status: 'open' });
  const google = await reader(uid, deps.config, {
    now: nowDate,
    date: opts.date,
    timeZone: opts.timeZone,
  });

  const payload: MeDashboardPayload = {
    generatedAt: nowDate.toISOString(),
    work,
    todos: { open: openTodos, openCount: openTodos.length },
    google,
  };

  evictStale(nowMs);
  cache.set(key, { expiresAt: nowMs + ME_DASHBOARD_CACHE_TTL_MS, payload });
  return payload;
}
