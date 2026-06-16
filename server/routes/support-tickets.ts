import { v4 as uuidv4 } from 'uuid';
import { Router, Request, Response } from 'express';
import type { RouteDeps, KanbanCardRow } from '../types.js';
import {
  getSupportTicket,
  listSupportTickets,
  updateSupportTicketStatus,
  recordSupportTicketInvestigation,
  deleteSupportTicket,
  markSupportTicketRead,
  markSupportTicketUnread,
  markAllSupportTicketsRead,
  countUnreadSupportTickets,
  SUPPORT_TICKET_STATUSES,
} from '../support-tickets-store.js';
import type { SupportTicketStatus, SupportTicketRow } from '../types.js';
import { intakeSupportTicket, setGuardedReplayRef } from '../support-ticket-intake.js';
import { setSupportTicketScreenshotRef } from '../support-tickets-store.js';
import {
  persistSupportTicketScreenshot,
  deleteSupportTicketScreenshot,
} from '../support-ticket-screenshot.js';
import { buildCardFieldsFromTicket } from '../support-ticket-convert.js';
import { getOrCreateBoard } from './board.js';
import { linkReplay } from '../replays/replay-store.js';
import { getDb } from '../db.js';

/**
 * Best-effort attribution of a session replay (referenced by `replayRef`) to a
 * project / ticket / card. Wrapped so a replay-store hiccup never fails the
 * ticket operation that triggered it — the link is metadata, not the payload.
 * Used for the convert path, where the ticket's `replay_ref` was already
 * validated for this project at create/PATCH time.
 */
async function tryLinkReplay(
  stmts: RouteDeps['stmts'],
  replayRef: string | null | undefined,
  link: { projectId?: string | null; supportTicketId?: string | null; cardId?: string | null },
): Promise<void> {
  try {
    await linkReplay(stmts, replayRef, link);
  } catch (err) {
    console.error('[SupportTickets] Failed to link replay:', (err as Error).message);
  }
}

/**
 * Whether a screenshot ref is still embedded in the markdown of the card this
 * ticket was converted to. The convert path bakes the screenshot ref into the
 * card description (`![screenshot](/uploads/...)`), so a file referenced by a
 * live converted card must NOT be deleted when the ticket's own attachment is
 * later replaced or cleared. Each screenshot file has a unique uuid name and is
 * only ever referenced by its own ticket + that ticket's converted card, so
 * checking this one card is sufficient.
 */
function screenshotReferencedByConvertedCard(
  stmts: RouteDeps['stmts'],
  ticket: SupportTicketRow,
  ref: string,
): boolean {
  if (!ticket.converted_card_id) return false;
  const card = stmts.getKanbanCard.get(ticket.converted_card_id) as KanbanCardRow | undefined;
  return Boolean(card && typeof card.description === 'string' && card.description.includes(ref));
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

  /**
   * Broadcast a support-ticket mutation, always stamping the project's current
   * unread count so subscribers (Support sidebar badge) stay accurate without a
   * refetch. `extra` carries the event-specific payload (`ticket` for
   * create/update, `ticketId` for delete).
   */
  const broadcastTicket = (
    type: string,
    projectId: string,
    extra: Record<string, unknown>,
  ): void => {
    broadcast({ type, projectId, unreadCount: countUnreadSupportTickets(projectId), ...extra });
  };

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

  // Registered before the `/:id` route so the literal path wins the match.
  router.get(
    '/api/projects/:projectId/support-tickets/unread-count',
    (req: Request, res: Response) => {
      const project = findProject(req.params.projectId as string);
      if (!project) return res.status(404).json({ error: 'Project not found' });
      res.json({ count: countUnreadSupportTickets(project.id) });
    },
  );

  router.get('/api/projects/:projectId/support-tickets/:id', (req: Request, res: Response) => {
    const project = findProject(req.params.projectId as string);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const ticket = getSupportTicket(req.params.id as string);
    if (!ticket || ticket.project_id !== project.id) {
      return res.status(404).json({ error: 'Support ticket not found' });
    }
    res.json(ticket);
  });

  router.post('/api/projects/:projectId/support-tickets', async (req: Request, res: Response) => {
    const project = findProject(req.params.projectId as string);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const { type, severity, subject, body, reporter, replayRef, screenshot } = req.body as {
      type?: string;
      severity?: string;
      subject?: string;
      body?: string;
      reporter?: string;
      replayRef?: string;
      screenshot?: string;
    };

    // Persist the optional screenshot (a base64 data URL) before landing the
    // ticket. The file is written first because the ref must be stored with the
    // row; if the ticket then fails to land we roll the file back below so a
    // rejected request never leaves an orphan under /uploads.
    let screenshotRef: string | null = null;
    if (screenshot) {
      try {
        screenshotRef = await persistSupportTicketScreenshot(deps.serverDir, screenshot);
      } catch (err) {
        return res.status(400).json({ error: (err as Error).message });
      }
    }

    try {
      const ticket = await intakeSupportTicket(
        {
          projectId: project.id,
          type: type as never,
          severity: severity as never,
          subject,
          body: body ?? '',
          reporter: reporter ?? null,
          replayRef: replayRef ?? null,
          screenshotRef,
        },
        { stmts, broadcast, config: deps.config, serverDir: deps.serverDir, cwd: project.cwd },
      );
      res.status(201).json(ticket);
    } catch (err) {
      // The ticket didn't land — remove the screenshot we just wrote so it
      // isn't orphaned (intake validates body/type/severity and can throw).
      await deleteSupportTicketScreenshot(deps.serverDir, screenshotRef);
      res.status(400).json({ error: (err as Error).message });
    }
  });

  router.patch(
    '/api/projects/:projectId/support-tickets/:id',
    async (req: Request, res: Response) => {
      const project = findProject(req.params.projectId as string);
      if (!project) return res.status(404).json({ error: 'Project not found' });

      const existing = getSupportTicket(req.params.id as string);
      if (!existing || existing.project_id !== project.id) {
        return res.status(404).json({ error: 'Support ticket not found' });
      }

      const { status, aiSummary, aiInvestigation, replayRef, screenshot } = req.body as {
        status?: string;
        aiSummary?: string | null;
        aiInvestigation?: string | null;
        replayRef?: string | null;
        screenshot?: string | null;
      };

      // Resolve the screenshot mutation up-front so a bad data URL fails the
      // whole PATCH with a 400 before any field is written. `null` clears the
      // existing attachment; a string is persisted and its ref stored.
      let screenshotRef: string | null | undefined;
      if (screenshot !== undefined) {
        if (screenshot === null || screenshot === '') {
          screenshotRef = null;
        } else {
          try {
            screenshotRef = await persistSupportTicketScreenshot(deps.serverDir, screenshot);
          } catch (err) {
            return res.status(400).json({ error: (err as Error).message });
          }
        }
      }

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
          // Set + attribution-guard in one step: a ref that doesn't attribute
          // to THIS project is cleared so the legacy investigation path can't
          // resolve a foreign capture.
          ticket = (await setGuardedReplayRef(stmts, ticket.id, project.id, replayRef))!;
        }
        if (screenshotRef !== undefined) {
          const previousRef = existing.screenshot_ref;
          ticket = setSupportTicketScreenshotRef(ticket.id, screenshotRef)!;
          // A replaced/cleared screenshot leaves the prior file orphaned and
          // still publicly fetchable under /uploads. Delete it — unless this
          // ticket's converted card still embeds that ref in its markdown (the
          // historical attachment the card needs).
          if (
            previousRef &&
            previousRef !== screenshotRef &&
            !screenshotReferencedByConvertedCard(stmts, ticket, previousRef)
          ) {
            await deleteSupportTicketScreenshot(deps.serverDir, previousRef);
          }
        }
        broadcastTicket('support_ticket_updated', ticket.project_id, { ticket });
        res.json(ticket);
      } catch (err) {
        // A later mutation rejected (e.g. invalid status). If we wrote a new
        // screenshot file up-front, roll it back so the rejected PATCH leaves no
        // orphan. `screenshotRef` is a string only when a new file was written
        // (null = clear, undefined = untouched), so this never deletes the
        // ticket's existing attachment.
        if (typeof screenshotRef === 'string') {
          await deleteSupportTicketScreenshot(deps.serverDir, screenshotRef);
        }
        res.status(400).json({ error: (err as Error).message });
      }
    },
  );

  // Mark every unread ticket in the project read (clears the sidebar badge).
  // Registered before the `/:id/...` routes so the literal path wins the match.
  router.post(
    '/api/projects/:projectId/support-tickets/read-all',
    (req: Request, res: Response) => {
      const project = findProject(req.params.projectId as string);
      if (!project) return res.status(404).json({ error: 'Project not found' });

      const marked = markAllSupportTicketsRead(project.id);
      const unreadCount = countUnreadSupportTickets(project.id);
      // A single light event rather than one per ticket: subscribers reset the
      // project's badge to 0 and locally flag their loaded rows read.
      broadcast({ type: 'support_tickets_read_all', projectId: project.id, unreadCount });
      res.json({ marked, unreadCount });
    },
  );

  router.post(
    '/api/projects/:projectId/support-tickets/:id/read',
    (req: Request, res: Response) => {
      const project = findProject(req.params.projectId as string);
      if (!project) return res.status(404).json({ error: 'Project not found' });

      const existing = getSupportTicket(req.params.id as string);
      if (!existing || existing.project_id !== project.id) {
        return res.status(404).json({ error: 'Support ticket not found' });
      }

      const ticket = markSupportTicketRead(existing.id)!;
      broadcastTicket('support_ticket_updated', ticket.project_id, { ticket });
      res.json(ticket);
    },
  );

  router.post(
    '/api/projects/:projectId/support-tickets/:id/unread',
    (req: Request, res: Response) => {
      const project = findProject(req.params.projectId as string);
      if (!project) return res.status(404).json({ error: 'Project not found' });

      const existing = getSupportTicket(req.params.id as string);
      if (!existing || existing.project_id !== project.id) {
        return res.status(404).json({ error: 'Support ticket not found' });
      }

      const ticket = markSupportTicketUnread(existing.id)!;
      broadcastTicket('support_ticket_updated', ticket.project_id, { ticket });
      res.json(ticket);
    },
  );

  /**
   * Promote a support ticket to a kanban card.
   *
   * Creates a To Do card carrying over the ticket's title/description, a
   * severity→priority mapping, and `support,<type>` labels, with a footer in
   * the description linking back to the source ticket. The source ticket is
   * then **removed** — once promoted to the board the card is the single
   * source of truth, so the ticket queue isn't left holding a stale duplicate.
   *
   * Returns `{ card, ticketId, deleted: true }`. Because the ticket is gone
   * afterwards, the operation is not idempotent: re-POSTing the same ticket id
   * 404s (there's nothing left to convert).
   *
   * Card-creation and ticket-deletion run in a single synchronous SQLite
   * transaction that re-claims the ticket inside the transaction. This makes
   * conversion duplicate-safe: a retry (e.g. after a lost/slow 201) finds the
   * ticket already gone and 404s instead of inserting a second card — there is
   * no create-then-delete window for a concurrent request to slip into.
   */
  router.post(
    '/api/projects/:projectId/support-tickets/:id/convert',
    async (req: Request, res: Response) => {
      const project = findProject(req.params.projectId as string);
      if (!project) return res.status(404).json({ error: 'Project not found' });

      const ticket = getSupportTicket(req.params.id as string);
      if (!ticket || ticket.project_id !== project.id) {
        return res.status(404).json({ error: 'Support ticket not found' });
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

      // Atomic create-card + delete-ticket. The transaction re-reads the ticket
      // and bails (returns null) if it has already been converted/deleted by a
      // concurrent or retried request — so at most one card is ever created for
      // a given ticket. better-sqlite3 transactions run synchronously, and
      // nothing between the top-of-handler read and this block awaits, so no
      // second request can observe the ticket as still-present after the claim.
      const convert = getDb().transaction((): KanbanCardRow | null => {
        if (!getSupportTicket(ticket.id)) return null; // already converted — lost the race
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
        deleteSupportTicket(ticket.id);
        return stmts.getKanbanCard.get(cardId) as KanbanCardRow;
      });

      const card = convert();
      if (!card) {
        // A concurrent/retried convert already promoted this ticket; the card it
        // created is the canonical one, so don't create a duplicate.
        return res.status(404).json({ error: 'Support ticket not found' });
      }

      // Carry the replay attribution onto the new card. The source ticket has
      // been deleted, so attribute to the card (and project) only — a
      // supportTicketId pointer would dangle now that the row is gone.
      if (ticket.replay_ref) {
        await tryLinkReplay(stmts, ticket.replay_ref, {
          projectId: project.id,
          cardId,
        });
      }

      // Preserve the screenshot file: `buildCardFieldsFromTicket` bakes the ref
      // into the card description as a markdown image, so the card still needs
      // it even though the ticket row is gone.
      if (
        ticket.screenshot_ref &&
        !(typeof card.description === 'string' && card.description.includes(ticket.screenshot_ref))
      ) {
        await deleteSupportTicketScreenshot(deps.serverDir, ticket.screenshot_ref);
      }

      broadcast({ type: 'kanban_update', projectId: project.id });
      broadcastTicket('support_ticket_deleted', project.id, { ticketId: ticket.id });

      res.status(201).json({ card, ticketId: ticket.id, deleted: true });
    },
  );

  router.delete(
    '/api/projects/:projectId/support-tickets/:id',
    async (req: Request, res: Response) => {
      const project = findProject(req.params.projectId as string);
      if (!project) return res.status(404).json({ error: 'Project not found' });

      const ticket = getSupportTicket(req.params.id as string);
      if (!ticket || ticket.project_id !== project.id) {
        return res.status(404).json({ error: 'Support ticket not found' });
      }

      deleteSupportTicket(ticket.id);
      // The row is gone — its screenshot file would otherwise stay orphaned and
      // publicly fetchable. Delete it unless a converted card still embeds it.
      if (
        ticket.screenshot_ref &&
        !screenshotReferencedByConvertedCard(stmts, ticket, ticket.screenshot_ref)
      ) {
        await deleteSupportTicketScreenshot(deps.serverDir, ticket.screenshot_ref);
      }
      broadcastTicket('support_ticket_deleted', project.id, { ticketId: ticket.id });
      res.json({ ok: true });
    },
  );

  return router;
}
