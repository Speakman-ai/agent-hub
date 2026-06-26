/**
 * card-on-merge.ts — kanban + event side effects after a native PR merge.
 *
 * This replaces the GitHub `pull_request.merged` webhook signal (removed)
 * for Agent Hub-hosted projects: card discovery reuses the exact helpers
 * the webhook used (`findKanbanCardForIncomingPr` / `linkKanbanCardPrUrl`),
 * the Done-move mirrors `finalize/card-lifecycle.ts`, and the
 * `webhook_pr_merged` broadcast keeps its legacy type name so the
 * push-notification bridge (server/push.ts) fires unchanged.
 *
 * This is the canonical Done transition: "Done means merged, not pushed."
 * By default (`cardDoneOnPush=false`) finalize's post-push-detach parks the
 * card in Review and this merge handler is what moves it to Done. If an
 * operator opts into `cardDoneOnPush=true` ("pushed = shipped"), the card may
 * already be in Done; both moves are idempotent by column check, so
 * merge-after-push is a no-op move plus one comment — acceptable.
 */

import { randomUUID } from 'crypto';
import type {
  BroadcastFn,
  KanbanCardRow,
  KanbanColumnRow,
  PullRequestRow,
  Stmts,
} from '../types.js';
import { findKanbanCardForIncomingPr, linkKanbanCardPrUrl } from '../kanban-pr-link.js';
import { getOrCreateBoard } from '../routes/board.js';
import { pickDoneColumn } from '../card-auto-close.js';
import { buildNativePrUrl } from './url.js';

export interface CardOnMergeDeps {
  stmts: Stmts;
  broadcast: BroadcastFn;
  /** Done-column name override (defaults to 'Done'). */
  doneColumnName?: string;
}

export function handleCardOnMerge(
  deps: CardOnMergeDeps,
  projectId: string,
  pr: PullRequestRow,
  mergedBy: string,
): void {
  const { stmts, broadcast } = deps;
  const prUrl = buildNativePrUrl(projectId, pr.number);

  let card: KanbanCardRow | undefined;
  let cols: KanbanColumnRow[] = [];
  try {
    const board = getOrCreateBoard(stmts, projectId);
    cols = board.columns;
    const found = findKanbanCardForIncomingPr(stmts, board.board.id, {
      prUrl,
      headRef: pr.head_branch,
      prTitle: pr.title,
      cols,
      prNumber: pr.number,
    });
    card = found.card;
    if (card && found.path !== 'already_linked') {
      linkKanbanCardPrUrl(stmts, broadcast, projectId, card, prUrl, found.path, pr.number);
    }
  } catch (err: unknown) {
    console.warn(
      `[native-pr] card discovery failed for ${projectId}#${pr.number}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  if (card) {
    try {
      const freshBoard = getOrCreateBoard(stmts, projectId);
      cols = freshBoard.columns;
      const doneName = deps.doneColumnName;
      const done = doneName ? cols.find((c) => c.name === doneName) : pickDoneColumn(cols);
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
        `Merged PR #${pr.number} (${pr.merge_method ?? 'squash'}) by ${mergedBy}`,
      );
      broadcast({ type: 'kanban_update', projectId });
    } catch (err: unknown) {
      console.warn(
        `[native-pr] card Done-move failed for ${projectId}#${pr.number}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  // Legacy type name on purpose — the push-notification bridge in
  // server/push.ts maps `webhook_pr_merged` → a `pr_merged` push and the
  // client re-renders off `kanban_update`/`card_moved`.
  broadcast({
    type: 'webhook_pr_merged',
    projectId,
    prNumber: pr.number,
    prUrl,
    cardId: card?.id,
    cardTitle: card?.title,
    mergedBy,
  });
}
