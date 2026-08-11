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
 *   - `status`    — filter to one lifecycle state (new | investigating |
 *                   converted | closed)
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
    const status = req.query.status as string | undefined;
    if (status && !(SUPPORT_TICKET_STATUSES as readonly string[]).includes(status)) {
      return res
        .status(400)
        .json({ error: `status must be one of: ${SUPPORT_TICKET_STATUSES.join(', ')}` });
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
        statuses: status ? [status as SupportTicketStatus] : undefined,
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
    const allRows = resolvedProjectId || status || unread ? listAllSupportTickets() : tickets;
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
