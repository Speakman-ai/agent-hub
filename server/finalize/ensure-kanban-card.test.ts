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

describe('ensureKanbanCardForSession titles', () => {
  function stubStmts() {
    const created: unknown[][] = [];
    return {
      created,
      stmts: {
        getKanbanCardBySession: { get: vi.fn(() => undefined) },
        getKanbanBoard: { get: vi.fn(() => undefined) },
        getKanbanCardsByColumn: { all: vi.fn(() => []) },
        createKanbanCard: { run: vi.fn((...args: unknown[]) => created.push(args)) },
        markKanbanCardTitleAuto: { run: vi.fn() },
        getKanbanCard: { get: vi.fn((id: string) => ({ id, title: created[0]?.[3] })) },
        getSession: { get: vi.fn(() => undefined) },
        updateSessionName: { run: vi.fn() },
      },
    };
  }

  it('marks a card derived from an auto-named session as auto and leaves the session alone', () => {
    const { stmts, created } = stubStmts();
    ensureKanbanCardForSession(
      { stmts: stmts as never, broadcast: vi.fn(), findAgent: () => null },
      { projectId: 'proj-1', session: session({ title_source: 'auto' }) },
    );
    expect(created[0][3]).toBe('Lobby host start');
    expect(stmts.markKanbanCardTitleAuto.run).toHaveBeenCalledTimes(1);
    expect(stmts.updateSessionName.run).not.toHaveBeenCalled();
  });

  it('never copies a UUID session name into the card title', () => {
    const { stmts, created } = stubStmts();
    ensureKanbanCardForSession(
      { stmts: stmts as never, broadcast: vi.fn(), findAgent: () => null },
      {
        projectId: 'proj-1',
        session: session({ name: '92d3cc41-606c-42f1-9798-baf32245d1fa', title_source: 'auto' }),
      },
    );
    expect(created[0][3]).toBe('Untitled session');
    expect(stmts.markKanbanCardTitleAuto.run).toHaveBeenCalledTimes(1);
  });

  it('keeps a card from a manually named session pinned', () => {
    const { stmts } = stubStmts();
    ensureKanbanCardForSession(
      { stmts: stmts as never, broadcast: vi.fn(), findAgent: () => null },
      { projectId: 'proj-1', session: session({ title_source: 'manual' }) },
    );
    expect(stmts.markKanbanCardTitleAuto.run).not.toHaveBeenCalled();
  });
});
