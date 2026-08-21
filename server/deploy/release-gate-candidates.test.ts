import { describe, it, expect } from 'vitest';
import { buildReleaseGateSessionCandidates } from './release-gate-candidates.js';
import type { Stmts } from '../types.js';

interface FxSession {
  id: string;
  name: string;
  updated_at?: string;
}

interface Fixture {
  projectId: string;
  /** agent ids in the project (the sidebar is the union of each agent's list). */
  agents: string[];
  /** Live sessions the sidebar shows per agent (already `deleted_at IS NULL`). */
  sessionsByAgent: Record<string, FxSession[]>;
  board?: { id: string } | null;
  columns: { id: string; name: string }[];
  cards: { id: string; column_id: string; session_id: string | null; title: string }[];
  /** session ids whose linked card sits in a Done column (merged). */
  mergedSessions?: Set<string>;
}

/**
 * Minimal `Stmts` stub covering exactly what the candidate builder and the
 * `merged` signal it calls touch. `getSessions` mirrors the sidebar's live
 * per-agent list; the kanban statements drive terminal-column exclusion,
 * labels, and the `merged` signal.
 */
function makeStmts(fx: Fixture): Stmts {
  const columnById = new Map(fx.columns.map((c) => [c.id, c]));
  const mergedColumnId = 'col-merged';
  return {
    getSessions: { all: (agentId: string) => fx.sessionsByAgent[agentId] ?? [] },
    getKanbanBoard: { get: (pid: string) => (pid === fx.projectId ? fx.board : undefined) },
    getKanbanColumns: { all: (boardId: string) => (fx.board?.id === boardId ? fx.columns : []) },
    getKanbanCards: { all: (boardId: string) => (fx.board?.id === boardId ? fx.cards : []) },
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
    agents: ['agent-1'],
    board: { id: 'board-1' },
    columns: [
      { id: 'col-todo', name: 'To Do' },
      { id: 'col-prog', name: 'In Progress' },
      { id: 'col-done', name: 'Done' },
      { id: 'col-cancel', name: 'Cancelled' },
    ],
  };

  const project = (fx: Fixture) => ({
    id: fx.projectId,
    agents: fx.agents.map((id) => ({ id })),
  });

  it('includes a live session with no kanban card (sidebar parity)', () => {
    // Regression: a running chat session that is visible in the sidebar but was
    // never linked to a card must still be offered as a gate candidate.
    const fx: Fixture = {
      ...base,
      sessionsByAgent: {
        'agent-1': [
          { id: 'sess-carded', name: 'Fix auth', updated_at: '2026-08-21T02:00:00Z' },
          {
            id: 'sess-no-card',
            name: 'Issue with local docker',
            updated_at: '2026-08-21T01:00:00Z',
          },
        ],
      },
      cards: [
        { id: 'c1', column_id: 'col-prog', session_id: 'sess-carded', title: 'Fix auth card' },
      ],
    };
    expect(buildReleaseGateSessionCandidates(makeStmts(fx), project(fx))).toEqual([
      { id: 'sess-carded', label: 'Fix auth' },
      { id: 'sess-no-card', label: 'Issue with local docker' },
    ]);
  });

  it('labels a carded session by its card title when the session name is blank', () => {
    const fx: Fixture = {
      ...base,
      sessionsByAgent: { 'agent-1': [{ id: 'sess-a', name: '   ' }] },
      cards: [{ id: 'c1', column_id: 'col-prog', session_id: 'sess-a', title: 'From card' }],
    };
    expect(buildReleaseGateSessionCandidates(makeStmts(fx), project(fx))).toEqual([
      { id: 'sess-a', label: 'From card' },
    ]);
  });

  it('excludes sessions whose linked card is in a Done or Cancelled column', () => {
    const fx: Fixture = {
      ...base,
      sessionsByAgent: {
        'agent-1': [
          { id: 'sess-done', name: 'Old work' },
          { id: 'sess-cancel', name: 'Dropped' },
          { id: 'sess-open', name: 'Open' },
        ],
      },
      cards: [
        { id: 'c1', column_id: 'col-done', session_id: 'sess-done', title: 'Old work' },
        { id: 'c2', column_id: 'col-cancel', session_id: 'sess-cancel', title: 'Dropped' },
        { id: 'c3', column_id: 'col-prog', session_id: 'sess-open', title: 'Open' },
      ],
    };
    expect(buildReleaseGateSessionCandidates(makeStmts(fx), project(fx))).toEqual([
      { id: 'sess-open', label: 'Open' },
    ]);
  });

  it('excludes already-merged sessions', () => {
    const fx: Fixture = {
      ...base,
      sessionsByAgent: {
        'agent-1': [
          { id: 'sess-merged', name: 'Shipped' },
          { id: 'sess-open', name: 'Open' },
        ],
      },
      cards: [{ id: 'c1', column_id: 'col-prog', session_id: 'sess-merged', title: 'Shipped' }],
      mergedSessions: new Set(['sess-merged']),
    };
    expect(buildReleaseGateSessionCandidates(makeStmts(fx), project(fx))).toEqual([
      { id: 'sess-open', label: 'Open' },
    ]);
  });

  it('unions sessions across agents and dedupes by id', () => {
    const fx: Fixture = {
      ...base,
      agents: ['agent-1', 'agent-2'],
      sessionsByAgent: {
        'agent-1': [{ id: 'sess-a', name: 'A', updated_at: '2026-08-21T03:00:00Z' }],
        'agent-2': [
          { id: 'sess-a', name: 'A dup', updated_at: '2026-08-21T03:00:00Z' },
          { id: 'sess-b', name: 'B', updated_at: '2026-08-21T02:00:00Z' },
        ],
      },
      cards: [],
    };
    expect(buildReleaseGateSessionCandidates(makeStmts(fx), project(fx))).toEqual([
      { id: 'sess-a', label: 'A' },
      { id: 'sess-b', label: 'B' },
    ]);
  });

  it('orders candidates most-recently-updated first', () => {
    const fx: Fixture = {
      ...base,
      sessionsByAgent: {
        'agent-1': [
          { id: 'sess-old', name: 'Old', updated_at: '2026-08-20T00:00:00Z' },
          { id: 'sess-new', name: 'New', updated_at: '2026-08-21T00:00:00Z' },
        ],
      },
      cards: [],
    };
    expect(buildReleaseGateSessionCandidates(makeStmts(fx), project(fx))).toEqual([
      { id: 'sess-new', label: 'New' },
      { id: 'sess-old', label: 'Old' },
    ]);
  });

  it('returns empty when the project has no live sessions', () => {
    const fx: Fixture = { ...base, sessionsByAgent: {}, cards: [] };
    expect(buildReleaseGateSessionCandidates(makeStmts(fx), project(fx))).toEqual([]);
  });

  it('offers sessions even when the project has no board (labels fall back to session name)', () => {
    const fx: Fixture = {
      ...base,
      board: null,
      sessionsByAgent: { 'agent-1': [{ id: 'sess-a', name: 'Ad-hoc thread' }] },
      cards: [],
    };
    expect(buildReleaseGateSessionCandidates(makeStmts(fx), project(fx))).toEqual([
      { id: 'sess-a', label: 'Ad-hoc thread' },
    ]);
  });
});
