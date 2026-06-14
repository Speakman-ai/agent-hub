import { v4 as uuidv4 } from 'uuid';
import { Router, Request, Response } from 'express';
import type { RouteDeps, KanbanCardRow } from '../types.js';
import {
  createSupportTicket,
  getSupportTicket,
  listSupportTickets,
  updateSupportTicketStatus,
  recordSupportTicketInvestigation,
  setSupportTicketReplayRef,
  convertSupportTicketToCard,
  deleteSupportTicket,
  SUPPORT_TICKET_STATUSES,
} from '../support-tickets-store.js';
import type { SupportTicketStatus } from '../types.js';
import { triggerSupportTicketInvestigation } from '../support-ticket-investigation.js';
import { buildCardFieldsFromTicket } from '../support-ticket-convert.js';
import { getOrCreateBoard } from './board.js';
import { linkReplay } from '../replays/replay-store.js';

/**
 * Best-effort attribution of a session replay (referenced by `replayRef`) to a
 * project / ticket / card. Wrapped so a replay-store hiccup never fails the
 * ticket operation that triggered it — the link is metadata, not the payload.
 * Used for the convert path, where the ticket's `replay_ref` was already
 * validated for this project at create/PATCH time.
 */
function tryLinkReplay(
  stmts: RouteDeps['stmts'],
  replayRef: string | null | undefined,
  link: { projectId?: string | null; supportTicketId?: string | null; cardId?: string | null },
): void {
  try {
    linkReplay(stmts, replayRef, link);
  } catch (err) {
    console.error('[SupportTickets] Failed to link replay:', (err as Error).message);
  }
}

/**
 * Link the replay referenced by `replayRef` to this project/ticket and report
 * whether the ref is safe to PERSIST on the ticket.
 *
 * A ref is kept only when the replay ends up owned by THIS project — freshly
 * linked from an unattributed row, or already ours. A ref we cannot attribute
 * (already owned by another project, or with no `session_replays` row at all)
 * is REJECTED, because the legacy investigation path
 * (`resolveReplayContext`) resolves the `/uploads/replay-<id>.json` file by ref
 * WITHOUT going through `canViewReplay`: persisting a foreign ref would splice
 * another project's capture into this ticket's triage prompt. Returns true to
 * keep the ref, false to clear it. Defensive — any error clears.
 */
function replayRefBelongsToProject(
  stmts: RouteDeps['stmts'],
  replayRef: string,
  projectId: string,
  ticketId: string,
): boolean {
  try {
    const row = linkReplay(stmts, replayRef, { projectId, supportTicketId: ticketId });
    return row !== null && row.project_id === projectId;
  } catch (err) {
    console.error('[SupportTickets] replay link failed; clearing ref:', (err as Error).message);
    return false;
  }
}

/**
 * Support ticket queue routes. Tickets are persisted in their own
 * project-scoped queue (see `support_tickets`), separate from the kanban
 * board. The list endpoint returns rows ordered by severity (most severe
 * first) so the most urgent requests sit at the top.
 */
export default function createSupportTicketRoutes(deps: RouteDeps): Router {
  const { broadcast, findProject, stmts } = deps;
  const router = Router();

  router.get('/api/projects/:projectId/support-tickets', (req: Request, res: Response) => {
    const project = findProject(req.params.projectId as string);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const status = req.query.status as string | undefined;
    if (status && !(SUPPORT_TICKET_STATUSES as readonly string[]).includes(status)) {
      return res
        .status(400)
        .json({ error: `status must be one of: ${SUPPORT_TICKET_STATUSES.join(', ')}` });
    }

    const tickets = listSupportTickets(project.id, {
      status: status as SupportTicketStatus | undefined,
    });
    res.json(tickets);
  });

  router.get('/api/projects/:projectId/support-tickets/:id', (req: Request, res: Response) => {
    const project = findProject(req.params.projectId as string);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const ticket = getSupportTicket(req.params.id as string);
    if (!ticket || ticket.project_id !== project.id) {
      return res.status(404).json({ error: 'Support ticket not found' });
    }
    res.json(ticket);
  });

  router.post('/api/projects/:projectId/support-tickets', (req: Request, res: Response) => {
    const project = findProject(req.params.projectId as string);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const { type, severity, subject, body, reporter, replayRef } = req.body as {
      type?: string;
      severity?: string;
      subject?: string;
      body?: string;
      reporter?: string;
      replayRef?: string;
    };

    try {
      let ticket = createSupportTicket({
        projectId: project.id,
        type: type as never,
        severity: severity as never,
        subject,
        body: body ?? '',
        reporter: reporter ?? null,
        replayRef: replayRef ?? null,
      });
      // Attribute the replay to this project + ticket now that we have a
      // trusted, project-scoped context (ingest itself is anonymous). If the
      // ref can't be attributed to THIS project, clear it before anything reads
      // it — otherwise the bug investigation below would resolve a foreign
      // capture via the legacy `/uploads` path (which bypasses canViewReplay).
      if (replayRef && !replayRefBelongsToProject(stmts, replayRef, project.id, ticket.id)) {
        ticket = setSupportTicketReplayRef(ticket.id, null)!;
      }
      broadcast({ type: 'support_ticket_created', ticket });

      // Bug tickets get an initial AI investigation pass that fills in the
      // ai_summary / ai_investigation fields. Fire-and-forget: the ticket has
      // already landed and the response is about to return, so a failed
      // investigation must never surface as an error here.
      if (ticket.type === 'bug') {
        triggerSupportTicketInvestigation(ticket.id, {
          config: deps.config,
          broadcast,
          serverDir: deps.serverDir,
          cwd: project.cwd,
        });
      }

      res.status(201).json(ticket);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  router.patch('/api/projects/:projectId/support-tickets/:id', (req: Request, res: Response) => {
    const project = findProject(req.params.projectId as string);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const existing = getSupportTicket(req.params.id as string);
    if (!existing || existing.project_id !== project.id) {
      return res.status(404).json({ error: 'Support ticket not found' });
    }

    const { status, aiSummary, aiInvestigation, replayRef } = req.body as {
      status?: string;
      aiSummary?: string | null;
      aiInvestigation?: string | null;
      replayRef?: string | null;
    };

    try {
      let ticket = existing;
      if (status !== undefined) {
        ticket = updateSupportTicketStatus(ticket.id, status as SupportTicketStatus)!;
      }
      if (aiSummary !== undefined || aiInvestigation !== undefined) {
        // Pass the raw values through: the store preserves fields left
        // `undefined` and treats an explicit `null` as a clear, so sending
        // only one field never wipes the other.
        ticket = recordSupportTicketInvestigation(ticket.id, {
          summary: aiSummary,
          details: aiInvestigation,
        })!;
      }
      if (replayRef !== undefined) {
        ticket = setSupportTicketReplayRef(ticket.id, replayRef)!;
        // Keep the ref only if it attributes to THIS project; otherwise clear it
        // so the legacy investigation path can't resolve a foreign capture.
        if (replayRef && !replayRefBelongsToProject(stmts, replayRef, project.id, ticket.id)) {
          ticket = setSupportTicketReplayRef(ticket.id, null)!;
        }
      }
      broadcast({ type: 'support_ticket_updated', ticket });
      res.json(ticket);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  /**
   * Promote a support ticket to a kanban card.
   *
   * Creates a To Do card carrying over the ticket's title/description, a
   * severity→priority mapping, and `support,<type>` labels, with a footer in
   * the description linking back to the source ticket. The ticket is then
   * flipped to `converted` and stamped with the new card id.
   *
   * Idempotent: a ticket already linked to a still-existing card returns that
   * card (200) instead of creating a duplicate. If the linked card was since
   * deleted, conversion runs again.
   */
  router.post(
    '/api/projects/:projectId/support-tickets/:id/convert',
    (req: Request, res: Response) => {
      const project = findProject(req.params.projectId as string);
      if (!project) return res.status(404).json({ error: 'Project not found' });

      const ticket = getSupportTicket(req.params.id as string);
      if (!ticket || ticket.project_id !== project.id) {
        return res.status(404).json({ error: 'Support ticket not found' });
      }

      // Double-conversion guard: if the ticket is already linked to a card that
      // still exists, return it unchanged rather than spawning a duplicate.
      if (ticket.converted_card_id) {
        const existingCard = stmts.getKanbanCard.get(ticket.converted_card_id) as
          | KanbanCardRow
          | undefined;
        if (existingCard) {
          return res.status(200).json({ ticket, card: existingCard, alreadyConverted: true });
        }
        // The previously-linked card was deleted — fall through and re-create.
      }

      const { board, columns } = getOrCreateBoard(stmts, project.id);
      // Prefer the canonical "To Do" column; fall back to the left-most column
      // so a board with renamed columns still gets a sensible landing spot.
      const todo =
        columns.find((c) => c.name.trim().toLowerCase() === 'to do') ??
        [...columns].sort((a, b) => a.position - b.position)[0];
      if (!todo) {
        return res.status(500).json({ error: 'Board has no columns to place the card in' });
      }

      const fields = buildCardFieldsFromTicket(ticket);
      const existingCards = stmts.getKanbanCardsByColumn.all(todo.id) as KanbanCardRow[];
      const maxPos =
        existingCards.length > 0 ? Math.max(...existingCards.map((c) => c.position)) + 1 : 0;
      const cardId = uuidv4();

      stmts.createKanbanCard.run(
        cardId,
        todo.id,
        board.id,
        fields.title,
        fields.description,
        fields.priority,
        null, // assignee
        fields.labels,
        null, // session_id
        null, // github_issue_url
        'support-ticket', // created_by
        null, // assign_model
        maxPos,
      );

      const updatedTicket = convertSupportTicketToCard(ticket.id, cardId)!;
      const card = stmts.getKanbanCard.get(cardId) as KanbanCardRow;

      // Carry the replay attribution onto the new card (project/ticket links
      // are preserved via COALESCE).
      if (ticket.replay_ref) {
        tryLinkReplay(stmts, ticket.replay_ref, {
          projectId: project.id,
          supportTicketId: ticket.id,
          cardId,
        });
      }

      broadcast({ type: 'kanban_update', projectId: project.id });
      broadcast({ type: 'support_ticket_updated', ticket: updatedTicket });

      res.status(201).json({ ticket: updatedTicket, card });
    },
  );

  router.delete('/api/projects/:projectId/support-tickets/:id', (req: Request, res: Response) => {
    const project = findProject(req.params.projectId as string);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const ticket = getSupportTicket(req.params.id as string);
    if (!ticket || ticket.project_id !== project.id) {
      return res.status(404).json({ error: 'Support ticket not found' });
    }

    deleteSupportTicket(ticket.id);
    broadcast({
      type: 'support_ticket_deleted',
      ticketId: ticket.id,
      projectId: project.id,
    });
    res.json({ ok: true });
  });

  return router;
}
