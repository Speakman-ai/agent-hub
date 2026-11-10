import { describe, expect, it, vi } from 'vitest';

vi.mock('./session-checkpoint-rewind.js', () => ({
  enrichSessionForClient: vi.fn((row) => row),
}));

import { adoptShippedTitle, syncAutoCardTitle } from './auto-title-sync.js';

function harness(opts: {
  session: { name: string; title_source: string | null };
  card?: { title: string; title_source: string | null } | null;
}) {
  const session = { id: 'sess-1', ...opts.session };
  const card = opts.card ? { id: 'card-1', board_id: 'board-1', ...opts.card } : undefined;
  const stmts = {
    getSession: { get: vi.fn(() => ({ ...session })) },
    updateSessionNameWithTitleSource: {
      run: vi.fn((name: string, source: string) => {
        session.name = name;
        session.title_source = source;
      }),
    },
    getKanbanCardBySession: { get: vi.fn(() => card) },
    updateAutoKanbanCardTitle: {
      run: vi.fn((title: string) => {
        if (card?.title_source !== 'auto') return { changes: 0 };
        card.title = title;
        return { changes: 1 };
      }),
    },
    getKanbanBoardById: { get: vi.fn(() => ({ id: 'board-1', project_id: 'proj-1' })) },
  };
  const broadcast = vi.fn();
  return { deps: { stmts: stmts as never, broadcast }, session, card, broadcast };
}

describe('adoptShippedTitle', () => {
  it('renames an ID-named auto session and its auto card to the PR title', () => {
    const h = harness({
      session: { name: '92d3cc41-606c-42f1-9798-baf32245d1fa', title_source: 'auto' },
      card: { title: 'Untitled session', title_source: 'auto' },
    });
    expect(adoptShippedTitle(h.deps, 'sess-1', 'Show time-to-ship on the stats page')).toEqual({
      session: true,
      card: true,
    });
    expect(h.session.name).toBe('Show time-to-ship on the stats page');
    expect(h.card?.title).toBe('Show time-to-ship on the stats page');
    expect(h.broadcast).toHaveBeenCalledWith({ type: 'kanban_update', projectId: 'proj-1' });
  });

  it('renames a placeholder session with no title source', () => {
    const h = harness({ session: { name: 'Session 11/10/2026, 5:53 PM', title_source: null } });
    expect(adoptShippedTitle(h.deps, 'sess-1', 'Fix login race').session).toBe(true);
    expect(h.session.title_source).toBe('auto');
  });

  it('leaves manual session names and human-edited cards alone', () => {
    const h = harness({
      session: { name: 'My name', title_source: 'manual' },
      card: { title: 'Human card', title_source: null },
    });
    expect(adoptShippedTitle(h.deps, 'sess-1', 'Fix login race')).toEqual({
      session: false,
      card: false,
    });
    expect(h.session.name).toBe('My name');
    expect(h.card?.title).toBe('Human card');
  });

  it('refuses to adopt a low-signal title', () => {
    const h = harness({ session: { name: 'Fix login race', title_source: 'auto' } });
    expect(
      adoptShippedTitle(h.deps, 'sess-1', 'f6210010-8f05-4b78-ae80-220f682ff276').session,
    ).toBe(false);
  });
});

describe('syncAutoCardTitle', () => {
  it('does nothing without a linked card', () => {
    const h = harness({ session: { name: 'x y', title_source: 'auto' }, card: null });
    expect(syncAutoCardTitle(h.deps, 'sess-1', 'Fix login race')).toBe(false);
  });
});
