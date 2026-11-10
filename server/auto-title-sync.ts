/**
 * Keep a session's auto-owned name and its auto-derived card title in step.
 *
 * Finalize creates a card from the session name when the session had none, and
 * that card title later wins as the PR title. Both the session name and that
 * card title are machine-derived, so when a better title shows up (the model's
 * whole-session title, or the PR title synthesized from the shipped commits)
 * both follow it. Human-set names are never touched: sessions only change while
 * `title_source` is 'auto' (or a placeholder with no source), cards only while
 * their `title_source` is 'auto'.
 */
import type { BroadcastFn, KanbanBoardRow, KanbanCardRow, SessionRow, Stmts } from './types.js';
import { enrichSessionForClient } from './session-checkpoint-rewind.js';
import { isLowSignalTitle, isPlaceholderSessionTitle } from './session-title.js';

export interface AutoTitleSyncDeps {
  stmts: Stmts;
  broadcast: BroadcastFn;
}

function linkedCard(stmts: Stmts, sessionId: string): KanbanCardRow | undefined {
  try {
    return stmts.getKanbanCardBySession.get(sessionId) as KanbanCardRow | undefined;
  } catch {
    return undefined;
  }
}

/** True when the card's title was derived and may still be rewritten. */
export function isAutoCardTitle(card: Pick<KanbanCardRow, 'title_source'> | null | undefined) {
  return card?.title_source === 'auto';
}

/** True when the session name belongs to the automatic title flow. */
export function isAutoSessionTitle(session: Pick<SessionRow, 'name' | 'title_source'>): boolean {
  const source = (session.title_source ?? '').trim();
  if (source === 'auto') return true;
  return !source && isPlaceholderSessionTitle(session.name);
}

/**
 * Rewrite the session's auto-derived card to `title`. Returns true when the
 * card changed.
 */
export function syncAutoCardTitle(
  deps: AutoTitleSyncDeps,
  sessionId: string,
  title: string,
): boolean {
  const next = title.trim();
  if (isLowSignalTitle(next)) return false;
  const card = linkedCard(deps.stmts, sessionId);
  if (!card || !isAutoCardTitle(card) || card.title === next) return false;
  const result = deps.stmts.updateAutoKanbanCardTitle.run(next, card.id) as { changes?: number };
  if (!result.changes) return false;
  const board = deps.stmts.getKanbanBoardById.get(card.board_id) as KanbanBoardRow | undefined;
  if (board) deps.broadcast({ type: 'kanban_update', projectId: board.project_id });
  return true;
}

/**
 * Adopt a title produced from the shipped change: rename the session when its
 * name is still auto-owned, and the linked card when it is auto-derived.
 */
export function adoptShippedTitle(deps: AutoTitleSyncDeps, sessionId: string, title: string) {
  const next = title.trim();
  if (isLowSignalTitle(next)) return { session: false, card: false };
  let sessionChanged = false;
  const session = deps.stmts.getSession.get(sessionId) as SessionRow | undefined;
  if (session && session.name !== next && isAutoSessionTitle(session)) {
    deps.stmts.updateSessionNameWithTitleSource.run(next, 'auto', sessionId);
    const updated = deps.stmts.getSession.get(sessionId) as SessionRow | undefined;
    if (updated) {
      deps.broadcast({
        type: 'session-updated',
        session: enrichSessionForClient(updated, deps.stmts),
      });
    }
    sessionChanged = true;
  }
  const cardChanged = syncAutoCardTitle(deps, sessionId, next);
  return { session: sessionChanged, card: cardChanged };
}
