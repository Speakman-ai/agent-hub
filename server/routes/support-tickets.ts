import { v4 as uuidv4 } from 'uuid';
import { Router, Request, Response } from 'express';
import rateLimit, { type RateLimitInfo } from 'express-rate-limit';
import type { RouteDeps, KanbanCardRow } from '../types.js';
import {
  getSupportTicket,
  listSupportTickets,
  updateSupportTicketStatus,
  updateSupportTicketType,
  updateSupportTicketSeverity,
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
  SUPPORT_TICKET_SEVERITIES,
} from '../support-tickets-store.js';
import type {
  SupportTicketStatus,
  SupportTicketType,
  SupportTicketSeverity,
  SupportTicketRow,
} from '../types.js';
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
import {
  AddSupportTicketCommentRequestSchema,
  CastVoteRequestSchema,
  ConvertSupportTicketRequestSchema,
  LinkSupportTicketToCardRequestSchema,
  VotingListQuerySchema,
} from './support-tickets.openapi.js';
import { resolveOneShotEngine, NoEnginesAvailableError } from '../engine-resolver.js';
import { resolveEffectiveEngineAndModel } from '../effective-model.js';
import type { SupportedEngine } from '../engine-availability.js';
import type { AuthenticatedRequest } from '../auth.js';
import { resolveOwnerUserId } from '../session-ownership.js';
import { triggerSupportTicketInvestigation } from '../support-ticket-investigation.js';
import { pickMainDevAgent } from '../routing.js';
import { resolveUploadsDir } from '../uploads-dir.js';
import { createUploadStore } from '../upload-store.js';

import {
  commentSourceForRequest,
  defaultReporterEmail,
  isExternalSupportCaller,
  serializeSupportTicket,
  serializeSupportTicketComment,
  serializeSupportTicketForBroadcast,
  serializeSupportTicketForRequest,
  serializeSupportTicketsForRequest,
  serializeVotingListForRequest,
  type SupportTicketResponse,
} from '../support-ticket-serialization.js';
import {
  addSupportTicketComment,
  getSupportTicketComment,
  hideSupportTicketComment,
  listSupportTicketComments,
  listSupportTicketsForVoting,
  applySupportTicketVote,
} from '../support-ticket-voting-store.js';

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
 * Per-ticket mutex so write + aggregate + broadcast cannot interleave.
 * Without this, request A can snapshot an older aggregate, request B can
 * write and emit a newer one, then A can emit the stale snapshot and Hub /
 * Survey Tracker clients regress.
 *
 * A rejecting task does not poison the chain. Different tickets still run
 * concurrently. Test hooks let a regression test park one request after the
 * snapshot and prove a second overlapping vote waits.
 */
const voteTails = new Map<string, Promise<unknown>>();
const voteWaiters = new Map<string, number>();
let voteAfterApply: ((ticketId: string) => Promise<void>) | null = null;

export function _setVoteAfterApply(fn: ((ticketId: string) => Promise<void>) | null): void {
  voteAfterApply = fn;
}

export function _voteLockWaiterCount(ticketId: string): number {
  return voteWaiters.get(ticketId) ?? 0;
}

async function withTicketVoteLock<T>(ticketId: string, task: () => Promise<T>): Promise<T> {
  voteWaiters.set(ticketId, (voteWaiters.get(ticketId) ?? 0) + 1);
  const prev = voteTails.get(ticketId) ?? Promise.resolve();
  const run = prev.then(task, task);
  const tail = run.then(
    () => {},
    () => {},
  );
  voteTails.set(ticketId, tail);
  try {
    return await run;
  } finally {
    const left = (voteWaiters.get(ticketId) ?? 1) - 1;
    if (left <= 0) voteWaiters.delete(ticketId);
    else voteWaiters.set(ticketId, left);
    if (voteTails.get(ticketId) === tail) voteTails.delete(ticketId);
  }
}

/**
 * Per-IP rate limits for the public vote / comment write endpoints. Survey
 * Tracker (and any future keyless surface) can drive these with an API key, so
 * they need a per-IP flood guard.
 *
 * This uses `express-rate-limit` (as the auth routes do) rather than a
 * hand-rolled `Map` bucket, on purpose. A hand-rolled map has two defects that
 * bit the earlier iterations of this code: (1) it never evicts stale entries,
 * so every previously-unseen public IP leaks a permanent entry — unbounded
 * growth over the process lifetime; and (2) it invites re-implementing client
 * IP resolution, which is easy to get wrong (trusting `X-Forwarded-For`
 * unconditionally lets a client rotate the header to mint a fresh bucket every
 * request). The library solves both at the root: its `MemoryStore` expires
 * entries every `windowMs` (bounded memory), and the default key generator uses
 * `req.ip`, which Express resolves only within the app's configured
 * `trust proxy` boundary (`server/index.ts`). No sibling call site in this file
 * should hand-roll a limiter.
 */
function rateLimitMax(envKey: string, fallback: number): number {
  const raw = process.env[envKey];
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const RATE_WINDOW_MS = 60 * 1000;
// Read per request so an env override (and tests) take effect without a restart.
const voteRateMax = (): number => rateLimitMax('AGENT_HUB_VOTE_RATE_MAX', 60);
const commentRateMax = (): number => rateLimitMax('AGENT_HUB_COMMENT_RATE_MAX', 10);

/**
 * Build a per-IP write limiter. `resource` shapes the structured 429 body;
 * `limit` is resolved per request so env overrides apply live. Each call gets
 * its own `MemoryStore`, so route instances (and per-test apps) stay isolated.
 */
function buildWriteRateLimiter(resource: string, limit: () => number) {
  return rateLimit({
    windowMs: RATE_WINDOW_MS,
    limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    // Default keyGenerator omitted on purpose — it uses ipKeyGenerator(req.ip),
    // which honors `trust proxy` and applies IPv6 subnet masking (see auth.ts).
    handler: (req, res) => {
      const info = (req as Request & { rateLimit?: RateLimitInfo }).rateLimit;
      const resetMs = info?.resetTime?.getTime() ?? Date.now() + RATE_WINDOW_MS;
      const retryAfterSeconds = Math.max(1, Math.ceil((resetMs - Date.now()) / 1000));
      res.setHeader('Retry-After', String(retryAfterSeconds));
      res.status(429).json({
        error: `Too many ${resource} requests from this IP. Retry in ${retryAfterSeconds}s.`,
        retryAfterSeconds,
      });
    },
  });
}

/**
 * Support ticket queue routes. Tickets are persisted in their own
 * project-scoped queue (see `support_tickets`), separate from the kanban
 * board. The list endpoint returns rows ordered by severity (most severe
 * first) so the most urgent requests sit at the top.
 */
export default function createSupportTicketRoutes(deps: RouteDeps): Router {
  const { broadcast, findProject, stmts } = deps;
  const uploadsDir = resolveUploadsDir(deps.config, deps.serverDir);
  const uploadStore = createUploadStore(deps.config, uploadsDir);
  const router = Router();

  // Per-IP flood guards for the public write endpoints (mounted as route
  // middleware below). One store each, created with the router.
  const voteRateLimiter = buildWriteRateLimiter('vote', voteRateMax);
  const commentRateLimiter = buildWriteRateLimiter('comment', commentRateMax);

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
    // Batched on purpose: a per-ticket serialize would re-query the converted
    // card (and re-resolve the caller's email visibility) once per row.
    res.json(serializeSupportTicketsForRequest(req, tickets));
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

  /**
   * Score-ranked voting feed. Only `type=feature_request` tickets that have
   * not been converted to a card (status !== 'converted'), joined with vote
   * tallies and non-hidden comment counts. Optional `voterKey` fills
   * `voting.myVote` for that identity; omitted/blank leaves it null.
   */
  router.get('/api/projects/:projectId/support-tickets/voting', (req: Request, res: Response) => {
    const project = findProject(req.params.projectId as string);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const parsed = VotingListQuerySchema.safeParse({ voterKey: req.query.voterKey });
    if (!parsed.success) {
      return res.status(400).json({
        error: 'voterKey must be a string of at most 256 characters',
      });
    }

    const listed = listSupportTicketsForVoting(project.id, parsed.data.voterKey);
    res.json(serializeVotingListForRequest(req, listed));
  });

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
        uploadsDir,
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
    // rejected request never leaves an orphan in the configured upload store.
    let screenshotRef: string | null = null;
    if (screenshot) {
      try {
        screenshotRef = await persistSupportTicketScreenshot(uploadStore, screenshot);
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
          uploadsDir,
          cwd: project.cwd,
          agent: pickMainDevAgent(project),
          userId: resolveOwnerUserId(req as AuthenticatedRequest),
        },
      );
      res.status(201).json(serializeForRequest(req, ticket));
    } catch (err) {
      // The ticket didn't land — remove the screenshot we just wrote so it
      // isn't orphaned (intake validates body/type/severity and can throw).
      await deleteSupportTicketScreenshot(uploadStore, screenshotRef);
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

      const {
        status,
        type,
        severity,
        wontDoReason,
        aiSummary,
        aiInvestigation,
        replayRef,
        screenshot,
      } = req.body as {
        status?: string;
        type?: string;
        severity?: string;
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

      // Validate every enum field BEFORE the first write. The mutations below
      // run in sequence against the store, so a late rejection (e.g. a bad
      // `severity` in `{ type: 'bug', severity: 'urgent' }`) would 400 with the
      // earlier fields already persisted — a partial write the caller can't see.
      const enumChecks: Array<[string | undefined, readonly string[], string]> = [
        [status, SUPPORT_TICKET_STATUSES, 'status'],
        [type, SUPPORT_TICKET_TYPES, 'type'],
        [severity, SUPPORT_TICKET_SEVERITIES, 'severity'],
      ];
      for (const [value, allowed, field] of enumChecks) {
        if (value !== undefined && !allowed.includes(value)) {
          return res.status(400).json({ error: `${field} must be one of: ${allowed.join(', ')}` });
        }
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
            screenshotRef = await persistSupportTicketScreenshot(uploadStore, screenshot);
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
        if (severity !== undefined) {
          ticket = updateSupportTicketSeverity(ticket.id, severity as SupportTicketSeverity)!;
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
            await deleteSupportTicketScreenshot(uploadStore, previousRef);
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
          await deleteSupportTicketScreenshot(uploadStore, screenshotRef);
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

  /**
   * Link a support ticket to an **existing** kanban card.
   *
   * The sibling of `/convert`: instead of creating a fresh card, this ties the
   * ticket to a card that already exists (e.g. the card whose fix already
   * addressed the reported bug). It stamps `support_ticket_id` /
   * `customer_report_id` on the target card, records a comment on that card
   * preserving the ticket's back-link + screenshot, then flags the source
   * ticket `converted` (recording `converted_card_id`) and marks it read — the
   * same terminal state as convert, so the ticket drops out of the open queue
   * but is retained.
   *
   * Returns `{ card, ticket, ticketId, linked: true }`. Idempotent-safe: a
   * concurrent/retried request that already converted the ticket 409s. The
   * target card must live on this project's board (404 otherwise) and must not
   * already be linked to a *different* ticket (409) so an existing card's
   * provenance is never silently clobbered.
   */
  router.post(
    '/api/projects/:projectId/support-tickets/:id/link-card',
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

      const parsed = LinkSupportTicketToCardRequestSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return res.status(400).json({ error: 'Invalid request body' });
      }
      const cardId = parsed.data.cardId.trim();
      if (!cardId) return res.status(400).json({ error: 'cardId is required' });
      const note = typeof parsed.data.comment === 'string' ? parsed.data.comment.trim() : '';

      const { board } = getOrCreateBoard(stmts, project.id);
      const target = stmts.getKanbanCard.get(cardId) as KanbanCardRow | undefined;
      if (!target || target.board_id !== board.id) {
        return res.status(404).json({ error: 'Target card not found on this board' });
      }
      // Never clobber the back-link of a card already tied to another ticket.
      if (target.support_ticket_id && target.support_ticket_id !== ticket.id) {
        return res.status(409).json({ error: 'Card is already linked to another support ticket' });
      }

      // Preserve the ticket context on the existing card as a comment: an
      // optional operator note, plus a footer linking back to the source ticket
      // and (if present) the reporter screenshot as a markdown image. The ref is
      // stored server-relative (/uploads/…) so the card renderer resolves it the
      // same way the convert path's baked-in screenshot is resolved.
      const footer = `Linked from support ticket \`${ticket.id}\` (${ticket.type}, ${ticket.severity}).`;
      const screenshotLine = ticket.screenshot_ref
        ? `\n\n**Screenshot:** ![screenshot](${ticket.screenshot_ref})`
        : '';
      const linkComment = note
        ? `${note}\n\n---\n${footer}${screenshotLine}`
        : `${footer}${screenshotLine}`;

      // Atomic stamp-card + flip-ticket-to-converted. The ticket re-read bails if
      // it was converted by a concurrent/retried request (linked once only). The
      // card back-link is claimed with a CONDITIONAL (compare-and-swap) UPDATE
      // that only matches while the card is still on this board AND unclaimed (or
      // already ours) — guarding the WRITE itself, not a preceding read, so the
      // claim is race-safe across processes: concurrent linkers serialize on the
      // SQLite write lock and the loser's UPDATE matches 0 rows (checked via
      // `changes`) rather than clobbering the winner's provenance or surfacing a
      // busy/snapshot 500. A 0-row claim is disambiguated into card-gone (404)
      // vs card-taken (409) by a follow-up read.
      const link = getDb().transaction(
        ():
          | { kind: 'ok'; card: KanbanCardRow }
          | { kind: 'gone' }
          | { kind: 'already' }
          | { kind: 'card-taken' }
          | { kind: 'card-gone' } => {
          const fresh = getSupportTicket(ticket.id);
          if (!fresh) return { kind: 'gone' };
          if (fresh.status === 'converted') return { kind: 'already' };
          const claim = stmts.claimKanbanCardForSupportTicket.run(
            ticket.id,
            ticket.id,
            cardId,
            board.id,
            ticket.id,
          );
          if (claim.changes === 0) {
            // The CAS matched nothing: either the card vanished / left the board
            // (404) or another ticket won the claim (409). Read to disambiguate.
            const freshCard = stmts.getKanbanCard.get(cardId) as KanbanCardRow | undefined;
            if (!freshCard || freshCard.board_id !== board.id) return { kind: 'card-gone' };
            return { kind: 'card-taken' };
          }
          stmts.createKanbanCardComment.run(uuidv4(), cardId, 'support-ticket', linkComment);
          convertSupportTicketToCard(ticket.id, cardId);
          markSupportTicketRead(ticket.id);
          // Linking flips status to 'converted'; a leftover wont_do_reason must
          // be cleared to keep the invariant (reason non-null only while wont_do).
          if (fresh.wont_do_reason) setSupportTicketWontDoReason(ticket.id, null);
          return { kind: 'ok', card: stmts.getKanbanCard.get(cardId) as KanbanCardRow };
        },
      );

      const result = link();
      if (result.kind === 'gone') {
        return res.status(404).json({ error: 'Support ticket not found' });
      }
      if (result.kind === 'card-gone') {
        return res.status(404).json({ error: 'Target card not found on this board' });
      }
      if (result.kind === 'already') {
        return res.status(409).json({ error: 'Support ticket already converted' });
      }
      if (result.kind === 'card-taken') {
        return res.status(409).json({ error: 'Card is already linked to another support ticket' });
      }
      const { card } = result;

      // Carry the replay attribution onto the linked card (best-effort).
      if (ticket.replay_ref) {
        await tryLinkReplay(stmts, ticket.replay_ref, {
          projectId: project.id,
          supportTicketId: ticket.id,
          cardId,
        });
      }

      const linked = getSupportTicket(ticket.id)!;
      broadcast({ type: 'kanban_update', projectId: project.id });
      broadcastTicket('support_ticket_updated', project.id, { ticket: linked });

      res.status(200).json({
        card: serializeCardForRequest(req, stmts, board.id, card),
        ticket: serializeForRequest(req, linked),
        ticketId: ticket.id,
        linked: true,
      });
    },
  );

  /**
   * Cast, change, or retract a vote on a feature-request ticket.
   * Body `{ voterKey, value }` where value is 1, -1, or null (retract).
   * UNIQUE(ticket, voter_key) makes the upsert/delete race-safe. Write,
   * aggregate, and broadcast share a per-ticket lock so overlapping votes
   * cannot emit a stale total after a newer one.
   */
  router.put(
    '/api/projects/:projectId/support-tickets/:id/vote',
    voteRateLimiter,
    async (req: Request, res: Response) => {
      const project = findProject(req.params.projectId as string);
      if (!project) return res.status(404).json({ error: 'Project not found' });

      const ticket = getSupportTicket(req.params.id as string);
      if (!ticket || ticket.project_id !== project.id) {
        return res.status(404).json({ error: 'Support ticket not found' });
      }
      if (ticket.type !== 'feature_request') {
        return res.status(400).json({
          error: 'Voting is only available on feature_request tickets',
        });
      }

      const parsed = CastVoteRequestSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return res.status(400).json({ error: 'Invalid request body' });
      }
      const { voterKey, value } = parsed.data;

      try {
        const aggregate = await withTicketVoteLock(ticket.id, async () => {
          const next = applySupportTicketVote(ticket.id, voterKey, value);
          if (voteAfterApply) await voteAfterApply(ticket.id);
          broadcast({
            type: 'support_ticket_vote_updated',
            ticketId: ticket.id,
            projectId: project.id,
            score: next.score,
            upvotes: next.upvotes,
            downvotes: next.downvotes,
          });
          return next;
        });
        res.json(aggregate);
      } catch (err) {
        if (!res.headersSent) {
          res.status(400).json({ error: (err as Error).message });
        }
      }
    },
  );

  /**
   * Anonymous comment thread. List is non-hidden, oldest-first. Hub-auth
   * responses include `source` and `hidden_at`; the external projection
   * drops `hidden_at`. Hidden rows never appear in either list.
   */
  router.get(
    '/api/projects/:projectId/support-tickets/:id/comments',
    (req: Request, res: Response) => {
      const project = findProject(req.params.projectId as string);
      if (!project) return res.status(404).json({ error: 'Project not found' });

      const ticket = getSupportTicket(req.params.id as string);
      if (!ticket || ticket.project_id !== project.id) {
        return res.status(404).json({ error: 'Support ticket not found' });
      }

      const comments = listSupportTicketComments(ticket.id).map((row) =>
        serializeSupportTicketComment(req, row),
      );
      res.json(comments);
    },
  );

  /**
   * Append an anonymous comment. `source` is derived from the caller
   * (Hub UI / local → hub; API-key-only → external), not the body.
   */
  router.post(
    '/api/projects/:projectId/support-tickets/:id/comments',
    commentRateLimiter,
    (req: Request, res: Response) => {
      const project = findProject(req.params.projectId as string);
      if (!project) return res.status(404).json({ error: 'Project not found' });

      const ticket = getSupportTicket(req.params.id as string);
      if (!ticket || ticket.project_id !== project.id) {
        return res.status(404).json({ error: 'Support ticket not found' });
      }

      const parsed = AddSupportTicketCommentRequestSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return res.status(400).json({ error: 'Invalid request body' });
      }

      try {
        const comment = addSupportTicketComment({
          supportTicketId: ticket.id,
          body: parsed.data.body,
          displayName: parsed.data.displayName,
          source: commentSourceForRequest(req),
        });
        const payload = serializeSupportTicketComment(req, comment);
        broadcast({
          type: 'support_ticket_comment_created',
          ticketId: ticket.id,
          projectId: project.id,
          comment: payload,
        });
        res.status(201).json(payload);
      } catch (err) {
        if (!res.headersSent) {
          res.status(400).json({ error: (err as Error).message });
        }
      }
    },
  );

  /**
   * Operator soft-delete. Hub-auth only; API-key-only (external) callers
   * get 403. Sets `hidden_at` so subsequent lists skip the row.
   */
  router.delete(
    '/api/projects/:projectId/support-tickets/:id/comments/:commentId',
    (req: Request, res: Response) => {
      const project = findProject(req.params.projectId as string);
      if (!project) return res.status(404).json({ error: 'Project not found' });

      if (isExternalSupportCaller(req)) {
        return res.status(403).json({ error: 'Comment moderation requires Hub authentication' });
      }

      const ticket = getSupportTicket(req.params.id as string);
      if (!ticket || ticket.project_id !== project.id) {
        return res.status(404).json({ error: 'Support ticket not found' });
      }

      const commentId = req.params.commentId as string;
      const existing = getSupportTicketComment(commentId);
      if (!existing || existing.support_ticket_id !== ticket.id) {
        return res.status(404).json({ error: 'Comment not found' });
      }

      const hidden = hideSupportTicketComment(commentId);
      if (!hidden) {
        return res.status(404).json({ error: 'Comment not found' });
      }

      broadcast({
        type: 'support_ticket_comment_deleted',
        ticketId: ticket.id,
        projectId: project.id,
        commentId,
      });
      res.json({ ok: true });
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
        await deleteSupportTicketScreenshot(uploadStore, ticket.screenshot_ref);
      }
      broadcastTicket('support_ticket_deleted', project.id, { ticketId: ticket.id });
      res.json({ ok: true });
    },
  );

  return router;
}
