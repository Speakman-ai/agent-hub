import { Router, Request, Response } from 'express';
import { getDb } from '../db.js';
import { getOrg, getActiveOrgId } from '../orgs.js';
import { getMembershipRole } from '../memberships-store.js';
import type { AuthenticatedRequest } from '../auth.js';
import { getAuthRecord } from '../auth-store.js';
import config from '../config.js';
import type { RouteDeps } from '../types.js';
import { isColumnDone, isColumnShippedLane } from '../kanban-blockers.js';
import { buildNativePrUrl } from '../native-pr/url.js';
import { mergeTree, revParse } from '../native-pr/git-read.js';
import { bareRepoPath, hostedRepoExists, isAgentHubHosted } from '../native-pr/host.js';
import { reviewDecisionFor } from '../native-pr/review-decision.js';
import { mapWithConcurrency } from '../git-host/recent-pushes.js';
import { computeSessionState } from '../session-state.js';
import { getUserById } from '../users-store.js';

/**
 * Mirrors `authIsConfigured` in routes/orgs.ts. When neither JWT-backed user
 * store nor apiKey is configured the middleware is a passthrough, so we
 * shouldn't gate by membership either — every caller is anonymous.
 */
function authIsConfigured(): boolean {
  return Boolean(getAuthRecord()) || Boolean(config.apiKey);
}

/**
 * Cap the per-request git fan-out used to compute open-PR mergeability on the
 * dashboard. Each rendered row can spawn two `revParse` calls plus a
 * `mergeTree`, so processing all 30 rows at once would launch ~90 concurrent
 * git operations — and every concurrent dashboard load multiplies that. Bound
 * the row-level concurrency so the worst case is a small, predictable pool of
 * git processes instead of an unbounded burst on this broad org landing page.
 */
export const MERGEABILITY_CONCURRENCY = 4;

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

/** A native open PR (from `pull_requests`), before kanban enrichment. */
interface OpenNativePrRow {
  prId: string;
  projectId: string;
  prNumber: number;
  prTitle: string;
  author: string;
  updatedAt: number;
  headBranch: string;
  baseBranch: string;
  reviewRequestedAt: number | null;
}

/** Kanban-card metadata used to enrich an open native PR row. */
interface PrCardMetaRow {
  cardId: string;
  cardTitle: string;
  priority: string;
  prUrl: string;
  reviewStatus: string | null;
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
  router.get('/api/orgs/:id/dashboard', async (req: Request, res: Response) => {
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

    // ── Active sessions queue (detail + count) ─────────────────────
    // The queue surfaces *every in-flight session* in this org, not just the
    // ones whose CLI is currently streaming. A session that is running tests,
    // under review, pending a push, or waiting for user input is still work
    // the team needs eyes on — it must not drop out of the queue the moment
    // the lead agent stops streaming a turn (the old `active_tasks WHERE
    // status='running'` filter made exactly those sessions disappear). We
    // enumerate non-deleted sessions, resolve each one's lifecycle state, and
    // keep everything that has not reached the terminal `merged` state (the
    // linked card parked in a Done column). Each row carries the owning user
    // so the queue shows who a session belongs to.
    //
    // The display cap is applied **after** the merged/roster filter, never
    // before: capping the raw `sessions` scan up front would let a burst of
    // recently-merged sessions push older still-in-flight sessions off the
    // queue (and out of the count). To do that without resolving the full
    // lifecycle state of every historical merged row, we cheaply pre-exclude
    // merged sessions in SQL (linked card sitting in a Done column — the same
    // `isColumnDone` signal `computeSessionState` reads), so the per-session
    // state resolver only runs over the genuinely-active remainder.
    //
    // Org scoping mirrors the rest of the payload: `getDb()` is the active
    // org's database (a non-active org already 409'd), and we additionally
    // restrict to the org's *current* agent roster (`allAgents()` reloaded
    // per-org from this org's projects.json). That walks
    // session → agent → project → org explicitly and drops orphaned rows for
    // since-deleted agents instead of surfacing a bare unknown id.
    const ACTIVE_SESSIONS_DISPLAY_LIMIT = 200;
    const agentsById = new Map(allAgents().map((a) => [a.id, a]));

    // Prompt + start time for the rows whose CLI is *currently* streaming —
    // fetched in one pass and looked up per session. Most sessions in the
    // queue are not streaming, so a join would mostly return nulls.
    const runningTaskBySession = new Map(
      (
        db
          .prepare(
            `SELECT session_id, prompt, started_at FROM active_tasks WHERE status = 'running'`,
          )
          .all() as Array<{ session_id: string; prompt: string; started_at: string }>
      ).map((t) => [t.session_id, t]),
    );

    // Cheap, set-based "merged" pre-filter. `computeSessionState` treats a
    // session as merged when its linked kanban card sits in a Done column
    // (`isColumnDone`). Resolving that one signal in SQL lets us drop the bulk
    // of historical merged sessions before the (relatively pricier) per-session
    // state resolution, so we never have to enumerate-then-resolve thousands of
    // terminal rows just to honor "every session that has not merged yet".
    const mergedColumnIds = (
      db.prepare('SELECT id, name FROM kanban_columns').all() as { id: string; name: string }[]
    )
      .filter((row) => isColumnDone(row.name))
      .map((r) => r.id);

    const mergedSessionIds = new Set<string>();
    if (mergedColumnIds.length) {
      const mergedCol = mergedColumnIds.map(() => '?').join(',');
      for (const row of db
        .prepare(
          `SELECT DISTINCT session_id FROM kanban_cards
           WHERE session_id IS NOT NULL AND column_id IN (${mergedCol})`,
        )
        .all(...mergedColumnIds) as { session_id: string | null }[]) {
        if (row.session_id) mergedSessionIds.add(row.session_id);
      }
    }

    // Enumerate *all* non-deleted sessions (no pre-truncation). The roster +
    // merged pre-filter below runs in JS before any cap, so the cap only ever
    // trims the already-active set.
    const candidateSessionRows = db
      .prepare(
        `SELECT id, agent_id, name, engine, model, owner_user_id, updated_at
         FROM sessions
         WHERE deleted_at IS NULL
         ORDER BY updated_at DESC`,
      )
      .all() as Array<{
      id: string;
      agent_id: string;
      name: string | null;
      engine: string | null;
      model: string | null;
      owner_user_id: string | null;
      updated_at: string;
    }>;

    // Cache owner lookups — many sessions share an owner and getUserById hits
    // the shared orgs DB on each call.
    const ownerNameCache = new Map<string, string | null>();
    const resolveOwnerName = (ownerId: string | null): string | null => {
      if (!ownerId) return null;
      if (ownerNameCache.has(ownerId)) return ownerNameCache.get(ownerId) ?? null;
      let name: string | null = null;
      try {
        name = getUserById(ownerId)?.username ?? null;
      } catch {
        name = null;
      }
      ownerNameCache.set(ownerId, name);
      return name;
    };

    const activeSessionsResolved = candidateSessionRows
      // Drop orphaned/cross-org rows, then cheaply pre-exclude merged sessions.
      // A merged-card session is kept *only* if it is actively streaming again
      // (reopened work) — `computeSessionState` ranks live activity above the
      // sticky `merged` marker, so the authoritative filter below still keeps
      // it. This is the lone case where a Done-column session is not terminal.
      .filter(
        (r) =>
          agentsById.has(r.agent_id) &&
          (!mergedSessionIds.has(r.id) || runningTaskBySession.has(r.id)),
      )
      .map((r) => ({ r, state: computeSessionState(stmts, r.id) }))
      // Authoritative terminal-state filter (covers the reopened edge above and
      // any finalize-phase nuance the SQL pre-filter can't express). Everything
      // earlier in the pipeline (waiting → working → tests → review → checks →
      // push → pushed) stays visible until it lands.
      .filter(({ state }) => state !== 'merged');

    // Cap is applied AFTER filtering, so a merged session can never displace an
    // in-flight one. Count and list stay the same scoped set, so they can never
    // disagree; if the active set ever exceeds the cap we log the truncation
    // rather than silently hide it.
    if (activeSessionsResolved.length > ACTIVE_SESSIONS_DISPLAY_LIMIT) {
      console.warn(
        `[dashboard] active sessions (${activeSessionsResolved.length}) exceed display cap ${ACTIVE_SESSIONS_DISPLAY_LIMIT}; truncating the queue for org ${orgId}.`,
      );
    }

    const activeSessionsList = activeSessionsResolved
      .slice(0, ACTIVE_SESSIONS_DISPLAY_LIMIT)
      .map(({ r, state }) => {
        const agent = agentsById.get(r.agent_id)!;
        const task = runningTaskBySession.get(r.id) || null;
        return {
          sessionId: r.id,
          sessionName: r.name || 'Untitled session',
          agentId: r.agent_id,
          agentName: agent.name || r.agent_id,
          agentColor: agent.color ?? null,
          engine: r.engine || '',
          model: r.model ?? null,
          prompt: task?.prompt || '',
          state,
          ownerUserId: r.owner_user_id ?? null,
          ownerName: resolveOwnerName(r.owner_user_id ?? null),
          startedAt: task?.started_at ?? null,
          lastActivityAt: r.updated_at,
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
    // "Open PRs" means native *Agent Hub repository* PRs — rows in the
    // `pull_requests` table with status='open' for one of this org's
    // projects. This is the *same* source of truth the Pulls page reads
    // (`nativePr.listPulls`), so the dashboard count can never disagree with
    // the per-project PR viewer.
    //
    // This list used to be derived indirectly from kanban cards carrying a
    // native `pr_url` not in a Done column. That undercounted: an open native
    // PR with no linked card (or whose card had been parked in a Done column)
    // rendered on the Pulls page but showed as 0 here. We now read
    // `pull_requests` directly and *enrich* each row with kanban metadata
    // (priority + the owning card id, used for the priority dot and in-app
    // navigation) when a card happens to link the PR url.
    //
    // GitHub-hosted projects have no rows in `pull_requests` (the table is
    // native-only), so they stay excluded from the count exactly as before.
    // Org scoping mirrors the rest of the payload: `getDb()` is the active
    // org's database and we restrict to the org's current project roster.
    const OPEN_PR_LIMIT = 30;
    const projectNameById = new Map(projects.map((p) => [p.id, p.name]));
    const projectById = new Map(projects.map((p) => [p.id, p]));
    const projectIds = [...projectNameById.keys()];
    const projectPlaceholders = projectIds.map(() => '?').join(',');

    const openNativePrRows = projectIds.length
      ? (db
          .prepare(
            `SELECT id as prId, project_id as projectId, number as prNumber,
                    title as prTitle, author as author, updated_at as updatedAt,
                    head_branch as headBranch, base_branch as baseBranch,
                    review_requested_at as reviewRequestedAt
             FROM pull_requests
             WHERE status = 'open' AND project_id IN (${projectPlaceholders})
             ORDER BY updated_at DESC`,
          )
          .all(...projectIds) as OpenNativePrRow[])
      : [];

    const openPRs = openNativePrRows.length;

    // pr_url → kanban-card lookup so an open PR that *does* have a linked card
    // can surface that card's priority + id. A PR with no card is fine — we
    // fall back to the PR's own metadata. The first (most-recently-updated)
    // card wins for a given url.
    const prCardMetaByUrl = new Map<string, PrCardMetaRow>();
    if (projectIds.length) {
      const cardRows = db
        .prepare(
          `SELECT k.id as cardId, k.title as cardTitle, k.priority as priority,
                  k.pr_url as prUrl, k.review_status as reviewStatus
           FROM kanban_cards k
           JOIN kanban_boards b ON b.id = k.board_id
           WHERE k.pr_url IS NOT NULL AND k.pr_url != ''
             AND b.project_id IN (${projectPlaceholders})
           ORDER BY k.updated_at DESC`,
        )
        .all(...projectIds) as PrCardMetaRow[];
      for (const c of cardRows) {
        if (!prCardMetaByUrl.has(c.prUrl)) prCardMetaByUrl.set(c.prUrl, c);
      }
    }

    // Per-url author-agent enrichment from the creation log (a display name
    // like "agent-hub-dev"), preferred over the raw PR `author` (a userId or
    // 'finalize'). Only queried for the rows we actually render.
    const authorAgentStmt = db.prepare(
      `SELECT author_agent as authorAgent FROM pr_creation_logs
       WHERE pr_url = ? ORDER BY created_at DESC LIMIT 1`,
    );

    const openPrRows = openNativePrRows.slice(0, OPEN_PR_LIMIT);
    const openPRsList = await mapWithConcurrency(
      openPrRows,
      MERGEABILITY_CONCURRENCY,
      async (r) => {
        const prUrl = buildNativePrUrl(r.projectId, r.prNumber);
        const card = prCardMetaByUrl.get(prUrl);
        const logRow = authorAgentStmt.get(prUrl) as { authorAgent: string | null } | undefined;

        let mergeable: boolean | null = null;
        const project = projectById.get(r.projectId);
        if (project && isAgentHubHosted(project) && hostedRepoExists(project.id)) {
          try {
            const repoPath = bareRepoPath(project.id);
            const [baseSha, headSha] = await Promise.all([
              revParse(repoPath, `refs/heads/${r.baseBranch}`),
              revParse(repoPath, `refs/heads/${r.headBranch}`),
            ]);
            if (baseSha && headSha) {
              mergeable = (await mergeTree(repoPath, baseSha, headSha)).mergeable;
            }
          } catch {
            mergeable = null;
          }
        }

        const reviewDecision = reviewDecisionFor(stmts, r.projectId, {
          number: r.prNumber,
          review_requested_at: r.reviewRequestedAt,
        });

        return {
          // Stable, always-present list key. Prefer the linked card id; fall
          // back to the (unique) PR url when no card links this PR. This is a
          // rendering key only — never treat it as a card identifier.
          key: card?.cardId ?? prUrl,
          // The owning kanban card id, or null when no card links this PR.
          // Kept strictly to real card ids so callers can safely run card
          // operations / navigation on it.
          cardId: card?.cardId ?? null,
          projectId: r.projectId,
          projectName: projectNameById.get(r.projectId) || r.projectId,
          prUrl,
          prNumber: r.prNumber,
          title: `PR #${r.prNumber}: ${r.prTitle}`,
          cardTitle: card?.cardTitle ?? null,
          authorAgent: logRow?.authorAgent ?? null,
          priority: card?.priority ?? null,
          updatedAt: r.updatedAt,
          mergeable,
          reviewDecision,
          reviewStatus: card?.reviewStatus ?? null,
        };
      },
    );

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
