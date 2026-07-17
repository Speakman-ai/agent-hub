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

/**
 * The base a session's committable / net-diff gate should measure against.
 *
 *  - `explicit`   — the card/epic configured an authoritative `pr_base_branch`
 *    (a stacked feature branch). The net-diff gate MUST prove a real diff vs
 *    this branch and fails closed if it cannot.
 *  - `default`    — no configured override: the real base IS the repo default,
 *    so the gate auto-detects it and keeps the legacy fail-open behavior.
 *  - `unresolved` — a card exists but its authoritative base could not be
 *    determined (malformed override, or an error resolving the epic). We must
 *    NOT silently fall back to probing the repo default — that is exactly the
 *    empty-stacked-change hole this guard closes — so the gate fails closed.
 */
export type FinalizeGateBase =
  | { kind: 'explicit'; baseBranch: string }
  | { kind: 'default' }
  | { kind: 'unresolved' };

/**
 * Resolve the committable/net-diff gate base for a session. No card (or no
 * worktree) → `default` (legacy repo-default path). A card with a valid
 * configured override → `explicit`. A card whose override is malformed, or
 * whose base resolution throws → `unresolved` (block; never silently default).
 */
export function resolveFinalizeGateBase(args: {
  card: KanbanCardRow | null | undefined;
  worktreePath: string | null | undefined;
  getEpic?: (epicId: string) => KanbanEpicRow | undefined;
}): FinalizeGateBase {
  if (!args.card || !args.worktreePath) return { kind: 'default' };
  try {
    const epic =
      args.card.epic_id && args.getEpic ? (args.getEpic(args.card.epic_id) ?? null) : null;
    const configured = effectivePrBaseBranch(args.card, epic);
    if (configured) {
      // A configured PR base is authoritative. A malformed value means we
      // cannot trust the target, so block rather than silently probe default.
      return SAFE_BRANCH_RE.test(configured)
        ? { kind: 'explicit', baseBranch: configured }
        : { kind: 'unresolved' };
    }
    // Card-backed but no override → the real base IS the repo default; probing
    // the default here is correct, not a silent downgrade.
    return { kind: 'default' };
  } catch {
    // Card exists but its base could not be resolved (e.g. epic lookup failed):
    // surface an undeterminable authoritative-base state so the gate blocks.
    return { kind: 'unresolved' };
  }
}
