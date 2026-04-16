import { vi, type Mock } from 'vitest';

// Mock child_process before importing auto-git
vi.mock('child_process', () => ({
  exec: vi.fn(
    (
      _cmd: string,
      _opts: unknown,
      cb?: (err: Error | null, result: { stdout: string; stderr: string }) => void,
    ) => {
      if (typeof _opts === 'function') {
        (_opts as (err: Error | null, result: { stdout: string; stderr: string }) => void)(null, {
          stdout: '',
          stderr: '',
        });
      } else if (cb) {
        cb(null, { stdout: '', stderr: '' });
      }
      return { stdout: '', stderr: '' };
    },
  ),
}));

const { initAutoGit, autoCommitAndPR } = await import('../auto-git.js');

describe('autoCommitAndPR — intake agent skip', () => {
  const mockStmts = {
    getKanbanCardBySession: { get: vi.fn() },
    setCardPrUrl: { run: vi.fn() },
    getKanbanBoard: { get: vi.fn() },
    getKanbanColumns: { all: vi.fn() },
    moveKanbanCard: { run: vi.fn() },
  };

  beforeAll(() => {
    initAutoGit({
      stmts: mockStmts as never,
      broadcast: vi.fn(),
      getConfig: () => ({ botGithubToken: null }) as never,
      DEFAULT_SKILLS_DIR: '/tmp/skills',
    });
  });

  it('skips commit/PR for intake role agents', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await autoCommitAndPR(
      'session-123',
      'agent-intake',
      { id: 'proj', cwd: '/tmp/proj' } as never,
      { id: 'agent-intake', name: 'Ticket Intake', role: 'intake' } as never,
      '/tmp/proj/worktree-1',
      'final content',
    );

    // Should have logged the skip message
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('skipping (intake agent, no PR)'),
    );

    // exec should NOT have been called (no git operations)
    const { exec } = await import('child_process');
    expect(exec).not.toHaveBeenCalled();

    consoleSpy.mockRestore();
  });

  it('does NOT skip for regular agents (proceeds to git check)', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await autoCommitAndPR(
      'session-456',
      'agent-dev',
      { id: 'proj', cwd: '/tmp/proj' } as never,
      { id: 'agent-dev', name: 'Dev Agent', role: undefined } as never,
      '/tmp/proj/worktree-2',
      'final content',
    );

    // Should NOT have logged the intake skip message
    const intakeSkipCalls = consoleSpy.mock.calls.filter(
      (args) => typeof args[0] === 'string' && args[0].includes('intake agent'),
    );
    expect(intakeSkipCalls).toHaveLength(0);

    consoleSpy.mockRestore();
  });
});
