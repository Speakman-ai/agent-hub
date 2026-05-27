import { v4 as uuidv4 } from 'uuid';
import type { BroadcastFn, MessageRow, Stmts } from './types.js';

// ─── Worktree-creation failure handler ───────────────────────────────────────
//
// When `ensureSessionWorkspace` fails to create a session worktree we used to
// just flip `sessions.use_worktree → 0` and broadcast a `worktree_failed`
// event into the void. No client listened for it, no system message landed in
// the chat, no comment was posted on the linked kanban card. The agent's
// dispatch prompt still claimed "a PR will be created automatically" so the
// agent worked around the missing worktree with a manual `git worktree add`,
// committed locally, and stopped. Auto-PR silently never fired.
//
// This module makes that failure loud:
//  1. `[worktree-failed]` server log line at the moment of failure (distinct
//     from the per-turn `[auto-commit] skipping (not a worktree)` lines so it
//     can be grepped at the moment of failure rather than retroactively).
//  2. Flip `sessions.use_worktree → 0` so subsequent turns don't keep retrying
//     worktree creation.
//  3. Insert a `role='system'` message into the affected session explaining
//     what happened and what to do next. Broadcast it so the chat panel
//     renders it live.
//  4. If the session is linked to a kanban card, post a comment with the same
//     body so the failure is visible on the card too.
//  5. Broadcast a `worktree_failed` event for any UI surface that wants to
//     toast / banner separately from the inline system bubble.
//
// Every side-effect is best-effort: if one step throws we log a `[worktree-
// failed]` warning and move on so the remaining steps still run.

type CardRow = { id: string; board_id: string };
type BoardRow = { id: string; project_id: string };

export function buildWorktreeFailureMessage(errorMessage: string): string {
  return [
    '**Worktree creation failed — auto-PR is disabled for this session.**',
    '',
    `Error: ${errorMessage}`,
    '',
    'Effect:',
    '- Edits will land in the project checkout, not an isolated worktree.',
    '- The auto-commit / auto-PR pipeline will NOT run for this session.',
    '- If you commit, you must push the branch and open the PR manually.',
    '',
    'To recover, ask the operator to investigate the worktree failure and start a new session.',
  ].join('\n');
}

export interface WorktreeFailureDeps {
  stmts: Stmts;
  broadcast: BroadcastFn;
}

/**
 * Run the worktree-failure-side effects for a single session: clear the
 * worktree flag, post a system message, comment on the linked card, and
 * broadcast a `worktree_failed` event. Every step is wrapped in its own
 * try/catch so a single failure cannot suppress the rest.
 */
export function handleWorktreeFailure(
  deps: WorktreeFailureDeps,
  sessionId: string,
  errorMessage: string,
): void {
  const { stmts, broadcast } = deps;

  // 1. Distinct, greppable log line at the moment of failure.
  console.warn(`[worktree-failed] session=${sessionId} reason=${errorMessage}`);

  // 2. Stop subsequent turns from retrying (and masking the failure).
  try {
    stmts.updateSessionWorktree.run(0, sessionId);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      `[worktree-failed] failed to clear use_worktree for session ${sessionId}: ${message}`,
    );
  }

  const body = buildWorktreeFailureMessage(errorMessage);

  // 3. System message into the session so the agent (next turn's history) and
  //    the chat UI both see the failure.
  try {
    const msgId = uuidv4();
    stmts.addMessage.run(
      msgId,
      sessionId,
      'system',
      body,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
    );
    try {
      stmts.touchSession.run(sessionId);
    } catch {
      /* best-effort */
    }
    const inserted = stmts.getMessageById.get(msgId) as MessageRow | undefined;
    if (inserted) {
      try {
        broadcast({ type: 'message', sessionId, message: inserted });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[worktree-failed] message broadcast failed for ${sessionId}: ${message}`);
      }
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[worktree-failed] system message insert failed for ${sessionId}: ${message}`);
  }

  // 4. Card comment when the session is linked to a kanban card.
  try {
    const card = stmts.getKanbanCardBySession.get(sessionId) as CardRow | undefined;
    if (card) {
      try {
        stmts.createKanbanCardComment.run(uuidv4(), card.id, 'Agent Hub', body);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(
          `[worktree-failed] card comment insert failed for card ${card.id}: ${message}`,
        );
      }
      try {
        const board = stmts.getKanbanBoardById.get(card.board_id) as BoardRow | undefined;
        if (board?.project_id) {
          broadcast({ type: 'kanban_update', projectId: board.project_id });
        }
      } catch {
        /* best-effort UI refresh — the comment is already persisted. */
      }
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[worktree-failed] card lookup failed for session ${sessionId}: ${message}`);
  }

  // 5. Standalone event so future toast/banner surfaces can react without
  //    re-parsing message bodies. Kept after the inline surfaces so even if a
  //    broadcast throws the persistent state is already in place.
  try {
    broadcast({ type: 'worktree_failed', sessionId, error: errorMessage });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[worktree-failed] worktree_failed broadcast failed for ${sessionId}: ${message}`);
  }
}
