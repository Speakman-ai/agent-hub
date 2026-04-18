import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock child_process before importing module
vi.mock('child_process', () => ({
  exec: vi.fn(),
  execFile: vi.fn(),
}));

vi.mock('fs', () => ({
  readFileSync: vi.fn(),
  existsSync: vi.fn(() => false),
  statSync: vi.fn(),
}));

import { exec, execFile } from 'child_process';
import {
  checkWorktreeChanges,
  initAutoGit,
  autoCommitAndPR,
  buildCardDescription,
  buildPrTitle,
  buildPrBody,
  isGarbageTitle,
} from './auto-git.js';
import type { MessageRow } from './types.js';

function makeMsg(role: 'user' | 'assistant', content: string): MessageRow {
  return {
    id: 'msg-1',
    session_id: 'sess-1',
    role,
    content,
    engine: null,
    model: null,
    attachments: null,
    metadata: null,
    created_at: new Date().toISOString(),
  };
}

// Helper to mock execAsync / execFileAsync results (git uses exec; gh uses execFile)
function mockExec(results: Record<string, { stdout?: string; stderr?: string; error?: Error }>) {
  const run = (
    cmd: string,
    callback?: (err: Error | null, result: { stdout: string; stderr: string }) => void,
  ) => {
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
    if (callback) {
      callback(null, { stdout: '', stderr: '' });
    }
  };

  (exec as unknown as ReturnType<typeof vi.fn>).mockImplementation(
    (
      cmd: string,
      _opts: Record<string, unknown>,
      callback?: (err: Error | null, result: { stdout: string; stderr: string }) => void,
    ) => {
      run(cmd, callback);
    },
  );

  (execFile as unknown as ReturnType<typeof vi.fn>).mockImplementation(
    (
      file: string,
      args: string[],
      _opts: Record<string, unknown>,
      callback?: (err: Error | null, result: { stdout: string; stderr: string }) => void,
    ) => {
      if (file === 'gh') {
        const cmd = ['gh', ...args].join(' ');
        run(cmd, callback);
      } else if (callback) {
        callback(new Error(`unexpected execFile(${file})`), { stdout: '', stderr: '' });
      }
    },
  );
}

/** Same handler for `exec('sh -c')` and `execFile('gh', …)` so tests track both. */
function installExecAndGhMock(
  impl: (
    cmd: string,
    _opts: Record<string, unknown>,
    callback?: (err: Error | null, result: { stdout: string; stderr: string }) => void,
  ) => void,
) {
  (exec as unknown as ReturnType<typeof vi.fn>).mockImplementation(impl);
  (execFile as unknown as ReturnType<typeof vi.fn>).mockImplementation(
    (
      file: string,
      args: string[],
      opts: Record<string, unknown>,
      callback?: (err: Error | null, result: { stdout: string; stderr: string }) => void,
    ) => {
      if (file === 'gh') {
        impl(['gh', ...args].join(' '), opts, callback);
      } else if (callback) {
        callback(new Error(`unexpected execFile(${file})`), { stdout: '', stderr: '' });
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

  // Regression: bug report "PR Button didnt show".
  // The old fallback hard-coded `git log main..HEAD`, so repos whose default
  // branch is `master` (or anything other than `main`) would silently report
  // `hasUnpushed = false` — suppressing the "Create PR" banner in the UI.
  it('detects unpushed commits against `master` when default branch is master', async () => {
    mockExec({
      'git status --porcelain': { stdout: '' },
      'git log @{upstream}..HEAD': { error: new Error('no upstream') },
      // origin/HEAD not configured → fall through to local branch probe
      'git symbolic-ref refs/remotes/origin/HEAD': { error: new Error('not set') },
      // `main` doesn't exist; `master` does
      'git rev-parse --verify main': { error: new Error('bad ref') },
      'git rev-parse --verify master': { stdout: 'deadbeef\n' },
      // Commits ahead of origin/master
      'git log origin/master..HEAD --oneline': { stdout: 'abc123 work in progress\n' },
      'git rev-parse --abbrev-ref HEAD': { stdout: 'feature/fix-docs\n' },
    });

    const result = await checkWorktreeChanges('/tmp/test');
    expect(result.hasUnpushed).toBe(true);
    expect(result.branch).toBe('feature/fix-docs');
  });

  it('uses origin/HEAD symbolic-ref when available to resolve default branch', async () => {
    mockExec({
      'git status --porcelain': { stdout: '' },
      'git log @{upstream}..HEAD': { error: new Error('no upstream') },
      'git symbolic-ref refs/remotes/origin/HEAD': {
        stdout: 'refs/remotes/origin/develop\n',
      },
      'git log origin/develop..HEAD --oneline': { stdout: 'abc123 feature commit\n' },
      'git rev-parse --abbrev-ref HEAD': { stdout: 'feature/thing\n' },
    });

    const result = await checkWorktreeChanges('/tmp/test');
    expect(result.hasUnpushed).toBe(true);
  });

  it('stays false when neither upstream, origin/HEAD, main, nor master can be resolved', async () => {
    mockExec({
      'git status --porcelain': { stdout: '' },
      'git log @{upstream}..HEAD': { error: new Error('no upstream') },
      'git symbolic-ref refs/remotes/origin/HEAD': { error: new Error('not set') },
      'git rev-parse --verify main': { error: new Error('bad ref') },
      'git rev-parse --verify master': { error: new Error('bad ref') },
      'git rev-parse --abbrev-ref HEAD': { stdout: 'solo-branch\n' },
    });

    const result = await checkWorktreeChanges('/tmp/test');
    expect(result.hasUncommitted).toBe(false);
    expect(result.hasUnpushed).toBe(false);
    expect(result.branch).toBe('solo-branch');
  });
});

describe('autoCommitAndPR — ad-hoc session with existing PR', () => {
  const mockBroadcast = vi.fn();
  const mockStmts = {
    getKanbanCardBySession: { get: vi.fn(() => undefined) },
    updateSessionChangesReady: { run: vi.fn() },
    clearSessionChangesReady: { run: vi.fn() },
  } as Record<string, unknown>;

  beforeEach(() => {
    vi.clearAllMocks();
    initAutoGit({
      stmts: mockStmts as never,
      broadcast: mockBroadcast,
      getConfig: vi.fn(() => ({}) as never),
      DEFAULT_SKILLS_DIR: '/tmp/skills',
    });
  });

  it('pushes the fix and broadcasts auto_pr_created (no new PR) when an open PR already exists', async () => {
    // Regression: ad-hoc session fixing CI / review comments on an existing
    // PR. Agent committed but did not push. We must push so GitHub sees the
    // fix, and we must NOT open a new PR — the existing one gets reused.
    const execCalls: string[] = [];
    const mockStmtsAdHoc = {
      getKanbanCardBySession: { get: vi.fn(() => undefined) },
      getSession: { get: vi.fn(() => ({ name: 'Ad-hoc fix session' })) },
      updateSessionChangesReady: { run: vi.fn() },
      clearSessionChangesReady: { run: vi.fn() },
    } as Record<string, unknown>;

    initAutoGit({
      stmts: mockStmtsAdHoc as never,
      broadcast: mockBroadcast,
      getConfig: vi.fn(() => ({}) as never),
      DEFAULT_SKILLS_DIR: '/tmp/skills',
    });

    installExecAndGhMock(
      (
        cmd: string,
        _opts: Record<string, unknown>,
        callback?: (err: Error | null, result: { stdout: string; stderr: string }) => void,
      ) => {
        execCalls.push(cmd);
        const ok = (stdout: string) => callback?.(null, { stdout, stderr: '' });
        const fail = (msg: string) => callback?.(new Error(msg), { stdout: '', stderr: '' });

        if (cmd.includes('git remote -v'))
          return ok('origin\thttps://github.com/test/repo.git (fetch)\n');
        if (cmd.includes('git status --porcelain')) return ok('M file.ts\n');
        if (cmd.includes('git log @{upstream}..HEAD')) return ok('');
        if (cmd.includes('git rev-parse --abbrev-ref HEAD')) return ok('feature/existing-pr\n');
        if (cmd.startsWith('gh pr view')) return ok('https://github.com/test/repo/pull/42\n');
        if (cmd.startsWith('gh pr create')) {
          // Simulate gh CLI's actual error when the branch already has a PR.
          return fail(
            'a pull request for branch "feature/existing-pr" already exists: https://github.com/test/repo/pull/42',
          );
        }
        // git config / git add / git commit / git push — succeed silently.
        return ok('');
      },
    );

    const project = { id: 'test', cwd: '/repo' } as never;
    const agent = { name: 'test-agent', role: 'dev' } as never;

    await autoCommitAndPR('sess-1', 'agent-1', project, agent, '/worktree', '');

    // The bug fix: branch must be pushed so GitHub sees the agent's commit.
    const pushCalls = execCalls.filter((c) => c.startsWith('git push'));
    expect(pushCalls.length).toBeGreaterThan(0);
    expect(pushCalls[0]).toContain('feature/existing-pr');

    // No `changes_ready` banner — there's already a PR, button isn't useful.
    const changesReadyEvents = mockBroadcast.mock.calls.filter(
      (c: Array<Record<string, string>>) => c[0]?.type === 'changes_ready',
    );
    expect(changesReadyEvents).toHaveLength(0);

    // The existing PR URL is surfaced via auto_pr_created — no new PR opened.
    const autoPrEvents = mockBroadcast.mock.calls.filter(
      (c: Array<Record<string, string>>) => c[0]?.type === 'auto_pr_created',
    );
    expect(autoPrEvents.length).toBeGreaterThan(0);
    const lastPrUrl = autoPrEvents[autoPrEvents.length - 1][0].prUrl;
    expect(lastPrUrl).toBe('https://github.com/test/repo/pull/42');
  });

  it('sets git identity before commit when not configured in worktree', async () => {
    // When commitPushAndCreatePR runs and git user.name is not set in the worktree,
    // it should copy identity from the project repo before committing.
    const execCalls: string[] = [];
    const mockCard = {
      id: 'card-1',
      title: 'Test card',
      description: 'desc',
      priority: 'medium',
      autonomous_iterations: 1,
      epic_id: null,
    };
    const mockStmtsWithCard = {
      getKanbanCardBySession: { get: vi.fn(() => mockCard) },
      getSession: { get: vi.fn(() => ({ name: 'Test session' })) },
      updateKanbanCard: { run: vi.fn() },
    } as Record<string, unknown>;

    initAutoGit({
      stmts: mockStmtsWithCard as never,
      broadcast: mockBroadcast,
      getConfig: vi.fn(() => ({}) as never),
      DEFAULT_SKILLS_DIR: '/tmp/skills',
    });

    installExecAndGhMock(
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

  it('persists changes_ready to the database when broadcasting', async () => {
    mockExec({
      'git remote -v': { stdout: 'origin\thttps://github.com/test/repo.git (fetch)\n' },
      'git status --porcelain': { stdout: 'M file.ts\n' },
      'git log @{upstream}..HEAD': { stdout: '' },
      'git rev-parse --abbrev-ref HEAD': { stdout: 'feature/persist-test\n' },
      'gh pr view': { error: new Error('no pull requests found') },
    });

    const project = { id: 'test', cwd: '/repo' } as never;
    const agent = { name: 'test-agent', role: 'dev' } as never;

    await autoCommitAndPR('sess-3', 'agent-1', project, agent, '/worktree', '');

    // Should persist changes_ready JSON to the session row
    const updateCalls = (mockStmts.updateSessionChangesReady as { run: ReturnType<typeof vi.fn> })
      .run.mock.calls;
    expect(updateCalls).toHaveLength(1);
    const [json, sessionId] = updateCalls[0];
    expect(sessionId).toBe('sess-3');
    const parsed = JSON.parse(json);
    expect(parsed.branch).toBe('feature/persist-test');
    expect(parsed.hasUncommitted).toBe(true);
    expect(parsed.agentId).toBe('agent-1');
  });

  // Note: the two auto-merge-on-existing-PR tests for the card-driven path
  // live in the dedicated `commitPushAndCreatePR — existing PR early return`
  // describe block below, where the card stmts are wired up correctly.

  it('clears changes_ready when a PR already exists', async () => {
    mockExec({
      'git remote -v': { stdout: 'origin\thttps://github.com/test/repo.git (fetch)\n' },
      'git status --porcelain': { stdout: 'M file.ts\n' },
      'git log @{upstream}..HEAD': { stdout: '' },
      'git rev-parse --abbrev-ref HEAD': { stdout: 'feature/existing\n' },
      'gh pr view': { stdout: 'https://github.com/test/repo/pull/99\n' },
    });

    const project = { id: 'test', cwd: '/repo' } as never;
    const agent = { name: 'test-agent', role: 'dev' } as never;

    await autoCommitAndPR('sess-4', 'agent-1', project, agent, '/worktree', '');

    // Should clear changes_ready from the session
    const clearCalls = (mockStmts.clearSessionChangesReady as { run: ReturnType<typeof vi.fn> }).run
      .mock.calls;
    expect(clearCalls).toHaveLength(1);
    expect(clearCalls[0][0]).toBe('sess-4');

    // Should NOT persist changes_ready
    const updateCalls = (mockStmts.updateSessionChangesReady as { run: ReturnType<typeof vi.fn> })
      .run.mock.calls;
    expect(updateCalls).toHaveLength(0);
  });
});

describe('commitPushAndCreatePR — existing PR early return re-applies auto-merge', () => {
  // When an autonomous/card-driven re-run finds an existing open PR on a
  // branch with no new changes, commitPushAndCreatePR takes its early-return
  // path. That path must still re-apply the project's auto-merge intent so
  // that flipping the Settings toggle ON after the PR was created actually
  // takes effect on the next re-run. Idempotent on GitHub's side.
  const mockBroadcast = vi.fn();
  const mockCard = {
    id: 'card-1',
    title: 'Existing PR task',
    description: 'desc',
    priority: 'medium',
    autonomous_iterations: 1,
    epic_id: null,
  };

  function makeStmts() {
    return {
      getKanbanCardBySession: { get: vi.fn(() => mockCard) },
      setCardPrUrl: { run: vi.fn() },
      getKanbanBoard: { get: vi.fn(() => ({ id: 'board-1' })) },
      getKanbanColumns: {
        all: vi.fn(() => [
          { id: 'col-review', name: 'Review' },
          { id: 'col-done', name: 'Done' },
        ]),
      },
      moveKanbanCard: { run: vi.fn() },
      updateSessionChangesReady: { run: vi.fn() },
      clearSessionChangesReady: { run: vi.fn() },
    } as Record<string, unknown>;
  }

  function mockExecExistingPR(prUrl: string, execCalls: string[]) {
    installExecAndGhMock(
      (
        cmd: string,
        _opts: Record<string, unknown>,
        callback?: (err: Error | null, result: { stdout: string; stderr: string }) => void,
      ) => {
        execCalls.push(cmd);
        if (cmd.includes('git remote -v')) {
          if (callback)
            callback(null, {
              stdout: 'origin\thttps://github.com/test/repo.git (fetch)\n',
              stderr: '',
            });
          return;
        }
        // Empty status + empty log → clean worktree → early-return path.
        if (cmd.includes('git status --porcelain')) {
          if (callback) callback(null, { stdout: '', stderr: '' });
          return;
        }
        if (cmd.includes('git log')) {
          if (callback) callback(null, { stdout: '', stderr: '' });
          return;
        }
        if (cmd.includes('git rev-parse --abbrev-ref HEAD')) {
          if (callback) callback(null, { stdout: 'feature/existing-pr\n', stderr: '' });
          return;
        }
        if (cmd.includes('gh pr view')) {
          if (callback) callback(null, { stdout: `${prUrl}\n`, stderr: '' });
          return;
        }
        if (callback) callback(null, { stdout: '', stderr: '' });
      },
    );
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('enables auto-merge when project.githubWorkflow.autoMerge is true', async () => {
    const execCalls: string[] = [];
    initAutoGit({
      stmts: makeStmts() as never,
      broadcast: mockBroadcast,
      getConfig: vi.fn(() => ({}) as never),
      DEFAULT_SKILLS_DIR: '/tmp/skills',
    });
    mockExecExistingPR('https://github.com/test/repo/pull/77', execCalls);

    const project = {
      id: 'proj-1',
      cwd: '/repo',
      githubWorkflow: { autoMerge: true },
    } as never;
    const agent = { name: 'test-agent', role: 'dev' } as never;

    await autoCommitAndPR('sess-am-on', 'agent-1', project, agent, '/worktree', '');

    // Fire-and-forget is scheduled via Promise.catch — flush microtasks AND
    // the setImmediate queue so the inner await execAsync(gh pr merge)
    // resolves before we assert.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    const autoMergeCalls = execCalls.filter((c) => c.includes('gh pr merge --auto --squash'));
    expect(autoMergeCalls).toHaveLength(1);
    expect(autoMergeCalls[0]).toContain('https://github.com/test/repo/pull/77');
  });

  it('does not enable auto-merge when project setting is off', async () => {
    const execCalls: string[] = [];
    initAutoGit({
      stmts: makeStmts() as never,
      broadcast: mockBroadcast,
      getConfig: vi.fn(() => ({}) as never),
      DEFAULT_SKILLS_DIR: '/tmp/skills',
    });
    mockExecExistingPR('https://github.com/test/repo/pull/78', execCalls);

    const project = { id: 'proj-1', cwd: '/repo' } as never; // no githubWorkflow
    const agent = { name: 'test-agent', role: 'dev' } as never;

    await autoCommitAndPR('sess-am-off', 'agent-1', project, agent, '/worktree', '');

    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    const autoMergeCalls = execCalls.filter((c) => c.includes('gh pr merge --auto'));
    expect(autoMergeCalls).toHaveLength(0);
  });
});

describe('broadcastAndMove — persists PR-created marker as a system message', () => {
  // When a PR is created (manual click OR auto-PR at session end), we persist
  // a permanent `role='system'` message in the chat timeline and broadcast a
  // `message_added` event so live clients can render it without a refetch.
  // This gives the user a timestamped, scrollable receipt of the action.

  const mockBroadcast = vi.fn();

  function makeStmtsWithMessageTable(opts?: { card?: Record<string, unknown> }) {
    // Capture the metadata argument passed to addMessage.run so the companion
    // getMessageById mock can return a faithful row (mirrors better-sqlite3's
    // round-trip behavior).
    let capturedMetadata: string | null = null;
    const addMessageRun = vi.fn((_id, _s, _role, _c, _e, _m, _att, metadata) => {
      capturedMetadata = metadata ?? null;
    });
    const getMessageByIdGet = vi.fn((id: string) => ({
      id,
      session_id: 'sess-1',
      role: 'system',
      content: 'PR created from these changes',
      engine: null,
      model: null,
      attachments: null,
      metadata: capturedMetadata,
      created_at: '2026-04-16T16:30:00.000Z',
    }));

    return {
      stmts: {
        getKanbanCardBySession: { get: vi.fn(() => opts?.card ?? undefined) },
        getSession: { get: vi.fn(() => ({ name: 'Test session' })) },
        setCardPrUrl: { run: vi.fn() },
        getKanbanBoard: { get: vi.fn(() => ({ id: 'board-1' })) },
        getKanbanColumns: {
          all: vi.fn(() => [
            { id: 'col-review', name: 'Review' },
            { id: 'col-done', name: 'Done' },
          ]),
        },
        moveKanbanCard: { run: vi.fn() },
        updateKanbanCard: { run: vi.fn() },
        updateSessionChangesReady: { run: vi.fn() },
        clearSessionChangesReady: { run: vi.fn() },
        addMessage: { run: addMessageRun },
        getMessageById: { get: getMessageByIdGet },
      } as Record<string, unknown>,
      addMessageRun,
      getMessageByIdGet,
    };
  }

  function mockExecForPRCreation(
    prUrl: string,
    commitSha: string,
    opts: { existingPR: boolean; probeReturnsUrl?: boolean },
    execCalls: string[],
  ) {
    installExecAndGhMock(
      (
        cmd: string,
        _opts: Record<string, unknown>,
        callback?: (err: Error | null, result: { stdout: string; stderr: string }) => void,
      ) => {
        execCalls.push(cmd);
        const ok = (stdout: string) => callback?.(null, { stdout, stderr: '' });
        const fail = (msg: string) => callback?.(new Error(msg), { stdout: '', stderr: '' });

        if (cmd.includes('git remote -v'))
          return ok('origin\thttps://github.com/test/repo.git (fetch)\n');
        // Non-empty status → we go through the commit/push/create path, which
        // is the path that exercises broadcastAndMove.
        if (cmd.includes('git status --porcelain')) return ok('M file.ts\n');
        if (cmd.includes('git log @{upstream}..HEAD')) return fail('no upstream');
        if (cmd.includes('git log main..HEAD')) return ok('');
        if (cmd.includes('git rev-parse --abbrev-ref HEAD')) return ok('feature/pr-marker\n');
        if (cmd.startsWith('git rev-parse HEAD')) return ok(`${commitSha}\n`);
        // `gh pr view --json` is used by BOTH the ad-hoc pre-check in
        // autoCommitAndPR AND the clean-worktree early-return inside
        // commitPushAndCreatePR. For the ad-hoc flow we want it to return a
        // URL so we take the "fix existing PR" branch; inside
        // commitPushAndCreatePR the worktree is not clean so the early return
        // is skipped anyway.
        if (cmd.startsWith('gh pr view --json'))
          return ok(opts.probeReturnsUrl ? `${prUrl}\n` : '');
        if (cmd.startsWith('gh pr view')) return ok('');
        if (cmd.startsWith('gh pr create')) {
          return opts.existingPR
            ? fail(`a pull request for branch "feature/pr-marker" already exists: ${prUrl}`)
            : ok(`${prUrl}\n`);
        }
        // git config / git add / git commit / git push — succeed silently.
        return ok('');
      },
    );
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('inserts a system message + broadcasts message_added on successful PR creation', async () => {
    const execCalls: string[] = [];
    const { stmts, addMessageRun, getMessageByIdGet } = makeStmtsWithMessageTable({
      card: {
        id: 'card-42',
        title: 'Fix login bug',
        description: 'desc',
        priority: 'medium',
        autonomous_iterations: 1,
        epic_id: null,
      },
    });

    initAutoGit({
      stmts: stmts as never,
      broadcast: mockBroadcast,
      getConfig: vi.fn(() => ({}) as never),
      DEFAULT_SKILLS_DIR: '/tmp/skills',
    });
    mockExecForPRCreation(
      'https://github.com/test/repo/pull/123',
      'abc123def456',
      { existingPR: false },
      execCalls,
    );

    const project = { id: 'p', cwd: '/repo' } as never;
    const agent = { name: 'dev', role: 'dev' } as never;
    await autoCommitAndPR('sess-1', 'agent-1', project, agent, '/worktree', '');

    // Flush fire-and-forget auto-merge microtasks so subsequent assertions are stable.
    await new Promise((r) => setImmediate(r));

    // 1. A row was inserted into the messages table with role='system'.
    expect(addMessageRun).toHaveBeenCalledTimes(1);
    const args = addMessageRun.mock.calls[0];
    expect(args[2]).toBe('system');
    expect(args[3]).toBe('PR created from these changes');
    // Positional: id, session_id, role, content, engine, model, attachments, metadata
    expect(args[4]).toBeNull(); // engine
    expect(args[5]).toBeNull(); // model
    expect(args[6]).toBeNull(); // attachments

    // 2. Metadata is valid JSON with the expected fields.
    const metadata = JSON.parse(args[7]);
    expect(metadata.kind).toBe('pr_created');
    expect(metadata.prUrl).toBe('https://github.com/test/repo/pull/123');
    expect(metadata.prNumber).toBe(123);
    expect(metadata.commitSha).toBe('abc123def456');
    expect(metadata.commitTitle).toBe('Fix login bug');
    expect(metadata.cardId).toBe('card-42');
    expect(metadata.cardTitle).toBe('Fix login bug');

    // 3. The inserted row was re-read and broadcast as message_added.
    expect(getMessageByIdGet).toHaveBeenCalled();
    const messageAddedEvents = mockBroadcast.mock.calls.filter(
      (c: Array<Record<string, unknown>>) => c[0]?.type === 'message_added',
    );
    expect(messageAddedEvents).toHaveLength(1);
    expect((messageAddedEvents[0][0] as { sessionId: string }).sessionId).toBe('sess-1');
    const msg = (messageAddedEvents[0][0] as { message: { role: string; metadata: string } })
      .message;
    expect(msg.role).toBe('system');
    expect(JSON.parse(msg.metadata).prNumber).toBe(123);
  });

  it('invokes gh pr create via execFile so PR bodies can contain backticks and shell metacharacters', async () => {
    const execCalls: string[] = [];
    const { stmts } = makeStmtsWithMessageTable({
      card: {
        id: 'card-shell',
        title: 'Shell-safe PR body',
        description: 'Refs `pulls/{pr}/reviews` and ${HOME} must not break /bin/sh.',
        priority: 'medium',
        autonomous_iterations: 1,
        epic_id: null,
      },
    });

    initAutoGit({
      stmts: stmts as never,
      broadcast: mockBroadcast,
      getConfig: vi.fn(() => ({}) as never),
      DEFAULT_SKILLS_DIR: '/tmp/skills',
    });
    mockExecForPRCreation(
      'https://github.com/test/repo/pull/555',
      'deadbeef',
      { existingPR: false },
      execCalls,
    );

    const project = { id: 'p', cwd: '/repo' } as never;
    const agent = { name: 'dev', role: 'dev' } as never;
    await autoCommitAndPR('sess-shell', 'agent-1', project, agent, '/worktree', '');
    await new Promise((r) => setImmediate(r));

    const ghCreateCalls = (execFile as unknown as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: unknown[]) =>
        c[0] === 'gh' &&
        Array.isArray(c[1]) &&
        (c[1] as string[])[0] === 'pr' &&
        (c[1] as string[])[1] === 'create',
    );
    expect(ghCreateCalls.length).toBe(1);
    const argv = ghCreateCalls[0][1] as string[];
    const bodyIdx = argv.indexOf('--body');
    expect(bodyIdx).toBeGreaterThan(-1);
    expect(argv[bodyIdx + 1]).toContain('`pulls/');
    expect(argv[bodyIdx + 1]).toContain('${HOME}');
  });

  it('sets cardId/cardTitle to null when session has no linked kanban card (ad-hoc flow)', async () => {
    // Ad-hoc flow: no card in DB for this session. The marker must still be
    // persisted, but with cardId/cardTitle both null so the client can render
    // the stripped-down variant.
    const execCalls: string[] = [];
    const { stmts, addMessageRun } = makeStmtsWithMessageTable({ card: undefined });

    // For the ad-hoc path (no card), autoCommitAndPR uses a different code
    // path that only goes through broadcastAndMove via the catch-existing-PR
    // branch. Mock gh pr create to fail with "already exists" so we reach the
    // broadcastAndMove call in commitPushAndCreatePR's catch handler.
    initAutoGit({
      stmts: stmts as never,
      broadcast: mockBroadcast,
      getConfig: vi.fn(() => ({}) as never),
      DEFAULT_SKILLS_DIR: '/tmp/skills',
    });
    // probeReturnsUrl=true → ad-hoc branch treats this as "fix an existing
    // PR" and falls through to commitPushAndCreatePR without a card. That
    // call's `gh pr create` then fails with "already exists", reaching the
    // catch branch where broadcastAndMove is invoked with the matched URL.
    mockExecForPRCreation(
      'https://github.com/test/repo/pull/200',
      'sha-no-card',
      { existingPR: true, probeReturnsUrl: true },
      execCalls,
    );

    const project = { id: 'p', cwd: '/repo' } as never;
    const agent = { name: 'dev', role: 'dev' } as never;
    await autoCommitAndPR('sess-adhoc', 'agent-1', project, agent, '/worktree', '');
    await new Promise((r) => setImmediate(r));

    expect(addMessageRun).toHaveBeenCalledTimes(1);
    const metadata = JSON.parse(addMessageRun.mock.calls[0][7]);
    expect(metadata.cardId).toBeNull();
    expect(metadata.cardTitle).toBeNull();
    expect(metadata.prUrl).toBe('https://github.com/test/repo/pull/200');
    expect(metadata.prNumber).toBe(200);
  });

  it('does not crash the PR flow if addMessage fails (marker persistence is best-effort)', async () => {
    // Defensive: if the system-message insert blows up for any reason, the
    // surrounding PR-creation flow must still succeed — the marker is a
    // cosmetic receipt, not a correctness guarantee.
    const execCalls: string[] = [];
    const { stmts } = makeStmtsWithMessageTable({
      card: {
        id: 'c',
        title: 'T',
        description: 'd',
        priority: 'medium',
        autonomous_iterations: 1,
        epic_id: null,
      },
    });
    (stmts.addMessage as { run: ReturnType<typeof vi.fn> }).run.mockImplementation(() => {
      throw new Error('simulated insert failure');
    });

    initAutoGit({
      stmts: stmts as never,
      broadcast: mockBroadcast,
      getConfig: vi.fn(() => ({}) as never),
      DEFAULT_SKILLS_DIR: '/tmp/skills',
    });
    mockExecForPRCreation(
      'https://github.com/test/repo/pull/9',
      'sha-fail',
      { existingPR: false },
      execCalls,
    );

    const project = { id: 'p', cwd: '/repo' } as never;
    const agent = { name: 'dev', role: 'dev' } as never;

    // Should not throw.
    await expect(
      autoCommitAndPR('sess-fail', 'agent-1', project, agent, '/worktree', ''),
    ).resolves.toBeUndefined();
    await new Promise((r) => setImmediate(r));

    // The original auto_pr_created broadcast still fires.
    const autoPrEvents = mockBroadcast.mock.calls.filter(
      (c: Array<Record<string, unknown>>) => c[0]?.type === 'auto_pr_created',
    );
    expect(autoPrEvents).toHaveLength(1);
  });
});

describe('autoCommitAndPR — isAutonomousCard gating (manual link vs dispatched)', () => {
  // Regression: manually linking a kanban card to a session via `session_id`
  // must NOT hijack session-end into the autonomous auto-PR path. Only cards
  // that were actually dispatched by the autonomous system
  // (autonomous_iterations > 0 OR epic_id set) should take that path.
  const mockBroadcast = vi.fn();

  function makeStmtsWithCard(card: Record<string, unknown>) {
    return {
      getKanbanCardBySession: { get: vi.fn(() => card) },
      getSession: { get: vi.fn(() => ({ name: 'Test session' })) },
      setCardPrUrl: { run: vi.fn() },
      getKanbanBoard: { get: vi.fn(() => ({ id: 'board-1' })) },
      getKanbanColumns: {
        all: vi.fn(() => [
          { id: 'col-review', name: 'Review' },
          { id: 'col-done', name: 'Done' },
        ]),
      },
      moveKanbanCard: { run: vi.fn() },
      updateKanbanCard: { run: vi.fn() },
      updateSessionChangesReady: { run: vi.fn() },
      clearSessionChangesReady: { run: vi.fn() },
      addMessage: { run: vi.fn() },
      getMessageById: { get: vi.fn() },
    } as Record<string, unknown>;
  }

  function mockExecAdHocStyle(execCalls: string[]) {
    // No existing PR, clean-ish worktree with one modified file, no upstream.
    // This is the shape that should trigger the `changes_ready` banner path
    // when we're on the ad-hoc branch.
    installExecAndGhMock(
      (
        cmd: string,
        _opts: Record<string, unknown>,
        callback?: (err: Error | null, result: { stdout: string; stderr: string }) => void,
      ) => {
        execCalls.push(cmd);
        const ok = (stdout: string) => callback?.(null, { stdout, stderr: '' });
        const fail = (msg: string) => callback?.(new Error(msg), { stdout: '', stderr: '' });

        if (cmd.includes('git remote -v'))
          return ok('origin\thttps://github.com/test/repo.git (fetch)\n');
        if (cmd.includes('git status --porcelain')) return ok('M file.ts\n');
        if (cmd.includes('git log @{upstream}..HEAD')) return fail('no upstream');
        if (cmd.includes('git log main..HEAD')) return ok('');
        if (cmd.includes('git rev-parse --abbrev-ref HEAD')) return ok('feature/manual-link\n');
        if (cmd.startsWith('gh pr view')) return fail('no pull requests found');
        if (cmd.startsWith('gh pr create')) return ok('https://github.com/test/repo/pull/999\n');
        return ok('');
      },
    );
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('manually-linked card (iters=0, epic=null) takes AD-HOC path → broadcasts changes_ready, does NOT open a PR', async () => {
    const execCalls: string[] = [];
    const stmts = makeStmtsWithCard({
      id: 'card-manual',
      title: 'Manually linked card',
      description: 'desc',
      priority: 'medium',
      autonomous_iterations: 0,
      epic_id: null,
    });

    initAutoGit({
      stmts: stmts as never,
      broadcast: mockBroadcast,
      getConfig: vi.fn(() => ({}) as never),
      DEFAULT_SKILLS_DIR: '/tmp/skills',
    });
    mockExecAdHocStyle(execCalls);

    const project = { id: 'p', cwd: '/repo' } as never;
    const agent = { name: 'dev', role: 'dev' } as never;
    await autoCommitAndPR('sess-manual', 'agent-1', project, agent, '/worktree', '');

    // Must broadcast changes_ready → "Create PR" button appears in UI.
    const changesReadyEvents = mockBroadcast.mock.calls.filter(
      (c: Array<Record<string, unknown>>) => c[0]?.type === 'changes_ready',
    );
    expect(changesReadyEvents).toHaveLength(1);
    expect((changesReadyEvents[0][0] as { branch: string }).branch).toBe('feature/manual-link');

    // Must NOT have auto-created a PR.
    const ghCreateCalls = execCalls.filter((c) => c.startsWith('gh pr create'));
    expect(ghCreateCalls).toHaveLength(0);
    const autoPrEvents = mockBroadcast.mock.calls.filter(
      (c: Array<Record<string, unknown>>) => c[0]?.type === 'auto_pr_created',
    );
    expect(autoPrEvents).toHaveLength(0);
  });

  it('card with autonomous_iterations=1 takes AUTONOMOUS path → opens PR, no changes_ready', async () => {
    const execCalls: string[] = [];
    const stmts = makeStmtsWithCard({
      id: 'card-auto',
      title: 'Autonomous card',
      description: 'desc',
      priority: 'medium',
      autonomous_iterations: 1,
      epic_id: null,
    });

    initAutoGit({
      stmts: stmts as never,
      broadcast: mockBroadcast,
      getConfig: vi.fn(() => ({}) as never),
      DEFAULT_SKILLS_DIR: '/tmp/skills',
    });
    mockExecAdHocStyle(execCalls);

    const project = { id: 'p', cwd: '/repo' } as never;
    const agent = { name: 'dev', role: 'dev' } as never;
    await autoCommitAndPR('sess-auto', 'agent-1', project, agent, '/worktree', '');

    // Autonomous path creates the PR.
    const ghCreateCalls = execCalls.filter((c) => c.startsWith('gh pr create'));
    expect(ghCreateCalls).toHaveLength(1);

    // No changes_ready banner on the autonomous path.
    const changesReadyEvents = mockBroadcast.mock.calls.filter(
      (c: Array<Record<string, unknown>>) => c[0]?.type === 'changes_ready',
    );
    expect(changesReadyEvents).toHaveLength(0);
  });

  it('card with epic_id set (iters=0) takes AUTONOMOUS path → opens PR', async () => {
    const execCalls: string[] = [];
    const stmts = makeStmtsWithCard({
      id: 'card-epic',
      title: 'Epic card',
      description: 'desc',
      priority: 'medium',
      autonomous_iterations: 0,
      epic_id: 'epic-xyz',
    });

    initAutoGit({
      stmts: stmts as never,
      broadcast: mockBroadcast,
      getConfig: vi.fn(() => ({}) as never),
      DEFAULT_SKILLS_DIR: '/tmp/skills',
    });
    mockExecAdHocStyle(execCalls);

    const project = { id: 'p', cwd: '/repo' } as never;
    const agent = { name: 'dev', role: 'dev' } as never;
    await autoCommitAndPR('sess-epic', 'agent-1', project, agent, '/worktree', '');

    const ghCreateCalls = execCalls.filter((c) => c.startsWith('gh pr create'));
    expect(ghCreateCalls).toHaveLength(1);

    const changesReadyEvents = mockBroadcast.mock.calls.filter(
      (c: Array<Record<string, unknown>>) => c[0]?.type === 'changes_ready',
    );
    expect(changesReadyEvents).toHaveLength(0);
  });
});

describe('buildCardDescription', () => {
  it('includes the first user message as the task', () => {
    const messages = [
      makeMsg('user', 'Fix the login page crash when email is empty'),
      makeMsg('assistant', 'I found the issue in LoginForm.jsx...'),
    ];
    const result = buildCardDescription(messages, '');
    expect(result).toContain('### Task');
    expect(result).toContain('Fix the login page crash when email is empty');
  });

  it('truncates long user messages to 500 chars', () => {
    const longMessage = 'A'.repeat(600);
    const messages = [makeMsg('user', longMessage)];
    const result = buildCardDescription(messages, '');
    expect(result).toContain('A'.repeat(500) + '...');
    expect(result).not.toContain('A'.repeat(501));
  });

  it('includes git diff stat in a Changes section', () => {
    const messages = [makeMsg('user', 'Add dark mode')];
    const diffStat =
      ' src/App.jsx | 12 ++++++------\n 1 file changed, 6 insertions(+), 6 deletions(-)';
    const result = buildCardDescription(messages, diffStat);
    expect(result).toContain('### Changes');
    expect(result).toContain('src/App.jsx');
    expect(result).toContain('```');
  });

  it('limits diff stat to 20 lines', () => {
    const messages = [makeMsg('user', 'Refactor everything')];
    const statLines = Array.from({ length: 25 }, (_, i) => ` file${i}.ts | 1 +`);
    const diffStat = statLines.join('\n');
    const result = buildCardDescription(messages, diffStat);
    expect(result).toContain('file0.ts');
    expect(result).toContain('file18.ts');
    expect(result).not.toContain('file19.ts');
    expect(result).toContain('... and 6 more files');
  });

  it('returns empty string when no messages and no diff', () => {
    const result = buildCardDescription([], '');
    expect(result).toBe('');
  });

  it('skips assistant-only start and finds the first user message', () => {
    const messages = [
      makeMsg('assistant', 'How can I help you?'),
      makeMsg('user', 'Fix the bug in auth'),
    ];
    const result = buildCardDescription(messages, '');
    expect(result).toContain('Fix the bug in auth');
    expect(result).not.toContain('How can I help you?');
  });
});

describe('buildPrTitle', () => {
  it('passes short clean titles through unchanged', () => {
    expect(buildPrTitle('Add dark mode support')).toBe('Add dark mode support');
  });

  it('trims whitespace and collapses internal whitespace', () => {
    expect(buildPrTitle('  Fix   login   crash  ')).toBe('Fix login crash');
  });

  it('strips trailing punctuation (GitHub convention: no period)', () => {
    expect(buildPrTitle('Fix login crash.')).toBe('Fix login crash');
    expect(buildPrTitle('Did it!')).toBe('Did it');
    expect(buildPrTitle('Why?')).toBe('Why');
  });

  it('sentence-cases a lowercase first letter', () => {
    expect(buildPrTitle('fix login crash')).toBe('Fix login crash');
  });

  it('preserves scoped prefixes like `fix:` when already starting uppercase', () => {
    expect(buildPrTitle('Fix: login crash')).toBe('Fix: login crash');
  });

  it('truncates long titles at a word boundary with an ellipsis', () => {
    const raw =
      'Refactor the authentication middleware to handle concurrent refresh tokens gracefully across tabs';
    const result = buildPrTitle(raw);
    expect(result.length).toBeLessThanOrEqual(70);
    expect(result.endsWith('…')).toBe(true);
    // The portion before the ellipsis must be a whole-word prefix of the
    // input — i.e. the original continues with a space after the cut point.
    const stem = result.slice(0, -1);
    expect(raw.startsWith(stem + ' ')).toBe(true);
  });

  it('hard-clips when the first word alone exceeds the limit', () => {
    const raw = 'A'.repeat(100);
    const result = buildPrTitle(raw);
    expect(result.length).toBeLessThanOrEqual(70);
    expect(result.endsWith('…')).toBe(true);
  });

  it('returns a safe default for empty input', () => {
    expect(buildPrTitle('')).toBe('Untitled change');
    expect(buildPrTitle('   ')).toBe('Untitled change');
  });

  it('produces a clean PR title for a handoff-derived session name (regression for PR #363)', () => {
    // `server/handoff.ts` now stores the session name as a `buildPrTitle`-
    // normalised first line of the handoff note. auto-git.ts:510 falls back
    // to that session name when no kanban card is linked, then re-runs it
    // through buildPrTitle. The pipeline must be idempotent and must never
    // regress to a locale-timestamp format.
    const sessionName = buildPrTitle('Fix PR titles for handoff-sourced sessions');
    const prTitle = buildPrTitle(sessionName);
    expect(prTitle).toBe('Fix PR titles for handoff-sourced sessions');
    expect(prTitle).not.toMatch(/\d{1,2}:\d{2}/);
    expect(prTitle).not.toMatch(/ — /);
  });
});

describe('buildPrBody', () => {
  const agentName = 'dev';

  it('renders a minimal body when no card / commits / diff are available', () => {
    const body = buildPrBody({ agentName });
    expect(body).toContain('## Summary');
    expect(body).toContain(`Task completed by ${agentName}.`);
    expect(body).toContain('Agent: **dev**');
    expect(body).toContain('_Automated PR from Agent Hub_');
    // No empty section headers.
    expect(body).not.toContain('## Commits');
    expect(body).not.toContain('## Files changed');
  });

  it('uses the card description as the summary when present', () => {
    const card = {
      id: 'c1',
      description: 'Fix the login crash when email is empty',
    } as never;
    const body = buildPrBody({ agentName, card });
    expect(body).toContain('## Summary');
    expect(body).toContain('Fix the login crash when email is empty');
    expect(body).not.toContain(`Task completed by ${agentName}.`);
  });

  it('omits the Commits section when only one commit is present', () => {
    const body = buildPrBody({ agentName, commits: ['Fix login'] });
    expect(body).not.toContain('## Commits');
  });

  it('lists commits when there are multiple, newest first', () => {
    const body = buildPrBody({
      agentName,
      commits: ['Fix null pointer', 'Add regression test', 'Tidy imports'],
    });
    expect(body).toContain('## Commits');
    expect(body).toContain('- Fix null pointer');
    expect(body).toContain('- Add regression test');
    expect(body).toContain('- Tidy imports');
  });

  it('caps the commit list at 20 entries with an overflow note', () => {
    const commits = Array.from({ length: 25 }, (_, i) => `Commit ${i}`);
    const body = buildPrBody({ agentName, commits });
    expect(body).toContain('- Commit 0');
    expect(body).toContain('- Commit 19');
    expect(body).not.toContain('- Commit 20');
    expect(body).toContain('…and 5 more');
  });

  it('renders a diff stat inside a Files changed code block', () => {
    const diffStat =
      ' src/App.jsx | 12 ++++++------\n 1 file changed, 6 insertions(+), 6 deletions(-)';
    const body = buildPrBody({ agentName, diffStat });
    expect(body).toContain('## Files changed');
    expect(body).toContain('src/App.jsx');
    expect(body).toMatch(/```[\s\S]*src\/App\.jsx[\s\S]*```/);
  });

  it('caps the diff stat at 20 lines with an overflow note', () => {
    const diffStat = Array.from({ length: 25 }, (_, i) => ` file${i}.ts | 1 +`).join('\n');
    const body = buildPrBody({ agentName, diffStat });
    expect(body).toContain('file0.ts');
    expect(body).toContain('file18.ts');
    expect(body).not.toContain('file19.ts');
    expect(body).toContain('…and 6 more');
  });

  it('renders priority and labels in the metadata footer when present', () => {
    const card = {
      id: 'c2',
      description: 'desc',
      priority: 'high',
      labels: 'bug, p1 ,regression',
    } as never;
    const body = buildPrBody({ agentName, card });
    expect(body).toContain('Agent: **dev**');
    expect(body).toContain('Priority: `high`');
    expect(body).toContain('Labels: `bug`, `p1`, `regression`');
    expect(body).toContain('_Automated PR from Agent Hub · kanban card c2_');
  });

  it('omits priority/labels rather than showing empty headers', () => {
    const card = { id: 'c3', description: 'desc', priority: '', labels: '' } as never;
    const body = buildPrBody({ agentName, card });
    expect(body).not.toContain('Priority:');
    expect(body).not.toContain('Labels:');
    // Footer still renders agent + card id.
    expect(body).toContain('Agent: **dev**');
    expect(body).toContain('kanban card c3');
  });

  it('uses the ad-hoc footer when no card is linked', () => {
    const body = buildPrBody({ agentName });
    expect(body).toContain('_Automated PR from Agent Hub_');
    expect(body).not.toContain('kanban card');
  });
});

describe('isGarbageTitle', () => {
  it('rejects titles with newlines', () => {
    expect(isGarbageTitle('line one\nline two')).toBe(true);
  });

  it('rejects titles starting with status symbols', () => {
    expect(isGarbageTitle('✓ Success')).toBe(true);
    expect(isGarbageTitle('✗ Failed')).toBe(true);
    expect(isGarbageTitle('⚠ Warning')).toBe(true);
  });

  it('rejects titles starting with timestamps', () => {
    expect(isGarbageTitle('4/15/2026, 9:00:00 AM')).toBe(true);
    expect(isGarbageTitle('12/31/2025 some output')).toBe(true);
  });

  it('rejects titles starting with markdown headers', () => {
    expect(isGarbageTitle('## Update Report')).toBe(true);
    expect(isGarbageTitle('### Key highlights')).toBe(true);
  });

  it('rejects very long titles (>120 chars)', () => {
    expect(isGarbageTitle('A'.repeat(121))).toBe(true);
  });

  it('accepts clean titles', () => {
    expect(isGarbageTitle('Fix login page crash')).toBe(false);
    expect(isGarbageTitle('Add dark mode support')).toBe(false);
    expect(isGarbageTitle('Update dependencies to v2.1.109')).toBe(false);
  });

  it('accepts empty string (not garbage, just empty)', () => {
    expect(isGarbageTitle('')).toBe(false);
  });

  it('rejects real cron output like the screenshot bug', () => {
    const cronTitle = '✓ Success\n4/15/2026, 9:00:00 AM\n88.5s\nX\n---\n\n## Update Report';
    expect(isGarbageTitle(cronTitle)).toBe(true);
  });
});
