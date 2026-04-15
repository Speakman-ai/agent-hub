import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock child_process before importing module
vi.mock('child_process', () => ({
  exec: vi.fn(),
}));

vi.mock('fs', () => ({
  readFileSync: vi.fn(),
  existsSync: vi.fn(() => false),
  statSync: vi.fn(),
}));

import { exec } from 'child_process';
import { checkWorktreeChanges, initAutoGit, autoCommitAndPR } from './auto-git.js';

// Helper to mock execAsync results
function mockExec(results: Record<string, { stdout?: string; stderr?: string; error?: Error }>) {
  (exec as unknown as ReturnType<typeof vi.fn>).mockImplementation(
    (
      cmd: string,
      _opts: Record<string, unknown>,
      callback?: (err: Error | null, result: { stdout: string; stderr: string }) => void,
    ) => {
      // promisify wraps exec, so the mock needs to support the callback style
      for (const [pattern, result] of Object.entries(results)) {
        if (cmd.includes(pattern)) {
          if (callback) {
            if (result.error) {
              callback(result.error, { stdout: '', stderr: '' });
            } else {
              callback(null, { stdout: result.stdout || '', stderr: result.stderr || '' });
            }
          }
          return;
        }
      }
      // Default: empty output
      if (callback) {
        callback(null, { stdout: '', stderr: '' });
      }
    },
  );
}

describe('checkWorktreeChanges', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('detects uncommitted changes', async () => {
    mockExec({
      'git status --porcelain': { stdout: 'M server/index.ts\n' },
      'git log @{upstream}..HEAD': { error: new Error('no upstream') },
      'git log main..HEAD': { stdout: '' },
      'git rev-parse --abbrev-ref HEAD': { stdout: 'feature/test\n' },
    });

    const result = await checkWorktreeChanges('/tmp/test');
    expect(result.hasUncommitted).toBe(true);
    expect(result.branch).toBe('feature/test');
  });

  it('detects unpushed commits', async () => {
    mockExec({
      'git status --porcelain': { stdout: '' },
      'git log @{upstream}..HEAD': { stdout: 'abc123 some commit\n' },
      'git rev-parse --abbrev-ref HEAD': { stdout: 'feature/test\n' },
    });

    const result = await checkWorktreeChanges('/tmp/test');
    expect(result.hasUncommitted).toBe(false);
    expect(result.hasUnpushed).toBe(true);
  });

  it('returns no changes when clean', async () => {
    mockExec({
      'git status --porcelain': { stdout: '' },
      'git log @{upstream}..HEAD': { stdout: '' },
      'git rev-parse --abbrev-ref HEAD': { stdout: 'main\n' },
    });

    const result = await checkWorktreeChanges('/tmp/test');
    expect(result.hasUncommitted).toBe(false);
    expect(result.hasUnpushed).toBe(false);
    expect(result.branch).toBe('main');
  });
});

describe('autoCommitAndPR — ad-hoc session with existing PR', () => {
  const mockBroadcast = vi.fn();
  const mockStmts = {
    getKanbanCardBySession: { get: vi.fn(() => undefined) },
  } as Record<string, unknown>;

  beforeEach(() => {
    vi.clearAllMocks();
    initAutoGit({
      stmts: mockStmts as never,
      broadcast: mockBroadcast,
      triggerReviewForCard: vi.fn(),
      leadReviewPR: vi.fn(),
      getConfig: vi.fn(() => ({}) as never),
      DEFAULT_SKILLS_DIR: '/tmp/skills',
    });
  });

  it('broadcasts auto_pr_created instead of changes_ready when a PR already exists', async () => {
    mockExec({
      'git remote -v': { stdout: 'origin\thttps://github.com/test/repo.git (fetch)\n' },
      'git status --porcelain': { stdout: 'M file.ts\n' },
      'git log @{upstream}..HEAD': { stdout: '' },
      'git rev-parse --abbrev-ref HEAD': { stdout: 'feature/existing-pr\n' },
      'gh pr view': { stdout: 'https://github.com/test/repo/pull/42\n' },
    });

    const project = { id: 'test', cwd: '/repo' } as never;
    const agent = { name: 'test-agent', role: 'dev' } as never;

    await autoCommitAndPR('sess-1', 'agent-1', project, agent, '/worktree', '');

    // Should NOT broadcast changes_ready
    const changesReadyEvents = mockBroadcast.mock.calls.filter(
      (c: Array<Record<string, string>>) => c[0]?.type === 'changes_ready',
    );
    expect(changesReadyEvents).toHaveLength(0);

    // Should broadcast auto_pr_created
    const autoPrEvents = mockBroadcast.mock.calls.filter(
      (c: Array<Record<string, string>>) => c[0]?.type === 'auto_pr_created',
    );
    expect(autoPrEvents).toHaveLength(1);
    expect(autoPrEvents[0][0].prUrl).toBe('https://github.com/test/repo/pull/42');
  });

  it('sets git identity before commit when not configured in worktree', async () => {
    // When commitPushAndCreatePR runs and git user.name is not set in the worktree,
    // it should copy identity from the project repo before committing.
    const execCalls: string[] = [];
    const mockCard = { id: 'card-1', title: 'Test card', description: 'desc', priority: 'medium' };
    const mockStmtsWithCard = {
      getKanbanCardBySession: { get: vi.fn(() => mockCard) },
      getSession: { get: vi.fn(() => ({ name: 'Test session' })) },
      updateKanbanCard: { run: vi.fn() },
    } as Record<string, unknown>;

    initAutoGit({
      stmts: mockStmtsWithCard as never,
      broadcast: mockBroadcast,
      triggerReviewForCard: vi.fn(),
      leadReviewPR: vi.fn(),
      getConfig: vi.fn(() => ({}) as never),
      DEFAULT_SKILLS_DIR: '/tmp/skills',
    });

    (exec as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (
        cmd: string,
        opts: Record<string, unknown>,
        callback?: (err: Error | null, result: { stdout: string; stderr: string }) => void,
      ) => {
        execCalls.push(cmd);
        // git config user.name fails in worktree (not configured)
        if (cmd === 'git config user.name' && opts?.cwd === '/worktree') {
          if (callback) callback(new Error('not set'), { stdout: '', stderr: '' });
          return;
        }
        // Source repo has identity
        if (cmd === 'git config user.name' && opts?.cwd === '/repo') {
          if (callback) callback(null, { stdout: 'My Name\n', stderr: '' });
          return;
        }
        if (cmd === 'git config user.email' && opts?.cwd === '/repo') {
          if (callback) callback(null, { stdout: 'me@example.com\n', stderr: '' });
          return;
        }
        if (cmd.includes('git status --porcelain')) {
          if (callback) callback(null, { stdout: 'M file.ts\n', stderr: '' });
          return;
        }
        if (cmd.includes('git remote -v')) {
          if (callback)
            callback(null, {
              stdout: 'origin\thttps://github.com/test/repo.git (fetch)\n',
              stderr: '',
            });
          return;
        }
        if (cmd.includes('git rev-parse --abbrev-ref HEAD')) {
          if (callback) callback(null, { stdout: 'feature/identity-test\n', stderr: '' });
          return;
        }
        if (cmd.includes('git log')) {
          if (callback) callback(new Error('no upstream'), { stdout: '', stderr: '' });
          return;
        }
        if (cmd.includes('gh pr view') || cmd.includes('gh pr create')) {
          if (callback)
            callback(null, { stdout: 'https://github.com/test/repo/pull/99\n', stderr: '' });
          return;
        }
        if (callback) callback(null, { stdout: '', stderr: '' });
      },
    );

    const project = { id: 'test', cwd: '/repo' } as never;
    const agent = { name: 'test-agent', role: 'dev' } as never;

    await autoCommitAndPR('sess-id', 'agent-1', project, agent, '/worktree', '');

    // Should have set git user.name and user.email in the worktree
    expect(execCalls).toContain('git config user.name "My Name"');
    expect(execCalls).toContain('git config user.email "me@example.com"');
  });

  it('broadcasts changes_ready when no PR exists', async () => {
    mockExec({
      'git remote -v': { stdout: 'origin\thttps://github.com/test/repo.git (fetch)\n' },
      'git status --porcelain': { stdout: 'M file.ts\n' },
      'git log @{upstream}..HEAD': { stdout: '' },
      'git rev-parse --abbrev-ref HEAD': { stdout: 'feature/new-work\n' },
      'gh pr view': { error: new Error('no pull requests found') },
    });

    const project = { id: 'test', cwd: '/repo' } as never;
    const agent = { name: 'test-agent', role: 'dev' } as never;

    await autoCommitAndPR('sess-2', 'agent-1', project, agent, '/worktree', '');

    // Should broadcast changes_ready
    const changesReadyEvents = mockBroadcast.mock.calls.filter(
      (c: Array<Record<string, string>>) => c[0]?.type === 'changes_ready',
    );
    expect(changesReadyEvents).toHaveLength(1);
    expect(changesReadyEvents[0][0].branch).toBe('feature/new-work');
  });
});
