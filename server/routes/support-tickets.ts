import { v4 as uuidv4 } from 'uuid';
import { Router, Request, Response } from 'express';
import type { RouteDeps, KanbanCardRow } from '../types.js';
import {
  getSupportTicket,
  listSupportTickets,
  updateSupportTicketStatus,
  updateSupportTicketType,
  setSupportTicketWontDoReason,
  convertSupportTicketToCard,
  recordSupportTicketInvestigation,
  deleteSupportTicket,
  markSupportTicketRead,
  markSupportTicketUnread,
  markAllSupportTicketsRead,
  countUnreadSupportTickets,
  SUPPORT_TICKET_STATUSES,
  SUPPORT_TICKET_OPEN_STATUSES,
  SUPPORT_TICKET_TYPES,
} from '../support-tickets-store.js';
import type { SupportTicketStatus, SupportTicketType, SupportTicketRow } from '../types.js';
import { intakeSupportTicket, setGuardedReplayRef } from '../support-ticket-intake.js';
import { setSupportTicketScreenshotRef } from '../support-tickets-store.js';
import {
  persistSupportTicketScreenshot,
  deleteSupportTicketScreenshot,
} from '../support-ticket-screenshot.js';
import { buildCardFieldsFromTicket } from '../support-ticket-convert.js';
import { getOrCreateBoard, serializeCardForRequest } from './board.js';
import { linkReplay } from '../replays/replay-store.js';
import { getDb } from '../db.js';
import { ConvertSupportTicketRequestSchema } from './support-tickets.openapi.js';
import { resolveOneShotEngine, NoEnginesAvailableError } from '../engine-resolver.js';
import { resolveEffectiveEngineAndModel } from '../effective-model.js';
import type { SupportedEngine } from '../engine-availability.js';
import type { AuthenticatedRequest } from '../auth.js';
import { resolveOwnerUserId } from '../session-ownership.js';
import { triggerSupportTicketInvestigation } from '../support-ticket-investigation.js';
import { pickMainDevAgent } from '../routing.js';

import {
  defaultReporterEmail,
  serializeSupportTicket,
  serializeSupportTicketForBroadcast,
  serializeSupportTicketForRequest,
  type SupportTicketResponse,
} from '../support-ticket-serialization.js';

export { serializeSupportTicket };

function serializeForRequest(
  req: Request,
  ticket: SupportTicketRow,
  opts: { includeReleaseNotifications?: boolean } = {},
): SupportTicketResponse {
  return serializeSupportTicketForRequest(req, ticket, opts);
}

function serializeForBroadcast(ticket: SupportTicketRow): SupportTicketResponse {
  return serializeSupportTicketForBroadcast(ticket);
}

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
    const safeExtra = { ...extra };
    if (safeExtra.ticket) {
      safeExtra.ticket = serializeForBroadcast(safeExtra.ticket as SupportTicketRow);
    }
    broadcast({ type, projectId, unreadCount: countUnreadSupportTickets(projectId), ...safeExtra });
  };

  router.get('/api/projects/:projectId/support-tickets', (req: Request, res: Response) => {
    const project = findProject(req.params.projectId as string);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    // `status` accepts a comma-separated list (e.g. `converted,closed`) so a UI
    // filter group can map to several lifecycle states in one request. When the
    // param is absent we default to the OPEN states only — terminal tickets
    // (converted / closed / duplicate / wont_do) are hidden until explicitly
    // requested, so resolved work doesn't clutter the live queue.
    //
    // A repeated query key (`?status=new&status=closed`) makes Express parse the
    // value as an array; only a single string is valid here, so reject any other
    // shape with the same 400 rather than letting `.split` throw a 500.
    const rawStatus = req.query.status;
    let statuses: SupportTicketStatus[];
    if (rawStatus === undefined) {
      statuses = [...SUPPORT_TICKET_OPEN_STATUSES];
    } else if (typeof rawStatus !== 'string') {
      return res
        .status(400)
        .json({ error: `status must be one of: ${SUPPORT_TICKET_STATUSES.join(', ')}` });
    } else {
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
      statuses = tokens.length
        ? (tokens as SupportTicketStatus[])
        : [...SUPPORT_TICKET_OPEN_STATUSES];
    }

    // `type` is likewise single-valued — an array (repeated key) or other
    // non-string shape is a 400, not a silent miss.
    const rawType = req.query.type;
    let type: SupportTicketType | undefined;
    if (rawType !== undefined) {
      if (
        typeof rawType !== 'string' ||
        !(SUPPORT_TICKET_TYPES as readonly string[]).includes(rawType)
      ) {
        return res
          .status(400)
          .json({ error: `type must be one of: ${SUPPORT_TICKET_TYPES.join(', ')}` });
      }
      type = rawType as SupportTicketType;
    }

    const tickets = listSupportTickets(project.id, { statuses, type });
    res.json(tickets.map((ticket) => serializeForRequest(req, ticket)));
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
    res.json(serializeForRequest(req, ticket, { includeReleaseNotifications: true }));
  });

  router.post(
    '/api/projects/:projectId/support-tickets/:id/investigate',
    async (req: Request, res: Response) => {
      const project = findProject(req.params.projectId as string);
      if (!project) return res.status(404).json({ error: 'Project not found' });

      const ticket = getSupportTicket(req.params.id as string);
      if (!ticket || ticket.project_id !== project.id) {
        return res.status(404).json({ error: 'Support ticket not found' });
      }

      const userId = resolveOwnerUserId(req as AuthenticatedRequest);
      const mainDevAgent = pickMainDevAgent(project);
      if (!mainDevAgent) {
        return res.status(400).json({ error: 'Project has no main dev agent' });
      }
      // Always resolve before queueing. Agent engines require an acting user,
      // and the runner uses this same owner context for credentials.
      const effective = resolveEffectiveEngineAndModel(deps.config, {
        agentId: mainDevAgent.id,
        agentEngine: mainDevAgent.engine,
        agentModel: mainDevAgent.model,
        ownerUserId: userId,
      });
      let resolved: Awaited<ReturnType<typeof resolveOneShotEngine>>;
      try {
        resolved = await resolveOneShotEngine(deps.config, {
          preferred: effective.engine as SupportedEngine,
          preferredModel: effective.model,
          fallbackChain: [effective.engine as SupportedEngine],
          userId,
        });
      } catch (err) {
        if (err instanceof NoEnginesAvailableError) {
          return res.status(400).json({ code: err.code, error: err.message });
        }
        return res.status(400).json({ error: (err as Error).message });
      }

      triggerSupportTicketInvestigation(ticket.id, {
        config: deps.config,
        broadcast: deps.broadcast,
        serverDir: deps.serverDir,
        cwd: project.cwd,
        agentId: mainDevAgent.id,
        agentEngine: mainDevAgent.engine,
        agentModel: mainDevAgent.model,
        userId,
      });

      res.status(202).json({
        queued: true,
        engine: resolved.engine,
        model: resolved.model,
        ticket: serializeForRequest(req, ticket),
      });
    },
  );

  router.post('/api/projects/:projectId/support-tickets', async (req: Request, res: Response) => {
    const project = findProject(req.params.projectId as string);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const {
      type,
      severity,
      subject,
      body,
      reporter,
      reporter_email,
      reporterEmail,
      replayRef,
      screenshot,
    } = req.body as {
      type?: string;
      severity?: string;
      subject?: string;
      body?: string;
      reporter?: string;
      reporter_email?: string | null;
      reporterEmail?: string | null;
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
          reporterEmail: reporter_email ?? reporterEmail ?? defaultReporterEmail(req),
          replayRef: replayRef ?? null,
          screenshotRef,
        },
        {
          stmts,
          broadcast,
          config: deps.config,
          serverDir: deps.serverDir,
          cwd: project.cwd,
          agent: pickMainDevAgent(project),
          userId: resolveOwnerUserId(req as AuthenticatedRequest),
        },
      );
      res.status(201).json(serializeForRequest(req, ticket));
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

      const { status, type, wontDoReason, aiSummary, aiInvestigation, replayRef, screenshot } =
        req.body as {
          status?: string;
          type?: string;
          wontDoReason?: string | null;
          aiSummary?: string | null;
          aiInvestigation?: string | null;
          replayRef?: string | null;
          screenshot?: string | null;
        };

      // A "won't do" ticket must always carry a non-empty reason. Fail fast
      // before any field is written (clear 400 for the UI) when either:
      //   - moving a ticket TO 'wont_do' without a reason, or
      //   - a reason-only edit on an already-'wont_do' ticket that would blank
      //     it — clearing the reason while the status stays 'wont_do' would
      //     break the invariant, so require a status transition to clear it.
      const trimmedReason = typeof wontDoReason === 'string' ? wontDoReason.trim() : '';
      const reasonOnlyEditOnWontDo =
        status === undefined && existing.status === 'wont_do' && wontDoReason !== undefined;
      if ((status === 'wont_do' || reasonOnlyEditOnWontDo) && !trimmedReason) {
        return res.status(400).json({
          error:
            "wontDoReason is required for a 'wont_do' ticket; transition the status to clear it",
        });
      }

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
          // Keep wont_do_reason in lock-step with the status: store it when
          // moving to 'wont_do', clear it on any other transition so a stale
          // reason never lingers on a re-opened ticket.
          ticket =
            status === 'wont_do'
              ? setSupportTicketWontDoReason(ticket.id, trimmedReason)!
              : setSupportTicketWontDoReason(ticket.id, null)!;
        } else if (wontDoReason !== undefined && existing.status === 'wont_do') {
          // Reason-only edit on an already-"won't do" ticket. A blank reason was
          // already rejected above, so this only ever stores a non-empty reason.
          ticket = setSupportTicketWontDoReason(ticket.id, trimmedReason)!;
        }
        if (type !== undefined) {
          ticket = updateSupportTicketType(ticket.id, type as SupportTicketType)!;
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
        res.json(serializeForRequest(req, ticket));
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
      res.json(serializeForRequest(req, ticket));
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
      res.json(serializeForRequest(req, ticket));
    },
  );

  /**
   * Promote a support ticket to a kanban card.
   *
   * Creates a To Do card carrying over the ticket's title/description, a
   * severity→priority mapping, and `support,<type>` labels, with a footer in
   * the description linking back to the source ticket. The ticket itself is
   * **retained** and flagged `converted` (recording `converted_card_id`) — it
   * drops out of the default "open" queue but is never destroyed, so the
   * support history stays intact and auditable. Converting also marks the
   * ticket read so it no longer pings the unread badge.
   *
   * Returns `{ card, ticket, ticketId, converted: true }`. The operation is
   * idempotent-safe: re-POSTing an already-converted ticket 409s (the original
   * card is the canonical one) rather than creating a duplicate.
   *
   * Card-creation + status flip run in a single synchronous SQLite transaction
   * that re-reads the ticket inside the transaction and bails if it has already
   * been converted by a concurrent/retried request, so at most one card is ever
   * created for a given ticket.
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
      if (ticket.status === 'converted') {
        return res.status(409).json({ error: 'Support ticket already converted' });
      }

      // Optional body: per-card auto-merge preference + a note. Tolerate a
      // missing/empty body (the common case) but reject a malformed one.
      const parsedConvert = ConvertSupportTicketRequestSchema.safeParse(req.body ?? {});
      if (!parsedConvert.success) {
        return res.status(400).json({ error: 'Invalid request body' });
      }
      const autoMergePref =
        typeof parsedConvert.data.autoMerge === 'boolean'
          ? parsedConvert.data.autoMerge
          : undefined;
      const convertNote =
        typeof parsedConvert.data.comment === 'string' ? parsedConvert.data.comment.trim() : '';

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

      // Atomic create-card + flip-status-to-converted. The transaction re-reads
      // the ticket and bails if it's gone ('gone') or already converted
      // ('already') by a concurrent or retried request — so at most one card is
      // ever created for a given ticket. better-sqlite3 transactions run
      // synchronously and nothing between the top-of-handler read and this block
      // awaits, so no second request can slip in mid-claim.
      const convert = getDb().transaction(
        (): { kind: 'ok'; card: KanbanCardRow } | { kind: 'gone' } | { kind: 'already' } => {
          const fresh = getSupportTicket(ticket.id);
          if (!fresh) return { kind: 'gone' };
          if (fresh.status === 'converted') return { kind: 'already' };
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
          stmts.linkKanbanCardSupportTicket.run(ticket.id, ticket.id, cardId);
          // Stamp the auto-merge preference (if the operator set one) so it
          // carries over to the board's assign UI and the eventual session's
          // finalize automation level.
          if (autoMergePref !== undefined) {
            stmts.setKanbanCardAutoMerge.run(autoMergePref ? 1 : 0, cardId);
          }
          // Attach the optional assignment note as a card comment.
          if (convertNote) {
            stmts.createKanbanCardComment.run(uuidv4(), cardId, 'support-ticket', convertNote);
          }
          // Flag the ticket converted (records converted_card_id) and mark it
          // read so a converted ticket no longer counts toward the unread badge.
          convertSupportTicketToCard(ticket.id, cardId);
          markSupportTicketRead(ticket.id);
          // Converting changes the lifecycle to 'converted', so a reason left
          // over from a prior 'wont_do' state must be cleared — the invariant is
          // that wont_do_reason is non-null only while status is 'wont_do'.
          if (fresh.wont_do_reason) setSupportTicketWontDoReason(ticket.id, null);
          return { kind: 'ok', card: stmts.getKanbanCard.get(cardId) as KanbanCardRow };
        },
      );

      const result = convert();
      if (result.kind === 'gone') {
        return res.status(404).json({ error: 'Support ticket not found' });
      }
      if (result.kind === 'already') {
        // A concurrent/retried convert already promoted this ticket; the card it
        // created is the canonical one, so don't create a duplicate.
        return res.status(409).json({ error: 'Support ticket already converted' });
      }
      const { card } = result;

      // Carry the replay attribution onto the new card. The ticket is retained,
      // so attribute to the project, card, AND the (still-present) ticket.
      if (ticket.replay_ref) {
        await tryLinkReplay(stmts, ticket.replay_ref, {
          projectId: project.id,
          supportTicketId: ticket.id,
          cardId,
        });
      }

      const converted = getSupportTicket(ticket.id)!;
      broadcast({ type: 'kanban_update', projectId: project.id });
      // The ticket is retained (now `converted`); broadcast the updated row so
      // open clients move it out of the default queue rather than dropping it.
      broadcastTicket('support_ticket_updated', project.id, { ticket: converted });

      res.status(201).json({
        card: serializeCardForRequest(req, stmts, board.id, card),
        ticket: serializeForRequest(req, converted),
        ticketId: ticket.id,
        converted: true,
      });
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
