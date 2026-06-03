import { describe, expect, it, vi } from 'vitest';

vi.mock('../routes/board.js', () => ({
  getOrCreateBoard: vi.fn(() => ({
    board: { id: 'board-1' },
    columns: [{ id: 'col-ip', name: 'In Progress', position: 1, board_id: 'board-1' }],
    cards: [],
    epics: [],
  })),
}));

vi.mock('../kanban-caller-session.js', () => ({
  maybeRenameSessionForLinkedCard: vi.fn(),
}));

vi.mock('../session-checkpoint-rewind.js', () => ({
  enrichSessionForClient: vi.fn((row) => row),
}));

import type { KanbanCardRow, SessionRow } from '../types.js';
import { ensureKanbanCardForSession } from './ensure-kanban-card.js';

function session(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    id: 'sess-1',
    agent_id: 'agent-1',
    name: 'Lobby host start',
    engine: 'claude-code',
    model: 'opus',
    worktree_path: '/wt',
    worktree_branch: 'feature/x',
    ...overrides,
  } as SessionRow;
}

describe('ensureKanbanCardForSession', () => {
  it('returns an existing linked card without creating a duplicate', () => {
    const existing = { id: 'card-1', board_id: 'board-1', session_id: 'sess-1' } as KanbanCardRow;
    const stmts = {
      getKanbanCardBySession: { get: vi.fn(() => existing) },
      getKanbanBoard: { get: vi.fn(() => ({ id: 'board-1' })) },
      createKanbanCard: { run: vi.fn() },
    };
    const result = ensureKanbanCardForSession(
      { stmts: stmts as never, broadcast: vi.fn(), findAgent: () => null },
      { projectId: 'proj-1', session: session() },
    );
    expect(result.created).toBe(false);
    expect(result.card).toBe(existing);
    expect(stmts.createKanbanCard.run).not.toHaveBeenCalled();
  });
});
