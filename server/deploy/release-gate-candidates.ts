/**
 * release-gate-candidates.ts — server-side source of truth for what the
 * release-gate editor may offer as a "session to gate on".
 *
 * The picker used to be built from board cards alone: any non-done card with a
 * `session_id` became an option. That had two problems. It listed dead work —
 * cards whose linked session was purged/deleted (a dangling id, sometimes a
 * corrupt comma-joined value) still showed up. And, more importantly, it *only*
 * listed sessions that happened to be attached to a kanban card: a plain chat
 * session that is running and visible in the sidebar but never linked to a card
 * (e.g. an ad-hoc "Issue with local docker" thread) could never be gated on.
 *
 * This helper now mirrors the sidebar: it enumerates the project's live
 * sessions (per-agent, `deleted_at IS NULL`, exactly what the sidebar's
 * `GET /api/agents/:agentId/sessions` lists) and offers each one, using the
 * board only to (a) drop sessions whose linked card is terminal
 * (Done/Cancelled) and (b) label carded sessions when the session name is
 * empty.
 *
 * A live session is a candidate when ALL hold:
 *   - it still exists and is not archived (soft-deleted) — implied by the live
 *     `getSessions` scan the sidebar uses,
 *   - its linked board card (if any) is not in a Done/Cancelled (terminal)
 *     column, and
 *   - it is not already merged (a merged session is complete, not a thing you
 *     gate a future release on).
 * Sessions are deduped by id and ordered most-recently-updated first, matching
 * the sidebar order.
 */
import type { KanbanCardRow, KanbanColumnRow, SessionRow, Stmts } from '../types.js';
import { isColumnDone } from '../kanban-blockers.js';
import { gatherSessionStateSignals } from '../session-state.js';

export interface ReleaseGateSessionCandidate {
  id: string;
  label: string;
}

/** Minimal project shape this helper needs: its id and its agent ids. */
export interface ReleaseGateCandidateProject {
  id: string;
  agents: { id: string }[];
}

/** Done- or Cancelled-like column: cards there are terminal, not in flight. */
function isTerminalColumn(name: string): boolean {
  if (isColumnDone(name)) return true;
  return name.toLowerCase().includes('cancel');
}

/**
 * Board-derived, per-session context: the label from the first card that links
 * the session, and whether that card sits in a terminal (Done/Cancelled)
 * column. Sessions with no linked card are simply absent from the maps.
 */
function buildCardContext(
  stmts: Stmts,
  projectId: string,
): { cardLabelBySession: Map<string, string>; terminalSessions: Set<string> } {
  const cardLabelBySession = new Map<string, string>();
  const terminalSessions = new Set<string>();

  const board = stmts.getKanbanBoard.get(projectId) as { id?: string } | undefined;
  if (!board?.id) return { cardLabelBySession, terminalSessions };

  const columns = stmts.getKanbanColumns.all(board.id) as KanbanColumnRow[];
  const columnNameById = new Map<string, string>();
  for (const col of columns) columnNameById.set(String(col.id), String(col.name ?? ''));

  const cards = stmts.getKanbanCards.all(board.id) as KanbanCardRow[];
  for (const card of cards) {
    const sessionId = typeof card.session_id === 'string' ? card.session_id.trim() : '';
    if (!sessionId) continue;
    const terminal = isTerminalColumn(columnNameById.get(String(card.column_id)) ?? '');
    if (terminal) terminalSessions.add(sessionId);
    // First card per session wins as the label source (matches prior behavior).
    if (!cardLabelBySession.has(sessionId) && card.title) {
      cardLabelBySession.set(sessionId, card.title);
    }
  }
  return { cardLabelBySession, terminalSessions };
}

/**
 * The project's in-flight sessions eligible for a release gate. Sourced from the
 * live per-agent session lists the sidebar shows (so a running session with no
 * kanban card is still offered), minus sessions whose linked card is terminal
 * and minus already-merged sessions.
 */
export function buildReleaseGateSessionCandidates(
  stmts: Stmts,
  project: ReleaseGateCandidateProject,
): ReleaseGateSessionCandidate[] {
  const { cardLabelBySession, terminalSessions } = buildCardContext(stmts, project.id);

  // Union the sidebar's live sessions across every agent in the project. The
  // per-agent `getSessions` statement is `deleted_at IS NULL ORDER BY
  // updated_at DESC` — identical to what the sidebar renders.
  const bySession = new Map<string, SessionRow>();
  for (const agent of project.agents ?? []) {
    if (!agent?.id) continue;
    const rows = stmts.getSessions.all(agent.id) as SessionRow[];
    for (const row of rows) {
      if (!row?.id || bySession.has(row.id)) continue;
      bySession.set(row.id, row);
    }
  }

  const candidates: (ReleaseGateSessionCandidate & { updatedAt: string })[] = [];
  for (const [sessionId, row] of bySession) {
    if (terminalSessions.has(sessionId)) continue;
    if (gatherSessionStateSignals(stmts, sessionId).merged) continue;

    const name = typeof row.name === 'string' ? row.name.trim() : '';
    const label = name || cardLabelBySession.get(sessionId) || sessionId;
    candidates.push({ id: sessionId, label, updatedAt: String(row.updated_at ?? '') });
  }

  // Most-recently-updated first, matching the sidebar's ordering.
  candidates.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  return candidates.map(({ id, label }) => ({ id, label }));
}
