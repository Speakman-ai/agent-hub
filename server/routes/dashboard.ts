import { Router, Request, Response } from 'express';
import { getDb } from '../db.js';
import { getOrg, getActiveOrgId } from '../orgs.js';
import { getMembershipRole } from '../memberships-store.js';
import type { AuthenticatedRequest } from '../auth.js';
import { getAuthRecord } from '../auth-store.js';
import config from '../config.js';
import type { RouteDeps } from '../types.js';

/**
 * Mirrors `authIsConfigured` in routes/orgs.ts. When neither JWT-backed user
 * store nor apiKey is configured the middleware is a passthrough, so we
 * shouldn't gate by membership either — every caller is anonymous.
 */
function authIsConfigured(): boolean {
  return Boolean(getAuthRecord()) || Boolean(config.apiKey);
}

interface KanbanBreakdownRow {
  column_name: string;
  count: number;
}

interface PriorityCountRow {
  priority: string;
  count: number;
}

interface CardActivityRow {
  id: string;
  title: string;
  column_name: string;
  priority: string;
  updated_at: string;
  created_at: string;
}

interface SessionActivityRow {
  id: string;
  name: string;
  agent_id: string;
  created_at: string;
}

interface EscalationActivityRow {
  id: string;
  project_id: string;
  type: string;
  title: string;
  created_at: string;
}

interface DoneColumnRow {
  id: string;
}

export default function createDashboardRoutes(deps: RouteDeps): Router {
  const { stmts, getProjects, allAgents } = deps;
  const router = Router();

  /**
   * Org-wide dashboard. Aggregates counts + recent activity across every
   * project in the org so the sidebar can render a single top-level view
   * without stitching together per-project endpoints.
   *
   * Implementation note: `stmts` and `getDb()` always point at the active
   * org's database. A request for a non-active org returns 409 — the client
   * is expected to `POST /api/orgs/:id/switch` first. This keeps the route
   * stateless and avoids having to juggle multiple per-org connections on a
   * read path. Membership gating mirrors `/api/orgs/:id/members`.
   */
  router.get('/api/orgs/:id/dashboard', (req: Request, res: Response) => {
    const authedReq = req as AuthenticatedRequest;
    const { id: orgId } = req.params as { id: string };

    const org = getOrg(orgId);
    if (!org) return res.status(404).json({ error: 'Org not found' });

    // Membership gate: any member (Owner/Admin/User) can read their own
    // org's dashboard. apiKey callers are global. No-auth dev mode passes
    // through.
    if (authIsConfigured() && !authedReq.authViaApiKey) {
      if (!authedReq.authUserId) {
        return res.status(401).json({ error: 'Authentication required.' });
      }
      const role = getMembershipRole(authedReq.authUserId, orgId);
      if (!role) {
        return res.status(403).json({ error: 'You are not a member of this org.' });
      }
    }

    const activeOrgId = getActiveOrgId();
    if (orgId !== activeOrgId) {
      // The per-org DBs aren't all mounted on this handle; ask the client
      // to switch first rather than silently returning stale / empty data.
      return res.status(409).json({
        error: 'Org not active. Switch to this org before loading its dashboard.',
        activeOrgId,
      });
    }

    const db = getDb();

    const projects = getProjects();
    const projectCount = projects.length;
    const agentCount = allAgents().length;

    // ── Headline counters ──────────────────────────────────────────
    const sessionsTotal =
      (db.prepare('SELECT COUNT(*) as c FROM sessions').get() as { c: number }).c || 0;
    const activeSessions =
      (
        db.prepare("SELECT COUNT(*) as c FROM active_tasks WHERE status = 'running'").get() as {
          c: number;
        }
      ).c || 0;

    // "Done" is identified by column name rather than a flag — match the
    // kanban convention used elsewhere (see `isColumnDone`). Case-insensitive
    // so "done" / "Done" / "DONE" all match.
    const doneColumnIds = (
      db
        .prepare(
          "SELECT id FROM kanban_columns WHERE LOWER(name) = 'done' OR LOWER(name) = 'shipped'",
        )
        .all() as DoneColumnRow[]
    ).map((r) => r.id);

    const placeholders = doneColumnIds.length ? doneColumnIds.map(() => '?').join(',') : "''"; // Empty IN (...) isn't legal in SQLite — fall back to a value nothing equals.

    const openCards =
      (
        db
          .prepare(
            `SELECT COUNT(*) as c FROM kanban_cards WHERE column_id NOT IN (${placeholders})`,
          )
          .get(...doneColumnIds) as { c: number }
      ).c || 0;

    const openPRs =
      (
        db
          .prepare(
            `SELECT COUNT(*) as c FROM kanban_cards
             WHERE pr_url IS NOT NULL AND pr_url != ''
               AND column_id NOT IN (${placeholders})`,
          )
          .get(...doneColumnIds) as { c: number }
      ).c || 0;

    const escalations = (stmts.getAllActiveEscalations.all() as unknown[]).length;

    // ── Kanban breakdown ──────────────────────────────────────────
    const totalBoards =
      (db.prepare('SELECT COUNT(*) as c FROM kanban_boards').get() as { c: number }).c || 0;
    const totalCards =
      (db.prepare('SELECT COUNT(*) as c FROM kanban_cards').get() as { c: number }).c || 0;

    const byColumnRows = db
      .prepare(
        `SELECT c.name as column_name, COUNT(k.id) as count
         FROM kanban_columns c
         LEFT JOIN kanban_cards k ON k.column_id = c.id
         GROUP BY LOWER(c.name)
         ORDER BY count DESC, column_name ASC`,
      )
      .all() as KanbanBreakdownRow[];

    // Normalise to unique display names. GROUP BY LOWER(...) means we
    // arbitrarily pick one row per (case-insensitive) column name; the
    // `name` value on that row is already a representative label.
    const byColumn = byColumnRows.map((r) => ({
      columnName: r.column_name,
      count: r.count,
    }));

    const priorityRows = db
      .prepare(
        `SELECT priority, COUNT(*) as count FROM kanban_cards
         WHERE column_id NOT IN (${placeholders})
         GROUP BY priority`,
      )
      .all(...doneColumnIds) as PriorityCountRow[];

    const byPriority: Record<'urgent' | 'high' | 'medium' | 'low', number> = {
      urgent: 0,
      high: 0,
      medium: 0,
      low: 0,
    };
    for (const row of priorityRows) {
      if (row.priority in byPriority) {
        byPriority[row.priority as keyof typeof byPriority] = row.count;
      }
    }

    // ── Recent activity (union of three sources, sorted by timestamp) ─
    const ACTIVITY_LIMIT = 20;

    const recentCards = db
      .prepare(
        `SELECT k.id, k.title, c.name as column_name, k.priority,
                k.updated_at, k.created_at
         FROM kanban_cards k
         JOIN kanban_columns c ON c.id = k.column_id
         ORDER BY k.updated_at DESC
         LIMIT ?`,
      )
      .all(ACTIVITY_LIMIT) as CardActivityRow[];

    const recentSessions = db
      .prepare(
        `SELECT id, name, agent_id, created_at FROM sessions
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(ACTIVITY_LIMIT) as SessionActivityRow[];

    const recentEscalations = db
      .prepare(
        `SELECT id, project_id, type, title, created_at FROM escalations
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(ACTIVITY_LIMIT) as EscalationActivityRow[];

    type ActivityEntry = {
      type: 'card_created' | 'card_updated' | 'session_created' | 'escalation';
      id: string;
      title: string;
      timestamp: string;
      meta?: Record<string, string | number | null>;
    };

    const activity: ActivityEntry[] = [];
    for (const c of recentCards) {
      // If created_at === updated_at we treat the card as newly-created;
      // otherwise surface it as an update. Either way only one event per
      // card makes the merged feed (we dedupe on id:type below).
      const isNew = c.created_at === c.updated_at;
      activity.push({
        type: isNew ? 'card_created' : 'card_updated',
        id: c.id,
        title: c.title,
        timestamp: c.updated_at,
        meta: { column: c.column_name, priority: c.priority },
      });
    }
    for (const s of recentSessions) {
      activity.push({
        type: 'session_created',
        id: s.id,
        title: s.name,
        timestamp: s.created_at,
        meta: { agentId: s.agent_id },
      });
    }
    for (const e of recentEscalations) {
      activity.push({
        type: 'escalation',
        id: e.id,
        title: e.title,
        timestamp: e.created_at,
        meta: { projectId: e.project_id, escalationType: e.type },
      });
    }

    activity.sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));
    const recentActivity = activity.slice(0, ACTIVITY_LIMIT);

    return res.json({
      orgId,
      orgName: org.name,
      isActive: true,
      headline: {
        projects: projectCount,
        agents: agentCount,
        sessions: sessionsTotal,
        activeSessions,
        openCards,
        openPRs,
        escalations,
      },
      kanban: {
        totalBoards,
        totalCards,
        byColumn,
        byPriority,
      },
      recentActivity,
    });
  });

  return router;
}
