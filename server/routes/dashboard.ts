import { Router, Request, Response } from 'express';
import { getDb } from '../db.js';
import { getOrg, getActiveOrgId } from '../orgs.js';
import { getMembershipRole } from '../memberships-store.js';
import type { AuthenticatedRequest } from '../auth.js';
import { getAuthRecord } from '../auth-store.js';
import config from '../config.js';
import type { RouteDeps } from '../types.js';
import { isColumnDone, isColumnShippedLane } from '../kanban-blockers.js';
import { isNativePrUrl } from '../native-pr/url.js';

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
  project_id: string;
  pr_url: string | null;
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

interface PrCreationActivityRow {
  id: string;
  project_id: string;
  card_id: string | null;
  session_id: string | null;
  pr_url: string;
  pr_number: number | null;
  pr_title: string;
  author_agent: string;
  created_at: string;
}

interface OpenPrRow {
  cardId: string;
  cardTitle: string;
  prUrl: string;
  priority: string;
  updatedAt: string;
  projectId: string;
  prNumber: number | null;
  prTitle: string | null;
  authorAgent: string | null;
}

/** Same semantics as headline "open" work: Done-ish columns + shipped lanes. */
function isHeadlineClosedColumnName(name: string): boolean {
  return isColumnDone(name) || isColumnShippedLane(name);
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
    const { id: rawOrgId } = req.params as { id: string };

    // `:id = 'active'` is an alias for the server's currently-active org.
    // This exists primarily for remote-mode client bookmarks (see
    // `client/src/utils/orgs.js`) whose `id` is a browser-generated random
    // string that has no counterpart on the remote server — they can send
    // `active` and get the remote's active-org dashboard without knowing
    // its real id. Local callers still use explicit ids.
    const activeOrgId = getActiveOrgId();
    const orgId = rawOrgId === 'active' ? activeOrgId : rawOrgId;

    const org = getOrg(orgId);
    if (!org) return res.status(404).json({ error: 'Org not found' });

    // Membership gate: any member (Owner/Admin/User) can read their own
    // org's dashboard. apiKey callers are global. No-auth dev mode passes
    // through. Gate against the resolved id so the `active` alias still
    // enforces real membership on the underlying org.
    if (authIsConfigured() && !authedReq.authViaApiKey && !authedReq.authLocalOrgBypass) {
      if (!authedReq.authUserId) {
        return res.status(401).json({ error: 'Authentication required.' });
      }
      const role = getMembershipRole(authedReq.authUserId, orgId);
      if (!role) {
        return res.status(403).json({ error: 'You are not a member of this org.' });
      }
    }

    if (orgId !== activeOrgId) {
      // The per-org DBs aren't all mounted on this handle; ask the client
      // to switch first rather than silently returning stale / empty data.
      // (Unreachable when `rawOrgId === 'active'` — we already resolved it
      // to `activeOrgId` above.)
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

    // ── Active sessions (detail + count) ───────────────────────────
    // The panel wants per-session rows so it can list what each agent is
    // working on and deep-link into the chat; the headline `activeSessions`
    // counter is the same set, just counted.
    //
    // Org scoping: `getDb()` is the active org's database and the route has
    // already 409'd any non-active org, so `active_tasks` here only contains
    // this org's rows — the same hard boundary the kanban/recent-activity
    // queries rely on. On top of that physical isolation we restrict to the
    // org's *current* agent roster: `allAgents()` is reloaded per-org from
    // this org's `projects.json`, so an `agent_id` it contains is by
    // definition an agent in a project in this org. This walks the
    // session → agent → project → org relationship explicitly (rather than
    // leaning solely on the per-org DB handle), and as a bonus drops orphaned
    // rows for deleted agents instead of surfacing a bare unknown id.
    const agentsById = new Map(allAgents().map((a) => [a.id, a]));
    const activeSessionRows = db
      .prepare(
        `SELECT t.session_id, t.agent_id, t.engine, t.model, t.prompt, t.started_at,
                s.name as session_name
         FROM active_tasks t
         LEFT JOIN sessions s ON s.id = t.session_id
         WHERE t.status = 'running'
         ORDER BY t.started_at ASC`,
      )
      .all() as Array<{
      session_id: string;
      agent_id: string;
      engine: string;
      model: string | null;
      prompt: string;
      started_at: string;
      session_name: string | null;
    }>;

    const activeSessionsList = activeSessionRows
      .filter((r) => agentsById.has(r.agent_id))
      .map((r) => {
        const agent = agentsById.get(r.agent_id)!;
        return {
          sessionId: r.session_id,
          sessionName: r.session_name || 'Untitled session',
          agentId: r.agent_id,
          agentName: agent.name || r.agent_id,
          agentColor: agent.color ?? null,
          engine: r.engine,
          model: r.model,
          prompt: r.prompt || '',
          startedAt: r.started_at,
        };
      });

    // Count and list are the same scoped set, so they can never disagree.
    const activeSessions = activeSessionsList.length;

    // "Done" is identified by column name (see `isColumnDone` in kanban-blockers).
    // Must not require an exact spelling of "Done" — boards rename the lane to
    // "Deployed / Done", "Done ✅", etc.; those must not count toward open cards.
    const doneColumnIds = (
      db.prepare('SELECT id, name FROM kanban_columns').all() as { id: string; name: string }[]
    )
      .filter((row) => isHeadlineClosedColumnName(row.name))
      .map((r) => r.id);

    const placeholders = doneColumnIds.length ? doneColumnIds.map(() => '?').join(',') : "''"; // Empty IN (...) isn't legal in SQLite — fall back to a value nothing equals.

    const openCards =
      (
        db
          .prepare(
            `SELECT COUNT(*) as c FROM kanban_cards WHERE column_id NOT IN (${placeholders})`,
          )
          .get(...doneColumnIds) as { c: number }
      ).c || 0;

    // ── Open PRs (count + detail list) ─────────────────────────────
    // "Open PRs" means *Agent Hub repository* PRs only — kanban cards
    // carrying a non-empty `pr_url` that points at a native Hub PR
    // (`/projects/<id>/pulls/<n>`) and are not yet in a Done-ish / shipped
    // column. GitHub-hosted PR URLs are intentionally excluded from both the
    // headline counter and the panel list: a card's `pr_url` is an opaque
    // string, so `isNativePrUrl` is the single source of truth for "this PR
    // lives in an Agent Hub repository". Each row is enriched per-row from
    // `pr_creation_logs` (PR number / title / author) when a creation log
    // exists for that URL, falling back to the card title when it doesn't.
    //
    // Org scoping: like `activeSessions` above, we don't lean solely on the
    // per-org DB handle — we explicitly restrict to the org's *current*
    // project roster (`getProjects()` is reloaded per-org from this org's
    // projects.json). This walks card → board → project → org so a board row
    // left behind by a since-deleted project can't surface its PR/card
    // metadata in the list, keeping it consistent with the rest of the
    // payload. With no projects there is nothing to list.
    //
    // The headline `openPRs` counter is derived from the same native set so
    // the panel and the mobile "Open PRs" tile never disagree. We fetch all
    // qualifying rows (native filter and the 30-row cap are applied in JS,
    // since the URL scheme can't be expressed in SQL) and slice for the list.
    const OPEN_PR_LIMIT = 30;
    const projectNameById = new Map(projects.map((p) => [p.id, p.name]));
    const projectIds = [...projectNameById.keys()];
    const projectPlaceholders = projectIds.map(() => '?').join(',');

    const openPrCandidates = projectIds.length
      ? (db
          .prepare(
            `SELECT k.id as cardId, k.title as cardTitle, k.pr_url as prUrl, k.priority as priority,
                k.updated_at as updatedAt, b.project_id as projectId,
                (SELECT pr_number FROM pr_creation_logs WHERE pr_url = k.pr_url ORDER BY created_at DESC LIMIT 1) as prNumber,
                (SELECT pr_title FROM pr_creation_logs WHERE pr_url = k.pr_url ORDER BY created_at DESC LIMIT 1) as prTitle,
                (SELECT author_agent FROM pr_creation_logs WHERE pr_url = k.pr_url ORDER BY created_at DESC LIMIT 1) as authorAgent
         FROM kanban_cards k
         JOIN kanban_boards b ON b.id = k.board_id
         WHERE k.pr_url IS NOT NULL AND k.pr_url != ''
           AND k.column_id NOT IN (${placeholders})
           AND b.project_id IN (${projectPlaceholders})
         ORDER BY k.updated_at DESC`,
          )
          .all(...doneColumnIds, ...projectIds) as OpenPrRow[])
      : [];

    // Agent Hub repository PRs only — drop GitHub (and any non-native) URLs.
    const nativeOpenPrRows = openPrCandidates.filter((r) => isNativePrUrl(r.prUrl));
    const openPRs = nativeOpenPrRows.length;
    const openPrRows = nativeOpenPrRows.slice(0, OPEN_PR_LIMIT);

    const openPRsList = openPrRows.map((r) => ({
      cardId: r.cardId,
      projectId: r.projectId,
      projectName: projectNameById.get(r.projectId) || r.projectId,
      prUrl: r.prUrl,
      prNumber: r.prNumber,
      // Prefer the richer "PR #123: title" form when a creation log exists;
      // otherwise fall back to the card's own title so external/legacy PRs
      // (no creation log) still render a meaningful label.
      title:
        r.prNumber != null && r.prTitle
          ? `PR #${r.prNumber}: ${r.prTitle}`
          : r.prTitle || r.cardTitle,
      cardTitle: r.cardTitle,
      authorAgent: r.authorAgent,
      priority: r.priority,
      updatedAt: r.updatedAt,
    }));

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

    // ── Recent activity (union of card/session/escalation/PR sources, sorted by timestamp) ─
    const ACTIVITY_LIMIT = 20;

    const recentCards = db
      .prepare(
        `SELECT k.id, k.title, c.name as column_name, k.priority,
                k.updated_at, k.created_at, b.project_id as project_id, k.pr_url as pr_url
         FROM kanban_cards k
         JOIN kanban_columns c ON c.id = k.column_id
         JOIN kanban_boards b ON b.id = k.board_id
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

    const recentPrCreations = db
      .prepare(
        `SELECT id, project_id, card_id, session_id, pr_url, pr_number, pr_title, author_agent, created_at
         FROM pr_creation_logs
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(ACTIVITY_LIMIT) as PrCreationActivityRow[];

    type ActivityEntry = {
      type: 'card_created' | 'card_updated' | 'session_created' | 'escalation' | 'pr_created';
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
        meta: {
          column: c.column_name,
          priority: c.priority,
          projectId: c.project_id,
          ...(c.pr_url ? { prUrl: c.pr_url } : {}),
        },
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
    for (const p of recentPrCreations) {
      activity.push({
        type: 'pr_created',
        id: p.id,
        title: p.pr_number != null ? `PR #${p.pr_number}: ${p.pr_title}` : p.pr_title,
        timestamp: p.created_at,
        meta: {
          projectId: p.project_id,
          cardId: p.card_id,
          sessionId: p.session_id,
          prUrl: p.pr_url,
          prNumber: p.pr_number,
          authorAgent: p.author_agent,
        },
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
      activeSessions: activeSessionsList,
      openPRs: openPRsList,
      recentActivity,
    });
  });

  return router;
}
