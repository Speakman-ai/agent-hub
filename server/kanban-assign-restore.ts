import { randomUUID } from 'crypto';
import { recomputeEpicState } from './epic-state.js';
import type { BroadcastFn, KanbanCardRow, Stmts } from './types.js';

/**
 * Undo an assign whose agent session failed to start. The assign route writes
 * the card (In Progress, new session_id, assignee) before handing the first
 * message to the engine; if that start rejects, leaving those writes in place
 * parks the card on a session that never ran. Only restores when the card still
 * points at the failed session, so a later assign wins, and only moves it back
 * if it still sits in the column the assign put it in, so a manual move made
 * while the start was pending is kept.
 */
export function restoreCardAfterFailedAssign(
  stmts: Stmts,
  broadcast: BroadcastFn,
  args: {
    before: KanbanCardRow;
    sessionId: string;
    /** Column the assign moved the card into. */
    assignedColumnId: string;
    projectId: string;
    reason: string;
  },
): boolean {
  const { before, sessionId, assignedColumnId, projectId, reason } = args;
  try {
    const current = stmts.getKanbanCard.get(before.id) as KanbanCardRow | undefined;
    if (!current || current.session_id !== sessionId) return false;
    stmts.updateKanbanCard.run(
      current.title,
      current.description,
      current.priority,
      before.assignee,
      current.labels,
      before.session_id,
      current.github_issue_url,
      current.pr_url,
      current.epic_id,
      current.phase_id ?? null,
      before.assign_model ?? null,
      before.assign_engine ?? null,
      current.pr_base_branch ?? null,
      before.id,
    );
    if (current.column_id === assignedColumnId) {
      stmts.moveKanbanCard.run(before.column_id, before.position ?? 0, before.id);
      // The assign recomputed the epic for In Progress; undo that too.
      try {
        recomputeEpicState(stmts, current.epic_id);
      } catch {
        /* the restore is authoritative; a stale epic aggregate self-heals on the next card change */
      }
    }
    stmts.createKanbanCardComment.run(
      randomUUID(),
      before.id,
      'agenthub',
      `Assignment undone: session ${sessionId.slice(0, 8)} failed to start (${reason.slice(0, 300)}).`,
    );
    broadcast({ type: 'kanban_update', projectId });
    return true;
  } catch (err: unknown) {
    console.warn(
      `[Board Assign] restoring card ${before.id} after failed start: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return false;
  }
}
