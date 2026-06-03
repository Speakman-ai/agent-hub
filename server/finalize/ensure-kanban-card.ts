/**
 * ensure-kanban-card.ts — create/link a kanban card for a card-less session.
 *
 * Ad-hoc chat sessions can ship through Finalize Code Changes without the
 * operator manually filing a board card first. The session-scoped finalize
 * trigger calls this before kicking off the orchestrator.
 */
import { v4 as uuidv4 } from 'uuid';
import type {
  BroadcastFn,
  KanbanBoardRow,
  KanbanCardRow,
  KanbanColumnRow,
  SessionRow,
  Stmts,
} from '../types.js';
import { getOrCreateBoard } from '../routes/board.js';
import { maybeRenameSessionForLinkedCard } from '../kanban-caller-session.js';
import { enrichSessionForClient } from '../session-checkpoint-rewind.js';
import type { AgentLookup } from '../types.js';

export interface EnsureKanbanCardDeps {
  stmts: Stmts;
  broadcast: BroadcastFn;
  findAgent: (agentId: string) => AgentLookup | null;
}

export interface EnsureKanbanCardResult {
  card: KanbanCardRow;
  created: boolean;
}

function resolveInProgressColumnId(columns: KanbanColumnRow[]): string {
  const inProgress = columns.find((c) => c.name.toLowerCase() === 'in progress');
  if (inProgress) return inProgress.id;
  const sorted = [...columns].sort((a, b) => a.position - b.position);
  if (!sorted[0]) throw new Error('Board has no columns');
  return sorted[0].id;
}

function defaultCardTitle(session: SessionRow): string {
  const name = session.name?.trim();
  if (name) return name.slice(0, 200);
  return 'Session work';
}

/**
 * Return the kanban card linked to `session`, creating one on the project
 * board when missing.
 */
export function ensureKanbanCardForSession(
  deps: EnsureKanbanCardDeps,
  args: { projectId: string; session: SessionRow; createdBy?: string | null },
): EnsureKanbanCardResult {
  const { projectId, session, createdBy = null } = args;
  const existing = deps.stmts.getKanbanCardBySession.get(session.id) as KanbanCardRow | undefined;
  if (existing) {
    const board = deps.stmts.getKanbanBoard.get(projectId) as KanbanBoardRow | undefined;
    if (board && existing.board_id === board.id) {
      return { card: existing, created: false };
    }
  }

  const { board, columns } = getOrCreateBoard(deps.stmts, projectId);
  const columnId = resolveInProgressColumnId(columns);
  const existingCards = deps.stmts.getKanbanCardsByColumn.all(columnId) as KanbanCardRow[];
  const maxPos =
    existingCards.length > 0 ? Math.max(...existingCards.map((c) => c.position)) + 1 : 0;

  const title = defaultCardTitle(session);
  const assignee = deps.findAgent(session.agent_id)?.agent.name ?? null;
  const id = uuidv4();

  deps.stmts.createKanbanCard.run(
    id,
    columnId,
    board.id,
    title,
    null,
    'medium',
    assignee,
    null,
    session.id,
    null,
    createdBy,
    null,
    maxPos,
  );

  const card = deps.stmts.getKanbanCard.get(id) as KanbanCardRow;
  deps.broadcast({ type: 'kanban_update', projectId });
  maybeRenameSessionForLinkedCard(deps.stmts, deps.broadcast, session.id, title);

  const refreshed = deps.stmts.getSession.get(session.id) as SessionRow | undefined;
  if (refreshed) {
    deps.broadcast({
      type: 'session-updated',
      session: enrichSessionForClient(refreshed, deps.stmts),
    });
  }

  return { card, created: true };
}
