/**
 * Kanban card ↔ GitHub PR linking helpers.
 *
 * Three discovery paths (in priority order):
 *   1. Card already has matching `pr_url`
 *   2. Branch carries `session-<8 hex>` or matches `sessions.worktree_branch`
 *   3. Exact card title match (case-insensitive)
 *
 * Callers must invoke {@link linkKanbanCardPrUrl} after a successful find so
 * clients receive `kanban_update` and logs record which path fired.
 */
import type {
  BroadcastFn,
  FinalizeRunRow,
  KanbanCardRow,
  KanbanColumnRow,
  Stmts,
} from './types.js';

/** Matches `session-abcdef12` anywhere in a branch name (e.g. `agent-hub/foo/session-abcdef12`). */
export const SESSION_BRANCH_REF_RE = /session-([a-f0-9]{8})\b/i;

export type KanbanPrLinkPath =
  | 'already_linked'
  | 'finalize_run'
  | 'branch_session_id'
  | 'branch_worktree'
  | 'title'
  | 'none';

export interface FindKanbanCardForPrOpts {
  prUrl: string;
  headRef?: string | null;
  prTitle?: string | null;
  cols: KanbanColumnRow[];
  prNumber?: number;
}

export interface FindKanbanCardForPrResult {
  card: KanbanCardRow | undefined;
  path: KanbanPrLinkPath;
}

function isTerminalKanbanColumnName(name: string): boolean {
  const n = name.toLowerCase().trim();
  return n === 'done' || n === 'cancelled' || n === 'canceled' || n === 'closed';
}

function terminalColumnIds(cols: KanbanColumnRow[]): Set<string> {
  return new Set(cols.filter((c) => isTerminalKanbanColumnName(c.name)).map((c) => c.id));
}

/**
 * Title fallback (find only). Persist via {@link linkKanbanCardPrUrl}.
 * Exported for unit tests; prefer {@link findKanbanCardForIncomingPr}.
 */
export function findKanbanCardByPrTitle(
  stmts: Stmts,
  boardId: string,
  prUrl: string,
  prTitle: string,
  cols: KanbanColumnRow[],
): KanbanCardRow | undefined {
  const terminalColIds = terminalColumnIds(cols);
  const allCards = stmts.getKanbanCards.all(boardId) as KanbanCardRow[];
  const titleLower = prTitle.toLowerCase().trim();
  return allCards.find(
    (c) =>
      !terminalColIds.has(c.column_id) &&
      c.title.toLowerCase().trim() === titleLower &&
      (!c.pr_url || c.pr_url === prUrl),
  );
}

/** @deprecated Use {@link findKanbanCardByPrTitle} — kept for webhook re-export compatibility. */
export const tryLinkKanbanCardByPrTitle = findKanbanCardByPrTitle;

function findCardBySessionIdPrefix(
  stmts: Stmts,
  boardId: string,
  shortId: string,
  terminalColIds: Set<string>,
): KanbanCardRow | undefined {
  const allCards = stmts.getKanbanCards.all(boardId) as KanbanCardRow[];
  const matches = allCards.filter(
    (c) =>
      c.session_id &&
      c.session_id.toLowerCase().startsWith(shortId.toLowerCase()) &&
      !terminalColIds.has(c.column_id),
  );
  if (matches.length === 0) return undefined;
  if (matches.length > 1) {
    console.warn(
      `[KanbanPrLink] ambiguous session prefix "${shortId}" — ${matches.length} cards; using first`,
    );
  }
  return matches[0];
}

function findCardByWorktreeBranch(
  stmts: Stmts,
  headRef: string,
  terminalColIds: Set<string>,
): KanbanCardRow | undefined {
  const rows = stmts.getSessionIdsByWorktreeBranch.all(headRef) as Array<{ id: string }>;
  if (rows.length !== 1) {
    if (rows.length > 1) {
      console.warn(
        `[KanbanPrLink] ambiguous worktree_branch "${headRef}" — ${rows.length} sessions`,
      );
    }
    return undefined;
  }

  const card = stmts.getKanbanCardBySession.get(rows[0].id) as KanbanCardRow | undefined;
  if (!card || terminalColIds.has(card.column_id)) return undefined;
  return card;
}

function findCardByFinalizeRunPrUrl(
  stmts: Stmts,
  boardId: string,
  prUrl: string,
): KanbanCardRow | undefined {
  const run = stmts.getFinalizeRunByPrUrl?.get(prUrl) as FinalizeRunRow | undefined;
  if (!run?.card_id) return undefined;
  const card = stmts.getKanbanCard.get(run.card_id) as KanbanCardRow | undefined;
  if (!card || card.board_id !== boardId) return undefined;
  if (card.pr_url && card.pr_url !== prUrl) return undefined;
  return card;
}

/**
 * Resolve a kanban card for an incoming GitHub PR (webhook / reconcile).
 * Does not broadcast — call {@link linkKanbanCardPrUrl} when `path !== 'none'`.
 */
export function findKanbanCardForIncomingPr(
  stmts: Stmts,
  boardId: string,
  opts: FindKanbanCardForPrOpts,
): FindKanbanCardForPrResult {
  const { prUrl, headRef, prTitle, cols } = opts;
  const terminalColIds = terminalColumnIds(cols);

  const byUrl = stmts.getKanbanCardByPrUrl?.get(prUrl) as KanbanCardRow | undefined;
  if (byUrl) {
    return { card: byUrl, path: 'already_linked' };
  }

  const byFinalizeRun = findCardByFinalizeRunPrUrl(stmts, boardId, prUrl);
  if (byFinalizeRun) {
    return { card: byFinalizeRun, path: 'finalize_run' };
  }

  if (headRef) {
    const branchMatch = headRef.match(SESSION_BRANCH_REF_RE);
    if (branchMatch) {
      const shortId = branchMatch[1];
      const card = findCardBySessionIdPrefix(stmts, boardId, shortId, terminalColIds);
      if (card) {
        return { card, path: 'branch_session_id' };
      }
    }

    const byWorktree = findCardByWorktreeBranch(stmts, headRef, terminalColIds);
    if (byWorktree) {
      return { card: byWorktree, path: 'branch_worktree' };
    }
  }

  if (prTitle) {
    const byTitle = findKanbanCardByPrTitle(stmts, boardId, prUrl, prTitle, cols);
    if (byTitle) {
      return { card: byTitle, path: 'title' };
    }
  }

  return { card: undefined, path: 'none' };
}

/**
 * Persist `pr_url` on a card when unset and notify clients.
 * Returns true when a new link was written.
 */
export function linkKanbanCardPrUrl(
  stmts: Stmts,
  broadcast: BroadcastFn | undefined,
  projectId: string,
  card: KanbanCardRow,
  prUrl: string,
  path: KanbanPrLinkPath,
  prNumber?: number,
): boolean {
  if (card.pr_url === prUrl) return false;
  if (card.pr_url && card.pr_url !== prUrl) return false;

  if (!card.pr_url) {
    try {
      stmts.setCardPrUrl.run(prUrl, card.id);
    } catch {
      return false;
    }
  }

  console.log(
    `[KanbanPrLink] path=${path} pr=#${prNumber ?? '?'} card="${card.title}" id=${card.id}`,
  );

  broadcast?.({ type: 'kanban_update', projectId });
  return true;
}
