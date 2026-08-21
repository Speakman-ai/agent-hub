/**
 * release-gate-candidates.ts — server-side source of truth for what the
 * release-gate editor may offer as a "session to gate on".
 *
 * The picker used to be built client-side from board cards alone: any non-done
 * card with a `session_id` became an option. That listed dead work — cards whose
 * linked session was purged/deleted (a dangling id, sometimes a corrupt
 * comma-joined value) still showed up because the client has no way to check
 * session liveness. This helper does that check against the DB so only real,
 * in-flight sessions surface.
 *
 * A card is a candidate when ALL hold:
 *   - it carries a non-empty `session_id`,
 *   - its column is not Done/Cancelled (terminal),
 *   - that session still exists (`getSession` resolves it), and
 *   - that session is not already merged (a merged session is complete, not a
 *     thing you gate a future release on).
 * The first card per session id wins (dedupe), and its title is the label.
 */
import type { KanbanCardRow, KanbanColumnRow, Stmts } from '../types.js';
import { isColumnDone } from '../kanban-blockers.js';
import { gatherSessionStateSignals } from '../session-state.js';

export interface ReleaseGateSessionCandidate {
  id: string;
  label: string;
}

/** Done- or Cancelled-like column: cards there are terminal, not in flight. */
function isTerminalColumn(name: string): boolean {
  if (isColumnDone(name)) return true;
  return name.toLowerCase().includes('cancel');
}

/**
 * The project's in-flight sessions eligible for a release gate, resolved from
 * the board's non-terminal cards and validated against live session state.
 */
export function buildReleaseGateSessionCandidates(
  stmts: Stmts,
  projectId: string,
): ReleaseGateSessionCandidate[] {
  const board = stmts.getKanbanBoard.get(projectId) as { id?: string } | undefined;
  if (!board?.id) return [];

  const columns = stmts.getKanbanColumns.all(board.id) as KanbanColumnRow[];
  const columnNameById = new Map<string, string>();
  for (const col of columns) columnNameById.set(String(col.id), String(col.name ?? ''));

  const cards = stmts.getKanbanCards.all(board.id) as KanbanCardRow[];
  const seen = new Set<string>();
  const candidates: ReleaseGateSessionCandidate[] = [];
  for (const card of cards) {
    const sessionId = typeof card.session_id === 'string' ? card.session_id.trim() : '';
    if (!sessionId || seen.has(sessionId)) continue;
    if (isTerminalColumn(columnNameById.get(String(card.column_id)) ?? '')) continue;

    // Liveness gate: a dangling/corrupt session id resolves to nothing, and a
    // merged session is already complete — neither is a valid gate target.
    const session = stmts.getSession.get(sessionId) as { id?: string } | undefined;
    if (!session) continue;
    if (gatherSessionStateSignals(stmts, sessionId).merged) continue;

    seen.add(sessionId);
    candidates.push({ id: sessionId, label: card.title || sessionId });
  }
  return candidates;
}
