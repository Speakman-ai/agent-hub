import { Router, Request, Response } from 'express';
import type { RouteDeps, RumSessionRow } from '../types.js';
import { listRumSessions, type ListRumSessionsOpts } from '../replays/rum-session-list-store.js';

/**
 * RUM Session Explorer — the authenticated, project-scoped list surface behind
 * the Datadog-parity session-grain dashboard table.
 *
 * Mounts under `/api/projects/:projectId`, so it inherits the shared
 * project-visibility gate — `app.use('/api/projects/:projectId',
 * createProjectVisibilityGate(...))` in index.ts runs AHEAD of this router and
 * masks a caller who can't view the project as 404 before the handler runs.
 * This matters here because the response carries user PII (usrEmail/usrName), so
 * the handler deliberately does NOT re-check membership — the gate owns tenant
 * isolation. That contract is pinned by rum-sessions-visibility.test.ts (a
 * non-viewer is masked with no PII leak; the owner is let through).
 *
 * Unlike the capture-grain `/replays` table (one row per rrweb blob, with
 * ticket-linking), this lists the `rum_sessions` rollup — one row per
 * client-minted session id, carrying the session-level aggregates and indexed
 * facets the Explorer filters on (user, device, browser, os, geo, duration,
 * view/action/error/frustration counts, started-at time range).
 */
export default function createRumSessionsRoutes(deps: RouteDeps): Router {
  const { findProject } = deps;
  const router = Router();

  // ── List: paginated, filterable session table ────────────────────
  router.get('/api/projects/:projectId/rum/sessions', (req: Request, res: Response) => {
    const project = findProject(req.params.projectId as string);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const q = req.query;
    const opts: ListRumSessionsOpts = {
      projectId: project.id,
      usrEmail: stringParam(q.usrEmail),
      usrName: stringParam(q.usrName),
      usrId: stringParam(q.usrId),
      deviceType: stringParam(q.deviceType),
      browser: stringParam(q.browser),
      os: stringParam(q.os),
      geoCountry: stringParam(q.geoCountry),
      durationMinMs: numberParam(q.durationMinMs),
      durationMaxMs: numberParam(q.durationMaxMs),
      viewCountMin: numberParam(q.viewCountMin),
      actionCountMin: numberParam(q.actionCountMin),
      errorCountMin: numberParam(q.errorCountMin),
      frustrationCountMin: numberParam(q.frustrationCountMin),
      from: numberParam(q.from),
      to: numberParam(q.to),
      limit: numberParam(q.limit),
      offset: numberParam(q.offset),
    };

    const page = listRumSessions(opts);
    res.json({
      sessions: page.sessions.map(toRumSessionListItem),
      total: page.total,
      limit: page.limit,
      offset: page.offset,
      hasMore: page.hasMore,
    });
  });

  return router;
}

/** A trimmed query-string param, or undefined for missing / non-string / blank
 *  (Express gives arrays for repeated params — those collapse to undefined). */
function stringParam(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t.length ? t : undefined;
}

/** A finite numeric query param, or undefined so the store applies its default. */
function numberParam(v: unknown): number | undefined {
  if (typeof v !== 'string' || v.trim() === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export interface RumSessionListItemView {
  sessionId: string;
  projectId: string | null;
  /** Earliest event timestamp across the session, epoch ms (null until seen). */
  startedAt: number | null;
  /** Latest event timestamp across the session, epoch ms (null until seen). */
  endedAt: number | null;
  /** Session duration, ms (`endedAt - startedAt`, 0 until both are known). */
  timeSpent: number;
  viewCount: number;
  actionCount: number;
  errorCount: number;
  frustrationCount: number;
  usrId: string | null;
  usrEmail: string | null;
  usrName: string | null;
  /** Custom (non-standard) user attributes, parsed from JSON; null when none. */
  usrAttributes: Record<string, unknown> | null;
  deviceType: string | null;
  browser: string | null;
  os: string | null;
  geoCountry: string | null;
  firstSeenAt: string;
  updatedAt: string;
}

/** Parse the stored custom-attributes JSON to an object, tolerating a legacy /
 *  malformed blob (returns null rather than throwing the whole list query). */
function parseUserAttributes(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through
  }
  return null;
}

export function toRumSessionListItem(row: RumSessionRow): RumSessionListItemView {
  return {
    sessionId: row.session_id,
    projectId: row.project_id,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    timeSpent: row.time_spent,
    viewCount: row.view_count,
    actionCount: row.action_count,
    errorCount: row.error_count,
    frustrationCount: row.frustration_count,
    usrId: row.usr_id,
    usrEmail: row.usr_email,
    usrName: row.usr_name,
    usrAttributes: parseUserAttributes(row.usr_attributes),
    deviceType: row.device_type,
    browser: row.browser,
    os: row.os,
    geoCountry: row.geo_country,
    firstSeenAt: row.first_seen_at,
    updatedAt: row.updated_at,
  };
}
