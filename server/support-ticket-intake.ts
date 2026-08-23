/**
 * Shared support-ticket intake.
 *
 * Both the authenticated queue route (`POST /api/projects/:projectId/
 * support-tickets`) and the public bug-report intake endpoint
 * (`POST /api/bug-reports`) land a ticket the SAME way: create the row,
 * attribute + guard its session-replay ref, broadcast `support_ticket_created`,
 * and fire the one-shot AI investigation for `bug` tickets. Keeping that
 * sequence in one place means the security-sensitive replay guard can't drift
 * between the two entry points.
 */
import type { Agent, RouteDeps, SupportTicketRow } from './types.js';
import {
  createSupportTicket,
  setSupportTicketReplayRef,
  setSupportTicketBody,
  countUnreadSupportTickets,
  maskReporterEmail,
  type CreateSupportTicketInput,
} from './support-tickets-store.js';
import { triggerSupportTicketInvestigation } from './support-ticket-investigation.js';
import { linkReplay } from './replays/replay-store.js';

export interface SupportTicketIntakeDeps {
  stmts: RouteDeps['stmts'];
  broadcast: RouteDeps['broadcast'];
  config: RouteDeps['config'];
  uploadsDir: string;
  /** Working dir for the AI investigation (the project's cwd). */
  cwd?: string;
  /** Primary project agent used for the automatic investigation. */
  agent?: Pick<Agent, 'id' | 'engine' | 'model'> | null;
  /** Authenticated owner whose CLI credentials and model preference are used. */
  userId?: string | null;
  /**
   * Optional post-guard body finalizer. Invoked with the ticket AFTER the
   * replay-ref attribution guard has run — so `ticket.replay_ref` is the
   * persisted, accepted value (or null). Return a string to persist as the
   * final body, or null to leave the created body untouched. The result is
   * applied BEFORE the `support_ticket_created` broadcast and the bug
   * investigation fire, so both observe the finalized body. Lets a caller
   * (e.g. the public bug-report intake) surface an accepted replay ref in the
   * body without ever leaking a rejected one — no timing assumption required.
   */
  finalizeBody?: (ticket: SupportTicketRow) => string | null;
}

/**
 * Link the replay referenced by `replayRef` to this project/ticket and report
 * whether the ref is safe to PERSIST on the ticket.
 *
 * A ref is kept only when the replay ends up owned by THIS project — freshly
 * linked from an unattributed row, or already ours. A ref we cannot attribute
 * (already owned by another project, or with no `session_replays` row at all)
 * is REJECTED, because the legacy investigation path (`resolveReplayContext`)
 * resolves the `/uploads/replay-<id>.json` file by ref WITHOUT going through
 * `canViewReplay`: persisting a foreign ref would splice another project's
 * capture into this ticket's triage prompt. Returns true to keep the ref, false
 * to clear it. Defensive — any error clears.
 *
 * Module-private: callers outside this file go through `setGuardedReplayRef`
 * (or `intakeSupportTicket`) so the set-then-guard sequence stays in one place.
 */
async function replayRefBelongsToProject(
  stmts: RouteDeps['stmts'],
  replayRef: string,
  projectId: string,
  ticketId: string,
): Promise<boolean> {
  try {
    const row = await linkReplay(stmts, replayRef, { projectId, supportTicketId: ticketId });
    return row !== null && row.project_id === projectId;
  } catch (err) {
    console.error('[SupportTickets] replay link failed; clearing ref:', (err as Error).message);
    return false;
  }
}

/**
 * Set (or clear) an existing ticket's replay ref WITH the project attribution
 * guard applied: the ref is persisted only if it attributes to `projectId`; a
 * foreign/nonexistent ref (or an explicit `null`) leaves `replay_ref` cleared.
 * Returns the updated ticket, or null if the ticket doesn't exist.
 *
 * Shared by the support-ticket PATCH route and `intakeSupportTicket` so the
 * set-then-guard sequence — and the security boundary it enforces — lives in
 * exactly one place.
 */
export async function setGuardedReplayRef(
  stmts: RouteDeps['stmts'],
  ticketId: string,
  projectId: string,
  replayRef: string | null,
): Promise<SupportTicketRow | null> {
  let ticket = setSupportTicketReplayRef(ticketId, replayRef);
  if (!ticket) return null;
  if (replayRef && !(await replayRefBelongsToProject(stmts, replayRef, projectId, ticketId))) {
    ticket = setSupportTicketReplayRef(ticketId, null);
  }
  return ticket;
}

/**
 * Create a support ticket, attribute/guard its replay ref, broadcast the
 * `support_ticket_created` event, and fire the one-shot AI investigation for
 * `bug` tickets. Throws on invalid input (empty body / bad type|severity) so
 * the caller can map it to a 400 — everything after the create is best-effort
 * and never throws.
 */
export async function intakeSupportTicket(
  input: CreateSupportTicketInput,
  deps: SupportTicketIntakeDeps,
): Promise<SupportTicketRow> {
  let ticket = createSupportTicket(input);

  // Attribute the replay to this project + ticket now that we have a trusted,
  // project-scoped context (ingest itself is anonymous). If the ref can't be
  // attributed to THIS project, clear it before anything reads it — otherwise
  // the investigation below would resolve a foreign capture via the legacy
  // `/uploads` path (which bypasses canViewReplay).
  if (
    input.replayRef &&
    !(await replayRefBelongsToProject(deps.stmts, input.replayRef, ticket.project_id, ticket.id))
  ) {
    ticket = setSupportTicketReplayRef(ticket.id, null)!;
  }

  // Finalize the body from the POST-guard ticket (now that `replay_ref` holds
  // the accepted/cleared value) before anyone observes the ticket. This keeps a
  // replay-aware body in sync with the guarded ref for the broadcast and the
  // investigation, without leaking a rejected ref.
  if (deps.finalizeBody) {
    const finalBody = deps.finalizeBody(ticket);
    if (finalBody !== null && finalBody !== ticket.body) {
      ticket = setSupportTicketBody(ticket.id, finalBody) ?? ticket;
    }
  }

  deps.broadcast({
    type: 'support_ticket_created',
    ticket: {
      ...ticket,
      reporter_email: maskReporterEmail(ticket.reporter_email),
      reporter_email_masked: Boolean(ticket.reporter_email),
    },
    projectId: ticket.project_id,
    unreadCount: countUnreadSupportTickets(ticket.project_id),
  });

  // Bug tickets get an initial AI investigation pass that fills in the
  // ai_summary / ai_investigation fields. Fire-and-forget: the ticket has
  // already landed, so a failed investigation must never surface as an error.
  if (ticket.type === 'bug') {
    triggerSupportTicketInvestigation(ticket.id, {
      config: deps.config,
      broadcast: deps.broadcast,
      uploadsDir: deps.uploadsDir,
      cwd: deps.cwd,
      agentId: deps.agent?.id,
      agentEngine: deps.agent?.engine,
      agentModel: deps.agent?.model,
      userId: deps.userId,
    });
  }

  return ticket;
}
