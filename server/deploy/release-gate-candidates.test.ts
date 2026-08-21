import { describe, it, expect } from 'vitest';
import { buildReleaseGateSessionCandidates } from './release-gate-candidates.js';
import type { Stmts } from '../types.js';

interface Fixture {
  projectId: string;
  board?: { id: string } | null;
  columns: { id: string; name: string }[];
  cards: { id: string; column_id: string; session_id: string | null; title: string }[];
  sessions: Set<string>;
  /** session ids whose linked card sits in a Done column (merged). */
  mergedSessions?: Set<string>;
}

/**
 * Minimal `Stmts` stub covering exactly what the candidate builder and the
 * `merged` signal it calls touch. Everything else is undefined; the session-state
 * lookups it doesn't need are try/catch-guarded and fall back to false.
 */
function makeStmts(fx: Fixture): Stmts {
  const columnById = new Map(fx.columns.map((c) => [c.id, c]));
  const mergedColumnId = 'col-merged';
  return {
    getKanbanBoard: { get: (pid: string) => (pid === fx.projectId ? fx.board : undefined) },
    getKanbanColumns: { all: (boardId: string) => (fx.board?.id === boardId ? fx.columns : []) },
    getKanbanCards: { all: (boardId: string) => (fx.board?.id === boardId ? fx.cards : []) },
    getSession: { get: (sid: string) => (fx.sessions.has(sid) ? { id: sid } : undefined) },
    // Drives the `merged` signal: a merged session resolves to a card in a Done
    // column. Non-merged sessions resolve to nothing → merged = false.
    getKanbanCardBySession: {
      get: (sid: string) =>
        fx.mergedSessions?.has(sid) ? { column_id: mergedColumnId } : undefined,
    },
    getKanbanColumn: {
      get: (colId: string) =>
        colId === mergedColumnId ? { name: 'Done' } : (columnById.get(colId) ?? undefined),
    },
  } as unknown as Stmts;
}

describe('buildReleaseGateSessionCandidates', () => {
  const base = {
    projectId: 'proj-1',
    board: { id: 'board-1' },
    columns: [
      { id: 'col-todo', name: 'To Do' },
      { id: 'col-prog', name: 'In Progress' },
      { id: 'col-done', name: 'Done' },
      { id: 'col-cancel', name: 'Cancelled' },
    ],
  };

  it('returns live, non-merged sessions on non-terminal cards', () => {
    const stmts = makeStmts({
      ...base,
      cards: [
        { id: 'c1', column_id: 'col-prog', session_id: 'sess-a', title: 'Fix auth' },
        { id: 'c2', column_id: 'col-todo', session_id: 'sess-b', title: 'Add search' },
      ],
      sessions: new Set(['sess-a', 'sess-b']),
    });
    expect(buildReleaseGateSessionCandidates(stmts, 'proj-1')).toEqual([
      { id: 'sess-a', label: 'Fix auth' },
      { id: 'sess-b', label: 'Add search' },
    ]);
  });

  it('excludes cards whose linked session no longer exists', () => {
    const stmts = makeStmts({
      ...base,
      cards: [
        { id: 'c1', column_id: 'col-prog', session_id: 'sess-live', title: 'Live' },
        { id: 'c2', column_id: 'col-prog', session_id: 'sess-gone', title: 'Purged session' },
      ],
      sessions: new Set(['sess-live']),
    });
    expect(buildReleaseGateSessionCandidates(stmts, 'proj-1')).toEqual([
      { id: 'sess-live', label: 'Live' },
    ]);
  });

  it('excludes a corrupt comma-joined session id that resolves to nothing', () => {
    const stmts = makeStmts({
      ...base,
      cards: [
        {
          id: 'c1',
          column_id: 'col-todo',
          session_id: 'sess-x, sess-x',
          title: 'Corrupt link',
        },
      ],
      sessions: new Set(['sess-x']),
    });
    expect(buildReleaseGateSessionCandidates(stmts, 'proj-1')).toEqual([]);
  });

  it('excludes already-merged sessions', () => {
    const stmts = makeStmts({
      ...base,
      cards: [
        { id: 'c1', column_id: 'col-prog', session_id: 'sess-merged', title: 'Shipped' },
        { id: 'c2', column_id: 'col-prog', session_id: 'sess-open', title: 'Open' },
      ],
      sessions: new Set(['sess-merged', 'sess-open']),
      mergedSessions: new Set(['sess-merged']),
    });
    expect(buildReleaseGateSessionCandidates(stmts, 'proj-1')).toEqual([
      { id: 'sess-open', label: 'Open' },
    ]);
  });

  it('excludes cards in Done/Cancelled columns and cards without a session', () => {
    const stmts = makeStmts({
      ...base,
      cards: [
        { id: 'c1', column_id: 'col-done', session_id: 'sess-done', title: 'Old work' },
        { id: 'c2', column_id: 'col-cancel', session_id: 'sess-cancel', title: 'Dropped' },
        { id: 'c3', column_id: 'col-prog', session_id: null, title: 'No session' },
        { id: 'c4', column_id: 'col-prog', session_id: '   ', title: 'Blank session' },
      ],
      sessions: new Set(['sess-done', 'sess-cancel']),
    });
    expect(buildReleaseGateSessionCandidates(stmts, 'proj-1')).toEqual([]);
  });

  it('dedupes by session id, keeping the first card title', () => {
    const stmts = makeStmts({
      ...base,
      cards: [
        { id: 'c1', column_id: 'col-prog', session_id: 'sess-a', title: 'First' },
        { id: 'c2', column_id: 'col-todo', session_id: 'sess-a', title: 'Second' },
      ],
      sessions: new Set(['sess-a']),
    });
    expect(buildReleaseGateSessionCandidates(stmts, 'proj-1')).toEqual([
      { id: 'sess-a', label: 'First' },
    ]);
  });

  it('returns empty when the project has no board', () => {
    const stmts = makeStmts({ ...base, board: null, cards: [], sessions: new Set() });
    expect(buildReleaseGateSessionCandidates(stmts, 'proj-1')).toEqual([]);
  });
});
