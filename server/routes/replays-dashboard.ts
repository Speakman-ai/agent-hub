import { Router, Request, Response } from 'express';
import type { RouteDeps, SessionReplayRow } from '../types.js';
import { resolveVisibilityCaller } from '../project-visibility-middleware.js';
import type { VisibilityCaller } from '../project-visibility.js';
import {
  listProjectReplays,
  unlinkReplayTicket,
  isReplayListFilter,
  REPLAY_LIST_FILTERS,
  type ReplayListFilter,
  type ReplayListRow,
} from '../replays/replay-list-store.js';
import { getSupportTicket, countUnreadSupportTickets } from '../support-tickets-store.js';
import { setGuardedReplayRef } from '../support-ticket-intake.js';
import { setSupportTicketReplayRef } from '../support-tickets-store.js';
import { parseReplayIdFromRef } from '../replays/replay-store.js';

/**
 * Replays Explorer dashboard — the authenticated, project-scoped READ + LINK
 * surface behind the Datadog-RUM-Explorer-style table.
 *
 * These routes mount under `/api/projects/:projectId`, so they inherit the
 * shared project-visibility gate (`createProjectVisibilityGate`) — a caller who
 * can't view the project never reaches a handler. On top of that:
 *
 *   - The `orphans` filter lists global UNATTRIBUTED captures
 *     (`project_id IS NULL`). Those carry masked DOM with no project to scope
 *     to, so they're privileged-only (Owner / local-bundled apiKey) — the same
 *     rule `canViewReplay` applies to unattributed rows in the single-read path.
 *   - Linking re-uses `setGuardedReplayRef`, the first-write attribution guard:
 *     a replay is attached to this project + ticket ONLY if it's unattributed or
 *     already ours. A capture owned by another project is a no-op (409) — it
 *     can't be stolen across the project boundary.
 *
 * This is the inverse of the original flow (a support ticket created WITH a
 * `replayRef` claims the replay). The dashboard lets an operator start from a
 * stranded replay and attach it to a ticket — the path that recovers
 * anonymous-ingest captures that never rode along on a ticket creation.
 */
export default function createReplaysDashboardRoutes(deps: RouteDeps): Router {
  const { broadcast, findProject, stmts } = deps;
  const router = Router();

  const canViewOrphans = (caller: VisibilityCaller): boolean =>
    Boolean(caller.localBypass) || caller.role === 'Owner';

  const broadcastTicketUpdate = (projectId: string, ticket: unknown): void => {
    broadcast({
      type: 'support_ticket_updated',
      projectId,
      unreadCount: countUnreadSupportTickets(projectId),
      ticket,
    });
  };

  // ── List: paginated, filterable replay table ──────────────────────
  router.get('/api/projects/:projectId/replays', (req: Request, res: Response) => {
    const project = findProject(req.params.projectId as string);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const rawFilter = req.query.filter;
    let filter: ReplayListFilter = 'all';
    if (rawFilter !== undefined) {
      if (!isReplayListFilter(rawFilter)) {
        return res
          .status(400)
          .json({ error: `filter must be one of: ${REPLAY_LIST_FILTERS.join(', ')}` });
      }
      filter = rawFilter;
    }

    // Unattributed (orphan) captures are not scoped to any project, so only a
    // privileged caller may enumerate them — mirrors canViewReplay.
    if (filter === 'orphans' && !canViewOrphans(resolveVisibilityCaller(req))) {
      return res.status(403).json({ error: 'Not authorized to view unattributed replays' });
    }

    const page = listProjectReplays({
      projectId: project.id,
      filter,
      limit: parseIntParam(req.query.limit),
      offset: parseIntParam(req.query.offset),
    });

    res.json({
      replays: page.replays.map(toReplayListItem),
      total: page.total,
      limit: page.limit,
      offset: page.offset,
      hasMore: page.hasMore,
      filter,
      canViewOrphans: canViewOrphans(resolveVisibilityCaller(req)),
    });
  });

  // ── Link: attach a replay to one of this project's support tickets ─
  router.post('/api/projects/:projectId/replays/:id/link', async (req: Request, res: Response) => {
    const project = findProject(req.params.projectId as string);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const replayId = req.params.id as string;
    const row = stmts.getSessionReplay.get(replayId) as SessionReplayRow | undefined;
    // 404 (not 403) when the replay is missing OR owned by another project, so
    // a leaked id can't probe cross-project existence (matches canViewReplay).
    if (!row || (row.project_id && row.project_id !== project.id)) {
      return res.status(404).json({ error: 'Replay not found' });
    }

    const { supportTicketId } = (req.body ?? {}) as { supportTicketId?: unknown };
    if (typeof supportTicketId !== 'string' || supportTicketId.trim() === '') {
      return res.status(400).json({ error: 'supportTicketId is required' });
    }
    const ticket = getSupportTicket(supportTicketId);
    if (!ticket || ticket.project_id !== project.id) {
      return res.status(404).json({ error: 'Support ticket not found' });
    }

    // Reject re-linking a replay that's already attached to a DIFFERENT ticket.
    // The attribution guard is first-write-wins on `support_ticket_id`, so a
    // blind re-link would leave the replay pointing at the original ticket while
    // still stamping the new ticket's `replay_ref` — two tickets referencing one
    // replay with a one-way inverse pointer. The UI hides Link for linked rows,
    // but a stale/concurrent API client can still reach this path. Linking to
    // the SAME ticket stays idempotent (re-affirms the ref).
    if (row.support_ticket_id && row.support_ticket_id !== supportTicketId) {
      return res
        .status(409)
        .json({ error: 'Replay is already linked to another ticket; unlink it first' });
    }

    // Symmetric guard on the TARGET ticket: if it already references a DIFFERENT
    // replay, attaching this one would stamp the ticket's `replay_ref` to us
    // while the old replay still carries `support_ticket_id = <ticket>` — two
    // replay rows claiming one ticket, and a later unlink of the old replay
    // would clear the ticket's inverse pointer and silently break this link.
    // Require the operator to unlink the existing replay first. Reject ANY
    // non-empty existing ref unless it parses to THIS replay (so a legacy /
    // unparseable ref can't be silently overwritten); idempotent when it already
    // points at this replay.
    if (ticket.replay_ref && parseReplayIdFromRef(ticket.replay_ref) !== replayId) {
      return res
        .status(409)
        .json({ error: 'Ticket is already linked to a different replay; unlink it first' });
    }

    const ref = `/uploads/replay-${replayId}.json`;
    const updatedTicket = await setGuardedReplayRef(stmts, supportTicketId, project.id, ref);
    // Confirm the persisted ref is exactly the one we requested. The guard
    // clears the ref when the replay can't be attributed to this project (it's
    // owned elsewhere); a value that isn't our `ref` means the link didn't take,
    // so surface a conflict rather than a misleading 200.
    if (!updatedTicket || updatedTicket.replay_ref !== ref) {
      return res.status(409).json({ error: 'Replay could not be linked to this project' });
    }

    const replay = stmts.getSessionReplay.get(replayId) as SessionReplayRow;
    broadcastTicketUpdate(project.id, updatedTicket);
    broadcast({ type: 'replay_linked', projectId: project.id, replayId, supportTicketId });
    res.json({
      replay: toReplayListItem({
        ...replay,
        ticket_subject: updatedTicket.subject,
        ticket_status: updatedTicket.status,
      }),
      ticket: updatedTicket,
    });
  });

  // ── Unlink: detach a replay from its support ticket ───────────────
  router.delete('/api/projects/:projectId/replays/:id/link', (req: Request, res: Response) => {
    const project = findProject(req.params.projectId as string);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const replayId = req.params.id as string;
    const row = stmts.getSessionReplay.get(replayId) as SessionReplayRow | undefined;
    if (!row || row.project_id !== project.id) {
      return res.status(404).json({ error: 'Replay not found' });
    }

    const ticketId = row.support_ticket_id;
    unlinkReplayTicket(replayId, project.id);
    // Clear the inverse pointer too — but ONLY if the ticket's ref still points
    // at THIS replay. Re-read the ticket and compare its current replay_ref: a
    // concurrent ticket-first/link flow may have re-pointed the same ticket at a
    // different replay between our `row` read and here, and a blind clear-by-id
    // would silently erase that newer link. Matching on the ref makes the clear
    // a no-op when the ticket has moved on.
    if (ticketId) {
      const ticket = getSupportTicket(ticketId);
      if (
        ticket &&
        ticket.project_id === project.id &&
        parseReplayIdFromRef(ticket.replay_ref) === replayId
      ) {
        const cleared = setSupportTicketReplayRef(ticketId, null);
        if (cleared) broadcastTicketUpdate(project.id, cleared);
      }
    }

    const replay = stmts.getSessionReplay.get(replayId) as SessionReplayRow;
    broadcast({ type: 'replay_unlinked', projectId: project.id, replayId });
    res.json({
      replay: toReplayListItem({ ...replay, ticket_subject: null, ticket_status: null }),
    });
  });

  return router;
}

/** Parse a numeric query param; undefined for missing / non-numeric so the
 *  store applies its pagination defaults. */
function parseIntParam(v: unknown): number | undefined {
  if (typeof v !== 'string' || v.trim() === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export interface ReplayListItemView {
  id: string;
  projectId: string | null;
  orphaned: boolean;
  createdAt: string;
  durationMs: number;
  eventCount: number;
  size: number;
  uncompressedSize: number;
  supportTicketId: string | null;
  cardId: string | null;
  pageUrl: string | null;
  trigger: string | null;
  errorMessage: string | null;
  meta: Record<string, unknown> | null;
  eventsUrl: string;
  replayRef: string;
  ticket: { id: string; subject: string | null; status: string | null } | null;
}

/** Best-effort string pluck from the free-form recorder `meta`. */
function metaString(meta: Record<string, unknown> | null, ...keys: string[]): string | null {
  if (!meta) return null;
  for (const k of keys) {
    const v = meta[k];
    if (typeof v === 'string' && v.trim() !== '') return v;
  }
  return null;
}

export function toReplayListItem(row: ReplayListRow): ReplayListItemView {
  let meta: Record<string, unknown> | null = null;
  if (row.meta) {
    try {
      const parsed = JSON.parse(row.meta) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        meta = parsed as Record<string, unknown>;
      }
    } catch {
      meta = null;
    }
  }
  return {
    id: row.id,
    projectId: row.project_id,
    orphaned: row.project_id == null,
    createdAt: row.created_at,
    durationMs: row.duration_ms,
    eventCount: row.event_count,
    size: row.size,
    uncompressedSize: row.uncompressed_size,
    supportTicketId: row.support_ticket_id,
    cardId: row.card_id,
    pageUrl: metaString(meta, 'url', 'pageUrl', 'href', 'location'),
    trigger: metaString(meta, 'trigger', 'reason', 'source'),
    errorMessage: metaString(meta, 'error', 'errorMessage', 'message'),
    meta,
    eventsUrl: `/api/replays/${row.id}/events`,
    replayRef: `/uploads/replay-${row.id}.json`,
    ticket: row.support_ticket_id
      ? {
          id: row.support_ticket_id,
          subject: row.ticket_subject,
          status: row.ticket_status,
        }
      : null,
  };
}
