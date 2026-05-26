import { describe, it, expect, vi } from 'vitest';
import { maybeRenameSessionForLinkedCard } from './kanban-caller-session.js';
import type { Stmts } from './types.js';

describe('maybeRenameSessionForLinkedCard', () => {
  it('no-ops when session name is already customized', () => {
    const updateSessionName = vi.fn();
    const stmts = {
      getSession: {
        get: () => ({ id: 'sess-1', name: 'Already Custom', agent_id: 'agent-1' }),
      },
      updateSessionName: { run: updateSessionName },
    } as unknown as Stmts;

    const broadcast = vi.fn();
    maybeRenameSessionForLinkedCard(stmts, broadcast, 'sess-1', 'New Card Title');

    expect(updateSessionName).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('renames placeholder Session titles and broadcasts session-updated', () => {
    const updateSessionName = vi.fn();
    const updatedRow = { id: 'sess-2', name: 'Card Title', agent_id: 'agent-1' };
    const stmts = {
      getSession: {
        get: (id: string) =>
          id === 'sess-2'
            ? { id: 'sess-2', name: 'Session 5/26/2026, 7:00 PM', agent_id: 'agent-1' }
            : updatedRow,
      },
      updateSessionName: { run: updateSessionName },
    } as unknown as Stmts;

    const broadcast = vi.fn();
    maybeRenameSessionForLinkedCard(stmts, broadcast, 'sess-2', 'Card Title');

    expect(updateSessionName).toHaveBeenCalledWith('Card Title', 'sess-2');
    expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: 'session-updated' }));
  });
});
