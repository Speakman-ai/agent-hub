import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
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
  KanbanBlockerLink,
  KanbanCardBlockerRow,
  SessionRow,
  FinalizeRunRow,
} from '../types.js';
import { findCycle, loadBoardBlockers } from '../kanban-blockers.js';
import { maybeRenameSessionForLinkedCard, resolveCardSessionId } from '../kanban-caller-session.js';
import { parsePrBaseBranchInput } from '../kanban-pr-base.js';
import { ensureOperatorBaseBranch } from '../autonomous.js';
import {
  validateKanbanAssignModel,
  validateKanbanAssignModelForEngine,
} from '../kanban-assign-model.js';
import { sanitizeOrchestrationBudgetsPartial } from '../orchestration-budgets.js';
import { defaultSessionUseWorktreeFlag } from '../project-mode.js';
import { maybeStartKanbanColumnWorkflowRuns } from '../workflow-triggers.js';
import { setSessionOwner, resolveOwnerUserId } from '../session-ownership.js';
import { enrichSessionForClient } from '../session-checkpoint-rewind.js';
import { recomputeSessionState } from '../session-state.js';
import { markSessionAutoShipOnComplete, markSessionFinalizeAutomation } from '../session-ship.js';
import { assignedFinalizeAutomationLevel } from '../finalize/automation.js';
import { resolveShouldAutoMerge } from '../auto-merge.js';
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
  CreateEpicRequestSchema,
  UpdateEpicRequestSchema,
  LinkEpicRequestSchema,
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

interface BoardData {
  board: KanbanBoardRow;
  columns: KanbanColumnRow[];
  cards: KanbanCardRow[];
  epics: KanbanEpicRow[];
}

/** A card row enriched with its blocker relationships. */
interface EnrichedCard extends KanbanCardRow {
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
 * Defense-in-depth: when a card-create / card-update payload carries a
 * `session_id` that points at an *intake-role* agent's session, drop it.
 *
 * Background: the `agent-hub-intake` flow (bug-report intake, autonomous-mode
 * triage, etc.) spawns ephemeral sessions whose only job is to *file* a
 * ticket for the user — they never go on to *do* the work themselves. If
 * such a session stamps its own `session_id` on the card it just created,
 * the server treats the card as implicitly assigned, the UI hides the
 * Assignee dropdown, and the autonomous dispatcher refuses to pick the
 * card up because it's "already linked to a live session". The result is
 * a backlog of frozen tickets that can never be worked on.
 *
 * Returns true when the supplied `sessionId` resolves to an intake-role
 * agent's session and the caller should therefore strip both `session_id`
 * and (optionally) `assignee` before persisting. A null/unknown session
 * always returns false — we never strip when we can't prove intent.
 */
function isIntakeOwnedSession(
  stmts: Stmts,
  findAgent: (agentId: string) => AgentLookup | null,
  sessionId: string | null | undefined,
): boolean {
  if (!sessionId) return false;
  const session = stmts.getSession.get(sessionId) as { agent_id?: string } | undefined;
  if (!session?.agent_id) return false;
  const lookup = findAgent(session.agent_id);
  return lookup?.agent.role === 'intake';
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

export function getOrCreateBoard(stmts: Stmts, projectId: string): BoardData {
  let board = stmts.getKanbanBoard.get(projectId) as KanbanBoardRow | undefined;
  if (board) {
    return {
      board,
      columns: stmts.getKanbanColumns.all(board.id) as KanbanColumnRow[],
      cards: stmts.getKanbanCards.all(board.id) as KanbanCardRow[],
      epics: stmts.getKanbanEpics.all(board.id) as KanbanEpicRow[],
    };
  }
  const boardId = uuidv4();
  stmts.createKanbanBoard.run(boardId, projectId, 'Board');
  const defaultColumns = [
    { name: 'To Do', color: '#3B82F6' },
    { name: 'In Progress', color: '#F59E0B' },
    { name: 'Review', color: '#8B5CF6' },
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
  } = deps;

  const router = Router();

  router.get('/api/projects/:projectId/board', (req: Request, res: Response) => {
    const project = findProject(req.params.projectId as string);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const data = getOrCreateBoard(stmts, req.params.projectId as string);
    // Annotate each card with its blocker relationships. A single indexed
    // query fetches every edge on the board; we then attach empty arrays
    // for cards with no blockers so clients can rely on the shape.
    const index = loadBoardBlockers(stmts, data.board.id);
    // Latest finalize run per session, keyed by session_id — one window-
    // function query per board fetch. Folded into each card so the per-
    // card badge in the client can render from board state instead of
    // self-fetching (PR #1169 reviewer feedback).
    const finalizeRuns = loadBoardFinalizeRuns(stmts, data.board.id);
    const enrichedCards: EnrichedCard[] = data.cards.map((c) => ({
      ...c,
      blockers: index.blockersByCard.get(c.id) ?? [],
      blocks: index.blocksByCard.get(c.id) ?? [],
      finalize_run: c.session_id ? (finalizeRuns.get(c.session_id) ?? null) : null,
    }));
    res.json({ ...data, cards: enrichedCards });
  });

  router.post('/api/projects/:projectId/board/columns', (req: Request, res: Response) => {
    const project = findProject(req.params.projectId as string);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const parsed = parseBody(CreateColumnRequestSchema, req, res);
    if (!parsed) return;
    const { name, color } = parsed;
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
    const { name, position, color } = parsed;
    stmts.updateKanbanColumn.run(name, position, color || null, req.params.columnId);
    broadcast({ type: 'kanban_update', projectId: req.params.projectId });
    res.json({ ok: true });
  });

  router.delete(
    '/api/projects/:projectId/board/columns/:columnId',
    (req: Request, res: Response) => {
      stmts.deleteKanbanColumn.run(req.params.columnId);
      broadcast({ type: 'kanban_update', projectId: req.params.projectId });
      res.json({ ok: true });
    },
  );

  router.get('/api/projects/:projectId/board/cards', (req: Request, res: Response) => {
    const project = findProject(req.params.projectId as string);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const { board } = getOrCreateBoard(stmts, req.params.projectId as string);
    res.json(stmts.getKanbanCards.all(board.id));
  });

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
      // Return the existing card instead of creating a duplicate
      return res.json(duplicate);
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
        return res.json(linked);
      }
    }

    const existingCards = stmts.getKanbanCardsByColumn.all(columnId) as KanbanCardRow[];
    const maxPos =
      existingCards.length > 0 ? Math.max(...existingCards.map((c) => c.position)) + 1 : 0;
    const id = uuidv4();

    // Defense-in-depth: an intake-role agent's session must never be
    // stamped on a card it files for someone else (see `isIntakeOwnedSession`
    // for the full rationale). Strip both `session_id` and `assignee` when
    // the calling session resolves to an intake agent — the UI's Assignee
    // dropdown and the autonomous dispatcher both rely on these being null
    // for a freshly-filed ticket.
    let effectiveSessionId: string | null = sessionId || null;
    // Normalize agent.id → agent.name; pass through human-typed names; null
    // when empty/whitespace. See `normalizeAssignee` for the full rationale.
    let effectiveAssignee: string | null = normalizeAssignee(assignee, findAgent);
    if (effectiveSessionId && isIntakeOwnedSession(stmts, findAgent, effectiveSessionId)) {
      console.log(
        `[Board] Stripping session_id/assignee on card create — session ${effectiveSessionId} belongs to an intake-role agent`,
      );
      effectiveSessionId = null;
      effectiveAssignee = null;
    }

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
    broadcast({ type: 'kanban_update', projectId: req.params.projectId });
    if (effectiveSessionId) {
      maybeRenameSessionForLinkedCard(stmts, broadcast, effectiveSessionId, title);
    }
    res.json(stmts.getKanbanCard.get(id));
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

    // Defense-in-depth (matches POST /board/cards): if the client is
    // setting `session_id` to an intake-role agent's session, strip it.
    // Only fires when the new value is non-null — explicit clears are
    // honored verbatim.
    let effectiveSessionId: string | null | undefined = sessionId;
    // Normalize agent.id → agent.name on update too, but only when the
    // caller is explicitly setting `assignee`. If the key isn't present in
    // the payload we leave the value untouched (no normalization sweep).
    let effectiveAssignee: string | null | undefined = hasAssignee
      ? normalizeAssignee(assignee, findAgent)
      : assignee;
    if (hasSessionId && sessionId && isIntakeOwnedSession(stmts, findAgent, sessionId)) {
      console.log(
        `[Board] Stripping session_id/assignee on card update — session ${sessionId} belongs to an intake-role agent`,
      );
      effectiveSessionId = null;
      // Also drop the assignee being set in the same payload, since intake
      // agents shouldn't pin themselves as assignee on tickets they file.
      if (hasAssignee) effectiveAssignee = null;
    }

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

    stmts.updateKanbanCard.run(
      title ?? card.title,
      hasDescription ? (description ?? null) : card.description,
      priority ?? card.priority,
      hasAssignee ? (effectiveAssignee ?? null) : card.assignee,
      hasLabels ? (labels ?? null) : card.labels,
      hasSessionId ? (effectiveSessionId ?? null) : card.session_id,
      hasGithubIssueUrl ? (githubIssueUrl ?? null) : card.github_issue_url,
      hasPrUrl ? (prUrl ?? null) : card.pr_url,
      hasEpicId ? (epicId ?? null) : card.epic_id,
      hasAssignModel
        ? assignModel != null && String(assignModel).trim()
          ? String(assignModel).trim()
          : null
        : card.assign_model,
      hasAssignEngine ? (nextAssignEngine ?? null) : (card.assign_engine ?? null),
      hasPrBaseBranch ? (prBaseBranch ?? null) : (card.pr_base_branch ?? null),
      req.params.cardId,
    );
    broadcast({ type: 'kanban_update', projectId: req.params.projectId });
    res.json(stmts.getKanbanCard.get(req.params.cardId));
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
      const previousColumnId = card.column_id;
      stmts.moveKanbanCard.run(columnId, position ?? 0, req.params.cardId);
      broadcast({ type: 'kanban_update', projectId: req.params.projectId });
      const updatedCard = stmts.getKanbanCard.get(req.params.cardId) as KanbanCardRow;
      res.json(updatedCard);

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
          // Live merged trigger: when a session-linked card crosses a column
          // boundary (e.g. a PR merge or a human drag lands it in Done), the
          // session's resolved lifecycle state changes — typically to `merged`.
          // Recompute + push `session_state` so the sidebar icon flips live.
          if (updatedCard.session_id) {
            recomputeSessionState(stmts, updatedCard.session_id, { agentId, broadcast });
          }
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
      const { agentId, model: modelBody, engine: engineBody } = parsedAssign;

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
      const wt = defaultSessionUseWorktreeFlag(project);
      stmts.createSession.run(sessionId, agentId, card.title, engine, resolvedModel, wt, 0, 1);
      markSessionAutoShipOnComplete(stmts, sessionId);
      // Assigned cards run at least "Build and Push"; they escalate to "Send
      // It" (auto-merge) only when the project's auto-merge is enabled.
      markSessionFinalizeAutomation(
        stmts,
        sessionId,
        assignedFinalizeAutomationLevel(resolveShouldAutoMerge(undefined, project.githubWorkflow)),
      );
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
        trimmedOverride,
        trimmedEngineOverride,
        card.pr_base_branch ?? null,
        req.params.cardId,
      );
      stmts.moveKanbanCard.run(inProgressColumnId, 0, req.params.cardId);

      const contextLines = [`# Task: ${card.title}`];
      if (card.description) contextLines.push(`\n## Description\n${card.description}`);
      if (card.priority) contextLines.push(`\n**Priority:** ${card.priority}`);
      if (card.labels) contextLines.push(`**Labels:** ${card.labels}`);
      if (card.github_issue_url) contextLines.push(`**GitHub:** ${card.github_issue_url}`);

      if (agent.role === 'intake') {
        contextLines.push(
          `\n---\n## Ticket Research & Breakdown`,
          `\nYou have been assigned this card for **research and ticket creation only** — do NOT write code or create PRs.`,
          `\nYour job:`,
          `1. **Research** this task — understand the scope, identify sub-tasks, and consider edge cases`,
          `2. **Check for duplicates** — before creating any new ticket, search the existing board to make sure a similar card doesn't already exist`,
          `3. **Break it down** into actionable sub-tickets on the kanban board (in To Do)`,
          `4. **Link sub-tickets** to the same epic as this card (if it has one)${card.epic_id ? ` — epic ID: \`${card.epic_id}\`` : ''}`,
          `5. **Add a comment** to this card summarizing what you created`,
          `6. **Move this card to Done** when finished`,
          `\n### Duplicate Detection`,
          `Before creating each ticket, fetch all existing cards:`,
          `\`\`\`bash`,
          `curl -s http://localhost:3051/api/projects/${req.params.projectId}/board | jq '.cards[] | {id, title, description, column: .column_id}'`,
          `\`\`\``,
          `If a card with a similar title or overlapping scope already exists, skip creating a duplicate and note it in your summary comment.`,
          `\n### Card APIs`,
          `- **Get board**: \`GET /api/projects/${req.params.projectId}/board\``,
          `- **Create card**: \`POST /api/projects/${req.params.projectId}/board/cards\` with \`{title, description, priority, labels, columnId, createdBy: "${agent.id}"}\``,
          `- **Link to epic**: \`POST /api/projects/${req.params.projectId}/board/cards/:cardId/epic\` with \`{epicId}\``,
          `- **Add comment**: \`POST /api/projects/${req.params.projectId}/board/cards/${req.params.cardId}/comments\` with \`{content, author: "${agent.id}"}\``,
          `- **Move card**: \`POST /api/projects/${req.params.projectId}/board/cards/${req.params.cardId}/move\` with \`{columnId: "<done-column-id>"}\``,
        );
      } else {
        contextLines.push(
          `\n---`,
          `You have been assigned this task from the project kanban board. Review the description above and begin working on it.`,
          ``,
          `**This session is already linked to kanban card \`${req.params.cardId}\`.** Do **NOT** create a new card for this work — the card already exists and tracks your progress. The "Bias to Action — create a card" guidance in your system prompt does not apply here. Instead:`,
          `- **Comment** on this card to record findings, blockers, or PR links: \`POST /api/projects/${req.params.projectId}/board/cards/${req.params.cardId}/comments\``,
          `- **Move** this card as state changes (In Progress → Review → Done): \`POST /api/projects/${req.params.projectId}/board/cards/${req.params.cardId}/move\``,
          `- **Update** title/description/labels in place: \`PUT /api/projects/${req.params.projectId}/board/cards/${req.params.cardId}\``,
          ``,
          `If the work splits into genuinely separate follow-ups, create child cards in To Do with this card's id as a blocker — but the card you were assigned to stays the canonical ticket for this task.`,
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
        // Explicit user-driven kanban assign — opt out of the bug-report
        // reroute guard so a card whose description embeds `## Bug Report`
        // (e.g. one filed through the bug-report intake endpoint) still
        // lands on the chosen assignee. See `server/bug-report-reroute.ts`.
        _fromBoardAssign: true,
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
        card: stmts.getKanbanCard.get(req.params.cardId),
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
        null,
        null,
        card.pr_base_branch ?? null,
        req.params.cardId,
      );

      broadcast({ type: 'kanban_update', projectId: req.params.projectId });
      res.json(stmts.getKanbanCard.get(req.params.cardId));
    },
  );

  router.delete('/api/projects/:projectId/board/cards/:cardId', (req: Request, res: Response) => {
    const cardId = req.params.cardId as string;

    lastDispatchedReviewId.delete(cardId);

    stmts.deleteKanbanCard.run(cardId);
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
    const { board } = getOrCreateBoard(stmts, req.params.projectId as string);
    res.json(stmts.getKanbanEpics.all(board.id));
  });

  router.post('/api/projects/:projectId/board/epics', (req: Request, res: Response) => {
    const { board } = getOrCreateBoard(stmts, req.params.projectId as string);
    const parsedEpic = parseBody(CreateEpicRequestSchema, req, res);
    if (!parsedEpic) return;
    const { name, description, color } = parsedEpic;
    const hasEpicPrBase = parsedEpic.prBaseBranch !== undefined;
    if (hasEpicPrBase) {
      const parsedBranch = parsePrBaseBranchInput(parsedEpic.prBaseBranch);
      if (!parsedBranch.ok) return res.status(400).json({ error: parsedBranch.error });
    }
    const epics = stmts.getKanbanEpics.all(board.id) as KanbanEpicRow[];
    const maxPos = epics.length > 0 ? Math.max(...epics.map((e) => e.position)) + 1 : 0;
    const id = uuidv4();
    stmts.createKanbanEpic.run(id, board.id, name, description || null, color || '#6366F1', maxPos);
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
          id,
        );
      }
    }
    const createdEpic = stmts.getKanbanEpic.get(id) as KanbanEpicRow;
    // Eager creation of the operator-set integration branch on origin. Without
    // this, the branch is only created lazily by the next autonomous dispatch
    // tick — any session dispatched against this epic in the meantime races
    // ahead, opens its auto-PR before the umbrella exists, and ends up
    // pointing at origin/main (or asks the agent to manually retarget).
    // `ensureOperatorBaseBranch` self-debounces, swallows errors with a single
    // logged line, and the autonomous loop's existing call remains the
    // safety-net retry — so fire-and-forget keeps the HTTP response snappy.
    if (hasEpicPrBase && createdEpic.pr_base_branch && createdEpic.pr_base_branch.trim()) {
      const project = findProject(req.params.projectId as string);
      if (project) {
        const branch = createdEpic.pr_base_branch;
        void ensureOperatorBaseBranch(project, branch, { config }).catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(
            `[Board] ensureOperatorBaseBranch threw for project "${project.name}", branch "${branch}": ${msg}`,
          );
        });
      }
    }
    broadcast({ type: 'kanban_update', projectId: req.params.projectId });
    res.json(createdEpic);
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
    } = parsedEpic;

    const hasEpicPrBasePut = parsedEpic.prBaseBranch !== undefined;
    let nextEpicPrBaseField: string | null | undefined;
    if (hasEpicPrBasePut) {
      const parsedBranch = parsePrBaseBranchInput(parsedEpic.prBaseBranch);
      if (!parsedBranch.ok) return res.status(400).json({ error: parsedBranch.error });
      nextEpicPrBaseField = parsedBranch.value;
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

    if (autonomous && !epic.autonomous) {
      const currentAutonomous = stmts.getAutonomousEpic.get(epic.board_id) as
        | KanbanEpicRow
        | undefined;
      if (currentAutonomous && currentAutonomous.id !== epic.id) {
        stmts.updateKanbanEpic.run(
          currentAutonomous.name,
          currentAutonomous.description,
          currentAutonomous.color,
          0,
          currentAutonomous.autonomous_interval,
          currentAutonomous.autonomous_max_concurrent,
          currentAutonomous.autonomous_model ?? null,
          (currentAutonomous as { orchestration_budgets_json?: string | null })
            .orchestration_budgets_json ?? null,
          currentAutonomous.pr_base_branch ?? null,
          currentAutonomous.id,
        );
      }
    }

    if (autonomous && !epic.autonomous) {
      const currentAutonomous2 = stmts.getAutonomousEpic.get(epic.board_id) as
        | KanbanEpicRow
        | undefined;
      if (currentAutonomous2 && currentAutonomous2.id !== epic.id) {
        scheduleAutonomousEpic(req.params.projectId as string, {
          ...currentAutonomous2,
          autonomous: 0,
        });
      }
    }

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
      req.params.epicId,
    );

    // "Send It" override is persisted via a standalone setter so the main
    // updateKanbanEpic call sites stay untouched. Only write when the payload
    // explicitly carried the field; omitting it preserves the stored value.
    if (autonomousSendIt !== undefined) {
      stmts.setEpicAutonomousSendIt.run(autonomousSendIt ? 1 : 0, req.params.epicId);
    }

    const updatedEpic = stmts.getKanbanEpic.get(req.params.epicId) as KanbanEpicRow;
    scheduleAutonomousEpic(req.params.projectId as string, updatedEpic);

    // Eager creation of the operator-set integration branch on origin (same
    // rationale as POST /board/epics above). Only fires when the PUT payload
    // explicitly set a non-blank `prBaseBranch`; preserving the existing
    // value (key omitted) doesn't re-trigger the probe. Fire-and-forget so
    // git network ops don't extend the response latency.
    if (hasEpicPrBasePut && nextEpicPrBaseField && nextEpicPrBaseField.trim()) {
      const project = findProject(req.params.projectId as string);
      if (project) {
        const branch = nextEpicPrBaseField;
        void ensureOperatorBaseBranch(project, branch, { config }).catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(
            `[Board] ensureOperatorBaseBranch threw for project "${project.name}", branch "${branch}": ${msg}`,
          );
        });
      }
    }

    broadcast({ type: 'kanban_update', projectId: req.params.projectId });
    res.json(updatedEpic);
  });

  router.delete('/api/projects/:projectId/board/epics/:epicId', (req: Request, res: Response) => {
    const epicCards = stmts.getKanbanCardsByEpic.all(req.params.epicId) as KanbanCardRow[];
    for (const card of epicCards) {
      stmts.updateKanbanCardEpic.run(null, card.id);
    }
    stmts.deleteKanbanEpic.run(req.params.epicId);
    broadcast({ type: 'kanban_update', projectId: req.params.projectId });
    res.json({ ok: true });
  });

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
    if (!boardData?.board) return res.json({ active: false });
    const epic = stmts.getAutonomousEpic.get(boardData.board.id) as KanbanEpicRow | undefined;
    if (!epic) return res.json({ active: false });

    const eligible = stmts.getEligibleAutonomousCards.all(epic.id) as KanbanCardRow[];
    const allEpicCards = stmts.getKanbanCardsByEpic.all(epic.id) as KanbanCardRow[];
    const cols = stmts.getKanbanColumns.all(boardData.board.id) as KanbanColumnRow[];
    const colNameMap = Object.fromEntries(cols.map((c) => [c.id, c.name]));
    const inProgress = allEpicCards.filter((c) => colNameMap[c.column_id] === 'In Progress');
    const inReview = allEpicCards.filter((c) => colNameMap[c.column_id] === 'Review');
    const done = allEpicCards.filter((c) => colNameMap[c.column_id] === 'Done');
    const activeCards = inProgress.length + inReview.length;

    res.json({
      active: true,
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
    });
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
      broadcast({ type: 'kanban_update', projectId: req.params.projectId });
      res.json(stmts.getKanbanCard.get(req.params.cardId));
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
