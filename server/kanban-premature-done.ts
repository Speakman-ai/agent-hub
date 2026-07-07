/**
 * Premature-Done guard for the board card-move endpoint.
 *
 * Done means merged for Finalize-gated work: the platform writes Done when
 * the push/merge lands (finalize post-push detach, PR card-on-merge). When
 * an agent instead moves its linked card to Done at the end of its coding
 * turn, the board bounces: the card sits in Done for the ~30s until the
 * end-of-turn automation starts Finalize, `card-lifecycle.onStarted` pulls
 * it back to In Progress for the whole checks/review window, and the merge
 * closes it a second time. This guard rejects that first premature move at
 * the REST seam.
 *
 * Scope: ONLY `POST /board/cards/:cardId/move` consults this. Platform
 * Done-writers (post-push detach, card-on-merge, `<agenthub:close-card>`
 * auto-close, epic-spec completion) call `moveKanbanCard` directly and are
 * unaffected. The guard fires only when every hold applies:
 *
 *   - the target column is a Done column (`isColumnDone` semantics),
 *   - the card is linked to a session with a worktree,
 *   - that worktree is Finalize-gated (`.agent-hub/ci.yaml` present),
 *   - the session has not pushed through Finalize yet,
 *   - the caller did not pass `force: true` (operator escape hatch).
 *
 * Cancelled/other columns, unlinked cards, non-gated projects, and
 * already-pushed sessions all pass through untouched.
 *
 * **`force` is deliberately unauthenticated.** Every board caller — agents
 * via the break-glass `x-api-key` and humans via JWT — can pass
 * `force: true`, so the guard is a guardrail, not an enforcement boundary:
 * it corrects the default agent flow (prompts no longer instruct a Done
 * move, and a bare move now fails loudly instead of silently bouncing) and
 * gives humans a UI confirm step, but it cannot stop a caller that
 * explicitly opts out. That is accepted: the API key is already an
 * all-orgs-Owner credential, so there is no lower-privilege tier to gate
 * `force` on, and platform Done-writers bypass the route entirely. If a
 * hard boundary is ever needed, gate `force` on an authenticated human
 * role at the route layer.
 */
import { isColumnDone } from './kanban-blockers.js';
import { hasPushedFinalizeRun } from './finalize/post-push-session-lock.js';
import { worktreeHasFinalizeCi } from './finalize/worktree-has-ci.js';
import type { KanbanCardRow, SessionRow, Stmts } from './types.js';

export const PREMATURE_DONE_ERROR = 'premature_done_move';

export const PREMATURE_DONE_MESSAGE =
  'Done is written on merge for Finalize-gated sessions. Leave this card in ' +
  'In Progress — Finalize moves it automatically when the push/merge lands. ' +
  'Pass "force": true to override (operator escape hatch).';

export interface PrematureDoneMoveArgs {
  stmts: Pick<Stmts, 'getSession' | 'getPushedFinalizeRunForSession'>;
  card: Pick<KanbanCardRow, 'session_id'>;
  /** Name of the column the move targets. */
  targetColumnName: string;
  /** Explicit override from the request body — skips the guard entirely. */
  force?: boolean;
  /** Injectable for tests; defaults to the fs-backed ci.yaml probe. */
  hasFinalizeCi?: (worktreePath: string | null | undefined) => boolean;
}

/** True when the move must be rejected as a premature Done. */
export function blocksPrematureDoneMove(args: PrematureDoneMoveArgs): boolean {
  if (args.force === true) return false;
  if (!isColumnDone(args.targetColumnName)) return false;
  if (!args.card.session_id) return false;

  const session = args.stmts.getSession.get(args.card.session_id) as SessionRow | undefined;
  if (!session?.worktree_path) return false;

  const hasCi = args.hasFinalizeCi ?? worktreeHasFinalizeCi;
  if (!hasCi(session.worktree_path)) return false;

  return !hasPushedFinalizeRun(args.stmts, args.card.session_id);
}
