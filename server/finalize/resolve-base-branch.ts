import { effectivePrBaseBranch } from '../kanban-pr-base.js';
import { resolveDefaultBranch } from '../git-default-branch.js';
import type { KanbanCardRow, KanbanEpicRow } from '../types.js';

const SAFE_BRANCH_RE = /^[A-Za-z0-9._/-]+$/;
const FALLBACK_DEFAULT_BRANCH = 'main';

/**
 * Effective rebase / PR base for Finalize: card → epic override, else git
 * default branch detection, else `main`.
 */
export async function resolveFinalizeBaseBranch(args: {
  card: Pick<KanbanCardRow, 'pr_base_branch' | 'epic_id'>;
  epic?: Pick<KanbanEpicRow, 'pr_base_branch'> | null;
  worktreePath: string;
}): Promise<string> {
  const configured = effectivePrBaseBranch(args.card, args.epic ?? null);
  if (configured && SAFE_BRANCH_RE.test(configured)) {
    return configured;
  }
  const detected = await resolveDefaultBranch(args.worktreePath);
  return detected ?? FALLBACK_DEFAULT_BRANCH;
}

export async function resolveFinalizeBaseBranchForCard(args: {
  card: KanbanCardRow;
  worktreePath: string;
  getEpic?: (epicId: string) => KanbanEpicRow | undefined;
}): Promise<string> {
  const epic = args.card.epic_id && args.getEpic ? (args.getEpic(args.card.epic_id) ?? null) : null;
  return resolveFinalizeBaseBranch({
    card: args.card,
    epic,
    worktreePath: args.worktreePath,
  });
}
