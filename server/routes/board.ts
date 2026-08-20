import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import nodeCron from 'node-cron';
import { Router, Request, Response } from 'express';
import type { z } from 'zod';
import { resolveEffectiveEngineAndModel } from '../effective-model.js';
import type {
  RouteDeps,
  Stmts,
  AgentLookup,
  KanbanBoardRow,
  KanbanColumnRow,
  KanbanCardRow,
  KanbanEpicRow,
  KanbanCardTemplateRow,
  KanbanEpicSpecItemRow,
  KanbanPhaseRow,
  KanbanBlockerLink,
  KanbanCardBlockerRow,
  SessionRow,
  FinalizeRunRow,
  SessionReplayRow,
  SupportTicketRow,
} from '../types.js';
import { findCycle, loadBoardBlockers, isSystemLockedColumnName } from '../kanban-blockers.js';
import {
  blocksPrematureDoneMove,
  PREMATURE_DONE_ERROR,
  PREMATURE_DONE_MESSAGE,
} from '../kanban-premature-done.js';
import { deriveCardPrefix } from '../kanban-short-id.js';
import { topologicallySortPhaseIds, PhaseCycleError } from '../kanban-phase-topo-sort.js';
import {
  type CardCursor,
  clampPageLimit,
  decodeCardCursor,
  encodeCardCursor,
} from '../kanban-pagination.js';
import { maybeRenameSessionForLinkedCard, resolveCardSessionId } from '../kanban-caller-session.js';
import { parsePrBaseBranchInput } from '../kanban-pr-base.js';
import { isAgentHubHosted } from '../native-pr/host.js';
import { prsForEpicFeatureBranch } from '../native-pr/epic-branch-link.js';
import { loadAssignableUsers, normalizeAssignedUserId } from '../kanban-assigned-user.js';
import { normalizeTemplatePriority, templateRowToClient } from '../kanban-card-templates.js';
import { getDb } from '../db.js';
import { loadCardReplayContext } from '../replays/replay-context-loader.js';
import {
  scheduleAutonomousPhase,
  startAutonomousPhase,
  stopAutonomousPhase,
  startAutonomousEpicChain,
} from '../autonomous.js';
import {
  refreshEpicStartScheduleRegistration,
  unregisterEpicStartSchedule,
} from '../autonomous-start-schedule.js';
import {
  validateKanbanAssignModel,
  validateKanbanAssignModelForEngine,
} from '../kanban-assign-model.js';
import { sanitizeOrchestrationBudgetsPartial } from '../orchestration-budgets.js';
import { defaultSessionUseWorktreeFlag } from '../project-mode.js';
import { maybeStartKanbanColumnWorkflowRuns } from '../workflow-triggers.js';
import { setSessionOwner, resolveOwnerUserId, getSessionOwner } from '../session-ownership.js';
import { enrichSessionForClient } from '../session-checkpoint-rewind.js';
import { recomputeSessionState } from '../session-state.js';
import { requestReleaseGateSweep } from '../deploy/release-gate-ticker.js';
import { epicsWithComputedState, recomputeEpicState } from '../epic-state.js';
import { disableAutonomousForEmptyEpic } from '../kanban-epic-autonomous-empty.js';
import { markSessionAutoShipOnComplete, markSessionFinalizeAutomation } from '../session-ship.js';
import { assignedFinalizeAutomationLevel } from '../finalize/automation.js';
import {
  canReadReporterEmail,
  linkedSupportTicketMetadata,
  serializeSupportTicketForBroadcast,
  type LinkedSupportTicketMetadata,
} from '../support-ticket-serialization.js';
import {
  countUnreadSupportTickets,
  markSupportTicketsFixedPendingReleaseForCard,
} from '../support-tickets-store.js';
import { buildAssignedCardSessionContext } from '../assign-card-context.js';
import {
  buildSpikeSessionContext,
  buildSpikeSessionContextFallback,
  completeSpikeCardForSpecItem,
  ensureSpecItemForSpikeCard,
  getSpecItemForSpikeCard,
  isSpikeCard,
  normalizeSpecItemStatus,
} from '../epic-spec.js';
import { buildDecideForMeSessionContext, pickDefaultDecideAgent } from '../spec-decide-for-me.js';
import { buildNoteScopingKickoff } from '../note-scoping.js';
import { resolveShouldAutoMerge } from '../auto-merge.js';
import { parseSourceMeta, serializeSourceMeta } from '../source-provenance.js';
import { releaseIssueFixClaimsForCard } from '../logs/log-issues-store.js';
import type { AuthenticatedRequest } from '../auth.js';
import { cardNeedsDevHubKey, getDevHubApiKey } from '../secrets.js';
import {
  CreateCardRequestSchema,
  UpdateCardRequestSchema,
  MoveCardRequestSchema,
  AssignCardRequestSchema,
  CreateCommentRequestSchema,
  AddBlockerRequestSchema,
  CreateColumnRequestSchema,
  UpdateColumnRequestSchema,
  ReorderColumnsRequestSchema,
  CreateEpicRequestSchema,
  UpdateEpicRequestSchema,
  LinkEpicRequestSchema,
  CreatePhaseRequestSchema,
  UpdatePhaseRequestSchema,
  ReorderPhasesRequestSchema,
  SetEpicStartScheduleRequestSchema,
  CreateSpecItemRequestSchema,
  UpdateSpecItemRequestSchema,
  DecideForMeRequestSchema,
  ScopeEpicRequestSchema,
  ScopeFromNotesRequestSchema,
  CreateCardTemplateRequestSchema,
  UpdateCardTemplateRequestSchema,
} from './board.openapi.js';

/**
 * Validate `req.body` against a Zod schema. On failure, writes a 400 with
 * `{error, details}` and returns `undefined`; the handler must `return`
 * immediately. On success, returns the parsed data (typed).
 *
 * The error message is taken from the first Zod issue so terse one-line
 * errors like "title is required" (carried over from the pre-Zod hand-rolled
 * checks) keep their shape. The full issue list is exposed under `details`
 * for clients that want to surface per-field validation.
 */
function parseBody<T extends z.ZodTypeAny>(
  schema: T,
  req: Request,
  res: Response,
): z.infer<T> | undefined {
  const result = schema.safeParse(req.body);
  if (!result.success) {
    const first = result.error.issues[0];
    res.status(400).json({
      error: first?.message ?? 'Validation failed',
      details: result.error.issues.map((i) => ({ path: i.path, message: i.message })),
    });
    return undefined;
  }
  return result.data;
}

function resolveTemplateEpicId(
  stmts: Stmts,
  boardId: string,
  epicId: string | null | undefined,
): string | null | 'invalid' {
  if (epicId === undefined || epicId === null || String(epicId).trim() === '') return null;
  const epic = stmts.getKanbanEpic.get(String(epicId).trim()) as KanbanEpicRow | undefined;
  if (!epic || epic.board_id !== boardId) return 'invalid';
  return epic.id;
}

function collectAvailableCardLabels(cards: KanbanCardRow[]): string[] {
  const labels = new Set<string>();
  for (const card of cards) {
    for (const raw of String(card.labels || '').split(',')) {
      const label = raw.trim();
      if (label) labels.add(label);
    }
  }
  return [...labels].sort((a, b) => a.localeCompare(b));
}

function defaultPhaseAutonomousModel(): string | null {
  // A phase must never capture the host-wide legacy model. When no per-user
  // agent model was supplied, autonomous dispatch resolves the model for the
  // session owner at spawn time instead.
  return null;
}

/**
 * Resolve the phase a card should join when it's linked to an epic but no phase
 * was supplied. Scoping requires every epic-linked ticket to live in a phase:
 * an unphased epic card is invisible in the phase flowchart (grouped by
 * `phase_id`) and the autonomous phase runner (which dispatches by `phase_id`)
 * never picks it up. Returns the epic's first phase by position, materializing a
 * default phase when the epic has none so we never leave an epic phase-less.
 */
function resolvePhaseForEpicLink(stmts: Stmts, boardId: string, epicId: string): string {
  const phases = stmts.getKanbanPhasesByEpic.all(epicId) as KanbanPhaseRow[];
  if (phases.length > 0) {
    return [...phases].sort((a, b) => a.position - b.position)[0].id;
  }
  // No phases yet — create the default one the scoping contract mandates
  // ("never leave an epic with zero phases") and drop the ticket into it.
  const id = uuidv4();
  stmts.createKanbanPhase.run(id, epicId, boardId, 'Phase 1', null, 0);
  const defaultPhaseModel = defaultPhaseAutonomousModel();
  if (defaultPhaseModel) {
    const created = stmts.getKanbanPhase.get(id) as KanbanPhaseRow;
    stmts.updateKanbanPhase.run(
      created.name,
      created.description,
      created.autonomous,
      created.autonomous_interval,
      created.autonomous_max_concurrent,
      defaultPhaseModel,
      created.autonomous_send_it ?? 1,
      id,
    );
  }
  return id;
}

function defaultPhaseAutonomousModelForAgent(
  cfg: RouteDeps['config'],
  agentLookup: AgentLookup | null,
  ownerUserId: string | null,
): string | null {
  if (!agentLookup) return null;
  const agent = agentLookup.agent;
  const resolved = resolveEffectiveEngineAndModel(cfg, {
    agentId: agent.id,
    agentEngine: agent.engine || 'claude-code',
    agentModel: agent.model ?? null,
    ownerUserId,
  });
  const model = typeof resolved.model === 'string' ? resolved.model.trim() : '';
  if (!model) return null;
  const allowed = cfg.engineValidModels?.[resolved.engine] || [];
  return allowed.includes(model) ? model : null;
}

interface BoardData {
  board: KanbanBoardRow;
  columns: KanbanColumnRow[];
  cards: KanbanCardRow[];
  epics: KanbanEpicRow[];
  phases: KanbanPhaseRow[];
  specItems: KanbanEpicSpecItemRow[];
}

interface LinkedSupportTicketRow extends SupportTicketRow {
  card_id: string;
}

export interface SerializedKanbanCard extends Omit<KanbanCardRow, 'source_meta'> {
  support_ticket_id: string | null;
  customer_report_id: string | null;
  linked_support_ticket: LinkedSupportTicketMetadata | null;
  /** Capture-provenance deep-link blob, parsed from the row's JSON TEXT. */
  source_meta: Record<string, unknown> | null;
}

/** A card row enriched with its blocker relationships. */
interface EnrichedCard extends SerializedKanbanCard {
  blockers: KanbanBlockerLink[];
  blocks: KanbanBlockerLink[];
  /**
   * Latest Finalize Code Changes run for `session_id`, or `null` if the
   * card has no session or the session has never triggered Finalize.
   *
   * Folded into the board payload so the per-card status badge in the
   * client can render without a separate GET per card. The shape mirrors
   * `FinalizeRunRow` 1:1; the client reads it as `initialRun` for the
   * `useFinalizeRun` hook which then live-updates via WebSocket events.
   */
  finalize_run: FinalizeRunRow | null;
}

/**
 * Resolve the latest finalize run for every session referenced by cards
 * on a board, keyed by `session_id`. Returns an empty map when no card
 * has a session_id or no session has finalize history. Cheap — one
 * indexed window-function query per board fetch.
 */
function loadBoardFinalizeRuns(stmts: Stmts, boardId: string): Map<string, FinalizeRunRow> {
  const rows = stmts.listLatestFinalizeRunsForBoard.all(boardId) as FinalizeRunRow[];
  const out = new Map<string, FinalizeRunRow>();
  for (const row of rows) {
    if (row.session_id) out.set(row.session_id, row);
  }
  return out;
}

/**
 * Attach the blocker graph (`blockers` / `blocks`) and the latest finalize run
 * to a set of card rows. Both lookups are board-scoped batched queries — one
 * for the blocker edges, one for the latest finalize run per session — so this
 * is cheap to call once per request whether it enriches the whole board or a
 * single paginated column slice.
 */
function loadLinkedSupportTicketsForCards(
  req: Request,
  stmts: Stmts,
  boardId: string,
): Map<string, LinkedSupportTicketMetadata> {
  const statement = (
    stmts as Stmts & {
      getLinkedSupportTicketsForBoard?: {
        all?: (boardId: string, fallbackBoardId: string) => unknown[];
      };
    }
  ).getLinkedSupportTicketsForBoard;
  if (!statement?.all) return new Map();
  const rows = statement.all(boardId, boardId) as LinkedSupportTicketRow[];
  const canRead = canReadReporterEmail(req);
  const out = new Map<string, LinkedSupportTicketMetadata>();
  for (const row of rows) {
    if (!out.has(row.card_id)) {
      out.set(row.card_id, linkedSupportTicketMetadata(row, { canReadReporterEmail: canRead }));
    }
  }
  return out;
}

export function serializeCardsForRequest(
  req: Request,
  stmts: Stmts,
  boardId: string,
  cards: KanbanCardRow[],
): SerializedKanbanCard[] {
  const linkedByCardId = loadLinkedSupportTicketsForCards(req, stmts, boardId);
  return cards.map((card) => {
    const linked = linkedByCardId.get(card.id) ?? null;
    const linkedId = linked?.id ?? null;
    return {
      ...card,
      support_ticket_id: card.support_ticket_id ?? linkedId,
      customer_report_id: card.customer_report_id ?? card.support_ticket_id ?? linkedId,
      linked_support_ticket: linked,
      source_type: card.source_type ?? null,
      source_id: card.source_id ?? null,
      source_meta: parseSourceMeta(card.source_meta),
    };
  });
}

export function serializeCardForRequest(
  req: Request,
  stmts: Stmts,
  boardId: string,
  card: KanbanCardRow,
): SerializedKanbanCard {
  return serializeCardsForRequest(req, stmts, boardId, [card])[0];
}

function enrichCards(
  req: Request,
  stmts: Stmts,
  boardId: string,
  cards: KanbanCardRow[],
): EnrichedCard[] {
  const index = loadBoardBlockers(stmts, boardId);
  const finalizeRuns = loadBoardFinalizeRuns(stmts, boardId);
  return serializeCardsForRequest(req, stmts, boardId, cards).map((c) => ({
    ...c,
    blockers: index.blockersByCard.get(c.id) ?? [],
    blocks: index.blocksByCard.get(c.id) ?? [],
    finalize_run: c.session_id ? (finalizeRuns.get(c.session_id) ?? null) : null,
  }));
}

/**
 * Fetch one keyset page of a column's cards ordered by `(position, id)`.
 *
 * Asks the DB for `limit + 1` rows: if the extra row comes back there's a next
 * page, and `nextCursor` encodes the last returned (in-page) card so the
 * caller can resume strictly after it. Returns `nextCursor: null` on the final
 * page. Pass `cursor = null` for the first page.
 */
function fetchColumnCardPage(
  stmts: Stmts,
  columnId: string,
  limit: number,
  cursor: CardCursor | null,
): { cards: KanbanCardRow[]; nextCursor: string | null } {
  const fetchN = limit + 1;
  const rows = (
    cursor
      ? stmts.getKanbanCardsByColumnPageAfter.all(
          columnId,
          cursor.position,
          cursor.position,
          cursor.id,
          fetchN,
        )
      : stmts.getKanbanCardsByColumnPageFirst.all(columnId, fetchN)
  ) as KanbanCardRow[];

  if (rows.length > limit) {
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return { cards: page, nextCursor: encodeCardCursor({ position: last.position, id: last.id }) };
  }
  return { cards: rows, nextCursor: null };
}

/** Per-column total card count, keyed by column id. Used for the board `counts` map. */
function loadColumnCounts(stmts: Stmts, columns: KanbanColumnRow[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const col of columns) {
    const row = stmts.countKanbanCardsByColumn.get(col.id) as { n: number } | undefined;
    counts[col.id] = row?.n ?? 0;
  }
  return counts;
}

function loadRequestAssignableUsers(req: Request): ReturnType<typeof loadAssignableUsers> {
  return loadAssignableUsers((req as AuthenticatedRequest).authOrgId);
}

/**
 * Resolve the user acting under this request, so a newly created card / epic
 * can default its lead to "whoever created it":
 *
 *   1. A human (JWT or per-user `ahub_*` API key) → `resolveOwnerUserId(req)`.
 *   2. An agent spawned on a user's behalf. On JWT-only deployments the spawn
 *      key already resolves to the owner via (1); on deployments with a global
 *      break-glass `AGENT_HUB_API_KEY` there is no `authUserId`, so fall back
 *      to the owner of the linked / spawn session (the `X-Agent-Hub-Session-Id`
 *      header every wrapper sends, or an explicit body `sessionId`).
 */
function resolveActingUserId(req: Request, sessionId: string | null | undefined): string | null {
  const direct = resolveOwnerUserId(req as AuthenticatedRequest);
  if (direct) return direct;
  const resolvedSessionId = resolveCardSessionId(req, sessionId ?? undefined);
  if (resolvedSessionId) {
    const owner = getSessionOwner(resolvedSessionId);
    if (owner) return owner;
  }
  return null;
}

function normalizeAssignedUserForCreate(
  req: Request,
  assignedUserId: string | null | undefined,
  sessionId?: string | null,
): string | null | 'invalid' {
  const assignableUsers = loadRequestAssignableUsers(req);

  // An explicit, non-empty lead choice always wins (and is validated against
  // the org's assignable users).
  if (assignedUserId != null && String(assignedUserId).trim() !== '') {
    return normalizeAssignedUserId(assignedUserId, assignableUsers);
  }

  // No lead was chosen (omitted, null, or empty string). Default the lead to
  // the acting user so "anything created under my profile" gets me as lead —
  // for cards I create in the UI (the modal sends an explicit null when no
  // lead is picked) and for cards / epics an agent creates on my behalf.
  const actingUserId = resolveActingUserId(req, sessionId);
  if (!actingUserId) return null;
  const normalizedActing = normalizeAssignedUserId(actingUserId, assignableUsers);
  return normalizedActing === 'invalid' ? null : normalizedActing;
}

/**
 * Normalize an incoming `assignee` value so the column always stores the
 * agent's **display name** (`agent.name`), never its id slug.
 *
 * Background: the `assignee` column is free-text. Both legitimate
 * auto-assign paths write `agent.name` ("Hub Lead Dev"):
 *
 *   - `POST /board/cards/:cardId/assign` (this file)
 *   - `runAutonomousLoop` (server/autonomous.ts)
 *
 * But the create/update endpoints used to accept whatever string the
 * caller sent. Agents using `scripts/board.sh create` often pasted their
 * own id slug ("agent-hub") into `assignee`, which (a) reads inconsistent
 * in the UI and (b) reserves the card out of the autonomous-dispatch
 * pool because the loop filters on `assignee IS NULL OR assignee = ''`.
 *
 * Behavior:
 *   - `null` / `undefined` / empty / whitespace → `null` (auto-clear).
 *   - Value matches a known `agent.id` → returns that agent's `name`.
 *   - Anything else (human name, "system", an unknown agent's display
 *     name) → passes through trimmed, unchanged. We do not 400 on
 *     unknown strings because the column historically held human-typed
 *     values too; only the id-as-display-name shape is wrong.
 */
function normalizeAssignee(
  raw: string | null | undefined,
  findAgent: (agentId: string) => AgentLookup | null,
): string | null {
  if (raw == null) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;
  const found = findAgent(trimmed);
  if (found) return found.agent.name;
  return trimmed;
}

function findTodoColumnId(stmts: Stmts, boardId: string): string | null {
  const cols = stmts.getKanbanColumns.all(boardId) as KanbanColumnRow[];
  const todo = cols.find((c) => c.name.toLowerCase() === 'to do');
  return todo?.id ?? cols[0]?.id ?? null;
}

/** Create a spike kanban card linked to a spec item (planning ticket). */
function createSpikeCardForSpecItem(
  stmts: Stmts,
  args: {
    boardId: string;
    epicId: string;
    phaseId?: string | null;
    specItem: KanbanEpicSpecItemRow;
  },
): KanbanCardRow | null {
  const columnId = findTodoColumnId(stmts, args.boardId);
  if (!columnId) return null;
  const existingCards = stmts.getKanbanCardsByColumn.all(columnId) as KanbanCardRow[];
  const maxPos =
    existingCards.length > 0 ? Math.max(...existingCards.map((c) => c.position)) + 1 : 0;
  const cardId = uuidv4();
  const title = `Spike: ${args.specItem.title}`;
  stmts.createKanbanCard.run(
    cardId,
    columnId,
    args.boardId,
    title,
    `Research and lock spec decision **${args.specItem.tag}: ${args.specItem.title}** (\`${args.specItem.id}\`).`,
    'medium',
    null,
    null,
    null,
    null,
    'system',
    null,
    maxPos,
  );
  stmts.setKanbanCardKind.run('spike', cardId);
  stmts.updateKanbanCardEpic.run(args.epicId, cardId);
  if (args.phaseId) {
    stmts.updateKanbanCardPhase.run(args.phaseId, cardId);
  }
  recomputeEpicState(stmts, args.epicId);
  stmts.setKanbanSpecItemSpikeCard.run(cardId, args.specItem.id);
  return (stmts.getKanbanCard.get(cardId) as KanbanCardRow | undefined) ?? null;
}

export function getOrCreateBoard(stmts: Stmts, projectId: string): BoardData {
  let board = stmts.getKanbanBoard.get(projectId) as KanbanBoardRow | undefined;
  if (board) {
    return {
      board,
      columns: stmts.getKanbanColumns.all(board.id) as KanbanColumnRow[],
      cards: stmts.getKanbanCards.all(board.id) as KanbanCardRow[],
      epics: stmts.getKanbanEpics.all(board.id) as KanbanEpicRow[],
      phases: stmts.getKanbanPhases.all(board.id) as KanbanPhaseRow[],
      specItems: stmts.getKanbanSpecItems.all(board.id) as KanbanEpicSpecItemRow[],
    };
  }
  const boardId = uuidv4();
  // Freeze the card-id prefix at creation from the immutable project slug, so a
  // later project rename never rewrites existing card ids (e.g. AH-123 stays
  // AH-123 forever, even if the project is renamed).
  stmts.createKanbanBoard.run(boardId, projectId, 'Board', deriveCardPrefix(projectId));
  const defaultColumns = [
    { name: 'To Do', color: '#3B82F6' },
    { name: 'In Progress', color: '#F59E0B' },
    { name: 'Done', color: '#10B981' },
  ];
  for (let i = 0; i < defaultColumns.length; i++) {
    stmts.createKanbanColumn.run(
      uuidv4(),
      boardId,
      defaultColumns[i].name,
      i,
      defaultColumns[i].color,
    );
  }
  board = stmts.getKanbanBoardById.get(boardId) as KanbanBoardRow | undefined;
  return {
    board: board!,
    columns: stmts.getKanbanColumns.all(boardId) as KanbanColumnRow[],
    cards: [],
    epics: [],
    phases: [],
    specItems: [],
  };
}

export default function createBoardRoutes(deps: RouteDeps): Router {
  const {
    findProject,
    findAgent,
    getEnrichedAgent,
    broadcast,
    stmts,
    handleChat,
    lastDispatchedReviewId,
    scheduleAutonomousEpic,
    autonomousCrons,
    runAutonomousLoop,
    config,
    nativePr,
  } = deps;

  const router = Router();

  // GET /board returns the full board state plus a `counts` map giving the
  // total card count per column.
  //
  // Shape:
  //   - `counts` (always present): `{ [columnId]: total }`. Additive — clients
  //     that ignore it keep working.
  //   - `?limit=N` (optional, opt-in): when supplied, `cards` carries only the
  //     first N cards per column (ordered by position, id), bounding the
  //     payload to N × columnCount. The response also gains a `cursors` map
  //     `{ [columnId]: nextCursor|null }` so a client can resume pagination
  //     per column from this single request (via GET
  //     /board/columns/:columnId/cards) without reconstructing the opaque
  //     cursor itself. A null entry means the first page is the last page.
  //     Clients fetch the rest via GET /board/columns/:columnId/cards using
  //     `cursors` + `counts` to know when to stop. When `?limit` is omitted,
  //     `cards` is the full board (backward compatible) and `cursors` is
  //     absent, so the current web / mobile clients are unaffected until they
  //     opt in.
  router.get('/api/projects/:projectId/board', (req: Request, res: Response) => {
    const project = findProject(req.params.projectId as string);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const data = getOrCreateBoard(stmts, req.params.projectId as string);
    data.epics = epicsWithComputedState(data.epics, data.cards, data.columns);
    const counts = loadColumnCounts(stmts, data.columns);

    let cards: KanbanCardRow[];
    let cursors: Record<string, string | null> | undefined;
    if (req.query.limit !== undefined) {
      const limit = clampPageLimit(req.query.limit);
      cards = [];
      cursors = {};
      for (const col of data.columns) {
        const page = fetchColumnCardPage(stmts, col.id, limit, null);
        cards.push(...page.cards);
        cursors[col.id] = page.nextCursor;
      }
    } else {
      cards = data.cards;
    }

    // Annotate each card with its blocker graph and latest finalize run. Both
    // are board-scoped batched queries; folding them into the payload lets the
    // client render blocker banners and per-card finalize badges without a GET
    // per card.
    // The card-id prefix is persisted on the board (frozen at creation from the
    // immutable project slug) so renaming the project never rewrites existing,
    // already-shared card ids. Fall back to deriving from the slug only for a
    // legacy board whose prefix predates the column and somehow wasn't
    // backfilled.
    const cardPrefix = data.board.card_prefix ?? deriveCardPrefix(project.id);
    const assignableUsers = loadRequestAssignableUsers(req);
    const cardTemplates = (
      stmts.getKanbanCardTemplates.all(data.board.id) as KanbanCardTemplateRow[]
    ).map(templateRowToClient);
    const body: Record<string, unknown> = {
      ...data,
      board: { ...data.board, card_prefix: cardPrefix },
      cards: enrichCards(req, stmts, data.board.id, cards),
      counts,
      assignableUsers,
      cardTemplates,
      availableLabels: collectAvailableCardLabels(data.cards),
    };
    if (cursors) body.cursors = cursors;
    res.json(body);
  });

  // GET /board/columns/:columnId/cards — keyset-paginated slice of one column.
  // Query: `limit` (default 50, max 200), `cursor` (opaque token from a prior
  // `nextCursor`). Returns `{ cards: EnrichedCard[], nextCursor, total }`.
  router.get(
    '/api/projects/:projectId/board/columns/:columnId/cards',
    (req: Request, res: Response) => {
      const project = findProject(req.params.projectId as string);
      if (!project) return res.status(404).json({ error: 'Project not found' });
      const { board } = getOrCreateBoard(stmts, project.id);
      const column = stmts.getKanbanColumn.get(req.params.columnId) as KanbanColumnRow | undefined;
      if (!column || column.board_id !== board.id) {
        return res.status(404).json({ error: 'Column not found' });
      }
      let cursor: CardCursor | null = null;
      if (req.query.cursor !== undefined && req.query.cursor !== '') {
        cursor = decodeCardCursor(String(req.query.cursor));
        if (!cursor) return res.status(400).json({ error: 'Invalid cursor' });
      }
      const limit = clampPageLimit(req.query.limit);
      const total = (stmts.countKanbanCardsByColumn.get(column.id) as { n: number }).n;
      const { cards: rows, nextCursor } = fetchColumnCardPage(stmts, column.id, limit, cursor);
      return res.json({ cards: enrichCards(req, stmts, board.id, rows), nextCursor, total });
    },
  );

  router.post('/api/projects/:projectId/board/columns', (req: Request, res: Response) => {
    const project = findProject(req.params.projectId as string);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const parsed = parseBody(CreateColumnRequestSchema, req, res);
    if (!parsed) return;
    const { name, color } = parsed;
    if (isSystemLockedColumnName(name)) {
      return res.status(400).json({
        error: 'Cannot create a duplicate system column (To Do, In Progress, or Done)',
      });
    }
    const { board, columns } = getOrCreateBoard(stmts, req.params.projectId as string);
    const maxPos = columns.length > 0 ? Math.max(...columns.map((c) => c.position)) + 1 : 0;
    const id = uuidv4();
    stmts.createKanbanColumn.run(id, board.id, name, maxPos, color || null);
    broadcast({ type: 'kanban_update', projectId: req.params.projectId });
    res.json(stmts.getKanbanColumns.all(board.id));
  });

  router.put('/api/projects/:projectId/board/columns/:columnId', (req: Request, res: Response) => {
    const project = findProject(req.params.projectId as string);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const parsed = parseBody(UpdateColumnRequestSchema, req, res);
    if (!parsed) return;
    const existing = stmts.getKanbanColumn.get(req.params.columnId) as KanbanColumnRow | undefined;
    if (!existing) return res.status(404).json({ error: 'Column not found' });
    const { board } = getOrCreateBoard(stmts, req.params.projectId as string);
    if (existing.board_id !== board.id) {
      return res.status(404).json({ error: 'Column not found' });
    }
    const { name, position, color } = parsed;
    const nextName = name ?? existing.name;
    const existingIsSystemLocked = isSystemLockedColumnName(existing.name);
    const nextNameIsSystemLocked = isSystemLockedColumnName(nextName);
    if (
      existingIsSystemLocked &&
      nextName.trim().toLowerCase() !== existing.name.trim().toLowerCase()
    ) {
      return res.status(400).json({
        error: 'Cannot rename a system column (To Do, In Progress, or Done)',
      });
    }
    if (!existingIsSystemLocked && nextNameIsSystemLocked) {
      return res.status(400).json({
        error:
          'Cannot rename a custom column to a system column name (To Do, In Progress, or Done)',
      });
    }
    const nextPosition = position ?? existing.position;
    const nextColor = color !== undefined ? color || null : existing.color;
    stmts.updateKanbanColumn.run(nextName, nextPosition, nextColor, req.params.columnId);
    broadcast({ type: 'kanban_update', projectId: req.params.projectId });
    res.json({ ok: true });
  });

  router.post('/api/projects/:projectId/board/columns/reorder', (req: Request, res: Response) => {
    const project = findProject(req.params.projectId as string);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const parsed = parseBody(ReorderColumnsRequestSchema, req, res);
    if (!parsed) return;
    const { board, columns } = getOrCreateBoard(stmts, req.params.projectId as string);
    const uniqueIds = new Set(parsed.columnIds);
    const columnById = new Map(columns.map((column) => [column.id, column]));
    if (uniqueIds.size !== parsed.columnIds.length) {
      return res.status(400).json({ error: 'columnIds must not contain duplicates' });
    }
    if (
      parsed.columnIds.length !== columns.length ||
      parsed.columnIds.some((columnId) => !columnById.has(columnId))
    ) {
      return res.status(400).json({
        error: 'columnIds must include every board column exactly once',
      });
    }

    const reorderColumns = getDb().transaction((columnIds: string[]) => {
      for (const [position, columnId] of columnIds.entries()) {
        const column = columnById.get(columnId);
        if (!column) throw new Error(`Column not found: ${columnId}`);
        stmts.updateKanbanColumn.run(column.name, position, column.color, column.id);
      }
      return stmts.getKanbanColumns.all(board.id) as KanbanColumnRow[];
    });

    const nextColumns = reorderColumns(parsed.columnIds);
    broadcast({ type: 'kanban_update', projectId: req.params.projectId });
    res.json(nextColumns);
  });

  router.delete(
    '/api/projects/:projectId/board/columns/:columnId',
    (req: Request, res: Response) => {
      const project = findProject(req.params.projectId as string);
      if (!project) return res.status(404).json({ error: 'Project not found' });
      const existing = stmts.getKanbanColumn.get(req.params.columnId) as
        | KanbanColumnRow
        | undefined;
      if (!existing) return res.status(404).json({ error: 'Column not found' });
      const { board, columns } = getOrCreateBoard(stmts, req.params.projectId as string);
      if (existing.board_id !== board.id) {
        return res.status(404).json({ error: 'Column not found' });
      }
      if (isSystemLockedColumnName(existing.name)) {
        return res.status(400).json({
          error: 'Cannot delete a system column (To Do, In Progress, or Done)',
        });
      }
      if (columns.length <= 1) {
        return res.status(400).json({ error: 'Cannot delete the last column on the board' });
      }
      const cardCount = (stmts.countKanbanCardsByColumn.get(req.params.columnId) as { n: number })
        .n;
      if (cardCount > 0) {
        return res.status(400).json({ error: 'Cannot delete a column that still contains cards' });
      }
      stmts.deleteKanbanColumn.run(req.params.columnId);
      broadcast({ type: 'kanban_update', projectId: req.params.projectId });
      res.json({ ok: true });
    },
  );

  router.get('/api/projects/:projectId/board/cards', (req: Request, res: Response) => {
    const project = findProject(req.params.projectId as string);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const { board } = getOrCreateBoard(stmts, req.params.projectId as string);
    const cards = stmts.getKanbanCards.all(board.id) as KanbanCardRow[];
    res.json(serializeCardsForRequest(req, stmts, board.id, cards));
  });

  // Resolve the session replay attributed to a card, if any. A bug ticket
  // surfaces its replay via `ticket.replay_ref`; once the ticket is converted
  // to a card the attribution moves to `session_replays.card_id`, but the card
  // row carries no ref — so the client needs this lookup to render a "Watch
  // replay" surface on a converted card. Returns the replay id (the playback
  // endpoints under /api/replays/:id handle their own per-replay authorization)
  // plus light metadata, or 404 when the card has no replay. The card is scoped
  // to the project's board so a leaked card id can't enumerate replays across
  // projects (the project-visibility gate already guards the project mount).
  router.get(
    '/api/projects/:projectId/board/cards/:cardId/replay',
    (req: Request, res: Response) => {
      const project = findProject(req.params.projectId as string);
      if (!project) return res.status(404).json({ error: 'Project not found' });
      const card = stmts.getKanbanCard.get(req.params.cardId) as KanbanCardRow | undefined;
      if (!card) return res.status(404).json({ error: 'Card not found' });
      const { board } = getOrCreateBoard(stmts, project.id);
      if (card.board_id !== board.id) {
        return res.status(404).json({ error: 'Card not found' });
      }
      const replay = stmts.getSessionReplayByCard.get(req.params.cardId) as
        | SessionReplayRow
        | undefined;
      if (!replay) return res.status(404).json({ error: 'No replay for card' });
      return res.json({
        replayId: replay.id,
        durationMs: replay.duration_ms,
        eventCount: replay.event_count,
        createdAt: replay.created_at,
      });
    },
  );

  router.post('/api/projects/:projectId/board/cards', (req: Request, res: Response) => {
    const project = findProject(req.params.projectId as string);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const parsed = parseBody(CreateCardRequestSchema, req, res);
    if (!parsed) return;
    const {
      title,
      description,
      priority,
      assignee,
      labels,
      columnId,
      sessionId: bodySessionId,
      githubIssueUrl,
      createdBy,
      epicId: bodyEpicId,
      phaseId: bodyPhaseId,
      source,
    } = parsed;
    // Merge header / spawn-creds fallbacks before dedup and intake gating so
    // both guards see the same resolved session id (not just the Zod body).
    const sessionId = resolveCardSessionId(req, bodySessionId);
    const { board } = getOrCreateBoard(stmts, req.params.projectId as string);

    // FK pre-flight: better-sqlite3 throws an opaque
    // `SqliteError: FOREIGN KEY constraint failed` if columnId is stale or
    // belongs to a different board. Validate up-front so clients get a
    // clean 404 instead of a 500.
    const targetColumn = stmts.getKanbanColumn.get(columnId) as KanbanColumnRow | undefined;
    if (!targetColumn || targetColumn.board_id !== board.id) {
      return res.status(404).json({ error: 'Column not found on this project board' });
    }

    // Deduplication: check for existing card with same title (case-insensitive) on this board
    const allBoardCards = stmts.getKanbanCards.all(board.id) as KanbanCardRow[];
    const titleLower = title.toLowerCase().trim();
    const duplicate = allBoardCards.find((c) => c.title.toLowerCase().trim() === titleLower);
    if (duplicate) {
      // Return the existing card instead of creating a duplicate. Signal the
      // dedup so callers can tell they got an existing card back rather than a
      // freshly created one (the body is a bare card and looks identical).
      res.setHeader('X-Agent-Hub-Card-Deduplicated', 'title');
      return res.json(serializeCardForRequest(req, stmts, board.id, duplicate));
    }

    // Session-id deduplication: when an agent has been spawned via
    // `POST /board/cards/:cardId/assign`, that endpoint stamps the new
    // session id on the assigned card. If the agent then follows the
    // "Bias to Action" prompt and POSTs a new card with `session_id` set
    // to its own session, we end up with two cards covering the same
    // logical task with the same session_id (see card ddfa8ba5 for the
    // 2026-05 repro). Return the originally-linked card instead of
    // creating a duplicate. Title-dedup above already runs first so
    // legitimate "rename a card" flows aren't affected.
    // sessionId above is already merged (body !== undefined ? body : header/spawn key)
    // via resolveCardSessionId() immediately after parseBody().
    if (sessionId && sessionId.trim()) {
      const linked = stmts.getKanbanCardBySession.get(sessionId) as KanbanCardRow | undefined;
      if (linked && linked.board_id === board.id) {
        // Non-silent dedup: the caller asked for a new card but this session
        // already owns one, so we hand back the existing card. The header lets
        // a caller detect it and (if they really want a second card) retry with
        // `sessionId: null`.
        res.setHeader('X-Agent-Hub-Card-Deduplicated', 'session');
        return res.json(serializeCardForRequest(req, stmts, board.id, linked));
      }
    }

    const normalizedAssignedUser = normalizeAssignedUserForCreate(
      req,
      parsed.assignedUserId,
      sessionId,
    );
    if (normalizedAssignedUser === 'invalid') {
      return res.status(400).json({ error: 'Invalid assignedUserId' });
    }
    const shouldSetAssignedUser = normalizedAssignedUser !== null;

    // Validate the epic/phase relationship BEFORE inserting, so a rejection
    // never leaves an orphan card on the board. Resolve the final (epic,
    // phase) the card will carry: a phase is authoritative for scope, so its
    // epic is derived; an explicit conflicting epicId is a contradiction.
    const hasBodyEpic = bodyEpicId != null && String(bodyEpicId).trim();
    const hasBodyPhase = bodyPhaseId != null && String(bodyPhaseId).trim();
    let resolvedEpicId: string | null = null;
    let resolvedPhaseId: string | null = null;
    if (hasBodyPhase) {
      const phase = stmts.getKanbanPhase.get(bodyPhaseId) as KanbanPhaseRow | undefined;
      // Reject missing/foreign phases explicitly rather than silently creating
      // an unscoped card (which the phase runner of another board could pick
      // up via getKanbanCardsByPhase).
      if (!phase || phase.board_id !== board.id) {
        return res.status(404).json({ error: 'Phase not found on this board' });
      }
      if (hasBodyEpic && String(bodyEpicId) !== String(phase.epic_id)) {
        return res.status(400).json({
          error: 'phaseId belongs to a different epic than the supplied epicId',
        });
      }
      resolvedPhaseId = String(bodyPhaseId);
      resolvedEpicId = String(phase.epic_id);
    } else if (hasBodyEpic) {
      const epic = stmts.getKanbanEpic.get(bodyEpicId) as KanbanEpicRow | undefined;
      // Unknown/foreign epic: ignore silently (matches prior behavior) — only
      // a valid same-board epic is linked.
      if (epic && epic.board_id === board.id) {
        resolvedEpicId = String(bodyEpicId);
        // An epic-linked card with no explicit phase must still land in a
        // phase (scoping contract) — otherwise it's orphaned from the phase
        // flowchart and never dispatched. Auto-resolve the epic's phase.
        resolvedPhaseId = resolvePhaseForEpicLink(stmts, board.id, resolvedEpicId);
      }
    }

    const existingCards = stmts.getKanbanCardsByColumn.all(columnId) as KanbanCardRow[];
    const maxPos =
      existingCards.length > 0 ? Math.max(...existingCards.map((c) => c.position)) + 1 : 0;
    const id = uuidv4();

    const effectiveSessionId: string | null = sessionId || null;
    // Normalize agent.id → agent.name; pass through human-typed names; null
    // when empty/whitespace. See `normalizeAssignee` for the full rationale.
    const effectiveAssignee: string | null = normalizeAssignee(assignee, findAgent);

    stmts.createKanbanCard.run(
      id,
      columnId,
      board.id,
      title,
      description || null,
      priority || 'medium',
      effectiveAssignee,
      labels || null,
      effectiveSessionId,
      githubIssueUrl || null,
      createdBy || null,
      null,
      maxPos,
    );

    // Stamp capture provenance (spec CAPTURE-PROVENANCE) when the caller
    // supplied an origin. Kept separate from createKanbanCard's positional
    // INSERT; the deep link is preserved in source_meta as a JSON blob.
    if (source) {
      stmts.setKanbanCardProvenance.run(
        source.sourceType,
        source.sourceId ?? null,
        serializeSourceMeta(source.sourceMeta ?? null),
        id,
      );
    }

    // Apply the pre-validated scope (validation + any 400/404 already ran
    // above, before the insert).
    if (resolvedEpicId) stmts.updateKanbanCardEpic.run(resolvedEpicId, id);
    if (resolvedPhaseId) stmts.updateKanbanCardPhase.run(resolvedPhaseId, id);
    if (resolvedEpicId) recomputeEpicState(stmts, resolvedEpicId);

    if (shouldSetAssignedUser) {
      stmts.setKanbanCardAssignedUser.run(normalizedAssignedUser, id);
    }

    broadcast({ type: 'kanban_update', projectId: req.params.projectId });
    if (effectiveSessionId) {
      maybeRenameSessionForLinkedCard(stmts, broadcast, effectiveSessionId, title);
    }
    const created = stmts.getKanbanCard.get(id) as KanbanCardRow;
    res.json(serializeCardForRequest(req, stmts, board.id, created));
  });

  router.put('/api/projects/:projectId/board/cards/:cardId', (req: Request, res: Response) => {
    const card = stmts.getKanbanCard.get(req.params.cardId) as KanbanCardRow | undefined;
    if (!card) return res.status(404).json({ error: 'Card not found' });
    const project = findProject(req.params.projectId as string);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const parsed = parseBody(UpdateCardRequestSchema, req, res);
    if (!parsed) return;

    // After Zod parsing + snake_case alias preprocess, key presence is
    // signalled by `field !== undefined`. The handler downstream uses the
    // `has*` flags to distinguish "omitted from body" (keep current value)
    // from "explicit null" (clear the column).
    const { title, priority } = parsed;
    const hasDescription = parsed.description !== undefined;
    const description = parsed.description;
    const hasAssignee = parsed.assignee !== undefined;
    const assignee = parsed.assignee;
    const hasLabels = parsed.labels !== undefined;
    const labels = parsed.labels;
    const hasSessionId = parsed.sessionId !== undefined;
    const sessionId = parsed.sessionId;
    const hasGithubIssueUrl = parsed.githubIssueUrl !== undefined;
    const githubIssueUrl = parsed.githubIssueUrl;
    const hasPrUrl = parsed.prUrl !== undefined;
    const prUrl = parsed.prUrl;
    const hasEpicId = parsed.epicId !== undefined;
    const epicId = parsed.epicId;
    const hasPhaseId = parsed.phaseId !== undefined;
    const phaseId = parsed.phaseId;
    const hasAssignModel = parsed.assignModel !== undefined;
    const assignModel = parsed.assignModel;
    const hasAssignEngine = parsed.assignEngine !== undefined;
    const assignEngine = parsed.assignEngine;

    const hasPrBaseBranch = parsed.prBaseBranch !== undefined;
    let prBaseBranch: string | null | undefined;
    if (hasPrBaseBranch) {
      const branchParsed = parsePrBaseBranchInput(parsed.prBaseBranch);
      if (!branchParsed.ok) return res.status(400).json({ error: branchParsed.error });
      prBaseBranch = branchParsed.value;
    } else {
      prBaseBranch = undefined;
    }

    // FK pre-flight: a non-null epicId must reference an existing epic on
    // the same board, otherwise the UPDATE throws an opaque
    // `SqliteError: FOREIGN KEY constraint failed`.
    if (hasEpicId && epicId != null) {
      const epic = stmts.getKanbanEpic.get(epicId) as KanbanEpicRow | undefined;
      if (!epic || epic.board_id !== card.board_id) {
        return res.status(404).json({ error: "Epic not found on this card's board" });
      }
    }

    // The epic the card will carry after this update — needed so the phase
    // block below can keep `epic_id` and `phase_id` consistent.
    let nextEpicId: string | null = hasEpicId ? (epicId ?? null) : (card.epic_id ?? null);

    // The phase the card will carry after this update. Starts from the request
    // (explicit phaseId) or the card's current phase, then gets reconciled with
    // the resolved epic below.
    let nextPhaseId: string | null = hasPhaseId ? (phaseId ?? null) : (card.phase_id ?? null);

    if (hasPhaseId && phaseId != null) {
      const phase = stmts.getKanbanPhase.get(phaseId) as KanbanPhaseRow | undefined;
      if (!phase || phase.board_id !== card.board_id) {
        return res.status(404).json({ error: "Phase not found on this card's board" });
      }
      // A phase implies its epic. If the caller also passed an explicit
      // `epicId` that disagrees, that's a contradiction — reject it. Then
      // force the card's epic to the phase's epic so the epic UI (filters by
      // `epic_id`) and phase dispatch (queries by `phase_id`) can't diverge.
      if (hasEpicId && epicId != null && String(epicId) !== String(phase.epic_id)) {
        return res.status(400).json({
          error: 'phaseId belongs to a different epic than the supplied epicId',
        });
      }
      nextEpicId = phase.epic_id;
      nextPhaseId = phase.id;
    }

    // Keep epic ↔ phase consistent. A phase belongs to exactly one epic, so a
    // carried-over phase from a different epic (e.g. the caller changed epicId
    // without a phaseId) is stale — drop it. Then enforce the scoping invariant:
    // a card linked to an epic always lives in a phase (unless the caller
    // explicitly cleared the phase in this same request).
    if (nextEpicId) {
      if (nextPhaseId) {
        const cur = stmts.getKanbanPhase.get(nextPhaseId) as KanbanPhaseRow | undefined;
        if (!cur || String(cur.epic_id) !== String(nextEpicId)) nextPhaseId = null;
      }
      const explicitlyCleared = hasPhaseId && phaseId == null;
      if (!nextPhaseId && !explicitlyCleared) {
        nextPhaseId = resolvePhaseForEpicLink(stmts, card.board_id, nextEpicId);
      }
    } else {
      // No epic → no phase (a phase belongs to an epic).
      nextPhaseId = null;
    }

    const effectiveSessionId: string | null | undefined = sessionId;
    // Normalize agent.id → agent.name on update too, but only when the
    // caller is explicitly setting `assignee`. If the key isn't present in
    // the payload we leave the value untouched (no normalization sweep).
    const effectiveAssignee: string | null | undefined = hasAssignee
      ? normalizeAssignee(assignee, findAgent)
      : assignee;

    const nextAssignee = hasAssignee ? (effectiveAssignee ?? null) : card.assignee;
    // Normalize + validate the engine override first because the model
    // validation below needs to know the *resolved* engine, not the
    // assignee agent's shared engine, so an operator can switch a card to
    // codex-cli + gpt-5.3-codex in a single PATCH without the model
    // validator rejecting "gpt-5.3-codex is not valid for claude-code".
    let nextAssignEngine: string | null | undefined;
    if (hasAssignEngine) {
      const trimmed =
        assignEngine != null && String(assignEngine).trim() ? String(assignEngine).trim() : null;
      if (trimmed) {
        const allowedEngines = Object.keys(config.engineValidModels || {});
        if (!allowedEngines.includes(trimmed)) {
          return res.status(400).json({
            error: `Invalid engine "${trimmed}". Allowed: ${allowedEngines.join(', ')}`,
          });
        }
        nextAssignEngine = trimmed;
      } else {
        nextAssignEngine = null;
      }
    }
    const resolvedEngineForValidation =
      (nextAssignEngine ?? (hasAssignEngine ? null : (card.assign_engine ?? null))) || null;
    if (hasAssignModel) {
      const normalized =
        assignModel != null && String(assignModel).trim() ? String(assignModel).trim() : null;
      if (normalized) {
        // When the card has an explicit engine override (either being set
        // now or already on the row), validate the model against THAT
        // engine — otherwise `validateKanbanAssignModel` would fall back
        // to the assignee agent's engine and reject cross-engine combos.
        if (resolvedEngineForValidation) {
          const v = validateKanbanAssignModelForEngine(
            normalized,
            resolvedEngineForValidation,
            config,
          );
          if (!v.ok) return res.status(400).json({ error: v.error });
        } else {
          const v = validateKanbanAssignModel(normalized, project, nextAssignee, config);
          if (!v.ok) return res.status(400).json({ error: v.error });
        }
      }
    }
    let normalizedAssignedUser: string | null = null;
    if (parsed.assignedUserId !== undefined) {
      const normalizedUser = normalizeAssignedUserId(
        parsed.assignedUserId,
        loadRequestAssignableUsers(req),
      );
      if (normalizedUser === 'invalid') {
        return res.status(400).json({ error: 'Invalid assignedUserId' });
      }
      normalizedAssignedUser = normalizedUser;
    }

    stmts.updateKanbanCard.run(
      title ?? card.title,
      hasDescription ? (description ?? null) : card.description,
      priority ?? card.priority,
      hasAssignee ? (effectiveAssignee ?? null) : card.assignee,
      hasLabels ? (labels ?? null) : card.labels,
      hasSessionId ? (effectiveSessionId ?? null) : card.session_id,
      hasGithubIssueUrl ? (githubIssueUrl ?? null) : card.github_issue_url,
      hasPrUrl ? (prUrl ?? null) : card.pr_url,
      nextEpicId,
      nextPhaseId,
      hasAssignModel
        ? assignModel != null && String(assignModel).trim()
          ? String(assignModel).trim()
          : null
        : card.assign_model,
      hasAssignEngine ? (nextAssignEngine ?? null) : (card.assign_engine ?? null),
      hasPrBaseBranch ? (prBaseBranch ?? null) : (card.pr_base_branch ?? null),
      req.params.cardId,
    );
    const affectedEpicIds = new Set<string>();
    if (card.epic_id) affectedEpicIds.add(card.epic_id);
    if (nextEpicId) affectedEpicIds.add(nextEpicId);
    for (const affectedEpicId of affectedEpicIds) {
      recomputeEpicState(stmts, affectedEpicId);
      disableAutonomousForEmptyEpic(deps, req.params.projectId as string, affectedEpicId);
    }
    if (parsed.assignedUserId !== undefined) {
      stmts.setKanbanCardAssignedUser.run(normalizedAssignedUser, req.params.cardId);
    }
    broadcast({ type: 'kanban_update', projectId: req.params.projectId });
    const updated = stmts.getKanbanCard.get(req.params.cardId) as KanbanCardRow;
    res.json(serializeCardForRequest(req, stmts, card.board_id, updated));
  });

  router.post(
    '/api/projects/:projectId/board/cards/:cardId/move',
    (req: Request, res: Response) => {
      const card = stmts.getKanbanCard.get(req.params.cardId) as KanbanCardRow | undefined;
      if (!card) return res.status(404).json({ error: 'Card not found' });
      const parsedMove = parseBody(MoveCardRequestSchema, req, res);
      if (!parsedMove) return;
      const { columnId, position } = parsedMove;
      // FK pre-flight: target column must exist AND belong to the card's
      // own board. Cross-board moves silently corrupt the join with
      // kanban_boards via the cascading FK; a stale columnId throws an
      // opaque 500 from better-sqlite3. Both cases get a clean 404 here.
      const targetColumn = stmts.getKanbanColumn.get(columnId) as KanbanColumnRow | undefined;
      if (!targetColumn || targetColumn.board_id !== card.board_id) {
        return res.status(404).json({ error: "Column not found on this card's board" });
      }
      // Done means merged for Finalize-gated sessions: reject the premature
      // agent-driven Done move that otherwise bounces the card back to
      // In Progress when Finalize starts seconds later (see
      // kanban-premature-done.ts). Platform Done-writers bypass this route.
      if (
        blocksPrematureDoneMove({
          stmts,
          card,
          targetColumnName: targetColumn.name,
          force: parsedMove.force,
        })
      ) {
        return res
          .status(409)
          .json({ error: PREMATURE_DONE_ERROR, message: PREMATURE_DONE_MESSAGE });
      }
      const previousColumnId = card.column_id;
      stmts.moveKanbanCard.run(columnId, position ?? 0, req.params.cardId);
      if (targetColumn.name.toLowerCase() === 'done') {
        // A completed Fix is no longer the active workflow for this issue;
        // release its cross-database claim so a later recurrence can start a
        // new tracked Fix instead of receiving a permanent 409.
        releaseIssueFixClaimsForCard(req.params.cardId as string);
      }
      recomputeEpicState(stmts, card.epic_id);
      broadcast({ type: 'kanban_update', projectId: req.params.projectId });
      const updatedCard = stmts.getKanbanCard.get(req.params.cardId) as KanbanCardRow;
      res.json(serializeCardForRequest(req, stmts, updatedCard.board_id, updatedCard));

      try {
        const col = (
          stmts.getKanbanColumn as { get?: (id: string) => KanbanColumnRow | undefined }
        )?.get?.(columnId);

        if (col && previousColumnId !== columnId) {
          let agentId: string | undefined;
          if (updatedCard.session_id) {
            const sess = stmts.getSession.get(updatedCard.session_id) as
              | { agent_id: string }
              | undefined;
            agentId = sess?.agent_id;
          }
          broadcast({
            type: 'card_moved',
            projectId: req.params.projectId,
            cardId: req.params.cardId,
            cardTitle: updatedCard.title,
            columnName: col.name,
            assignee: updatedCard.assignee,
            prUrl: updatedCard.pr_url,
            sessionId: updatedCard.session_id || undefined,
            agentId,
          });
          if (String(col.name || '') === 'Done') {
            for (const ticket of markSupportTicketsFixedPendingReleaseForCard(
              req.params.projectId as string,
              updatedCard.id,
            )) {
              broadcast({
                type: 'support_ticket_updated',
                projectId: ticket.project_id,
                unreadCount: countUnreadSupportTickets(ticket.project_id),
                ticket: serializeSupportTicketForBroadcast(ticket),
              });
            }
          }
          // Live merged trigger: when a session-linked card crosses a column
          // boundary (e.g. a PR merge or a human drag lands it in Done), the
          // session's resolved lifecycle state changes — typically to `merged`.
          // Recompute + push `session_state` so the sidebar icon flips live.
          if (updatedCard.session_id) {
            recomputeSessionState(stmts, updatedCard.session_id, { agentId, broadcast });
          }
          // A card landing in Done can complete the last session/epic a release
          // gate is waiting on — nudge an off-cadence sweep (minute sweep is the
          // backstop). No-op when deployments/release gates aren't configured.
          requestReleaseGateSweep('kanban-card-moved');
          maybeStartKanbanColumnWorkflowRuns(
            {
              stmts,
              broadcast,
              getEnrichedAgent,
              findProject,
            },
            {
              projectId: req.params.projectId as string,
              destinationColumnId: columnId,
              previousColumnId,
              destinationColumnName: String(col.name || ''),
              card: updatedCard,
            },
          );
        }
        // Note: PR review is now triggered by the GitHub webhook handler
        // (pull_request.opened/synchronize) rather than by a card moving into
        // the Review column. The Review column is a UI signal only.
      } catch (err) {
        console.error(`[Card Move] Error in post-move hooks:`, (err as Error).message);
      }
    },
  );

  router.post(
    '/api/projects/:projectId/board/cards/:cardId/assign',
    async (req: Request, res: Response) => {
      const card = stmts.getKanbanCard.get(req.params.cardId) as KanbanCardRow | undefined;
      if (!card) return res.status(404).json({ error: 'Card not found' });

      const parsedAssign = parseBody(AssignCardRequestSchema, req, res);
      if (!parsedAssign) return;
      const {
        agentId,
        model: modelBody,
        engine: engineBody,
        autoMerge: autoMergeBody,
        comment: commentBody,
      } = parsedAssign;

      const found = findAgent(agentId);
      if (!found) return res.status(404).json({ error: 'Agent not found' });
      const { agent } = found;
      const project = findProject(req.params.projectId as string);
      if (!project) return res.status(404).json({ error: 'Project not found' });

      const sessionId = crypto.randomUUID();
      const trimmedOverride =
        typeof modelBody === 'string' && modelBody.trim() ? modelBody.trim() : null;
      // Validate the optional engine override against the configured
      // engineValidModels keys before passing it to the resolver — an
      // unknown engine id has to be a 400, not a silent fallback to the
      // shared agent engine. NULL/missing = "no override".
      const trimmedEngineOverride =
        typeof engineBody === 'string' && engineBody.trim() ? engineBody.trim() : null;
      if (trimmedEngineOverride) {
        const allowedEngines = Object.keys(config.engineValidModels || {});
        if (!allowedEngines.includes(trimmedEngineOverride)) {
          return res.status(400).json({
            error: `Invalid engine "${trimmedEngineOverride}". Allowed: ${allowedEngines.join(', ')}`,
          });
        }
      }
      const assignOwnerUid = resolveOwnerUserId(req as AuthenticatedRequest);
      const { engine, model: resolvedModel } = resolveEffectiveEngineAndModel(config, {
        agentId,
        agentEngine: agent.engine || 'claude-code',
        agentModel: agent.model ?? null,
        ownerUserId: assignOwnerUid,
        explicitEngine: trimmedEngineOverride,
        explicitModel: trimmedOverride,
      });
      if (trimmedOverride) {
        // Validate the model against the engine the spawn will actually use
        // — which may be the explicit engine override, the per-user override
        // engine, or the agent's shared engine. Going through the
        // engine-keyed validator avoids the agent-name fallback in
        // `validateKanbanAssignModel`, which would otherwise widen the
        // allowlist to `cfg.allValidModels` (the global union across every
        // engine) when the resolved engine doesn't match `agent.engine` —
        // letting e.g. a claude-code model through even though the spawn
        // will use codex-cli.
        const v = validateKanbanAssignModelForEngine(trimmedOverride, engine, config);
        if (!v.ok) return res.status(400).json({ error: v.error });
      }
      // Resolve the auto-merge preference for this assignment. An explicit
      // boolean in the request body wins; otherwise fall back to whatever the
      // card already carries (e.g. carried over from a converted support
      // ticket — 1/0), and finally to the project default via
      // `resolveShouldAutoMerge`. `undefined` means "no override → use project
      // default".
      const autoMergeOverride: boolean | undefined =
        typeof autoMergeBody === 'boolean'
          ? autoMergeBody
          : card.auto_merge === 1
            ? true
            : card.auto_merge === 0
              ? false
              : undefined;

      const spikeAssign = isSpikeCard(card);
      const wt = spikeAssign ? 0 : defaultSessionUseWorktreeFlag(project);
      let linkedSpecItem = spikeAssign ? getSpecItemForSpikeCard(stmts, card.id) : null;
      if (spikeAssign && card.epic_id) {
        linkedSpecItem = ensureSpecItemForSpikeCard(stmts, card) ?? linkedSpecItem;
      }
      stmts.createSession.run(
        sessionId,
        agentId,
        card.title,
        engine,
        resolvedModel,
        wt,
        spikeAssign ? 1 : 0,
        1,
      );
      if (spikeAssign) {
        stmts.updateSessionMode.run('scoping', sessionId);
        if (card.epic_id) stmts.updateSessionLinkedEpic.run(card.epic_id, sessionId);
        if (linkedSpecItem) stmts.updateSessionLinkedSpecItem.run(linkedSpecItem.id, sessionId);
        markSessionFinalizeAutomation(stmts, sessionId, 'manual');
      } else {
        markSessionAutoShipOnComplete(stmts, sessionId);
        markSessionFinalizeAutomation(
          stmts,
          sessionId,
          assignedFinalizeAutomationLevel(
            resolveShouldAutoMerge(autoMergeOverride, project.githubWorkflow),
          ),
        );
      }
      // Reuse the owner uid resolved above; no need to walk req.user twice
      // in the same handler.
      setSessionOwner(sessionId, assignOwnerUid);

      const board = stmts.getKanbanBoard.get(req.params.projectId) as KanbanBoardRow | undefined;
      let inProgressColumnId = card.column_id;
      if (board) {
        const cols = stmts.getKanbanColumns.all(board.id) as KanbanColumnRow[];
        const inProgress = cols.find((c) => c.name.toLowerCase() === 'in progress');
        if (inProgress) inProgressColumnId = inProgress.id;
      }

      stmts.updateKanbanCard.run(
        card.title,
        card.description,
        card.priority,
        agent.name,
        card.labels,
        sessionId,
        card.github_issue_url,
        card.pr_url,
        card.epic_id,
        card.phase_id ?? null,
        trimmedOverride,
        trimmedEngineOverride,
        card.pr_base_branch ?? null,
        req.params.cardId,
      );
      stmts.moveKanbanCard.run(inProgressColumnId, 0, req.params.cardId);
      // If the card has no lead user yet, the person dispatching the work
      // becomes its lead so the now-in-progress card surfaces in their "My
      // Work" home pane. Mirrors card-create defaulting the lead to the acting
      // user (`normalizeAssignedUserForCreate`); an existing lead (e.g. an epic
      // lead already propagated) is never overridden.
      if (assignOwnerUid && !card.assigned_user_id) {
        stmts.setKanbanCardAssignedUser.run(assignOwnerUid, req.params.cardId);
      }
      recomputeEpicState(stmts, card.epic_id);

      // Persist an explicit auto-merge override on the card so it stays visible
      // in the assign UI and survives reassignment. Only an explicit boolean
      // mutates the stored value; a fallback to the card's existing preference
      // (or project default) leaves it untouched.
      if (typeof autoMergeBody === 'boolean') {
        stmts.setKanbanCardAutoMerge.run(autoMergeBody ? 1 : 0, req.params.cardId);
      }

      // Record an optional assignment note as a card comment so it's part of
      // the card's audit trail (it's also threaded into the agent's task
      // context below).
      const assignmentNote = typeof commentBody === 'string' ? commentBody.trim() : '';
      if (assignmentNote) {
        stmts.createKanbanCardComment.run(uuidv4(), req.params.cardId, agent.name, assignmentNote);
      }

      const contextLines: string[] = [];
      if (spikeAssign) {
        // The session was created in scoping mode (no worktree, manual
        // finalize) — its first message must be spike/research instructions,
        // never the implementation prompt. Mirror autonomous dispatch: use the
        // spec-linked context when one exists, else the planning-only fallback
        // (deriving the question from the card title). Emitting `# Task: …`
        // here would tell the agent to start building in a no-worktree session.
        contextLines.push(
          linkedSpecItem
            ? buildSpikeSessionContext({
                card,
                specItem: linkedSpecItem,
                projectId: req.params.projectId as string,
              })
            : buildSpikeSessionContextFallback({
                card,
                projectId: req.params.projectId as string,
              }),
        );
      } else {
        // Seed the session replay attached to this card (support tickets carry
        // one; conversion moves the attribution to `session_replays.card_id`).
        // Without this the agent inherits only the inert `/uploads/replay-*.json`
        // string that survives inside the card description, and has no way to
        // know what the customer actually did. Non-fatal by contract: a missing
        // blob or a storage outage returns null and the assignment proceeds.
        const replayContext = await loadCardReplayContext(
          { stmts, config },
          req.params.cardId as string,
        );

        contextLines.push(
          buildAssignedCardSessionContext({
            card,
            projectId: req.params.projectId as string,
            assignmentNote,
            replayContext,
          }),
        );
      }

      const contextMessage = contextLines.join('\n');

      const extraEnv: Record<string, string> = {};
      if (cardNeedsDevHubKey(card.labels)) {
        const devHubKey = await getDevHubApiKey();
        if (devHubKey) extraEnv.DEV_HUB_API_KEY = devHubKey;
      }

      handleChat(null, {
        type: 'chat',
        agentId,
        sessionId,
        content: contextMessage,
        hookSpecificOutput: { sessionTitle: card.title },
        ...(Object.keys(extraEnv).length > 0 ? { extraEnv } : {}),
      }).catch((err: Error) => {
        console.error(`[Board Assign] handleChat failed for session ${sessionId}:`, err.message);
        broadcast({
          type: 'error',
          agentId,
          sessionId,
          message: `Failed to start agent session: ${err.message}`,
        });
      });

      broadcast({ type: 'kanban_update', projectId: req.params.projectId });
      broadcast({
        type: 'session_created',
        agentId,
        session: enrichSessionForClient(stmts.getSession.get(sessionId) as SessionRow, stmts),
      });

      res.json({
        sessionId,
        card: serializeCardForRequest(
          req,
          stmts,
          card.board_id,
          stmts.getKanbanCard.get(req.params.cardId) as KanbanCardRow,
        ),
      });
    },
  );

  // Clear assignee and any linked session from a card. Mirrors the POST
  // /assign endpoint so the UI has a symmetric action for unassigning.
  router.post(
    '/api/projects/:projectId/board/cards/:cardId/unassign',
    (req: Request, res: Response) => {
      const card = stmts.getKanbanCard.get(req.params.cardId) as KanbanCardRow | undefined;
      if (!card) return res.status(404).json({ error: 'Card not found' });

      stmts.updateKanbanCard.run(
        card.title,
        card.description,
        card.priority,
        null,
        card.labels,
        null,
        card.github_issue_url,
        card.pr_url,
        card.epic_id,
        card.phase_id ?? null,
        null,
        null,
        card.pr_base_branch ?? null,
        req.params.cardId,
      );

      broadcast({ type: 'kanban_update', projectId: req.params.projectId });
      const updated = stmts.getKanbanCard.get(req.params.cardId) as KanbanCardRow;
      res.json(serializeCardForRequest(req, stmts, card.board_id, updated));
    },
  );

  router.delete('/api/projects/:projectId/board/cards/:cardId', (req: Request, res: Response) => {
    const cardId = req.params.cardId as string;
    const card = stmts.getKanbanCard.get(cardId) as KanbanCardRow | undefined;

    lastDispatchedReviewId.delete(cardId);
    releaseIssueFixClaimsForCard(cardId);

    stmts.deleteKanbanCard.run(cardId);
    recomputeEpicState(stmts, card?.epic_id);
    disableAutonomousForEmptyEpic(deps, req.params.projectId as string, card?.epic_id);
    broadcast({ type: 'kanban_update', projectId: req.params.projectId });
    res.json({ ok: true });
  });

  router.get('/api/projects/:projectId/board/undocumented', (req: Request, res: Response) => {
    const project = findProject(req.params.projectId as string);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const board = stmts.getKanbanBoard.get(req.params.projectId) as KanbanBoardRow | undefined;
    if (!board) return res.json(null);
    const card = stmts.getNextUndocumentedCard.get(board.id);
    res.json(card || null);
  });

  router.post(
    '/api/projects/:projectId/board/cards/:cardId/documented',
    (req: Request, res: Response) => {
      stmts.markCardDocumented.run(req.params.cardId);
      res.json({ ok: true });
    },
  );

  router.get(
    '/api/projects/:projectId/board/cards/:cardId/comments',
    (req: Request, res: Response) => {
      res.json(stmts.getKanbanCardComments.all(req.params.cardId));
    },
  );

  router.post(
    '/api/projects/:projectId/board/cards/:cardId/comments',
    (req: Request, res: Response) => {
      const parsedComment = parseBody(CreateCommentRequestSchema, req, res);
      if (!parsedComment) return;
      const { author, content } = parsedComment;
      // FK pre-flight: comments are FK-bound to kanban_cards.id. A stale
      // cardId would otherwise surface as a 500 SqliteError.
      const card = stmts.getKanbanCard.get(req.params.cardId) as KanbanCardRow | undefined;
      if (!card) return res.status(404).json({ error: 'Card not found' });
      const id = uuidv4();
      stmts.createKanbanCardComment.run(id, req.params.cardId, author, content);
      broadcast({ type: 'kanban_update', projectId: req.params.projectId });
      res.json(stmts.getKanbanCardComments.all(req.params.cardId));
    },
  );

  router.delete(
    '/api/projects/:projectId/board/cards/:cardId/comments/:commentId',
    (req: Request, res: Response) => {
      stmts.deleteKanbanCardComment.run(req.params.commentId);
      res.json({ ok: true });
    },
  );

  // ─── Card blockers ────────────────────────────────────────────────────
  //
  // Soft enforcement: the move endpoint does NOT gate on blocker state.
  // Clients show a confirm dialog; the autonomous dispatcher silently
  // skips blocked cards. See wiki (Kanban Blockers) for the product call.
  router.post(
    '/api/projects/:projectId/board/cards/:cardId/blockers',
    (req: Request, res: Response) => {
      const project = findProject(req.params.projectId as string);
      if (!project) return res.status(404).json({ error: 'Project not found' });

      const parsedBlocker = parseBody(AddBlockerRequestSchema, req, res);
      if (!parsedBlocker) return;
      const { blockedByCardId } = parsedBlocker;
      const cardId = req.params.cardId as string;
      if (blockedByCardId === cardId) {
        return res.status(400).json({ error: 'A card cannot block itself' });
      }

      // Both cards must exist and belong to this project's board. That second
      // check keeps blocker edges scoped to one board — cross-project links
      // would silently break the GET /board enrichment.
      const card = stmts.getKanbanCard.get(cardId) as KanbanCardRow | undefined;
      const other = stmts.getKanbanCard.get(blockedByCardId) as KanbanCardRow | undefined;
      if (!card || !other) return res.status(404).json({ error: 'Card not found' });
      const board = stmts.getKanbanBoard.get(req.params.projectId) as KanbanBoardRow | undefined;
      if (!board || card.board_id !== board.id || other.board_id !== board.id) {
        return res.status(404).json({ error: 'Card not found on this project board' });
      }

      // Duplicate check first — cheap and avoids walking the graph for a
      // link that's already there.
      const existing = stmts.getBlocker.get(cardId, blockedByCardId) as
        | KanbanCardBlockerRow
        | undefined;
      if (existing) return res.status(409).json({ error: 'duplicate' });

      // Cycle check: would adding (cardId → blockedByCardId) create a loop?
      // findCycle returns the path so the client can name the conflict.
      const cyclePath = findCycle(stmts, cardId, blockedByCardId);
      if (cyclePath) return res.status(409).json({ error: 'cycle', path: cyclePath });

      const id = uuidv4();
      stmts.createBlocker.run(id, cardId, blockedByCardId);
      broadcast({ type: 'kanban_update', projectId: req.params.projectId });
      res.status(201).json({
        id,
        card_id: cardId,
        blocked_by_card_id: blockedByCardId,
      });
    },
  );

  router.delete(
    '/api/projects/:projectId/board/cards/:cardId/blockers/:blockedByCardId',
    (req: Request, res: Response) => {
      const cardId = req.params.cardId as string;
      const blockedByCardId = req.params.blockedByCardId as string;
      const existing = stmts.getBlocker.get(cardId, blockedByCardId) as
        | KanbanCardBlockerRow
        | undefined;
      if (!existing) return res.status(404).json({ error: 'Blocker link not found' });
      stmts.deleteBlocker.run(cardId, blockedByCardId);
      broadcast({ type: 'kanban_update', projectId: req.params.projectId });
      res.status(204).end();
    },
  );

  router.get('/api/projects/:projectId/board/epics', (req: Request, res: Response) => {
    const data = getOrCreateBoard(stmts, req.params.projectId as string);
    res.json(epicsWithComputedState(data.epics, data.cards, data.columns));
  });

  // Pull requests related to an epic's feature branch: PRs that merge INTO it
  // (relation `targets`) or ship it onward (relation `integration`). Native PRs
  // only — GitHub-repo projects return an empty list with source: 'github'.
  router.get(
    '/api/projects/:projectId/board/epics/:epicId/pulls',
    (req: Request, res: Response) => {
      const project = findProject(req.params.projectId as string);
      if (!project) return res.status(404).json({ error: 'Project not found' });
      const board = stmts.getKanbanBoard.get(req.params.projectId) as { id: string } | undefined;
      const epic = stmts.getKanbanEpic.get(req.params.epicId) as KanbanEpicRow | undefined;
      if (!epic || !board || epic.board_id !== board.id) {
        return res.status(404).json({ error: 'Epic not found' });
      }

      // Normalize once at the boundary so blank-after-trim agrees with the
      // matcher semantics (blank = no branch) instead of running a misleading
      // whitespace branch query. `null` is echoed for a blank/absent branch.
      const trimmed = (epic.pr_base_branch ?? '').trim();
      const featureBranch = trimmed || null;
      if (!featureBranch || !isAgentHubHosted(project) || !nativePr) {
        return res.json({
          epicId: epic.id,
          featureBranch,
          source: isAgentHubHosted(project) ? 'agenthub' : 'github',
          pulls: [],
        });
      }

      // Filter by branch in storage (unbounded) rather than paging the full PR
      // list and filtering in memory — otherwise related PRs beyond the page
      // limit would silently vanish from the epic. Expected non-native / no-branch
      // cases are handled above; any error here is unexpected, so let it propagate
      // to the error handler (5xx) rather than masking it as "no related PRs".
      const rows = nativePr.listPullsForBranch({ project, branch: featureBranch });
      const pulls = prsForEpicFeatureBranch(
        rows as Array<{ head?: string | null; base?: string | null } & Record<string, unknown>>,
        featureBranch,
      ).map((p) => ({
        number: p.number,
        title: p.title,
        state: p.state,
        merged: p.merged ?? false,
        draft: p.draft ?? false,
        html_url: p.html_url,
        head: p.head,
        base: p.base,
        created_at: p.created_at,
        updated_at: p.updated_at,
        merged_at: p.merged_at ?? null,
        closed_at: p.closed_at ?? null,
        relation: p.epic_relation,
      }));
      res.json({ epicId: epic.id, featureBranch, source: 'agenthub', pulls });
    },
  );

  router.post('/api/projects/:projectId/board/epics', (req: Request, res: Response) => {
    const { board } = getOrCreateBoard(stmts, req.params.projectId as string);
    const parsedEpic = parseBody(CreateEpicRequestSchema, req, res);
    if (!parsedEpic) return;
    const { name, description, color, labels, assignedUserId } = parsedEpic;
    const hasEpicPrBase = parsedEpic.prBaseBranch !== undefined;
    if (hasEpicPrBase) {
      const parsedBranch = parsePrBaseBranchInput(parsedEpic.prBaseBranch);
      if (!parsedBranch.ok) return res.status(400).json({ error: parsedBranch.error });
    }
    const normalizedAssignedUser = normalizeAssignedUserForCreate(req, assignedUserId);
    if (normalizedAssignedUser === 'invalid') {
      return res.status(400).json({ error: 'Invalid assignedUserId' });
    }
    const shouldSetAssignedUser = normalizedAssignedUser !== null;
    const epics = stmts.getKanbanEpics.all(board.id) as KanbanEpicRow[];
    const maxPos = epics.length > 0 ? Math.max(...epics.map((e) => e.position)) + 1 : 0;
    const id = uuidv4();
    stmts.createKanbanEpic.run(
      id,
      board.id,
      name,
      description || null,
      color || '#6366F1',
      maxPos,
      labels ?? null,
    );
    if (hasEpicPrBase) {
      const p = parsePrBaseBranchInput(parsedEpic.prBaseBranch);
      if (p.ok) {
        const row = stmts.getKanbanEpic.get(id) as KanbanEpicRow;
        stmts.updateKanbanEpic.run(
          row.name,
          row.description,
          row.color,
          row.autonomous,
          row.autonomous_interval,
          row.autonomous_max_concurrent,
          row.autonomous_model ?? null,
          row.orchestration_budgets_json ?? null,
          p.value,
          row.labels ?? null,
          id,
        );
      }
    }
    if (shouldSetAssignedUser) {
      stmts.setKanbanEpicAssignedUser.run(normalizedAssignedUser, id);
    }
    const createdEpicFinal = stmts.getKanbanEpic.get(id) as KanbanEpicRow;
    broadcast({ type: 'kanban_update', projectId: req.params.projectId });
    res.json(createdEpicFinal);
  });

  router.put('/api/projects/:projectId/board/epics/:epicId', (req: Request, res: Response) => {
    const epic = stmts.getKanbanEpic.get(req.params.epicId) as KanbanEpicRow | undefined;
    if (!epic) return res.status(404).json({ error: 'Epic not found' });
    const parsedEpic = parseBody(UpdateEpicRequestSchema, req, res);
    if (!parsedEpic) return;
    const {
      name,
      description,
      color,
      autonomous,
      autonomousInterval,
      autonomousMaxConcurrent,
      autonomousModel,
      autonomousSendIt,
      orchestrationBudgets,
      labels,
      assignedUserId,
    } = parsedEpic;

    const hasEpicPrBasePut = parsedEpic.prBaseBranch !== undefined;
    const hasLabels = labels !== undefined;
    let nextEpicPrBaseField: string | null | undefined;
    if (hasEpicPrBasePut) {
      const parsedBranch = parsePrBaseBranchInput(parsedEpic.prBaseBranch);
      if (!parsedBranch.ok) return res.status(400).json({ error: parsedBranch.error });
      nextEpicPrBaseField = parsedBranch.value;
    }
    let normalizedAssignedUser: string | null = null;
    if (assignedUserId !== undefined) {
      const normalizedUser = normalizeAssignedUserId(
        assignedUserId,
        loadRequestAssignableUsers(req),
      );
      if (normalizedUser === 'invalid') {
        return res.status(400).json({ error: 'Invalid assignedUserId' });
      }
      normalizedAssignedUser = normalizedUser;
    }

    const nextAutonomousModel =
      autonomousModel !== undefined
        ? autonomousModel && String(autonomousModel).trim()
          ? String(autonomousModel).trim()
          : null
        : epic.autonomous_model;

    let nextOrchestrationJson: string | null =
      (epic as { orchestration_budgets_json?: string | null }).orchestration_budgets_json ?? null;
    if (orchestrationBudgets !== undefined) {
      if (orchestrationBudgets === null) {
        nextOrchestrationJson = null;
      } else if (typeof orchestrationBudgets === 'object' && orchestrationBudgets !== null) {
        const sanitized = sanitizeOrchestrationBudgetsPartial(orchestrationBudgets);
        nextOrchestrationJson = sanitized ? JSON.stringify(sanitized) : null;
      }
    }

    // NOTE: enabling autonomous on this epic no longer disables any other epic
    // on the board. A board may run multiple epics autonomously at once; each is
    // dispatched independently by the autonomous loop (see `runAutonomousLoop`).

    // Stamp the user who flipped autonomous on, so
    // `resolveAutonomousOwnerUserId` can fall back to them when an
    // autonomous-dispatched card lacks card-level owner signals.
    // Only fires on a 0 → 1 transition; a no-op rewrite (autonomous=1
    // → 1) keeps the original enabler so we don't churn the column
    // every time the UI saves the epic for an unrelated field change.
    const turningAutonomousOn = !!(autonomous && !epic.autonomous);
    if (turningAutonomousOn) {
      const enablerId = resolveOwnerUserId(req as AuthenticatedRequest);
      if (enablerId) {
        stmts.setEpicAutonomousEnabledBy.run(enablerId, req.params.epicId);
      }
    }

    stmts.updateKanbanEpic.run(
      name ?? epic.name,
      description ?? epic.description,
      color ?? epic.color,
      autonomous ?? epic.autonomous,
      autonomousInterval ?? epic.autonomous_interval,
      autonomousMaxConcurrent ?? epic.autonomous_max_concurrent,
      nextAutonomousModel,
      nextOrchestrationJson,
      hasEpicPrBasePut ? (nextEpicPrBaseField ?? null) : (epic.pr_base_branch ?? null),
      hasLabels ? (labels ?? null) : (epic.labels ?? null),
      req.params.epicId,
    );

    // "Auto Merge" override is persisted via a standalone setter so the main
    // updateKanbanEpic call sites stay untouched. Only write when the payload
    // explicitly carried the field; omitting it preserves the stored value.
    if (autonomousSendIt !== undefined) {
      stmts.setEpicAutonomousSendIt.run(autonomousSendIt ? 1 : 0, req.params.epicId);
    }

    if (assignedUserId !== undefined) {
      stmts.setKanbanEpicAssignedUser.run(normalizedAssignedUser, req.params.epicId);
    }

    const updatedEpic = stmts.getKanbanEpic.get(req.params.epicId) as KanbanEpicRow;
    scheduleAutonomousEpic(req.params.projectId as string, updatedEpic);

    broadcast({ type: 'kanban_update', projectId: req.params.projectId });
    res.json(updatedEpic);
  });

  router.post(
    '/api/projects/:projectId/board/epics/:epicId/assign-lead-to-cards',
    (req: Request, res: Response) => {
      const { board } = getOrCreateBoard(stmts, req.params.projectId as string);
      const epic = stmts.getKanbanEpic.get(req.params.epicId) as KanbanEpicRow | undefined;
      if (!epic || epic.board_id !== board.id) {
        return res.status(404).json({ error: 'Epic not found' });
      }

      const leadUserId = epic.assigned_user_id;
      if (!leadUserId) {
        return res.status(400).json({ error: 'Epic has no lead user assigned' });
      }

      const authedReq = req as AuthenticatedRequest;
      const callerId = resolveOwnerUserId(authedReq);
      const isSelf = !!callerId && callerId === leadUserId;
      const isLocalBypass = !!authedReq.authLocalOrgBypass;
      if (!isSelf && !isLocalBypass) {
        return res
          .status(403)
          .json({ error: 'Only the epic lead user can assign themselves to cards' });
      }

      const result = stmts.setKanbanCardsAssignedUserByEpic.run(leadUserId, req.params.epicId);
      broadcast({ type: 'kanban_update', projectId: req.params.projectId });
      res.json({ updatedCount: result.changes });
    },
  );

  router.get('/api/projects/:projectId/board/card-templates', (req: Request, res: Response) => {
    const { board } = getOrCreateBoard(stmts, req.params.projectId as string);
    const rows = stmts.getKanbanCardTemplates.all(board.id) as KanbanCardTemplateRow[];
    res.json(rows.map(templateRowToClient));
  });

  router.post('/api/projects/:projectId/board/card-templates', (req: Request, res: Response) => {
    const { board } = getOrCreateBoard(stmts, req.params.projectId as string);
    const parsed = parseBody(CreateCardTemplateRequestSchema, req, res);
    if (!parsed) return;
    const name = parsed.name.trim();
    if (!name) return res.status(400).json({ error: 'Template name is required' });
    const epicId = resolveTemplateEpicId(stmts, board.id, parsed.epicId);
    if (epicId === 'invalid') return res.status(400).json({ error: 'Invalid epicId' });
    const id = uuidv4();
    const priority = normalizeTemplatePriority(parsed.priority);
    stmts.createKanbanCardTemplate.run(
      id,
      board.id,
      name,
      parsed.title?.trim() || '',
      parsed.description ?? null,
      priority,
      parsed.labels ?? null,
      epicId,
      0,
    );
    const row = stmts.getKanbanCardTemplate.get(id) as KanbanCardTemplateRow;
    broadcast({ type: 'kanban_update', projectId: req.params.projectId });
    res.json(templateRowToClient(row));
  });

  router.put(
    '/api/projects/:projectId/board/card-templates/:templateId',
    (req: Request, res: Response) => {
      const { board } = getOrCreateBoard(stmts, req.params.projectId as string);
      const existing = stmts.getKanbanCardTemplate.get(req.params.templateId) as
        | KanbanCardTemplateRow
        | undefined;
      if (!existing || existing.board_id !== board.id) {
        return res.status(404).json({ error: 'Template not found' });
      }
      const parsed = parseBody(UpdateCardTemplateRequestSchema, req, res);
      if (!parsed) return;
      let nextName = existing.name;
      if (parsed.name !== undefined) {
        nextName = parsed.name.trim();
        if (!nextName) return res.status(400).json({ error: 'Template name is required' });
      }
      let nextEpicId = existing.epic_id;
      if (parsed.epicId !== undefined) {
        const resolved = resolveTemplateEpicId(stmts, board.id, parsed.epicId);
        if (resolved === 'invalid') return res.status(400).json({ error: 'Invalid epicId' });
        nextEpicId = resolved;
      }
      const priority = normalizeTemplatePriority(parsed.priority ?? existing.priority);
      stmts.updateKanbanCardTemplate.run(
        nextName,
        parsed.title !== undefined ? parsed.title.trim() : existing.title,
        parsed.description !== undefined ? parsed.description : existing.description,
        priority,
        parsed.labels !== undefined ? parsed.labels : existing.labels,
        nextEpicId,
        existing.id,
      );
      const row = stmts.getKanbanCardTemplate.get(existing.id) as KanbanCardTemplateRow;
      broadcast({ type: 'kanban_update', projectId: req.params.projectId });
      res.json(templateRowToClient(row));
    },
  );

  router.delete(
    '/api/projects/:projectId/board/card-templates/:templateId',
    (req: Request, res: Response) => {
      const { board } = getOrCreateBoard(stmts, req.params.projectId as string);
      const existing = stmts.getKanbanCardTemplate.get(req.params.templateId) as
        | KanbanCardTemplateRow
        | undefined;
      if (!existing || existing.board_id !== board.id) {
        return res.status(404).json({ error: 'Template not found' });
      }
      stmts.deleteKanbanCardTemplate.run(existing.id);
      broadcast({ type: 'kanban_update', projectId: req.params.projectId });
      res.json({ ok: true });
    },
  );

  router.delete('/api/projects/:projectId/board/epics/:epicId', (req: Request, res: Response) => {
    const { board } = getOrCreateBoard(stmts, req.params.projectId as string);
    const epic = stmts.getKanbanEpic.get(req.params.epicId) as KanbanEpicRow | undefined;
    if (!epic || epic.board_id !== board.id) {
      return res.status(404).json({ error: 'Epic not found' });
    }
    const epicCards = stmts.getKanbanCardsByEpic.all(req.params.epicId) as KanbanCardRow[];
    for (const card of epicCards) {
      stmts.updateKanbanCardEpic.run(null, card.id);
      stmts.updateKanbanCardPhase.run(null, card.id);
    }
    stmts.clearKanbanCardTemplateEpic.run(board.id, req.params.epicId);
    stmts.deleteKanbanEpic.run(req.params.epicId);
    // Drop any scheduled-start timer for the now-deleted epic.
    unregisterEpicStartSchedule(req.params.projectId as string, req.params.epicId as string);
    broadcast({ type: 'kanban_update', projectId: req.params.projectId });
    res.json({ ok: true });
  });

  // Epic-level start — sweep the epic's phases left-to-right and kick off the
  // leftmost phase with outstanding work, honoring each phase's auto-dispatch
  // arming (the sweep halts at the first disabled phase). Individual per-phase
  // Run buttons remain; this is the "start the whole epic" shortcut.
  router.post(
    '/api/projects/:projectId/board/epics/:epicId/run',
    async (req: Request, res: Response) => {
      // Resolve project/board/epic up front so a missing resource returns 404
      // (matching the start-schedule routes) — 400 is reserved for validation /
      // auth-style start failures thrown by startAutonomousEpicChain below.
      const project = findProject(req.params.projectId as string);
      if (!project) return res.status(404).json({ error: 'Project not found' });
      const { board } = getOrCreateBoard(stmts, req.params.projectId as string);
      const epic = stmts.getKanbanEpic.get(req.params.epicId) as KanbanEpicRow | undefined;
      if (!epic || epic.board_id !== board.id) {
        return res.status(404).json({ error: 'Epic not found' });
      }
      try {
        const enablerId = resolveOwnerUserId(req as AuthenticatedRequest);
        const result = await startAutonomousEpicChain(
          req.params.projectId as string,
          req.params.epicId as string,
          enablerId,
        );
        broadcast({ type: 'kanban_update', projectId: req.params.projectId });
        res.json(result);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        res.status(400).json({ error: msg });
      }
    },
  );

  // Set (or update) the epic's scheduled start. A node-cron expression +
  // optional IANA timezone; on fire the epic's phases start left-to-right under
  // the enabling operator's identity. `enabled: false` retains the config but
  // stops the timer (a pause). Mirrors the deploy scheduler / crons pattern.
  router.put(
    '/api/projects/:projectId/board/epics/:epicId/start-schedule',
    (req: Request, res: Response) => {
      const { board } = getOrCreateBoard(stmts, req.params.projectId as string);
      const epic = stmts.getKanbanEpic.get(req.params.epicId) as KanbanEpicRow | undefined;
      if (!epic || epic.board_id !== board.id) {
        return res.status(404).json({ error: 'Epic not found' });
      }
      const parsed = parseBody(SetEpicStartScheduleRequestSchema, req, res);
      if (!parsed) return;

      const cronExpr = parsed.cron.trim();
      if (!nodeCron.validate(cronExpr)) {
        return res.status(400).json({ error: 'cron must be a valid cron expression' });
      }
      let timezone: string | null = null;
      if (parsed.timezone != null && String(parsed.timezone).trim()) {
        timezone = String(parsed.timezone).trim();
        try {
          new Intl.DateTimeFormat('en-US', { timeZone: timezone });
        } catch {
          return res.status(400).json({ error: 'timezone must be a valid IANA timezone' });
        }
      }
      const enabled = parsed.enabled === false ? 0 : 1;
      // A scheduled run resolves spawn credentials from the enabler — require a
      // real owner when arming (same rule as the epic-run / phase-run paths).
      const ownerId = enabled ? resolveOwnerUserId(req as AuthenticatedRequest) : null;
      if (enabled && !ownerId) {
        return res.status(400).json({
          error:
            'Authentication required to schedule an epic start — no resolvable owner for credential resolution (schedule while logged in)',
        });
      }
      // Preserve the prior owner on a disable so re-enabling keeps context.
      const enabledBy = enabled ? ownerId : (epic.scheduled_start_enabled_by ?? null);

      stmts.setKanbanEpicStartSchedule.run(
        cronExpr,
        timezone,
        enabled,
        enabledBy,
        req.params.epicId,
      );
      refreshEpicStartScheduleRegistration(
        req.params.projectId as string,
        req.params.epicId as string,
      );
      broadcast({ type: 'kanban_update', projectId: req.params.projectId });
      res.json(stmts.getKanbanEpic.get(req.params.epicId));
    },
  );

  // Clear the epic's scheduled start entirely (config + timer).
  router.delete(
    '/api/projects/:projectId/board/epics/:epicId/start-schedule',
    (req: Request, res: Response) => {
      const { board } = getOrCreateBoard(stmts, req.params.projectId as string);
      const epic = stmts.getKanbanEpic.get(req.params.epicId) as KanbanEpicRow | undefined;
      if (!epic || epic.board_id !== board.id) {
        return res.status(404).json({ error: 'Epic not found' });
      }
      stmts.setKanbanEpicStartSchedule.run(null, null, 0, null, req.params.epicId);
      unregisterEpicStartSchedule(req.params.projectId as string, req.params.epicId as string);
      broadcast({ type: 'kanban_update', projectId: req.params.projectId });
      res.json(stmts.getKanbanEpic.get(req.params.epicId));
    },
  );

  router.get('/api/projects/:projectId/board/phases', (req: Request, res: Response) => {
    const { board } = getOrCreateBoard(stmts, req.params.projectId as string);
    res.json(stmts.getKanbanPhases.all(board.id));
  });

  router.post('/api/projects/:projectId/board/phases', (req: Request, res: Response) => {
    const { board } = getOrCreateBoard(stmts, req.params.projectId as string);
    const parsed = parseBody(CreatePhaseRequestSchema, req, res);
    if (!parsed) return;
    const { epicId, name, description, autonomousModel, agentId } = parsed;
    const epic = stmts.getKanbanEpic.get(epicId) as KanbanEpicRow | undefined;
    if (!epic || epic.board_id !== board.id) {
      return res.status(404).json({ error: 'Epic not found' });
    }
    let defaultAgentModel: string | null = null;
    if (agentId) {
      const found = findAgent(agentId);
      if (!found || found.project.id !== req.params.projectId) {
        return res.status(400).json({ error: 'agentId does not belong to this project' });
      }
      defaultAgentModel = defaultPhaseAutonomousModelForAgent(
        config,
        found,
        resolveOwnerUserId(req as AuthenticatedRequest),
      );
    }
    const existing = stmts.getKanbanPhasesByEpic.all(epicId) as KanbanPhaseRow[];
    const maxPos = existing.length > 0 ? Math.max(...existing.map((p) => p.position)) + 1 : 0;
    const id = uuidv4();
    stmts.createKanbanPhase.run(id, epicId, board.id, name, description || null, maxPos);
    const defaultPhaseModel = defaultAgentModel;
    const nextAutonomousModel =
      autonomousModel !== undefined
        ? autonomousModel && String(autonomousModel).trim()
          ? String(autonomousModel).trim()
          : null
        : defaultPhaseModel;
    if (autonomousModel !== undefined || nextAutonomousModel) {
      const created = stmts.getKanbanPhase.get(id) as KanbanPhaseRow;
      stmts.updateKanbanPhase.run(
        created.name,
        created.description,
        created.autonomous,
        created.autonomous_interval,
        created.autonomous_max_concurrent,
        nextAutonomousModel,
        created.autonomous_send_it ?? 1,
        id,
      );
    }
    broadcast({ type: 'kanban_update', projectId: req.params.projectId });
    res.json(stmts.getKanbanPhase.get(id));
  });

  router.put('/api/projects/:projectId/board/phases/:phaseId', (req: Request, res: Response) => {
    const phase = stmts.getKanbanPhase.get(req.params.phaseId) as KanbanPhaseRow | undefined;
    if (!phase) return res.status(404).json({ error: 'Phase not found' });
    // Phase IDs are global; scope the lookup to the URL's project so a caller
    // can't update (or `scheduleAutonomousPhase` under) a foreign project's
    // phase through any project URL.
    const { board: phaseBoard } = getOrCreateBoard(stmts, req.params.projectId as string);
    if (phase.board_id !== phaseBoard.id) {
      return res.status(404).json({ error: 'Phase not found' });
    }
    const parsed = parseBody(UpdatePhaseRequestSchema, req, res);
    if (!parsed) return;
    const {
      name,
      description,
      autonomous,
      autonomousInterval,
      autonomousMaxConcurrent,
      autonomousModel,
      autonomousSendIt,
    } = parsed;

    const nextAutonomousModel =
      autonomousModel !== undefined
        ? autonomousModel && String(autonomousModel).trim()
          ? String(autonomousModel).trim()
          : null
        : phase.autonomous_model;

    const turningAutonomousOn = !!(autonomous && !phase.autonomous);
    if (turningAutonomousOn) {
      const enablerId = resolveOwnerUserId(req as AuthenticatedRequest);
      if (enablerId) {
        stmts.setPhaseAutonomousEnabledBy.run(enablerId, req.params.phaseId);
      }
    }

    stmts.updateKanbanPhase.run(
      name ?? phase.name,
      description ?? phase.description,
      autonomous ?? phase.autonomous,
      autonomousInterval ?? phase.autonomous_interval,
      autonomousMaxConcurrent ?? phase.autonomous_max_concurrent,
      nextAutonomousModel,
      // `?? `, not `||`: a deliberate opt-out (autonomousSendIt === 0) must be
      // written, not treated as "unset" and reverted to the stored value.
      autonomousSendIt ?? phase.autonomous_send_it ?? 0,
      req.params.phaseId,
    );

    const turningAutonomousOff = autonomous !== undefined && !autonomous;
    if (turningAutonomousOff) {
      stmts.setPhaseAutonomousRunning.run(0, req.params.phaseId);
    }

    const updatedPhase = stmts.getKanbanPhase.get(req.params.phaseId) as KanbanPhaseRow;
    // Saving phase settings does not start dispatch — only POST .../run does.
    // If the phase is already running, reschedule so interval/concurrency changes apply.
    scheduleAutonomousPhase(req.params.projectId as string, updatedPhase);
    broadcast({ type: 'kanban_update', projectId: req.params.projectId });
    res.json(updatedPhase);
  });

  router.post(
    '/api/projects/:projectId/board/phases/:phaseId/run',
    async (req: Request, res: Response) => {
      try {
        const enablerId = resolveOwnerUserId(req as AuthenticatedRequest);
        await startAutonomousPhase(
          req.params.projectId as string,
          req.params.phaseId as string,
          enablerId,
        );
        const phase = stmts.getKanbanPhase.get(req.params.phaseId) as KanbanPhaseRow;
        broadcast({ type: 'kanban_update', projectId: req.params.projectId });
        res.json(phase);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        res.status(400).json({ error: msg });
      }
    },
  );

  router.post(
    '/api/projects/:projectId/board/phases/:phaseId/stop',
    (req: Request, res: Response) => {
      try {
        const phase = stopAutonomousPhase(
          req.params.projectId as string,
          req.params.phaseId as string,
        );
        res.json(phase);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        res.status(400).json({ error: msg });
      }
    },
  );

  router.delete('/api/projects/:projectId/board/phases/:phaseId', (req: Request, res: Response) => {
    const phase = stmts.getKanbanPhase.get(req.params.phaseId) as KanbanPhaseRow | undefined;
    if (!phase) return res.status(404).json({ error: 'Phase not found' });
    // Same project-scope guard as the PUT: never mutate a foreign project's
    // phase through this project's URL.
    const { board: phaseBoard } = getOrCreateBoard(stmts, req.params.projectId as string);
    if (phase.board_id !== phaseBoard.id) {
      return res.status(404).json({ error: 'Phase not found' });
    }
    const phaseCards = stmts.getKanbanCardsByPhase.all(req.params.phaseId) as KanbanCardRow[];
    for (const card of phaseCards) {
      stmts.updateKanbanCardPhase.run(null, card.id);
    }
    stmts.deleteKanbanPhase.run(req.params.phaseId);
    broadcast({ type: 'kanban_update', projectId: req.params.projectId });
    res.json({ ok: true });
  });

  router.post('/api/projects/:projectId/board/phases/reorder', (req: Request, res: Response) => {
    const project = findProject(req.params.projectId as string);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const parsed = parseBody(ReorderPhasesRequestSchema, req, res);
    if (!parsed) return;
    const { board } = getOrCreateBoard(stmts, req.params.projectId as string);
    const epic = stmts.getKanbanEpic.get(parsed.epicId) as KanbanEpicRow | undefined;
    if (!epic || epic.board_id !== board.id) {
      return res.status(404).json({ error: 'Epic not found' });
    }

    const phases = stmts.getKanbanPhasesByEpic.all(parsed.epicId) as KanbanPhaseRow[];
    const explicit = parsed.phaseIds != null;
    const auto = parsed.sortByDependencies === true;
    // Exactly one ordering source: an explicit permutation, or server-side
    // topological sort. Both (or neither) is ambiguous.
    if (explicit === auto) {
      return res.status(400).json({
        error: 'Provide exactly one of phaseIds (explicit order) or sortByDependencies (auto)',
      });
    }

    let orderedIds: string[];
    if (auto) {
      // Derive the dependency order from the epic's card blocker graph. Cards
      // outside these phases and intra-phase edges are ignored by the sorter.
      const epicCards = stmts.getKanbanCardsByEpic.all(parsed.epicId) as KanbanCardRow[];
      const cardIds = new Set(epicCards.map((c) => c.id));
      const blockerRows = stmts.getBlockersForBoard.all(board.id) as Array<{
        card_id: string;
        blocked_by_card_id: string;
      }>;
      const edges = blockerRows.filter((r) => cardIds.has(r.card_id));
      try {
        orderedIds = topologicallySortPhaseIds(
          phases.map((p) => ({ id: p.id, position: p.position })),
          epicCards.map((c) => ({ id: c.id, phase_id: c.phase_id ?? null })),
          edges,
        );
      } catch (err) {
        if (err instanceof PhaseCycleError) {
          return res.status(409).json({ error: 'cycle', phaseIds: err.cyclePhaseIds });
        }
        throw err;
      }
    } else {
      orderedIds = parsed.phaseIds as string[];
      const phaseById = new Map(phases.map((p) => [p.id, p]));
      const uniqueIds = new Set(orderedIds);
      if (uniqueIds.size !== orderedIds.length) {
        return res.status(400).json({ error: 'phaseIds must not contain duplicates' });
      }
      if (orderedIds.length !== phases.length || orderedIds.some((id) => !phaseById.has(id))) {
        return res.status(400).json({
          error: "phaseIds must include every one of the epic's phases exactly once",
        });
      }
    }

    const reorder = getDb().transaction((ids: string[]) => {
      for (const [position, phaseId] of ids.entries()) {
        stmts.setKanbanPhasePosition.run(position, phaseId);
      }
      return stmts.getKanbanPhasesByEpic.all(parsed.epicId) as KanbanPhaseRow[];
    });
    const nextPhases = reorder(orderedIds);
    broadcast({ type: 'kanban_update', projectId: req.params.projectId });
    res.json(nextPhases);
  });

  router.post('/api/projects/:projectId/board/spec-items', (req: Request, res: Response) => {
    const { board } = getOrCreateBoard(stmts, req.params.projectId as string);
    const parsed = parseBody(CreateSpecItemRequestSchema, req, res);
    if (!parsed) return;
    const { epicId, tag, title, decision, phaseId, createSpikeCard } = parsed;
    const epic = stmts.getKanbanEpic.get(epicId) as KanbanEpicRow | undefined;
    if (!epic || epic.board_id !== board.id) {
      return res.status(404).json({ error: 'Epic not found' });
    }
    // Honor an explicit initial status. Creating a `chosen` item requires a
    // real decision (same gate as the update path) — otherwise the open-spec
    // dispatch gate would be cleared with no decision context for workers.
    const createStatus = normalizeSpecItemStatus(parsed.status);
    const trimmedDecision = decision?.trim() || null;
    if (createStatus === 'chosen' && !trimmedDecision) {
      return res
        .status(400)
        .json({ error: 'A non-empty decision is required to create a spec item as chosen' });
    }
    // Normalize a blank/whitespace phaseId to NULL up front (matching the
    // card / linked-epic paths) so we never both skip validation AND persist
    // an empty string as an invalid phase reference.
    const normalizedPhaseId =
      phaseId != null && String(phaseId).trim() ? String(phaseId).trim() : null;
    // A supplied phase must be on this board AND belong to the spec item's
    // epic. Otherwise `createSpikeCard` would stamp a foreign/unrelated
    // `phase_id` on a card created on this board, and another project's phase
    // runner could later pick it up via `getKanbanCardsByPhase`.
    if (normalizedPhaseId) {
      const phase = stmts.getKanbanPhase.get(normalizedPhaseId) as KanbanPhaseRow | undefined;
      if (!phase || phase.board_id !== board.id || String(phase.epic_id) !== String(epicId)) {
        return res.status(400).json({ error: 'phaseId is not a valid phase of this epic' });
      }
    }
    const existing = stmts.getKanbanSpecItemsByEpic.all(epicId) as KanbanEpicSpecItemRow[];
    const maxPos = existing.length > 0 ? Math.max(...existing.map((s) => s.position)) + 1 : 0;
    const id = uuidv4();
    stmts.createKanbanSpecItem.run(
      id,
      epicId,
      board.id,
      normalizedPhaseId,
      tag.trim(),
      title.trim(),
      trimmedDecision,
      createStatus,
      maxPos,
    );
    let specItem = stmts.getKanbanSpecItem.get(id) as KanbanEpicSpecItemRow;
    // Only spike an *undecided* item — a spec created already `chosen` has its
    // decision and doesn't need a research spike.
    if (createSpikeCard === true && createStatus !== 'chosen') {
      createSpikeCardForSpecItem(stmts, {
        boardId: board.id,
        epicId,
        phaseId: normalizedPhaseId,
        specItem,
      });
      specItem = stmts.getKanbanSpecItem.get(id) as KanbanEpicSpecItemRow;
    }
    broadcast({ type: 'kanban_update', projectId: req.params.projectId });
    res.json(specItem);
  });

  router.put(
    '/api/projects/:projectId/board/spec-items/:specItemId',
    (req: Request, res: Response) => {
      const specItem = stmts.getKanbanSpecItem.get(req.params.specItemId) as
        | KanbanEpicSpecItemRow
        | undefined;
      if (!specItem) return res.status(404).json({ error: 'Spec item not found' });
      const { board } = getOrCreateBoard(stmts, req.params.projectId as string);
      if (specItem.board_id !== board.id) {
        return res.status(404).json({ error: 'Spec item not found' });
      }
      const parsed = parseBody(UpdateSpecItemRequestSchema, req, res);
      if (!parsed) return;
      // Normalize a blank/whitespace phaseId to NULL (an explicit clear),
      // matching the create path — never persist an empty-string phase ref.
      const nextPhaseId =
        parsed.phaseId !== undefined
          ? String(parsed.phaseId ?? '').trim() || null
          : (specItem.phase_id ?? null);
      // A supplied phase must stay on this board AND belong to the spec item's
      // epic, mirroring the create path — a foreign/cross-epic phase here would
      // be inherited by the spike card and dispatched under the wrong scope.
      if (parsed.phaseId !== undefined && nextPhaseId) {
        const phase = stmts.getKanbanPhase.get(nextPhaseId) as KanbanPhaseRow | undefined;
        if (
          !phase ||
          phase.board_id !== board.id ||
          String(phase.epic_id) !== String(specItem.epic_id)
        ) {
          return res.status(400).json({ error: 'phaseId is not a valid phase of this epic' });
        }
      }
      const nextStatus =
        parsed.status !== undefined ? normalizeSpecItemStatus(parsed.status) : specItem.status;
      // The effective decision after this update — either the (trimmed) value
      // in the body or the already-stored one.
      const nextDecision =
        parsed.decision !== undefined ? parsed.decision?.trim() || null : specItem.decision;
      // Locking a spec to `chosen` clears the open-spec dispatch gate, so a
      // worker must inherit a real decision. Refuse the transition when the
      // effective decision is empty.
      if (nextStatus === 'chosen' && !(nextDecision && String(nextDecision).trim())) {
        return res
          .status(400)
          .json({ error: 'A non-empty decision is required to mark a spec item chosen' });
      }
      const resolvedSessionId =
        parsed.resolvedSessionId !== undefined
          ? parsed.resolvedSessionId
          : nextStatus === 'chosen' && specItem.status !== 'chosen'
            ? ((req.headers['x-session-id'] as string | undefined) ?? specItem.resolved_session_id)
            : specItem.resolved_session_id;
      stmts.updateKanbanSpecItem.run(
        parsed.tag?.trim() ?? specItem.tag,
        parsed.title?.trim() ?? specItem.title,
        nextDecision,
        nextStatus,
        nextPhaseId,
        parsed.position ?? specItem.position,
        resolvedSessionId ?? null,
        req.params.specItemId,
      );
      const updated = stmts.getKanbanSpecItem.get(req.params.specItemId) as KanbanEpicSpecItemRow;
      if (nextStatus === 'chosen') {
        completeSpikeCardForSpecItem(stmts, updated);
      }
      broadcast({ type: 'kanban_update', projectId: req.params.projectId });
      res.json(updated);
    },
  );

  router.post(
    '/api/projects/:projectId/board/spec-items/:specItemId/decide-for-me',
    async (req: Request, res: Response) => {
      const specItem = stmts.getKanbanSpecItem.get(req.params.specItemId) as
        | KanbanEpicSpecItemRow
        | undefined;
      if (!specItem) return res.status(404).json({ error: 'Spec item not found' });
      const { board } = getOrCreateBoard(stmts, req.params.projectId as string);
      if (specItem.board_id !== board.id) {
        return res.status(404).json({ error: 'Spec item not found' });
      }
      if (specItem.status === 'chosen') {
        return res.status(400).json({ error: 'Spec decision is already locked' });
      }

      const parsed = parseBody(DecideForMeRequestSchema, req, res);
      if (!parsed) return;

      const project = findProject(req.params.projectId as string);
      if (!project) return res.status(404).json({ error: 'Project not found' });

      const ownerUserId = resolveOwnerUserId(req as AuthenticatedRequest);
      if (!ownerUserId) {
        return res.status(401).json({ error: 'Authentication required to run Decide for me' });
      }

      let found = parsed.agentId ? findAgent(parsed.agentId) : null;
      // An explicitly chosen agent must belong to THIS project. `findAgent` is
      // a global lookup, so without this a caller could start a scoping session
      // for this project's spec item under a foreign project's agent, mixing
      // session ownership/visibility and project context.
      if (parsed.agentId && (!found || found.project?.id !== project.id)) {
        return res.status(400).json({ error: 'agentId does not belong to this project' });
      }
      if (!found) {
        const pick = pickDefaultDecideAgent(project);
        if (!pick) return res.status(400).json({ error: 'No agent available for this project' });
        found = findAgent(pick.id);
      }
      if (!found) return res.status(404).json({ error: 'Agent not found' });
      const { agent } = found;

      if (specItem.resolved_session_id) {
        const existing = stmts.getSession.get(specItem.resolved_session_id) as
          | SessionRow
          | undefined;
        if (existing && existing.state === 'working') {
          return res.json({
            sessionId: existing.id,
            agentId: existing.agent_id,
            specItem,
          });
        }
      }

      const sessionId = crypto.randomUUID();
      const { engine, model: resolvedModel } = resolveEffectiveEngineAndModel(config, {
        agentId: agent.id,
        agentEngine: agent.engine || 'claude-code',
        agentModel: agent.model ?? null,
        ownerUserId,
      });

      stmts.createSession.run(
        sessionId,
        agent.id,
        `Decide: ${specItem.title}`,
        engine,
        resolvedModel,
        0,
        1,
        1,
      );
      stmts.updateSessionMode.run('scoping', sessionId);
      stmts.updateSessionLinkedEpic.run(specItem.epic_id, sessionId);
      stmts.updateSessionLinkedSpecItem.run(specItem.id, sessionId);
      markSessionFinalizeAutomation(stmts, sessionId, 'manual');
      setSessionOwner(sessionId, ownerUserId);

      stmts.updateKanbanSpecItem.run(
        specItem.tag,
        specItem.title,
        specItem.decision,
        specItem.status,
        specItem.phase_id,
        specItem.position,
        sessionId,
        specItem.id,
      );

      const context = buildDecideForMeSessionContext({
        specItem,
        projectId: req.params.projectId as string,
        projectName: project.name,
      });

      handleChat(null, {
        type: 'chat',
        agentId: agent.id,
        sessionId,
        content: context,
        hookSpecificOutput: { sessionTitle: `Decide: ${specItem.title}` },
      }).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[DecideForMe] handleChat failed for session ${sessionId}:`, msg);
      });

      const sessionRow = stmts.getSession.get(sessionId) as SessionRow;
      broadcast({
        type: 'session_created',
        agentId: agent.id,
        session: enrichSessionForClient(sessionRow, stmts),
      });
      broadcast({ type: 'kanban_update', projectId: req.params.projectId });

      const refreshed = stmts.getKanbanSpecItem.get(specItem.id) as KanbanEpicSpecItemRow;
      res.json({ sessionId, agentId: agent.id, specItem: refreshed });
    },
  );

  // Open a scoping-mode session pre-linked to an epic. Unlike Decide for me,
  // this does NOT auto-send a kickoff message — the session is created empty so
  // the user can type their own request. The scoping preamble (chat.ts) injects
  // the epic, its phases, spec items, and locked decisions on the first turn, so
  // the agent already knows which epic without being told.
  router.post(
    '/api/projects/:projectId/board/epics/:epicId/scope',
    async (req: Request, res: Response) => {
      const epic = stmts.getKanbanEpic.get(req.params.epicId) as KanbanEpicRow | undefined;
      if (!epic) return res.status(404).json({ error: 'Epic not found' });
      const { board } = getOrCreateBoard(stmts, req.params.projectId as string);
      if (epic.board_id !== board.id) {
        return res.status(404).json({ error: 'Epic not found' });
      }

      const parsed = parseBody(ScopeEpicRequestSchema, req, res);
      if (!parsed) return;

      const project = findProject(req.params.projectId as string);
      if (!project) return res.status(404).json({ error: 'Project not found' });

      const ownerUserId = resolveOwnerUserId(req as AuthenticatedRequest);
      if (!ownerUserId) {
        return res.status(401).json({ error: 'Authentication required to scope an epic' });
      }

      let found = parsed.agentId ? findAgent(parsed.agentId) : null;
      // An explicitly chosen agent must belong to THIS project — `findAgent` is a
      // global lookup, so without this guard a caller could open a scoping session
      // for this project's epic under a foreign project's agent.
      if (parsed.agentId && (!found || found.project?.id !== project.id)) {
        return res.status(400).json({ error: 'agentId does not belong to this project' });
      }
      if (!found) {
        const pick = pickDefaultDecideAgent(project);
        if (!pick) return res.status(400).json({ error: 'No agent available for this project' });
        found = findAgent(pick.id);
      }
      if (!found) return res.status(404).json({ error: 'Agent not found' });
      const { agent } = found;

      const sessionId = crypto.randomUUID();
      const { engine, model: resolvedModel } = resolveEffectiveEngineAndModel(config, {
        agentId: agent.id,
        agentEngine: agent.engine || 'claude-code',
        agentModel: agent.model ?? null,
        ownerUserId,
      });

      const sessionTitle = `Scope: ${epic.name}`;
      stmts.createSession.run(sessionId, agent.id, sessionTitle, engine, resolvedModel, 0, 1, 1);
      stmts.updateSessionMode.run('scoping', sessionId);
      stmts.updateSessionLinkedEpic.run(epic.id, sessionId);
      markSessionFinalizeAutomation(stmts, sessionId, 'manual');
      setSessionOwner(sessionId, ownerUserId);

      const sessionRow = stmts.getSession.get(sessionId) as SessionRow;
      broadcast({
        type: 'session_created',
        agentId: agent.id,
        session: enrichSessionForClient(sessionRow, stmts),
      });

      res.json({ sessionId, agentId: agent.id });
    },
  );

  // Open a scoping-mode session seeded with free-form note content (a whole
  // note or a single heading-scoped block). Unlike the epic-linked scope route,
  // this is NOT tied to an existing epic and DOES auto-send a kickoff message so
  // the agent immediately turns the captured notes into an Epic → Phases →
  // Tickets structure. The scoping-mode preamble (chat.ts) still injects the
  // hierarchy contract and rules on the first turn.
  router.post(
    '/api/projects/:projectId/board/scope-from-notes',
    async (req: Request, res: Response) => {
      const parsed = parseBody(ScopeFromNotesRequestSchema, req, res);
      if (!parsed) return;

      // Auth before existence: check authentication (401) before revealing
      // whether the project exists (404), so an unauthenticated caller can't
      // probe project ids.
      const ownerUserId = resolveOwnerUserId(req as AuthenticatedRequest);
      if (!ownerUserId) {
        return res.status(401).json({ error: 'Authentication required to scope notes' });
      }

      const project = findProject(req.params.projectId as string);
      if (!project) return res.status(404).json({ error: 'Project not found' });

      let found = parsed.agentId ? findAgent(parsed.agentId) : null;
      // An explicitly chosen agent must belong to THIS project — `findAgent` is
      // a global lookup, so without this guard a caller could open a scoping
      // session for this project under a foreign project's agent.
      if (parsed.agentId && (!found || found.project?.id !== project.id)) {
        return res.status(400).json({ error: 'agentId does not belong to this project' });
      }
      if (!found) {
        const pick = pickDefaultDecideAgent(project);
        if (!pick) return res.status(400).json({ error: 'No agent available for this project' });
        found = findAgent(pick.id);
      }
      if (!found) return res.status(404).json({ error: 'Agent not found' });
      const { agent } = found;

      const sessionId = crypto.randomUUID();
      const { engine, model: resolvedModel } = resolveEffectiveEngineAndModel(config, {
        agentId: agent.id,
        agentEngine: agent.engine || 'claude-code',
        agentModel: agent.model ?? null,
        ownerUserId,
      });

      const rawTitle = (parsed.title ?? '').trim();
      const sessionTitle = rawTitle ? `Scope: ${rawTitle}` : 'Scope: notes';
      stmts.createSession.run(sessionId, agent.id, sessionTitle, engine, resolvedModel, 0, 1, 1);
      stmts.updateSessionMode.run('scoping', sessionId);
      markSessionFinalizeAutomation(stmts, sessionId, 'manual');
      setSessionOwner(sessionId, ownerUserId);

      const kickoff = buildNoteScopingKickoff({
        content: parsed.content,
        title: rawTitle || null,
        projectName: project.name,
      });

      handleChat(null, {
        type: 'chat',
        agentId: agent.id,
        sessionId,
        content: kickoff,
        hookSpecificOutput: { sessionTitle },
      }).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[ScopeFromNotes] handleChat failed for session ${sessionId}:`, msg);
      });

      const sessionRow = stmts.getSession.get(sessionId) as SessionRow;
      broadcast({
        type: 'session_created',
        agentId: agent.id,
        session: enrichSessionForClient(sessionRow, stmts),
      });

      res.json({ sessionId, agentId: agent.id });
    },
  );

  router.post(
    '/api/projects/:projectId/board/spec-items/:specItemId/spike',
    (req: Request, res: Response) => {
      const specItem = stmts.getKanbanSpecItem.get(req.params.specItemId) as
        | KanbanEpicSpecItemRow
        | undefined;
      if (!specItem) return res.status(404).json({ error: 'Spec item not found' });
      const { board } = getOrCreateBoard(stmts, req.params.projectId as string);
      if (specItem.board_id !== board.id) {
        return res.status(404).json({ error: 'Spec item not found' });
      }
      if (specItem.spike_card_id) {
        const existing = stmts.getKanbanCard.get(specItem.spike_card_id) as
          | KanbanCardRow
          | undefined;
        if (existing) return res.json({ specItem, spikeCard: existing });
      }
      const spikeCard = createSpikeCardForSpecItem(stmts, {
        boardId: board.id,
        epicId: specItem.epic_id,
        phaseId: specItem.phase_id,
        specItem,
      });
      if (!spikeCard) return res.status(500).json({ error: 'Failed to create spike card' });
      const refreshed = stmts.getKanbanSpecItem.get(specItem.id) as KanbanEpicSpecItemRow;
      broadcast({ type: 'kanban_update', projectId: req.params.projectId });
      res.json({ specItem: refreshed, spikeCard });
    },
  );

  router.delete(
    '/api/projects/:projectId/board/spec-items/:specItemId',
    (req: Request, res: Response) => {
      const specItem = stmts.getKanbanSpecItem.get(req.params.specItemId) as
        | KanbanEpicSpecItemRow
        | undefined;
      if (!specItem) return res.status(404).json({ error: 'Spec item not found' });
      const { board } = getOrCreateBoard(stmts, req.params.projectId as string);
      if (specItem.board_id !== board.id) {
        return res.status(404).json({ error: 'Spec item not found' });
      }
      // Delete the linked spike card too. A spike card exists only to drive
      // this spec decision; left behind, it stays eligible for autonomous
      // dispatch (by `card_kind`, the `spike_card_id` link, OR a `Spike:`
      // title) and `ensureSpecItemForSpikeCard` would recreate a fresh spec
      // item on the next pass — resurrecting the decision we just deleted.
      if (specItem.spike_card_id) {
        lastDispatchedReviewId.delete(specItem.spike_card_id);
        stmts.deleteKanbanCard.run(specItem.spike_card_id);
      }
      stmts.deleteKanbanSpecItem.run(req.params.specItemId);
      recomputeEpicState(stmts, specItem.epic_id);
      broadcast({ type: 'kanban_update', projectId: req.params.projectId });
      res.json({ ok: true });
    },
  );

  router.post(
    '/api/projects/:projectId/board/autonomous/run',
    async (req: Request, res: Response) => {
      try {
        await runAutonomousLoop(req.params.projectId as string);
        res.json({ ok: true });
      } catch (err) {
        res.status(500).json({ error: (err as Error).message });
      }
    },
  );

  router.get('/api/projects/:projectId/board/autonomous/status', (req: Request, res: Response) => {
    const boardData = getOrCreateBoard(stmts, req.params.projectId as string);
    if (!boardData?.board) return res.json({ active: false, epics: [] });

    // A board may run multiple epics autonomously at once. Prefer the plural
    // statement; fall back to the singular for older wiring.
    const pluralStmt = (stmts as { getAutonomousEpics?: { all?: (id: string) => unknown } })
      .getAutonomousEpics;
    const epics = pluralStmt?.all
      ? ((pluralStmt.all(boardData.board.id) as KanbanEpicRow[]) ?? [])
      : (() => {
          const one = stmts.getAutonomousEpic.get(boardData.board.id) as KanbanEpicRow | undefined;
          return one ? [one] : [];
        })();

    const phases =
      ((
        stmts as { getAutonomousPhases?: { all?: (id: string) => unknown } }
      ).getAutonomousPhases?.all?.(boardData.board.id) as KanbanPhaseRow[] | undefined) ?? [];

    if (epics.length === 0 && phases.length === 0) {
      return res.json({ active: false, epics: [], phases: [] });
    }

    const cols = stmts.getKanbanColumns.all(boardData.board.id) as KanbanColumnRow[];
    const colNameMap = Object.fromEntries(cols.map((c) => [c.id, c.name]));

    const epicStatuses = epics.map((epic) => {
      const eligible = stmts.getEligibleAutonomousCards.all(epic.id) as KanbanCardRow[];
      const allEpicCards = stmts.getKanbanCardsByEpic.all(epic.id) as KanbanCardRow[];
      const inProgress = allEpicCards.filter((c) => colNameMap[c.column_id] === 'In Progress');
      const inReview = allEpicCards.filter((c) => colNameMap[c.column_id] === 'Review');
      const done = allEpicCards.filter((c) => colNameMap[c.column_id] === 'Done');
      const activeCards = inProgress.length + inReview.length;
      return {
        epicId: epic.id,
        epicName: epic.name,
        model: epic.autonomous_model,
        interval: epic.autonomous_interval,
        maxConcurrent: epic.autonomous_max_concurrent,
        eligibleCards: eligible.length,
        inProgressCards: inProgress.length,
        inReviewCards: inReview.length,
        activeCards,
        slotsAvailable: Math.max(0, epic.autonomous_max_concurrent - activeCards),
        doneCards: done.length,
        totalCards: allEpicCards.length,
        cronActive: autonomousCrons.has(epic.id),
      };
    });

    const epicNameById = new Map(epics.map((epic) => [epic.id, epic.name]));
    const phaseStatuses = phases.map((phase) => {
      const parentEpic =
        epicNameById.get(phase.epic_id) ??
        ((stmts.getKanbanEpic.get(phase.epic_id) as KanbanEpicRow | undefined)?.name || null);
      const eligible = stmts.getEligibleAutonomousCardsByPhase.all(phase.id) as KanbanCardRow[];
      const allPhaseCards = stmts.getKanbanCardsByPhase.all(phase.id) as KanbanCardRow[];
      const inProgress = allPhaseCards.filter((c) => colNameMap[c.column_id] === 'In Progress');
      const inReview = allPhaseCards.filter((c) => colNameMap[c.column_id] === 'Review');
      const done = allPhaseCards.filter((c) => colNameMap[c.column_id] === 'Done');
      const activeCards = inProgress.length + inReview.length;
      return {
        phaseId: phase.id,
        phaseName: phase.name,
        epicId: phase.epic_id,
        epicName: parentEpic,
        model: phase.autonomous_model,
        interval: phase.autonomous_interval,
        maxConcurrent: phase.autonomous_max_concurrent,
        eligibleCards: eligible.length,
        inProgressCards: inProgress.length,
        inReviewCards: inReview.length,
        activeCards,
        slotsAvailable: Math.max(0, phase.autonomous_max_concurrent - activeCards),
        doneCards: done.length,
        totalCards: allPhaseCards.length,
        cronActive: autonomousCrons.has(`phase:${phase.id}`),
      };
    });

    const primaryStatus = epicStatuses[0] ?? phaseStatuses[0] ?? {};
    // Top-level fields mirror the first epic so existing single-epic callers keep
    // working; `epics` and `phases` carry the scoped breakdowns for current UIs.
    res.json({ active: true, epics: epicStatuses, phases: phaseStatuses, ...primaryStatus });
  });

  router.post(
    '/api/projects/:projectId/board/cards/:cardId/epic',
    (req: Request, res: Response) => {
      const card = stmts.getKanbanCard.get(req.params.cardId) as KanbanCardRow | undefined;
      if (!card) return res.status(404).json({ error: 'Card not found' });
      const parsedLink = parseBody(LinkEpicRequestSchema, req, res);
      if (!parsedLink) return;
      const { epicId } = parsedLink;
      // FK pre-flight: a non-empty epicId must reference an existing epic
      // on the same board. Without this, a stale epicId from the client
      // surfaces as an opaque `SqliteError: FOREIGN KEY constraint failed`.
      if (epicId) {
        const epic = stmts.getKanbanEpic.get(epicId) as KanbanEpicRow | undefined;
        if (!epic || epic.board_id !== card.board_id) {
          return res.status(404).json({ error: "Epic not found on this card's board" });
        }
      }
      stmts.updateKanbanCardEpic.run(epicId || null, req.params.cardId);
      // Keep phase consistent with the new epic. Unlink (epicId null) clears the
      // phase; linking to an epic drops the card into a phase unless it already
      // sits in one belonging to that epic (scoping invariant: an epic-linked
      // card always lives in a phase).
      if (!epicId) {
        if (card.phase_id) stmts.updateKanbanCardPhase.run(null, req.params.cardId);
      } else {
        let keepPhase = false;
        if (card.phase_id) {
          const cur = stmts.getKanbanPhase.get(card.phase_id) as KanbanPhaseRow | undefined;
          keepPhase = !!cur && String(cur.epic_id) === String(epicId);
        }
        if (!keepPhase) {
          const resolvedPhase = resolvePhaseForEpicLink(stmts, card.board_id, epicId);
          stmts.updateKanbanCardPhase.run(resolvedPhase, req.params.cardId);
        }
      }
      const affectedEpicIds = new Set<string>();
      if (card.epic_id) affectedEpicIds.add(card.epic_id);
      if (epicId) affectedEpicIds.add(epicId);
      for (const affectedEpicId of affectedEpicIds) {
        recomputeEpicState(stmts, affectedEpicId);
        disableAutonomousForEmptyEpic(deps, req.params.projectId as string, affectedEpicId);
      }
      broadcast({ type: 'kanban_update', projectId: req.params.projectId });
      const updated = stmts.getKanbanCard.get(req.params.cardId) as KanbanCardRow;
      res.json(serializeCardForRequest(req, stmts, card.board_id, updated));
    },
  );

  // ─── Review Logs ─────────────────────────────────────────────────────
  router.get('/api/projects/:projectId/reviews', (req: Request, res: Response) => {
    const limit = parseInt(req.query.limit as string) || 50;
    const projectId = req.params.projectId;
    type ReviewRow = Record<string, unknown> & { completed_at: string };
    const reviewRows = stmts.getReviewLogs.all(projectId, limit) as ReviewRow[];
    const prRows = stmts.getPrCreationLogsByProject.all(projectId, limit) as Array<{
      id: string;
      project_id: string;
      card_id: string | null;
      session_id: string | null;
      pr_url: string;
      pr_number: number | null;
      pr_title: string;
      author_agent: string;
      created_at: string;
    }>;

    const merged: Array<Record<string, unknown>> = [
      ...reviewRows.map((r) => ({ event_kind: 'review', ...r })),
      ...prRows.map((p) => ({
        event_kind: 'pr_created',
        id: p.id,
        project_id: p.project_id,
        card_id: p.card_id,
        session_id: p.session_id,
        pr_url: p.pr_url,
        pr_number: p.pr_number,
        pr_title: p.pr_title,
        reviewer_agent: p.author_agent,
        author_agent: p.author_agent,
        outcome: null,
        review_body: null,
        started_at: p.created_at,
        completed_at: p.created_at,
      })),
    ];
    merged.sort((a, b) => {
      const ta = new Date(String((a as { completed_at: string }).completed_at)).getTime();
      const tb = new Date(String((b as { completed_at: string }).completed_at)).getTime();
      if (tb !== ta) return tb - ta;
      const ida = String((a as { id: string }).id);
      const idb = String((b as { id: string }).id);
      return ida < idb ? 1 : ida > idb ? -1 : 0;
    });
    res.json(merged.slice(0, limit));
  });

  // Active review sessions are now driven by the Reviewer agent's regular
  // sessions list (sessions whose title starts with "Review: PR #..."). The
  // legacy in-memory tracking map is gone, so this endpoint reports them by
  // querying the sessions table for each Reviewer agent on the project.
  router.get('/api/projects/:projectId/reviews/active', (req: Request, res: Response) => {
    const project = deps.getProjects().find((p) => p.id === req.params.projectId);
    if (!project) return res.json([]);

    const reviewerIds = (project.agents || [])
      .filter((a) => a.role === 'reviewer')
      .map((a) => a.id);
    if (reviewerIds.length === 0) return res.json([]);

    type SessionLite = { id: string; agent_id: string; name: string };
    const active: Array<{
      sessionId: string;
      cardId: null;
      prUrl: null;
      cardTitle: string;
    }> = [];

    for (const reviewerId of reviewerIds) {
      const rows = (stmts.getSessions.all(reviewerId) || []) as SessionLite[];
      for (const s of rows) {
        if (s.name && s.name.startsWith('Review: PR #')) {
          active.push({ sessionId: s.id, cardId: null, prUrl: null, cardTitle: s.name });
        }
      }
    }
    res.json(active);
  });

  return router;
}
