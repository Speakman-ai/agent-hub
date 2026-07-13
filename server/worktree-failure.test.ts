import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildWorktreeFailureMessage, handleWorktreeFailure } from './worktree-failure.js';
import type { Stmts } from './types.js';

describe('buildWorktreeFailureMessage', () => {
  it('includes the error message and explains the impact + recovery', () => {
    const body = buildWorktreeFailureMessage('fatal: branch already checked out');
    expect(body).toContain('Worktree creation failed');
    expect(body).toContain('auto-PR is disabled');
    expect(body).toContain('fatal: branch already checked out');
    expect(body).toContain('Edits will land in the project checkout');
    expect(body).toContain('push the branch and open the PR manually');
  });

  it('adds a classified likely-cause and prevention hint', () => {
    const body = buildWorktreeFailureMessage(
      'fatal: Authentication failed for https://github.com/acme/private.git',
    );
    expect(body).toContain('Likely cause:');
    expect(body).toContain('How to prevent it:');
    expect(body).toContain('Settings → GitHub');
  });
});

describe('handleWorktreeFailure', () => {
  function makeStmts(overrides: Partial<Stmts> = {}): Stmts {
    const defaults = {
      updateSessionWorktree: { run: vi.fn() },
      addMessage: { run: vi.fn() },
      touchSession: { run: vi.fn() },
      getMessageById: {
        get: vi.fn((id: string) => ({
          id,
          session_id: 'sess-1',
          role: 'system',
          content: 'msg',
          created_at: '2026-05-17T03:14:48Z',
          engine: null,
          model: null,
          attachments: null,
          metadata: null,
        })),
      },
      getKanbanCardBySession: { get: vi.fn().mockReturnValue(undefined) },
      createKanbanCardComment: { run: vi.fn() },
      getKanbanBoardById: { get: vi.fn().mockReturnValue(undefined) },
    };
    return { ...defaults, ...overrides } as unknown as Stmts;
  }

  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('emits a distinct [worktree-failed] log line at the moment of failure', () => {
    const stmts = makeStmts();
    const broadcast = vi.fn();
    handleWorktreeFailure({ stmts, broadcast }, 'sess-1', 'boom');

    const calls = warnSpy.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(
      calls.some(
        (line: string) =>
          line.includes('[worktree-failed]') && line.includes('sess-1') && line.includes('boom'),
      ),
    ).toBe(true);
  });

  it('clears use_worktree, inserts a system message, broadcasts message + worktree_failed', () => {
    const updateRun = vi.fn();
    const addRun = vi.fn();
    const stmts = makeStmts({
      updateSessionWorktree: { run: updateRun },
      addMessage: { run: addRun },
    } as unknown as Partial<Stmts>);
    const broadcast = vi.fn();

    handleWorktreeFailure({ stmts, broadcast }, 'sess-1', 'boom');

    // use_worktree → 0
    expect(updateRun).toHaveBeenCalledWith(0, 'sess-1');

    // role='system' message with the failure body
    expect(addRun).toHaveBeenCalledTimes(1);
    const [, sessionIdArg, roleArg, bodyArg] = addRun.mock.calls[0];
    expect(sessionIdArg).toBe('sess-1');
    expect(roleArg).toBe('system');
    expect(bodyArg).toContain('Worktree creation failed');
    expect(bodyArg).toContain('boom');

    // broadcasts include both the live message and the worktree_failed event
    const types = broadcast.mock.calls.map((c) => (c[0] as { type: string }).type);
    expect(types).toContain('message');
    expect(types).toContain('worktree_failed');

    const wtCall = broadcast.mock.calls.find(
      (c) => (c[0] as { type: string }).type === 'worktree_failed',
    );
    expect(wtCall?.[0]).toEqual({ type: 'worktree_failed', sessionId: 'sess-1', error: 'boom' });
  });

  it('posts a kanban card comment + kanban_update broadcast when the session is card-linked', () => {
    const commentRun = vi.fn();
    const stmts = makeStmts({
      getKanbanCardBySession: {
        get: vi.fn().mockReturnValue({ id: 'card-1', board_id: 'board-1' }),
      },
      createKanbanCardComment: { run: commentRun },
      getKanbanBoardById: {
        get: vi.fn().mockReturnValue({ id: 'board-1', project_id: 'proj-1' }),
      },
    } as unknown as Partial<Stmts>);
    const broadcast = vi.fn();

    handleWorktreeFailure({ stmts, broadcast }, 'sess-1', 'boom');

    // one comment, on the linked card, attributed to Agent Hub, with the body
    expect(commentRun).toHaveBeenCalledTimes(1);
    const [, cardIdArg, authorArg, bodyArg] = commentRun.mock.calls[0];
    expect(cardIdArg).toBe('card-1');
    expect(authorArg).toBe('Agent Hub');
    expect(bodyArg).toContain('Worktree creation failed');
    expect(bodyArg).toContain('boom');

    // kanban_update broadcast carries the resolved project id
    const kanbanCall = broadcast.mock.calls.find(
      (c) => (c[0] as { type: string }).type === 'kanban_update',
    );
    expect(kanbanCall?.[0]).toEqual({ type: 'kanban_update', projectId: 'proj-1' });
  });

  it('does NOT post a card comment or kanban_update when no card is linked', () => {
    const commentRun = vi.fn();
    const stmts = makeStmts({
      createKanbanCardComment: { run: commentRun },
    } as unknown as Partial<Stmts>);
    const broadcast = vi.fn();

    handleWorktreeFailure({ stmts, broadcast }, 'sess-1', 'boom');

    expect(commentRun).not.toHaveBeenCalled();
    const types = broadcast.mock.calls.map((c) => (c[0] as { type: string }).type);
    expect(types).not.toContain('kanban_update');
    // The worktree_failed event must still fire even when there's no card.
    expect(types).toContain('worktree_failed');
  });

  it('still runs subsequent steps when one step throws', () => {
    const stmts = makeStmts({
      // First step throws — message insert + broadcast must still happen.
      updateSessionWorktree: {
        run: vi.fn(() => {
          throw new Error('db locked');
        }),
      },
    } as unknown as Partial<Stmts>);
    const broadcast = vi.fn();

    expect(() => handleWorktreeFailure({ stmts, broadcast }, 'sess-1', 'boom')).not.toThrow();

    expect(stmts.addMessage.run).toHaveBeenCalled();
    const types = broadcast.mock.calls.map((c) => (c[0] as { type: string }).type);
    expect(types).toContain('message');
    expect(types).toContain('worktree_failed');
  });

  it('still broadcasts worktree_failed when the system-message insert throws', () => {
    const stmts = makeStmts({
      addMessage: {
        run: vi.fn(() => {
          throw new Error('addMessage failed');
        }),
      },
    } as unknown as Partial<Stmts>);
    const broadcast = vi.fn();

    handleWorktreeFailure({ stmts, broadcast }, 'sess-1', 'boom');

    const types = broadcast.mock.calls.map((c) => (c[0] as { type: string }).type);
    expect(types).toContain('worktree_failed');
  });

  it('skips the kanban_update broadcast when the linked card board cannot be resolved', () => {
    const stmts = makeStmts({
      getKanbanCardBySession: {
        get: vi.fn().mockReturnValue({ id: 'card-1', board_id: 'board-missing' }),
      },
      createKanbanCardComment: { run: vi.fn() },
      getKanbanBoardById: { get: vi.fn().mockReturnValue(undefined) },
    } as unknown as Partial<Stmts>);
    const broadcast = vi.fn();

    handleWorktreeFailure({ stmts, broadcast }, 'sess-1', 'boom');

    expect(stmts.createKanbanCardComment.run).toHaveBeenCalled();
    const types = broadcast.mock.calls.map((c) => (c[0] as { type: string }).type);
    expect(types).not.toContain('kanban_update');
  });
});
