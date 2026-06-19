/**
 * card-orphan-cleanup.ts — garbage-collect / flag the kanban card left behind
 * when a session is closed (soft-deleted / archived).
 *
 * ## Why
 * The board tolerates card-less sessions: a chat / one-off question never needs
 * a board card, and Finalize lazily materializes one only when code actually
 * ships (`server/finalize/ensure-kanban-card.ts`). But agents, following the
 * "Bias to Action — create the kanban card" prompt, often POST a card at the
 * very start of a turn. When that turn is a throwaway question or an abandoned
 * implementation, the card never progresses and the session is later closed —
 * leaving a stale, irrelevant ticket cluttering the board.
 *
 * ## What this does (on session close)
 * Look up the card linked to the closing session (`kanban_cards.session_id`).
 * Then:
 *   - **delete** it when it's a pristine, agent-filed stub that never
 *     progressed — no PR, no finalize run, still parked in an initial column,
 *     no comments, no epic. This is the abandoned-ticket case the cleanup
 *     targets.
 *   - **flag** it (set `kanban_cards.orphaned_at`) when it *did* progress — it
 *     has a PR / finalize run / advanced column / comments / epic / linked
 *     GitHub issue / blocker edge, or was dispatched autonomously. We must not
 *     delete real work, but its working session is gone, so we mark it orphaned
 *     for human attention.
 *   - **keep** (do nothing) when the card was not agent-filed — a human, the
 *     intake agent, or a support-ticket conversion created it. Those are never
 *     touched.
 *
 * Everything is best-effort: a failure here must never block session deletion.
 */
import { isColumnDone, isColumnShippedLane } from './kanban-blockers.js';
import type {
  AgentLookup,
  BroadcastFn,
  KanbanBoardRow,
  KanbanCardCommentRow,
  KanbanCardRow,
  KanbanColumnRow,
  SessionRow,
  Stmts,
} from './types.js';

export type OrphanCardAction = 'delete' | 'flag' | 'keep' | 'none';

export interface CardCloseSignals {
  /** Card was filed by the session's own agent (or lazily with no author) —
   *  i.e. NOT by a human, the intake agent, or a support-ticket conversion. */
  isAgentFiled: boolean;
  /** Card already carries a PR url. */
  hasPr: boolean;
  /** A Finalize run exists for the closing session. */
  hasFinalizeRun: boolean;
  /** Card sits in a Review / Done / Shipped lane (i.e. advanced past intake). */
  inAdvancedColumn: boolean;
  /** Card was claimed by autonomous dispatch. */
  isAutonomous: boolean;
  /** Card has at least one comment. */
  hasComments: boolean;
  /** Card is grouped under an epic. */
  hasEpic: boolean;
  /** Card is linked to a GitHub issue — a real, externally-tracked work item. */
  hasGithubIssue: boolean;
  /** Card participates in at least one blocker edge (in either direction) —
   *  accumulated coordination state that deleting the card would silently drop
   *  (the FK cascade would also un-block any downstream card). */
  hasBlockers: boolean;
  /** Card is already flagged orphaned (idempotency guard). */
  alreadyOrphaned: boolean;
}

export interface OrphanCardDecision {
  action: OrphanCardAction;
  reason: string;
}

/**
 * Pure decision function — given the gathered signals for the card linked to a
 * closing session, decide whether to delete it, flag it orphaned, or leave it
 * alone. Kept side-effect-free so it is exhaustively unit-testable.
 */
export function classifyCardOnSessionClose(signals: CardCloseSignals): OrphanCardDecision {
  // Never touch cards a human / intake / support flow owns.
  if (!signals.isAgentFiled) {
    return { action: 'keep', reason: 'not-agent-filed' };
  }
  // Idempotent: an already-flagged card stays flagged (don't re-broadcast).
  if (signals.alreadyOrphaned) {
    return { action: 'keep', reason: 'already-orphaned' };
  }

  const progressedReasons: string[] = [];
  if (signals.hasPr) progressedReasons.push('pr');
  if (signals.hasFinalizeRun) progressedReasons.push('finalize-run');
  if (signals.inAdvancedColumn) progressedReasons.push('advanced-column');
  if (signals.isAutonomous) progressedReasons.push('autonomous');
  if (signals.hasComments) progressedReasons.push('comments');
  if (signals.hasEpic) progressedReasons.push('epic');
  if (signals.hasGithubIssue) progressedReasons.push('github-issue');
  if (signals.hasBlockers) progressedReasons.push('blockers');

  if (progressedReasons.length > 0) {
    // Real work that lost its session → keep but flag (per product decision:
    // "if the session did progress, flag it as orphaned").
    return { action: 'flag', reason: `progressed:${progressedReasons.join('+')}` };
  }

  // Pristine, never-progressed, agent-filed stub → safe to garbage-collect.
  return { action: 'delete', reason: 'abandoned-stub' };
}

/** Is `columnName` an advanced (post-intake) lane — Review, Shipped, or Done? */
export function isAdvancedColumn(columnName: string | null | undefined): boolean {
  if (isColumnDone(columnName) || isColumnShippedLane(columnName)) return true;
  return /\breview\b/i.test((columnName ?? '').trim());
}

/**
 * Decide whether `createdBy` marks an agent-filed card. Agent-filed means the
 * author is empty (lazy/script default) or resolves to the session's own agent
 * (by name or id). Anything else — a human username, `support-ticket`, an
 * intake agent's name — is treated as externally owned and never deleted.
 */
export function isAgentFiledCard(
  createdBy: string | null | undefined,
  agent: { id: string; name: string } | null,
): boolean {
  const author = (createdBy ?? '').trim();
  if (!author) return true;
  if (!agent) return false;
  return author === agent.id || author.toLowerCase() === agent.name.toLowerCase();
}

export interface OrphanCleanupDeps {
  stmts: Stmts;
  broadcast: BroadcastFn;
  findAgent: (agentId: string) => AgentLookup | null;
}

export interface OrphanCleanupResult {
  action: OrphanCardAction;
  reason: string;
  cardId?: string;
  projectId?: string;
}

/**
 * Gather signals for the card linked to `sessionId` and execute the cleanup
 * decision (delete / flag / keep). Best-effort and self-contained: resolves the
 * board, column, finalize run, comments, and agent from the session, then
 * broadcasts a `kanban_update` only when the board actually changed.
 */
export function cleanupOrphanCardForClosedSession(
  deps: OrphanCleanupDeps,
  sessionId: string,
): OrphanCleanupResult {
  const { stmts, broadcast, findAgent } = deps;

  const card = stmts.getKanbanCardBySession.get(sessionId) as KanbanCardRow | undefined;
  if (!card) return { action: 'none', reason: 'no-linked-card' };

  const board = stmts.getKanbanBoardById.get(card.board_id) as KanbanBoardRow | undefined;
  const projectId = board?.project_id;

  const session = stmts.getSession.get(sessionId) as SessionRow | undefined;
  const agentLookup = session?.agent_id ? findAgent(session.agent_id) : null;
  const agent = agentLookup ? { id: agentLookup.agent.id, name: agentLookup.agent.name } : null;

  const column = stmts.getKanbanColumn.get(card.column_id) as KanbanColumnRow | undefined;
  const finalizeRun = stmts.getLatestFinalizeRunForSession.get(sessionId);
  const comments = stmts.getKanbanCardComments.all(card.id) as KanbanCardCommentRow[];
  const blockerEdgeCount =
    (stmts.countBlockerEdgesForCard.get(card.id, card.id) as { n: number } | undefined)?.n ?? 0;

  const signals: CardCloseSignals = {
    isAgentFiled: isAgentFiledCard(card.created_by, agent),
    hasPr: Boolean(card.pr_url && card.pr_url.trim()),
    hasFinalizeRun: Boolean(finalizeRun),
    inAdvancedColumn: isAdvancedColumn(column?.name),
    isAutonomous: Boolean(card.dispatched_by_autonomous),
    hasComments: comments.length > 0,
    hasEpic: Boolean(card.epic_id),
    hasGithubIssue: Boolean(card.github_issue_url && card.github_issue_url.trim()),
    hasBlockers: blockerEdgeCount > 0,
    alreadyOrphaned: Boolean(card.orphaned_at),
  };

  const decision = classifyCardOnSessionClose(signals);

  if (decision.action === 'delete') {
    stmts.deleteKanbanCard.run(card.id);
  } else if (decision.action === 'flag') {
    stmts.markKanbanCardOrphaned.run(card.id);
  }

  if ((decision.action === 'delete' || decision.action === 'flag') && projectId) {
    try {
      broadcast({ type: 'kanban_update', projectId });
    } catch {
      /* best-effort: a broadcast failure must not surface to the caller */
    }
  }

  return { action: decision.action, reason: decision.reason, cardId: card.id, projectId };
}
