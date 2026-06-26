/**
 * Kanban side effects for a github.com PR that Agent Hub knows has merged.
 *
 * Native Agent Hub-hosted PRs run through native-pr/card-on-merge.ts. This file
 * covers GitHub-backed projects where the merge happened through Agent Hub's
 * own `/api/pr/merge` route or Finalize auto-merge. It mirrors the native path:
 * resolve/link the card, move it to a Done-ish column, write an audit comment,
 * and emit the legacy `webhook_pr_merged` broadcast used by push notifications.
 */
import { randomUUID } from 'crypto';
import type { BroadcastFn, KanbanCardRow, KanbanColumnRow, Stmts } from './types.js';
import { pickDoneColumn } from './card-auto-close.js';
import { findKanbanCardForIncomingPr, linkKanbanCardPrUrl } from './kanban-pr-link.js';
import { getOrCreateBoard } from './routes/board.js';

export interface GithubCardOnMergeDeps {
  stmts: Stmts;
  broadcast: BroadcastFn;
}

export interface GithubCardOnMergeArgs {
  projectId: string;
  prUrl: string;
  prNumber?: number;
  prTitle?: string | null;
  headRef?: string | null;
  mergedBy: string;
  mergeMethod?: string | null;
}

export function handleGithubCardOnMerge(
  deps: GithubCardOnMergeDeps,
  args: GithubCardOnMergeArgs,
): void {
  const { stmts, broadcast } = deps;
  const { projectId, prUrl } = args;

  let card: KanbanCardRow | undefined;
  let cols: KanbanColumnRow[] = [];
  try {
    const board = getOrCreateBoard(stmts, projectId);
    cols = board.columns;
    const found = findKanbanCardForIncomingPr(stmts, board.board.id, {
      prUrl,
      headRef: args.headRef,
      prTitle: args.prTitle,
      cols,
      prNumber: args.prNumber,
    });
    card = found.card;
    if (card && found.path !== 'already_linked') {
      linkKanbanCardPrUrl(stmts, broadcast, projectId, card, prUrl, found.path, args.prNumber);
    }
  } catch (err: unknown) {
    console.warn(
      `[github-pr] card discovery failed for ${prUrl}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  if (card) {
    try {
      const freshBoard = getOrCreateBoard(stmts, projectId);
      cols = freshBoard.columns;
      const done = pickDoneColumn(cols);
      const fresh = stmts.getKanbanCard.get(card.id) as KanbanCardRow | undefined;
      if (done && fresh && fresh.column_id !== done.id) {
        stmts.moveKanbanCard.run(done.id, 0, card.id);
        broadcast({ type: 'kanban_update', projectId });
        broadcast({
          type: 'card_moved',
          projectId,
          cardId: card.id,
          cardTitle: fresh.title,
          columnName: done.name,
          assignee: fresh.assignee,
          prUrl: fresh.pr_url ?? prUrl,
          sessionId: fresh.session_id || undefined,
        });
      }
      stmts.createKanbanCardComment.run(
        randomUUID(),
        card.id,
        'agenthub',
        `Merged PR #${args.prNumber ?? '?'} (${args.mergeMethod ?? 'squash'}) by ${args.mergedBy}`,
      );
      broadcast({ type: 'kanban_update', projectId });
    } catch (err: unknown) {
      console.warn(
        `[github-pr] card Done-move failed for ${prUrl}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  broadcast({
    type: 'webhook_pr_merged',
    projectId,
    prNumber: args.prNumber,
    prUrl,
    cardId: card?.id,
    cardTitle: card?.title,
    mergedBy: args.mergedBy,
  });
}
