import { Router, Request, Response } from 'express';
import type { RouteDeps } from '../types.js';
import { listAllSupportTickets, SUPPORT_TICKET_STATUSES } from '../support-tickets-store.js';
import type { SupportTicketStatus } from '../types.js';
import { resolveVisibilityCaller } from '../project-visibility-middleware.js';
import { serializeSupportTickets } from '../support-ticket-serialization.js';

/**
 * Cross-project support overview.
 *
 * The per-project queue (`/api/projects/:projectId/support-tickets`) only ever
 * shows one project at a time. This route aggregates every project's support
 * tickets into a single severity-ordered list (critical → low, then newest) so
 * an operator can triage the whole org from one place. Each row is enriched
 * with `project_name` for display, and the response also carries the distinct
 * set of projects that currently have tickets so the client can build a stable
 * project filter regardless of which `projectId` filter is active.
 *
 * Optional query params (all compose, all applied server-side):
 *   - `status`    — filter to one or more lifecycle states, comma-separated
 *                   (e.g. `new,investigating`). Absent → every status. A UI
 *                   filter group can map to several states in one request.
 *   - `projectId` — scope to a single project (404 if the project is unknown)
 *   - `unread`    — when `true`/`1`, keep only tickets a human hasn't viewed
 *                   yet (`read_at IS NULL`). Powers the dashboard's
 *                   "needs triage" view.
 */
// Accepted truthy/falsy spellings for the `unread` query param. Mirrors the
// OpenAPI enum in support-tickets-overview.openapi.ts; an out-of-set value is a
// 400 (same contract as `status`) rather than a silent fall-through to false.
const UNREAD_PARAM_VALUES = ['true', '1', 'false', '0'] as const;

export default function createSupportTicketsOverviewRoutes(deps: RouteDeps): Router {
  const { getProjects, findProject } = deps;
  const router = Router();

  router.get('/api/support-tickets', (req: Request, res: Response) => {
    // `status` accepts a comma-separated list (e.g. `new,investigating`) so a
    // dashboard filter group can map to several lifecycle states in one request.
    // Absent → every status (unchanged). A repeated key makes Express parse an
    // array; only a single string is valid, so reject any other shape with 400
    // rather than letting `.split` throw a 500.
    const rawStatus = req.query.status;
    let statuses: SupportTicketStatus[] | undefined;
    if (rawStatus !== undefined) {
      if (typeof rawStatus !== 'string') {
        return res
          .status(400)
          .json({ error: `status must be one of: ${SUPPORT_TICKET_STATUSES.join(', ')}` });
      }
      const tokens = rawStatus
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const bad = tokens.filter((s) => !(SUPPORT_TICKET_STATUSES as readonly string[]).includes(s));
      if (bad.length) {
        return res
          .status(400)
          .json({ error: `status must be one of: ${SUPPORT_TICKET_STATUSES.join(', ')}` });
      }
      statuses = tokens.length ? (tokens as SupportTicketStatus[]) : undefined;
    }

    const projectId = req.query.projectId as string | undefined;
    let resolvedProjectId: string | undefined;
    if (projectId) {
      const project = findProject(projectId);
      if (!project) return res.status(404).json({ error: 'Project not found' });
      resolvedProjectId = project.id;
    }

    const unreadParam = req.query.unread as string | undefined;
    if (
      unreadParam !== undefined &&
      !(UNREAD_PARAM_VALUES as readonly string[]).includes(unreadParam)
    ) {
      return res
        .status(400)
        .json({ error: `unread must be one of: ${UNREAD_PARAM_VALUES.join(', ')}` });
    }
    const unread = unreadParam === 'true' || unreadParam === '1';

    const projectNameById = new Map(getProjects().map((p) => [p.id, p.name]));

    const caller = resolveVisibilityCaller(req);
    const canReadReporterEmail = Boolean(
      caller.localBypass || caller.role === 'Owner' || caller.role === 'Admin',
    );

    // Serialize as a batch — the per-ticket path would re-query each ticket's
    // converted card, an N+1 across this cross-project list.
    const tickets = serializeSupportTickets(
      listAllSupportTickets({
        projectId: resolvedProjectId,
        statuses,
        unread,
      }),
      { canReadReporterEmail },
    ).map((t) => ({
      ...t,
      project_name: projectNameById.get(t.project_id) ?? t.project_id,
    }));

    // The project filter options must stay complete regardless of the active
    // `projectId`/`status` filter, so derive them from an unfiltered scan of
    // distinct projects-with-tickets rather than from the (possibly filtered)
    // `tickets` above. Ordered by descending ticket count, then name.
    const allRows = resolvedProjectId || statuses || unread ? listAllSupportTickets() : tickets;
    const countByProject = new Map<string, number>();
    for (const t of allRows) {
      countByProject.set(t.project_id, (countByProject.get(t.project_id) ?? 0) + 1);
    }
    const projects = [...countByProject.entries()]
      .map(([id, count]) => ({ id, name: projectNameById.get(id) ?? id, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

    res.json({ tickets, projects });
  });

  return router;
}
