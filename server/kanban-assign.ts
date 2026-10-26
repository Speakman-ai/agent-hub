/**
 * Assign a kanban card to an agent and spawn its working session.
 *
 * This is the body of `POST /api/projects/:projectId/board/cards/:cardId/assign`,
 * kept callable from server code (QA finding cards) so every assignment goes
 * through the same refusal rules, session setup, card move, and kickoff.
 */
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { resolveEffectiveEngineAndModel } from './effective-model.js';
import type {
  KanbanBoardRow,
  KanbanCardRow,
  KanbanColumnRow,
  RouteDeps,
  SessionRow,
} from './types.js';
import { isColumnDone } from './kanban-blockers.js';
import { cardLinkedPrMerged, CARD_ALREADY_DONE_ERROR } from './kanban-premature-done.js';
import { validateKanbanAssignModelForEngine } from './kanban-assign-model.js';
import { assertEngineCredsOrThrow, EngineAuthRequiredError } from './per-user-cli-spawn.js';
import { defaultSessionUseWorktreeFlag } from './project-mode.js';
import {
  buildSpikeSessionContext,
  buildSpikeSessionContextFallback,
  ensureSpecItemForSpikeCard,
  getSpecItemForSpikeCard,
  isSpikeCard,
} from './epic-spec.js';
import { markSessionAutoShipOnComplete, markSessionFinalizeAutomation } from './session-ship.js';
import { assignedFinalizeAutomationLevel } from './finalize/automation.js';
import { resolveShouldAutoMerge } from './auto-merge.js';
import { setSessionOwner } from './session-ownership.js';
import { recomputeEpicState } from './epic-state.js';
import { loadCardReplayContext } from './replays/replay-context-loader.js';
import { buildAssignedCardSessionContext } from './assign-card-context.js';
import { loadCardSupportTicketCommentContext } from './support-ticket-comment-context.js';
import { cardNeedsDevHubKey, getDevHubApiKey } from './secrets.js';
import { restoreCardAfterFailedAssign } from './kanban-assign-restore.js';
import { enrichSessionForClient } from './session-checkpoint-rewind.js';

export type AssignCardDeps = Pick<
  RouteDeps,
  'stmts' | 'config' | 'findAgent' | 'findProject' | 'handleChat' | 'broadcast'
>;

export interface AssignCardInput {
  card: KanbanCardRow;
  projectId: string;
  agentId: string;
  /** Session owner; the spawn runs on this user's engine credentials. */
  ownerUserId: string | null;
  model?: string | null;
  engine?: string | null;
  autoMerge?: boolean | null;
  comment?: string | null;
  reopen?: boolean | null;
}

export type AssignCardResult =
  | { ok: true; sessionId: string }
  | { ok: false; status: number; body: Record<string, unknown> };

export async function assignKanbanCard(
  deps: AssignCardDeps,
  input: AssignCardInput,
): Promise<AssignCardResult> {
  const { stmts, config, findAgent, findProject, handleChat, broadcast } = deps;
  const { card, projectId, agentId } = input;
  const fail = (status: number, body: Record<string, unknown>): AssignCardResult => ({
    ok: false,
    status,
    body,
  });

  // A card that already shipped must not be pulled back to In Progress
  // and handed a fresh session by a stray assign: the old session link is
  // overwritten and, if the spawn then fails, the card is left stuck.
  // Reopening shipped work is a deliberate act, so it needs `reopen`.
  if (input.reopen !== true) {
    const currentColumn = stmts.getKanbanColumn.get(card.column_id) as KanbanColumnRow | undefined;
    if (isColumnDone(currentColumn?.name)) {
      return fail(409, {
        error: CARD_ALREADY_DONE_ERROR,
        message: `Card is in "${currentColumn?.name}". Pass "reopen": true to assign it again.`,
      });
    }
    if (cardLinkedPrMerged(stmts, card)) {
      return fail(409, {
        error: CARD_ALREADY_DONE_ERROR,
        message: `Card's linked PR (${card.pr_url}) is already merged. Pass "reopen": true to assign it again.`,
      });
    }
  }

  const found = findAgent(agentId);
  if (!found) return fail(404, { error: 'Agent not found' });
  const { agent } = found;
  const project = findProject(projectId);
  if (!project) return fail(404, { error: 'Project not found' });

  const sessionId = crypto.randomUUID();
  const trimmedOverride =
    typeof input.model === 'string' && input.model.trim() ? input.model.trim() : null;
  // Validate the optional engine override against the configured
  // engineValidModels keys before passing it to the resolver — an
  // unknown engine id has to be a 400, not a silent fallback to the
  // shared agent engine. NULL/missing = "no override".
  const trimmedEngineOverride =
    typeof input.engine === 'string' && input.engine.trim() ? input.engine.trim() : null;
  if (trimmedEngineOverride) {
    const allowedEngines = Object.keys(config.engineValidModels || {});
    if (!allowedEngines.includes(trimmedEngineOverride)) {
      return fail(400, {
        error: `Invalid engine "${trimmedEngineOverride}". Allowed: ${allowedEngines.join(', ')}`,
      });
    }
  }
  const assignOwnerUid = input.ownerUserId;
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
    if (!v.ok) return fail(400, { error: v.error });
  }
  // The spawn runs on the session owner's own engine credentials and
  // hard-fails without them. Check before creating the session or touching
  // the card, so a failed assign leaves the board exactly as it was.
  try {
    assertEngineCredsOrThrow(engine, assignOwnerUid, config.dataDir);
  } catch (err) {
    if (err instanceof EngineAuthRequiredError) {
      return fail(409, { error: err.message, code: 'no_account_credentials' });
    }
    throw err;
  }
  // Resolve the auto-merge preference for this assignment. An explicit
  // boolean in the request body wins; otherwise fall back to whatever the
  // card already carries (e.g. carried over from a converted support
  // ticket — 1/0), and finally to the project default via
  // `resolveShouldAutoMerge`. `undefined` means "no override → use project
  // default".
  const autoMergeOverride: boolean | undefined =
    typeof input.autoMerge === 'boolean'
      ? input.autoMerge
      : card.auto_merge === 1
        ? true
        : card.auto_merge === 0
          ? false
          : undefined;

  const spikeAssign = isSpikeCard(card);
  // Spikes get a worktree so they can try code; ship routes refuse them.
  const wt = defaultSessionUseWorktreeFlag(project);
  let linkedSpecItem = spikeAssign ? getSpecItemForSpikeCard(stmts, card.id) : null;
  if (spikeAssign && card.epic_id) {
    linkedSpecItem = ensureSpecItemForSpikeCard(stmts, card) ?? linkedSpecItem;
  }
  stmts.createSession.run(sessionId, agentId, card.title, engine, resolvedModel, wt, 0, 1);
  if (spikeAssign) {
    stmts.updateSessionMode.run('scoping', sessionId);
    stmts.updateSessionSpikeCard.run(card.id, sessionId);
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
  setSessionOwner(sessionId, assignOwnerUid);

  const board = stmts.getKanbanBoard.get(projectId) as KanbanBoardRow | undefined;
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
    card.id,
  );
  stmts.moveKanbanCard.run(inProgressColumnId, 0, card.id);
  // If the card has no lead user yet, the person dispatching the work
  // becomes its lead so the now-in-progress card surfaces in their "My
  // Work" home pane. Mirrors card-create defaulting the lead to the acting
  // user (`normalizeAssignedUserForCreate`); an existing lead (e.g. an epic
  // lead already propagated) is never overridden.
  if (assignOwnerUid && !card.assigned_user_id) {
    stmts.setKanbanCardAssignedUser.run(assignOwnerUid, card.id);
  }
  recomputeEpicState(stmts, card.epic_id);

  // Persist an explicit auto-merge override on the card so it stays visible
  // in the assign UI and survives reassignment. Only an explicit boolean
  // mutates the stored value; a fallback to the card's existing preference
  // (or project default) leaves it untouched.
  if (typeof input.autoMerge === 'boolean') {
    stmts.setKanbanCardAutoMerge.run(input.autoMerge ? 1 : 0, card.id);
  }

  // Record an optional assignment note as a card comment so it's part of
  // the card's audit trail (it's also threaded into the agent's task
  // context below).
  const assignmentNote = typeof input.comment === 'string' ? input.comment.trim() : '';
  if (assignmentNote) {
    stmts.createKanbanCardComment.run(uuidv4(), card.id, agent.name, assignmentNote);
  }

  const contextLines: string[] = [];
  if (spikeAssign) {
    // The session was created in scoping mode with manual finalize, so its
    // first message must be the spike instructions, never the
    // implementation prompt. Mirror autonomous dispatch: use the
    // spec-linked context when one exists, else the fallback (deriving the
    // question from the card title). Emitting `# Task: …` here would tell
    // the agent to build and ship the feature.
    contextLines.push(
      linkedSpecItem
        ? buildSpikeSessionContext({ card, specItem: linkedSpecItem, projectId })
        : buildSpikeSessionContextFallback({ card, projectId }),
    );
  } else {
    // Seed the session replay attached to this card (support tickets carry
    // one; conversion moves the attribution to `session_replays.card_id`).
    // Without this the agent inherits only the inert `/uploads/replay-*.json`
    // string that survives inside the card description, and has no way to
    // know what the customer actually did. Non-fatal by contract: a missing
    // blob or a storage outage returns null and the assignment proceeds.
    const replayContext = await loadCardReplayContext({ stmts, config }, card.id);
    contextLines.push(
      buildAssignedCardSessionContext({ card, projectId, assignmentNote, replayContext }),
    );
  }

  const commentContext = loadCardSupportTicketCommentContext(stmts, card, projectId);
  if (commentContext) contextLines.push(`\n${commentContext}`);

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
    restoreCardAfterFailedAssign(stmts, broadcast, {
      before: card,
      sessionId,
      assignedColumnId: inProgressColumnId,
      projectId,
      reason: err.message,
    });
    broadcast({
      type: 'error',
      agentId,
      sessionId,
      message: `Failed to start agent session: ${err.message}`,
    });
  });

  broadcast({ type: 'kanban_update', projectId });
  broadcast({
    type: 'session_created',
    agentId,
    session: enrichSessionForClient(stmts.getSession.get(sessionId) as SessionRow, stmts),
  });

  return { ok: true, sessionId };
}
