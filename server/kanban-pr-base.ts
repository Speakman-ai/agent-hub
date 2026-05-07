/**
 * Shared PR base branch parsing and epic/card resolution for worktree sync
 * and `gh pr create --base`.
 */

import type { KanbanCardRow, KanbanEpicRow } from './types.js';

const SAFE_BRANCH_RE = /^[A-Za-z0-9._/-]+$/;

/** Reject values that would break `gh` argv or confuse git. */
export function parsePrBaseBranchInput(
  raw: unknown,
): { ok: true; value: string | null } | { ok: false; error: string } {
  if (raw == null || String(raw).trim() === '') {
    return { ok: true, value: null };
  }
  const trimmed = String(raw).trim();
  if (!SAFE_BRANCH_RE.test(trimmed)) {
    return {
      ok: false,
      error:
        'Invalid pr_base_branch: must contain only letters, digits, dots, dashes, underscores, and slashes',
    };
  }
  return { ok: true, value: trimmed };
}

/**
 * Effective base branch for worktree / auto-PR: card override wins, else the
 * linked epic's default (when the card belongs to an epic).
 */
export function effectivePrBaseBranch(
  card: Pick<KanbanCardRow, 'pr_base_branch' | 'epic_id'> | null | undefined,
  epic: Pick<KanbanEpicRow, 'pr_base_branch'> | null | undefined,
): string | null {
  const fromCard = card?.pr_base_branch?.trim();
  if (fromCard) return fromCard;
  const fromEpic = epic?.pr_base_branch?.trim();
  if (fromEpic) return fromEpic;
  return null;
}
