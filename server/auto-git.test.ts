import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { EventEmitter } from 'events';

// Mock child_process before importing module
vi.mock('child_process', () => ({
  exec: vi.fn(),
  execFile: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock('fs', () => ({
  readFileSync: vi.fn(),
  existsSync: vi.fn(() => false),
  statSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

// Stubs for the per-user GitHub token resolution path. Default to nulls so
// the bulk of the suite (which doesn't care about token injection) is
// unaffected — tests that DO care override the return values inline.
vi.mock('./session-ownership.js', () => ({
  getSessionOwner: vi.fn(() => null),
  getOrgOwnerUserId: vi.fn(() => null),
}));
vi.mock('./github-connections-store.js', () => ({
  getActiveAccessToken: vi.fn(async () => null),
}));

import { exec, execFile, spawn } from 'child_process';
import {
  checkWorktreeChanges,
  initAutoGit,
  autoCommitAndPR,
  manualCommitAndPR,
  buildCardDescription,
  buildPrTitle,
  buildPrBody,
  buildPushArgs,
  isGarbageTitle,
  getProjectPreCommitCommands,
  getProjectCheckHealCommands,
  getProjectCheckHealMaxRounds,
  isEligibleCheckFailureForAutoHeal,
  CheckCommandFailedError,
  CHECK_COMMAND_NONZERO_EXIT_CODE,
  truncateForGitCommitMessage,
  MAX_GIT_COMMIT_MESSAGE_CHARS,
  runShellCommandStreaming,
  STREAM_OUTPUT_MAX_BYTES,
  normalizeCommitInputs,
  pickPrTitleFromCommits,
} from './auto-git.js';
import path from 'path';
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
  wireSpawnToExecMocks();
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
      const cmd = [file, ...args].join(' ');
      run(cmd, callback);
    },
  );
}

/**
 * `auto-git` streams git/gh/shell work via `spawn`. Tests historically mocked
 * `exec` / `execFile` only — bridge spawn → the active mock implementations.
 */
function wireSpawnToExecMocks() {
  (spawn as unknown as ReturnType<typeof vi.fn>).mockImplementation(
    (command: string, args: string[], options: { cwd?: string }) => {
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
        kill: ReturnType<typeof vi.fn>;
      };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = vi.fn();

      const finish = (err: Error | null, stdout: string, stderr: string) => {
        if (stdout) child.stdout.emit('data', Buffer.from(stdout));
        const errText = stderr || (err ? err.message : '');
        if (errText) child.stderr.emit('data', Buffer.from(errText));
        child.emit('close', err ? 1 : 0, null);
      };

      const run = () => {
        const execFileImpl = (execFile as unknown as Mock).getMockImplementation() as
          | ((
              file: string,
              args: string[],
              options: { cwd?: string },
              callback: (err: Error | null, result: { stdout: string; stderr: string }) => void,
            ) => void)
          | undefined;
        const execImpl = (exec as unknown as Mock).getMockImplementation() as
          | ((
              cmd: string,
              options: { cwd?: string },
              callback: (err: Error | null, result: { stdout: string; stderr: string }) => void,
            ) => void)
          | undefined;

        if (command === 'git' || command === 'gh') {
          if (execFileImpl) {
            execFileImpl(
              command,
              args,
              options || {},
              (err: Error | null, result: { stdout: string; stderr: string }) => {
                finish(err, result?.stdout || '', result?.stderr || '');
              },
            );
            return;
          }
        }

        const cIdx = args?.indexOf('-c');
        const shellScript =
          cIdx >= 0 && typeof args[cIdx + 1] === 'string'
            ? (args[cIdx + 1] as string)
            : String(command || '')
                  .toLowerCase()
                  .includes('cmd') && args?.length
              ? String(args[args.length - 1])
              : null;

        if (shellScript && execImpl) {
          execImpl(
            shellScript,
            options || {},
            (err: Error | null, result: { stdout: string; stderr: string }) => {
              finish(err, result?.stdout || '', result?.stderr || '');
            },
          );
          return;
        }

        // Neither `git`/`gh` argv nor a `-c` shell script matched — return an
        // empty success so tests that stub spawn without wiring exec keep working.
        finish(null, '', '');
      };

      queueMicrotask(run);
      return child;
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
  wireSpawnToExecMocks();
  (exec as unknown as ReturnType<typeof vi.fn>).mockImplementation(impl);
  (execFile as unknown as ReturnType<typeof vi.fn>).mockImplementation(
    (
      file: string,
      args: string[],
      opts: Record<string, unknown>,
      callback?: (err: Error | null, result: { stdout: string; stderr: string }) => void,
    ) => {
      impl([file, ...args].join(' '), opts, callback);
    },
  );
}

describe('buildPushArgs — lease pinning', () => {
  // The whole reason this helper exists: when the pre-push rebase rewrote
  // history we MUST pin `--force-with-lease` to the SHA we resolved from
  // origin via `ls-remote`, not the local `refs/remotes/origin/<branch>`
  // cache. Otherwise a parallel push by another actor trips the lease as
  // `! [rejected] <branch> -> <branch> (stale info)` and the session bails.
  // These tests freeze the argv shape so a future refactor can't silently
  // regress back to a bare lease.

  it('plain push (no lease) when the rebase did NOT rewrite history', () => {
    expect(
      buildPushArgs({
        branch: 'feature/x',
        rebaseRewroteHistory: false,
        expectedRemoteSha: 'deadbeef'.repeat(5),
      }),
    ).toEqual(['push', '-u', 'origin', 'feature/x']);
  });

  it('plain push when rebase did not rewrite history, even if no expected SHA is known', () => {
    expect(
      buildPushArgs({
        branch: 'feature/x',
        rebaseRewroteHistory: false,
        expectedRemoteSha: null,
      }),
    ).toEqual(['push', '-u', 'origin', 'feature/x']);
  });

  it('PINS the lease to the expected SHA when rebase rewrote history and origin SHA is known', () => {
    const sha = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
    expect(
      buildPushArgs({
        branch: 'feature/x',
        rebaseRewroteHistory: true,
        expectedRemoteSha: sha,
      }),
    ).toEqual(['push', `--force-with-lease=feature/x:${sha}`, '-u', 'origin', 'feature/x']);
  });

  it('falls back to bare --force-with-lease when rebase rewrote history but branch is brand-new on origin', () => {
    // Bare `--force-with-lease` correctly treats an absent remote ref as
    // the empty value, so a brand-new branch push still passes the lease
    // check. We document this fallback in the comment on `buildPushArgs`.
    expect(
      buildPushArgs({
        branch: 'feature/brand-new',
        rebaseRewroteHistory: true,
        expectedRemoteSha: null,
      }),
    ).toEqual(['push', '--force-with-lease', '-u', 'origin', 'feature/brand-new']);
  });

  it('preserves slashes in branch names when pinning the lease (typical agent-hub/<project>/<short-uuid> shape)', () => {
    const sha = 'cafebabe'.repeat(5);
    const branch = 'agent-hub/agent-hub/session-1a2b3c4d';
    expect(
      buildPushArgs({
        branch,
        rebaseRewroteHistory: true,
        expectedRemoteSha: sha,
      }),
    ).toEqual(['push', `--force-with-lease=${branch}:${sha}`, '-u', 'origin', branch]);
  });
});

describe('truncateForGitCommitMessage', () => {
  it('returns unchanged text when under the cap', () => {
    const s = 'Title\n\nBody with `backticks` and $(cmd)';
    expect(truncateForGitCommitMessage(s)).toBe(s);
  });

  it('strips NUL bytes', () => {
    expect(truncateForGitCommitMessage('a\0b\0c')).toBe('abc');
  });

  it('truncates oversized messages and ends with the truncation marker', () => {
    const huge = 'x'.repeat(MAX_GIT_COMMIT_MESSAGE_CHARS + 5000);
    const out = truncateForGitCommitMessage(huge);
    expect(out.length).toBeLessThanOrEqual(MAX_GIT_COMMIT_MESSAGE_CHARS);
    expect(out.endsWith('\n\n… (truncated by Agent Hub)')).toBe(true);
  });

  it('keeps the cap under the Windows CreateProcess command-line limit (minus argv headroom)', () => {
    const WIN32_MAX_CMDLINE_CHARS = 32767;
    const argvOverheadReserve = 5000;
    expect(MAX_GIT_COMMIT_MESSAGE_CHARS).toBeLessThanOrEqual(
      WIN32_MAX_CMDLINE_CHARS - argvOverheadReserve,
    );
  });
});

describe('getProjectPreCommitCommands', () => {
  it('returns trimmed non-empty strings from project.preCommitCommands', () => {
    const project = {
      id: 'p1',
      preCommitCommands: ['  npm run lint  ', '', 'npm test', 3],
    } as never;
    expect(getProjectPreCommitCommands(project)).toEqual(['npm run lint', 'npm test']);
  });

  it('returns empty array when missing or invalid', () => {
    expect(getProjectPreCommitCommands({ id: 'p' } as never)).toEqual([]);
    expect(getProjectPreCommitCommands({ id: 'p', preCommitCommands: 'x' } as never)).toEqual([]);
  });
});

describe('check auto-heal project fields', () => {
  it('getProjectCheckHealCommands trims and drops non-strings', () => {
    expect(
      getProjectCheckHealCommands({
        id: 'p',
        checkHealCommands: ['  npm run lint:fix  ', '', 'npm run format', 3],
      } as never),
    ).toEqual(['npm run lint:fix', 'npm run format']);
  });

  it('getProjectCheckHealMaxRounds clamps to 1–5 and defaults to 2', () => {
    expect(getProjectCheckHealMaxRounds({ id: 'p' } as never)).toBe(2);
    expect(getProjectCheckHealMaxRounds({ id: 'p', checkHealMaxRounds: 99 } as never)).toBe(5);
    expect(getProjectCheckHealMaxRounds({ id: 'p', checkHealMaxRounds: 1 } as never)).toBe(1);
    expect(getProjectCheckHealMaxRounds({ id: 'p', checkHealMaxRounds: '4' } as never)).toBe(4);
  });

  it('isEligibleCheckFailureForAutoHeal only treats normal non-zero check exits as fixable', () => {
    expect(
      isEligibleCheckFailureForAutoHeal(
        new CheckCommandFailedError('Pre-commit command failed (1): npm run lint', {
          exitCode: 1,
          logKind: 'pre_commit',
        }),
      ),
    ).toBe(true);
    expect(
      isEligibleCheckFailureForAutoHeal(
        new CheckCommandFailedError('edge', { exitCode: 0, logKind: 'pre_commit' }),
      ),
    ).toBe(false);
    expect(
      isEligibleCheckFailureForAutoHeal(new Error('Pre-commit command failed (1): npm run lint')),
    ).toBe(true);
    expect(
      isEligibleCheckFailureForAutoHeal(new Error('Pre-commit command timed out after 9ms: x')),
    ).toBe(false);
    expect(
      isEligibleCheckFailureForAutoHeal(
        new Error('Pre-commit command output exceeded 100 bytes: x'),
      ),
    ).toBe(false);
    expect(isEligibleCheckFailureForAutoHeal(new Error('Check heal command failed (1): x'))).toBe(
      false,
    );
    expect(
      isEligibleCheckFailureForAutoHeal(new Error('Pre-commit command failed (null): SIGTERM: x')),
    ).toBe(false);
  });

  it('CheckCommandFailedError carries a stable machine-readable code', () => {
    const err = new CheckCommandFailedError('msg', { exitCode: 7, logKind: 'pre_commit' });
    expect(err.agentHubErrorCode).toBe(CHECK_COMMAND_NONZERO_EXIT_CODE);
    expect(err.exitCode).toBe(7);
  });
});

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
    getSession: { get: vi.fn(() => ({ code_changed_at: null })) },
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

    const project = { id: 'test', cwd: '/repo', githubRepo: 'test/repo' } as never;
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

    // Regression: the pre-check must short-circuit `gh pr create` — calling
    // create at all (even when it fails) was the bug, because in resolve-
    // comment flows on a fresh worktree branch the create call SUCCEEDS and
    // opens a duplicate PR.
    const createCalls = execCalls.filter((c) => c.startsWith('gh pr create'));
    expect(createCalls).toHaveLength(0);
  });

  it('skips gh pr create entirely when the branch already has an open PR (resolve-comment regression)', async () => {
    // Resolve-comment regression: when a session pushes to a branch that
    // already has an open PR — whether that's the original PR branch
    // (linked-session reuse) or any branch GitHub sees an open PR for —
    // we must NOT invoke `gh pr create`. The previous behaviour relied on
    // `gh pr create` failing and a regex pulling the URL out of stderr;
    // when the resolve session ran on a fresh worktree branch the create
    // call SUCCEEDED instead of failing, producing one new PR per review
    // round. The fix pre-checks `gh pr view <branch>` and short-circuits.
    const execCalls: string[] = [];
    const mockBroadcast = vi.fn();
    const mockStmtsAdHoc = {
      getKanbanCardBySession: { get: vi.fn(() => undefined) },
      getSession: { get: vi.fn(() => ({ name: 'Resolve comment session' })) },
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

        if (cmd.includes('git remote -v'))
          return ok('origin\thttps://github.com/test/repo.git (fetch)\n');
        if (cmd.includes('git status --porcelain')) return ok('M file.ts\n');
        if (cmd.includes('git log @{upstream}..HEAD')) return ok('');
        if (cmd.includes('git rev-parse --abbrev-ref HEAD'))
          return ok('agent-hub/test/session-resolve\n');
        // Pre-check: branch already has an open PR.
        if (cmd.startsWith('gh pr view')) return ok('https://github.com/test/repo/pull/123\n');
        // `gh pr create` MUST NOT be invoked — fail loudly if it is so the
        // assertion below pinpoints the regression.
        if (cmd.startsWith('gh pr create')) {
          return callback?.(new Error('gh pr create should not be called'), {
            stdout: '',
            stderr: '',
          });
        }
        return ok('');
      },
    );

    const project = { id: 'test', cwd: '/repo', githubRepo: 'test/repo' } as never;
    const agent = { name: 'resolve-agent', role: 'dev' } as never;

    await autoCommitAndPR('sess-resolve', 'agent-resolve', project, agent, '/worktree-resolve', '');

    // The fix: no `gh pr create` call at all.
    const createCalls = execCalls.filter((c) => c.startsWith('gh pr create'));
    expect(createCalls).toHaveLength(0);

    // The existing PR must still be surfaced via auto_pr_created so the
    // card lifecycle (move to Review, etc.) runs.
    const autoPrEvents = mockBroadcast.mock.calls.filter(
      (c: Array<Record<string, string>>) => c[0]?.type === 'auto_pr_created',
    );
    expect(autoPrEvents.length).toBeGreaterThan(0);
    expect(autoPrEvents[autoPrEvents.length - 1][0].prUrl).toBe(
      'https://github.com/test/repo/pull/123',
    );

    // And the branch must still be pushed so the existing PR sees the
    // additional commits — the whole point of the resolve flow.
    const pushCalls = execCalls.filter((c) => c.startsWith('git push'));
    expect(pushCalls.length).toBeGreaterThan(0);
    expect(pushCalls[0]).toContain('agent-hub/test/session-resolve');
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
      dispatched_by_autonomous: 1,
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

    const project = { id: 'test', cwd: '/repo', githubRepo: 'test/repo' } as never;
    const agent = { name: 'test-agent', role: 'dev' } as never;

    await autoCommitAndPR('sess-id', 'agent-1', project, agent, '/worktree', '');

    // Should have set git user.name and user.email in the worktree
    expect(execCalls).toContain('git config user.name "My Name"');
    expect(execCalls).toContain('git config user.email "me@example.com"');
  });

  it('runs project pre-commit shell commands after git add and before git commit', async () => {
    const execCalls: string[] = [];
    const mockCard = {
      id: 'card-1',
      title: 'Test card',
      description: 'desc',
      priority: 'medium',
      dispatched_by_autonomous: 1,
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
        if (cmd === 'git config user.name' && opts?.cwd === '/worktree') {
          if (callback) callback(new Error('not set'), { stdout: '', stderr: '' });
          return;
        }
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
          if (callback) callback(null, { stdout: 'feature/precommit-test\n', stderr: '' });
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

    const project = {
      id: 'test',
      cwd: '/repo',
      githubRepo: 'test/repo',
      preCommitCommands: ['npm run verify'],
    } as never;
    const agent = { name: 'test-agent', role: 'dev' } as never;

    await autoCommitAndPR('sess-pc', 'agent-1', project, agent, '/worktree', '');

    const hookIdx = execCalls.findIndex((c) => c === 'npm run verify');
    const commitIdx = execCalls.findIndex((c) => c.startsWith('git commit'));
    const addIndices = execCalls
      .map((c, i) => (c.includes('git add -A') ? i : -1))
      .filter((i) => i >= 0);
    expect(addIndices.length).toBeGreaterThanOrEqual(2);
    expect(hookIdx).toBeGreaterThan(addIndices[0]);
    expect(addIndices[1]).toBeGreaterThan(hookIdx);
    expect(commitIdx).toBeGreaterThan(addIndices[1]);
  });

  it('passes merged spawn PATH to git commit so hooks inherit developer CLI dirs (Electron GUI)', async () => {
    vi.stubEnv('PATH', '/ide/electron/minimal');
    try {
      const mockCard = {
        id: 'card-1',
        title: 'PATH test',
        description: 'desc',
        priority: 'medium',
        dispatched_by_autonomous: 1,
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
          if (cmd === 'git config user.name' && opts?.cwd === '/worktree') {
            if (callback) callback(new Error('not set'), { stdout: '', stderr: '' });
            return;
          }
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
            if (callback) callback(null, { stdout: 'feature/path-env\n', stderr: '' });
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

      const project = { id: 'test', cwd: '/repo', githubRepo: 'test/repo' } as never;
      const agent = { name: 'test-agent', role: 'dev' } as never;

      await autoCommitAndPR('sess-path-env', 'agent-1', project, agent, '/worktree', '');

      const commitSpawn = (spawn as unknown as Mock).mock.calls.find(
        (c: unknown[]) => c[0] === 'git' && Array.isArray(c[1]) && c[1][0] === 'commit',
      );
      expect(commitSpawn).toBeDefined();
      const env = (commitSpawn![2] as { env?: NodeJS.ProcessEnv }).env;
      const p = env?.PATH ?? '';
      // auto-git uses resolveSpawnPath (same merge as buildSpawnEnv) so Husky / npx
      // see Node when the parent process is Electron with a stripped PATH.
      expect(p.startsWith('/ide/electron/minimal')).toBe(true);
      expect(p.split(path.delimiter).length).toBeGreaterThan(1);
      expect(p).toMatch(/\/usr\/bin|\/bin/);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('broadcasts changes_ready when no PR exists', async () => {
    mockExec({
      'git remote -v': { stdout: 'origin\thttps://github.com/test/repo.git (fetch)\n' },
      'git status --porcelain': { stdout: 'M file.ts\n' },
      'git log @{upstream}..HEAD': { stdout: '' },
      'git rev-parse --abbrev-ref HEAD': { stdout: 'feature/new-work\n' },
      'gh pr view': { error: new Error('no pull requests found') },
    });

    const project = { id: 'test', cwd: '/repo', githubRepo: 'test/repo' } as never;
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

    const project = { id: 'test', cwd: '/repo', githubRepo: 'test/repo' } as never;
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

    const project = { id: 'test', cwd: '/repo', githubRepo: 'test/repo' } as never;
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

  it('skips reviewer-role sessions entirely (no changes_ready, no git work)', async () => {
    // Reviewer sessions exist to review PRs, never to author them. Even if a
    // reviewer's worktree has uncommitted changes, the "Create PR" banner must
    // not surface. Fix for user-reported bug: review sessions should never
    // prompt for PR creation.
    const execCalls: string[] = [];
    installExecAndGhMock(
      (
        cmd: string,
        _opts: Record<string, unknown>,
        callback?: (err: Error | null, result: { stdout: string; stderr: string }) => void,
      ) => {
        execCalls.push(cmd);
        // Populate results that *would* trigger changes_ready on a dev agent.
        if (cmd.includes('git remote -v')) {
          callback?.(null, {
            stdout: 'origin\thttps://github.com/test/repo.git (fetch)\n',
            stderr: '',
          });
          return;
        }
        if (cmd.includes('git status --porcelain')) {
          callback?.(null, { stdout: 'M file.ts\n', stderr: '' });
          return;
        }
        if (cmd.includes('git rev-parse --abbrev-ref HEAD')) {
          callback?.(null, { stdout: 'review/pr-42\n', stderr: '' });
          return;
        }
        callback?.(null, { stdout: '', stderr: '' });
      },
    );

    const project = { id: 'test', cwd: '/repo', githubRepo: 'test/repo' } as never;
    const agent = { name: 'Reviewer', role: 'reviewer' } as never;

    await autoCommitAndPR('sess-reviewer', 'reviewer-1', project, agent, '/worktree', '');

    // No changes_ready broadcast.
    const changesReadyEvents = mockBroadcast.mock.calls.filter(
      (c: Array<Record<string, unknown>>) => c[0]?.type === 'changes_ready',
    );
    expect(changesReadyEvents).toHaveLength(0);

    // No persistence of changes_ready.
    const updateCalls = (mockStmts.updateSessionChangesReady as { run: ReturnType<typeof vi.fn> })
      .run.mock.calls;
    expect(updateCalls).toHaveLength(0);

    // Early return before any git / gh invocation.
    expect(execCalls).toHaveLength(0);
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
    dispatched_by_autonomous: 1,
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
      githubRepo: 'test/repo',
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

    const project = { id: 'proj-1', cwd: '/repo', githubRepo: 'test/repo' } as never; // no githubWorkflow
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
        createPrCreationLog: { run: vi.fn(() => ({ changes: 1 })) },
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
    const { stmts, addMessageRun, getMessageByIdGet, createPrCreationLogRun } = (() => {
      const t = makeStmtsWithMessageTable({
        card: {
          id: 'card-42',
          title: 'Fix login bug',
          description: 'desc',
          priority: 'medium',
          dispatched_by_autonomous: 1,
          epic_id: null,
        },
      });
      return {
        ...t,
        createPrCreationLogRun: (t.stmts.createPrCreationLog as { run: ReturnType<typeof vi.fn> })
          .run,
      };
    })();

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

    const project = { id: 'p', cwd: '/repo', githubRepo: 'test/repo' } as never;
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

    expect(createPrCreationLogRun).toHaveBeenCalledTimes(1);
    const prLogArgs = createPrCreationLogRun.mock.calls[0];
    expect(prLogArgs[1]).toBe('p');
    expect(prLogArgs[2]).toBe('card-42');
    expect(prLogArgs[3]).toBe('sess-1');
    expect(prLogArgs[4]).toBe('https://github.com/test/repo/pull/123');
    expect(prLogArgs[5]).toBe(123);
    expect(prLogArgs[6]).toBe('Fix login bug');
    expect(prLogArgs[7]).toBe('dev');
  });

  it('invokes gh pr create via execFile so PR bodies can contain backticks and shell metacharacters', async () => {
    const execCalls: string[] = [];
    const { stmts } = makeStmtsWithMessageTable({
      card: {
        id: 'card-shell',
        title: 'Shell-safe PR body',
        description: 'Refs `pulls/{pr}/reviews` and ${HOME} must not break /bin/sh.',
        priority: 'medium',
        dispatched_by_autonomous: 1,
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

    const project = { id: 'p', cwd: '/repo', githubRepo: 'test/repo' } as never;
    const agent = { name: 'dev', role: 'dev' } as never;
    await autoCommitAndPR('sess-shell', 'agent-1', project, agent, '/worktree', '');
    await new Promise((r) => setImmediate(r));

    const ghCreateSpawn = (spawn as unknown as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: unknown[]) =>
        c[0] === 'gh' &&
        Array.isArray(c[1]) &&
        (c[1] as string[])[0] === 'pr' &&
        (c[1] as string[])[1] === 'create',
    );
    expect(ghCreateSpawn.length).toBeGreaterThanOrEqual(1);
    const argv = ghCreateSpawn[ghCreateSpawn.length - 1][1] as string[];
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

    const project = { id: 'p', cwd: '/repo', githubRepo: 'test/repo' } as never;
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
        dispatched_by_autonomous: 1,
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

    const project = { id: 'p', cwd: '/repo', githubRepo: 'test/repo' } as never;
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

    const prLogRun = (stmts.createPrCreationLog as { run: ReturnType<typeof vi.fn> }).run;
    expect(prLogRun).toHaveBeenCalledTimes(1);
  });
});

describe('autoCommitAndPR — isAutonomousCard gating (manual link vs dispatched)', () => {
  // Regression: manually linking a kanban card to a session via `session_id`
  // must NOT hijack session-end into the autonomous auto-PR path. Only cards
  // with `dispatched_by_autonomous` (set when autonomous dispatch runs) take
  // the auto-PR path; manual links and non-dispatch epic grouping stay ad-hoc.
  const mockBroadcast = vi.fn();

  function makeStmtsWithCard(card: Record<string, unknown>) {
    const merged = { dispatched_by_autonomous: 0, ...card };
    return {
      getKanbanCardBySession: { get: vi.fn(() => merged) },
      getSession: { get: vi.fn(() => ({ name: 'Test session' })) },
      setCardPrUrl: { run: vi.fn() },
      getKanbanBoard: { get: vi.fn(() => ({ id: 'board-1' })) },
      getKanbanColumns: {
        all: vi.fn(() => [
          { id: 'col-review', name: 'Review' },
          { id: 'col-done', name: 'Done' },
        ]),
      },
      getKanbanEpic: { get: vi.fn(() => undefined) },
      createKanbanCardComment: { run: vi.fn() },
      moveKanbanCard: { run: vi.fn() },
      updateKanbanCard: { run: vi.fn() },
      updateSessionChangesReady: { run: vi.fn() },
      clearSessionChangesReady: { run: vi.fn() },
      addMessage: { run: vi.fn() },
      getMessageById: { get: vi.fn() },
      createPrCreationLog: { run: vi.fn(() => ({ changes: 1 })) },
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
      epic_id: null,
    });

    initAutoGit({
      stmts: stmts as never,
      broadcast: mockBroadcast,
      getConfig: vi.fn(() => ({}) as never),
      DEFAULT_SKILLS_DIR: '/tmp/skills',
    });
    mockExecAdHocStyle(execCalls);

    const project = { id: 'p', cwd: '/repo', githubRepo: 'test/repo' } as never;
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

  it('card with dispatched_by_autonomous=1 takes AUTONOMOUS path → opens PR, no changes_ready', async () => {
    const execCalls: string[] = [];
    const stmts = makeStmtsWithCard({
      id: 'card-auto',
      title: 'Autonomous card',
      description: 'desc',
      priority: 'medium',
      dispatched_by_autonomous: 1,
      epic_id: null,
    });

    initAutoGit({
      stmts: stmts as never,
      broadcast: mockBroadcast,
      getConfig: vi.fn(() => ({}) as never),
      DEFAULT_SKILLS_DIR: '/tmp/skills',
    });
    mockExecAdHocStyle(execCalls);

    const project = { id: 'p', cwd: '/repo', githubRepo: 'test/repo' } as never;
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

  it('card with epic_id but dispatched_by_autonomous=1 (legacy autonomous epic) → opens PR', async () => {
    const execCalls: string[] = [];
    const stmts = makeStmtsWithCard({
      id: 'card-epic',
      title: 'Epic card',
      description: 'desc',
      priority: 'medium',
      dispatched_by_autonomous: 1,
      epic_id: 'epic-xyz',
    });

    initAutoGit({
      stmts: stmts as never,
      broadcast: mockBroadcast,
      getConfig: vi.fn(() => ({}) as never),
      DEFAULT_SKILLS_DIR: '/tmp/skills',
    });
    mockExecAdHocStyle(execCalls);

    const project = { id: 'p', cwd: '/repo', githubRepo: 'test/repo' } as never;
    const agent = { name: 'dev', role: 'dev' } as never;
    await autoCommitAndPR('sess-epic', 'agent-1', project, agent, '/worktree', '');

    const ghCreateCalls = execCalls.filter((c) => c.startsWith('gh pr create'));
    expect(ghCreateCalls).toHaveLength(1);

    const changesReadyEvents = mockBroadcast.mock.calls.filter(
      (c: Array<Record<string, unknown>>) => c[0]?.type === 'changes_ready',
    );
    expect(changesReadyEvents).toHaveLength(0);
  });

  it('card with epic_id but dispatched_by_autonomous=0 → AD-HOC path (Create PR banner), no auto-open PR', async () => {
    const execCalls: string[] = [];
    const stmts = makeStmtsWithCard({
      id: 'card-epic-manual',
      title: 'Grouped under epic only',
      description: 'desc',
      priority: 'medium',
      dispatched_by_autonomous: 0,
      epic_id: 'epic-non-auto',
    });

    initAutoGit({
      stmts: stmts as never,
      broadcast: mockBroadcast,
      getConfig: vi.fn(() => ({}) as never),
      DEFAULT_SKILLS_DIR: '/tmp/skills',
    });
    mockExecAdHocStyle(execCalls);

    const project = { id: 'p', cwd: '/repo', githubRepo: 'test/repo' } as never;
    const agent = { name: 'dev', role: 'dev' } as never;
    await autoCommitAndPR('sess-epic-manual', 'agent-1', project, agent, '/worktree', '');

    const ghCreateCalls = execCalls.filter((c) => c.startsWith('gh pr create'));
    expect(ghCreateCalls).toHaveLength(0);

    const changesReadyEvents = mockBroadcast.mock.calls.filter(
      (c: Array<Record<string, unknown>>) => c[0]?.type === 'changes_ready',
    );
    expect(changesReadyEvents).toHaveLength(1);
  });
});

describe('autoCommitAndPR — nothing_to_publish log severity', () => {
  // Regression: autonomous-mode sessions that finish without producing
  // changes (research turns, already-done cards, <agenthub:close-card>
  // bailouts) used to emit `console.error("[auto-commit] Autonomous PR
  // path failed (nothing_to_publish): …")`. The dispatch-side classifier
  // picked that up as a tool-error even though the outcome is a benign
  // no-op. We now log nothing_to_publish at INFO and reserve `console.error`
  // for actual failures (commit_failed / push_failed / pr_failed).
  const mockBroadcast = vi.fn();

  function makeAutonomousStmts(card: Record<string, unknown> | undefined) {
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
      createPrCreationLog: { run: vi.fn(() => ({ changes: 1 })) },
    } as Record<string, unknown>;
  }

  /** Clean worktree + no open PR for this branch → triggers nothing_to_publish. */
  function mockExecCleanWorktreeNoPR() {
    installExecAndGhMock(
      (
        cmd: string,
        _opts: Record<string, unknown>,
        callback?: (err: Error | null, result: { stdout: string; stderr: string }) => void,
      ) => {
        const ok = (stdout: string) => callback?.(null, { stdout, stderr: '' });

        if (cmd.includes('git remote -v'))
          return ok('origin\thttps://github.com/test/repo.git (fetch)\n');
        // Clean worktree: nothing uncommitted, nothing unpushed.
        if (cmd.includes('git status --porcelain')) return ok('');
        if (cmd.includes('git log @{upstream}..HEAD')) return ok('');
        if (cmd.includes('git rev-parse --abbrev-ref HEAD')) return ok('feature/no-op\n');
        // gh pr view returns empty → no open PR for this branch.
        if (cmd.startsWith('gh pr view')) return ok('');
        return ok('');
      },
    );
  }

  /** Real failure path: push fails. Used to confirm console.error still fires. */
  function mockExecPushFails(execCalls: string[]) {
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
        if (cmd.includes('git rev-parse --abbrev-ref HEAD')) return ok('feature/push-fail\n');
        if (cmd.startsWith('git push')) return fail('Permission denied');
        return ok('');
      },
    );
  }

  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    consoleLogSpy.mockRestore();
  });

  it('autonomous path: nothing_to_publish logs at INFO (console.log), not ERROR', async () => {
    const stmts = makeAutonomousStmts({
      id: 'card-noop',
      title: 'Already done',
      description: 'desc',
      priority: 'medium',
      dispatched_by_autonomous: 1,
      epic_id: null,
    });

    initAutoGit({
      stmts: stmts as never,
      broadcast: mockBroadcast,
      getConfig: vi.fn(() => ({}) as never),
      DEFAULT_SKILLS_DIR: '/tmp/skills',
    });
    mockExecCleanWorktreeNoPR();

    const project = { id: 'p', cwd: '/repo', githubRepo: 'test/repo' } as never;
    const agent = { name: 'dev', role: 'dev' } as never;
    await autoCommitAndPR('sess-noop', 'agent-1', project, agent, '/repo/.worktrees/x', '');

    // Must NOT log the autonomous-failure message at ERROR for nothing_to_publish.
    const errorMatches = consoleErrorSpy.mock.calls.filter((args: unknown[]) =>
      String(args[0] ?? '').includes('Autonomous PR path failed (nothing_to_publish)'),
    );
    expect(errorMatches).toHaveLength(0);

    // Must log the benign no-op at INFO instead.
    const infoMatches = consoleLogSpy.mock.calls.filter((args: unknown[]) =>
      String(args[0] ?? '').includes('Autonomous PR path: nothing to publish'),
    );
    expect(infoMatches.length).toBeGreaterThan(0);
  });

  it('autonomous path: real failure (push_failed) still logs at ERROR', async () => {
    const execCalls: string[] = [];
    const stmts = makeAutonomousStmts({
      id: 'card-push-fail',
      title: 'Push will fail',
      description: 'desc',
      priority: 'medium',
      dispatched_by_autonomous: 1,
      epic_id: null,
    });

    initAutoGit({
      stmts: stmts as never,
      broadcast: mockBroadcast,
      getConfig: vi.fn(() => ({}) as never),
      DEFAULT_SKILLS_DIR: '/tmp/skills',
    });
    mockExecPushFails(execCalls);

    const project = { id: 'p', cwd: '/repo', githubRepo: 'test/repo' } as never;
    const agent = { name: 'dev', role: 'dev' } as never;
    await autoCommitAndPR('sess-push-fail', 'agent-1', project, agent, '/repo/.worktrees/x', '');

    // Real failure code (push_failed) MUST keep firing console.error so the
    // tool-error classifier surfaces it.
    const errorMatches = consoleErrorSpy.mock.calls.filter((args: unknown[]) =>
      String(args[0] ?? '').includes('Autonomous PR path failed (push_failed)'),
    );
    expect(errorMatches.length).toBeGreaterThan(0);
  });

  // Regression: silent push failures used to leave the user with no UI
  // indication that the session never published its work. The bug card
  // (8de09e88) called for surfacing the failure in the chat timeline and
  // via a top-level WebSocket event so the next operator notices.
  it('autonomous path: push_failed persists a pr_failed system message and broadcasts auto_pr_failed', async () => {
    const execCalls: string[] = [];
    const stmts = makeAutonomousStmts({
      id: 'card-push-fail-2',
      title: 'Push will fail (visibility)',
      description: 'desc',
      priority: 'medium',
      dispatched_by_autonomous: 1,
      epic_id: null,
    });
    // Make getMessageById return the row keyed by the id passed to addMessage
    // so the broadcast payload matches the inserted shape.
    const insertedRows: Record<string, unknown> = {};
    (stmts.addMessage as { run: ReturnType<typeof vi.fn> }).run = vi.fn(
      (id: string, sessionId: string, role: string, content: string, ...rest: unknown[]) => {
        insertedRows[id] = {
          id,
          session_id: sessionId,
          role,
          content,
          engine: rest[0] ?? null,
          model: rest[1] ?? null,
          attachments: rest[2] ?? null,
          metadata: rest[3] ?? null,
          created_at: new Date().toISOString(),
        };
      },
    );
    (stmts.getMessageById as { get: ReturnType<typeof vi.fn> }).get = vi.fn(
      (id: string) => insertedRows[id],
    );

    initAutoGit({
      stmts: stmts as never,
      broadcast: mockBroadcast,
      getConfig: vi.fn(() => ({}) as never),
      DEFAULT_SKILLS_DIR: '/tmp/skills',
    });
    mockExecPushFails(execCalls);

    const project = { id: 'p', cwd: '/repo', githubRepo: 'test/repo' } as never;
    const agent = { name: 'Hub Lead Dev', role: 'dev' } as never;
    await autoCommitAndPR('sess-push-fail-2', 'agent-1', project, agent, '/repo/.worktrees/x', '');

    // 1) A system-role message was persisted with pr_failed metadata.
    const addMessageCalls = (stmts.addMessage as { run: ReturnType<typeof vi.fn> }).run.mock.calls;
    const prFailedInsert = addMessageCalls.find((args: unknown[]) => {
      const role = args[2];
      const metaJson = args[7];
      if (role !== 'system' || typeof metaJson !== 'string') return false;
      try {
        const meta = JSON.parse(metaJson);
        return meta?.kind === 'pr_failed' && meta?.code === 'push_failed';
      } catch {
        return false;
      }
    });
    expect(prFailedInsert).toBeTruthy();

    // 2) auto_pr_failed broadcast fired with the failure code and card linkage.
    const autoPrFailed = mockBroadcast.mock.calls.find((args: unknown[]) => {
      const payload = args[0] as { type?: string };
      return payload?.type === 'auto_pr_failed';
    })?.[0] as
      | {
          type: string;
          sessionId: string;
          agentId: string;
          code: string;
          cardId: string | null;
          cardTitle: string | null;
        }
      | undefined;
    expect(autoPrFailed).toBeTruthy();
    expect(autoPrFailed?.sessionId).toBe('sess-push-fail-2');
    expect(autoPrFailed?.agentId).toBe('agent-1');
    expect(autoPrFailed?.code).toBe('push_failed');
    expect(autoPrFailed?.cardId).toBe('card-push-fail-2');
    expect(autoPrFailed?.cardTitle).toBe('Push will fail (visibility)');

    // 3) message_added broadcast fired so the chat timeline updates live.
    const messageAdded = mockBroadcast.mock.calls.find((args: unknown[]) => {
      const payload = args[0] as { type?: string };
      return payload?.type === 'message_added';
    });
    expect(messageAdded).toBeTruthy();
  });

  it('ad-hoc-with-existing-PR path: nothing_to_publish logs at INFO, not ERROR', async () => {
    // Construct the no-card / existing-PR ad-hoc shape: the worktree has
    // changes (so the early !changes return is skipped), gh pr view finds an
    // existing PR (so we recurse into commitPushAndCreatePR), and *inside*
    // commitPushAndCreatePR the worktree is now reported clean — yielding
    // the nothing_to_publish code on the inner call.
    const stmts = {
      getKanbanCardBySession: { get: vi.fn(() => undefined) },
      getSession: { get: vi.fn(() => ({ name: 'Ad-hoc no-op' })) },
      updateSessionChangesReady: { run: vi.fn() },
      clearSessionChangesReady: { run: vi.fn() },
      addMessage: { run: vi.fn() },
    } as Record<string, unknown>;

    initAutoGit({
      stmts: stmts as never,
      broadcast: mockBroadcast,
      getConfig: vi.fn(() => ({}) as never),
      DEFAULT_SKILLS_DIR: '/tmp/skills',
    });

    // First-pass checkWorktreeChanges (in autoCommitAndPR) must report
    // hasUnpushed=true so we enter the "existing PR" branch. Inside
    // commitPushAndCreatePR's checkWorktreeChanges call we then report
    // clean (no uncommitted, no unpushed) so it returns nothing_to_publish.
    let statusCalls = 0;
    let unpushedCalls = 0;
    installExecAndGhMock(
      (
        cmd: string,
        _opts: Record<string, unknown>,
        callback?: (err: Error | null, result: { stdout: string; stderr: string }) => void,
      ) => {
        const ok = (stdout: string) => callback?.(null, { stdout, stderr: '' });

        if (cmd.includes('git remote -v'))
          return ok('origin\thttps://github.com/test/repo.git (fetch)\n');
        if (cmd.includes('git status --porcelain')) {
          statusCalls += 1;
          // First call (outer): clean. Subsequent (inner): clean too.
          return ok('');
        }
        if (cmd.includes('git log @{upstream}..HEAD')) {
          unpushedCalls += 1;
          // First call: report unpushed so we enter the existing-PR branch.
          // Subsequent calls (inner check): clean.
          return ok(unpushedCalls === 1 ? 'abc commit\n' : '');
        }
        if (cmd.includes('git rev-parse --abbrev-ref HEAD')) return ok('feature/adhoc-noop\n');
        if (cmd.startsWith('gh pr view')) return ok('https://github.com/test/repo/pull/77\n');
        return ok('');
      },
    );

    const project = { id: 'p', cwd: '/repo', githubRepo: 'test/repo' } as never;
    const agent = { name: 'dev', role: 'dev' } as never;
    await autoCommitAndPR('sess-adhoc-noop', 'agent-1', project, agent, '/repo/.worktrees/x', '');

    // Sanity: the outer flow ran (status was queried at least once).
    expect(statusCalls).toBeGreaterThan(0);

    const errorMatches = consoleErrorSpy.mock.calls.filter((args: unknown[]) =>
      String(args[0] ?? '').includes('Ad-hoc push/PR path failed (nothing_to_publish)'),
    );
    expect(errorMatches).toHaveLength(0);
  });

  it('autonomous path: rebase_conflict aborts the push, posts a card comment, and surfaces via persistAndBroadcastPrFailure', async () => {
    // Build the autonomous-card surface the same way the push_failed test
    // does, then stub `git rebase` to fail with a conflict-shaped error.
    // The expected flow:
    //   1. Pre-push commit succeeds (status reports uncommitted)
    //   2. `git rebase origin/main` rejects → `rebase_conflict`
    //   3. Card comment is created (Agent Hub (pre-push rebase) author)
    //   4. `persistAndBroadcastPrFailure` fires → pr_failed system message
    //      + auto_pr_failed broadcast, both carrying `code: 'rebase_conflict'`
    //   5. `git push` is never invoked
    const execCalls: string[] = [];
    const createKanbanCardComment = vi.fn();
    const stmts = makeAutonomousStmts({
      id: 'card-rebase-conflict',
      title: 'Drift conflict on push',
      description: 'desc',
      priority: 'medium',
      dispatched_by_autonomous: 1,
      epic_id: null,
    });
    (stmts as { createKanbanCardComment?: unknown }).createKanbanCardComment = {
      run: createKanbanCardComment,
    };

    // Capture the inserted pr_failed metadata by routing addMessage through
    // a payload map (same trick as the push_failed test).
    const insertedRows: Record<string, unknown> = {};
    (stmts.addMessage as { run: ReturnType<typeof vi.fn> }).run = vi.fn(
      (id: string, sessionId: string, role: string, content: string, ...rest: unknown[]) => {
        insertedRows[id] = {
          id,
          session_id: sessionId,
          role,
          content,
          engine: rest[0] ?? null,
          model: rest[1] ?? null,
          attachments: rest[2] ?? null,
          metadata: rest[3] ?? null,
          created_at: new Date().toISOString(),
        };
      },
    );
    (stmts.getMessageById as { get: ReturnType<typeof vi.fn> }).get = vi.fn(
      (id: string) => insertedRows[id],
    );

    initAutoGit({
      stmts: stmts as never,
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
        if (cmd.includes('git log @{upstream}..HEAD')) return fail('no upstream');
        if (cmd.includes('git log main..HEAD')) return ok('');
        if (cmd.includes('git rev-parse --abbrev-ref HEAD')) return ok('feature/rebase-conflict\n');
        if (cmd.startsWith('git rev-parse origin/main')) return ok('basetip\n');
        if (cmd.startsWith('git rev-parse HEAD')) return ok('abc123def\n');
        if (cmd.startsWith('git merge-base ')) return ok('mergebase\n');
        if (cmd.startsWith('git rev-list --count'))
          // Pretend the base advanced one commit.
          return ok('1\n');
        if (cmd.startsWith('git fetch')) return ok('');
        // The rebase itself fails with a conflict-shaped error.
        if (cmd.startsWith('git rebase origin/main')) {
          return fail(
            'CONFLICT (content): Merge conflict in file.ts\nerror: could not apply abc... change',
          );
        }
        if (cmd.startsWith('git rebase --abort')) return ok('');
        if (cmd.startsWith('git push')) return fail('Push should never be called');
        return ok('');
      },
    );

    const project = { id: 'p', cwd: '/repo', githubRepo: 'test/repo' } as never;
    const agent = { name: 'Hub Lead Dev', role: 'dev' } as never;
    await autoCommitAndPR(
      'sess-rebase-conflict',
      'agent-1',
      project,
      agent,
      '/repo/.worktrees/x',
      '',
    );

    // 1) Card comment was posted with the pre-push rebase author.
    expect(createKanbanCardComment).toHaveBeenCalled();
    const commentArgs = createKanbanCardComment.mock.calls[0] as unknown[];
    // INSERT … (id, card_id, author, content) — author is arg[2].
    expect(commentArgs[2]).toContain('pre-push rebase');
    expect(String(commentArgs[3])).toMatch(/conflict|rebase/i);

    // 2) pr_failed system message persisted with code 'rebase_conflict'.
    const addMessageCalls = (stmts.addMessage as { run: ReturnType<typeof vi.fn> }).run.mock.calls;
    const prFailedInsert = addMessageCalls.find((args: unknown[]) => {
      const role = args[2];
      const metaJson = args[7];
      if (role !== 'system' || typeof metaJson !== 'string') return false;
      try {
        const meta = JSON.parse(metaJson);
        return meta?.kind === 'pr_failed' && meta?.code === 'rebase_conflict';
      } catch {
        return false;
      }
    });
    expect(prFailedInsert).toBeTruthy();

    // 3) auto_pr_failed broadcast fired with the failure code.
    const autoPrFailed = mockBroadcast.mock.calls.find((args: unknown[]) => {
      const payload = args[0] as { type?: string; code?: string };
      return payload?.type === 'auto_pr_failed' && payload?.code === 'rebase_conflict';
    });
    expect(autoPrFailed).toBeTruthy();

    // 4) `git push` was NEVER invoked — the rebase failure short-circuited the flow.
    const pushedCommands = execCalls.filter((c) => /\bgit push\b/.test(c));
    expect(pushedCommands).toHaveLength(0);
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

  // ─── Commit-subject preference (regression for PR #718) ──────────────
  // PR #718 had excellent commit subjects ("feat: per-user GitHub login via
  // PAT + setup-wizard step") but the PR title was the truncated user
  // request used as the kanban card title ("Need a way to login to github.
  // Also need to do this during s"). buildPrTitle must prefer the commit
  // subject when one is available so PR titles describe the *change*, not
  // the original problem statement.

  it('prefers a descriptive commit subject over the card / session title', () => {
    const cardTitle = 'Need a way to login to github. Also need to do this during s';
    const commits = ['feat: per-user GitHub login via PAT + setup-wizard step'];
    expect(buildPrTitle(cardTitle, commits)).toBe(
      'feat: per-user GitHub login via PAT + setup-wizard step',
    );
  });

  it('uses the newest descriptive commit when multiple are present', () => {
    const cardTitle = 'Some long question from the user';
    const commits = [
      'feat: decouple personal GitHub OAuth from the GitHub App',
      'feat: per-user GitHub login via PAT + setup-wizard step',
    ];
    expect(buildPrTitle(cardTitle, commits)).toBe(
      'feat: decouple personal GitHub OAuth from the GitHub App',
    );
  });

  it('skips generic commit subjects (wip, fixup!, "chore: format") and tries the next', () => {
    const cardTitle = 'Fallback card title';
    const commits = ['wip: still poking at this', 'fixup! earlier work', 'feat: add export button'];
    expect(buildPrTitle(cardTitle, commits)).toBe('feat: add export button');
  });

  it('falls back to the card / session title when every commit looks generic', () => {
    const cardTitle = 'Add export button to dashboard';
    const commits = ['wip', 'chore: format', 'fix typo'];
    expect(buildPrTitle(cardTitle, commits)).toBe('Add export button to dashboard');
  });

  it('falls back to the card / session title when commits is empty / undefined', () => {
    expect(buildPrTitle('Add dark mode support', [])).toBe('Add dark mode support');
    expect(buildPrTitle('Add dark mode support', undefined)).toBe('Add dark mode support');
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

  it('uses the card description as the summary when no commits are available', () => {
    const card = {
      id: 'c1',
      description: 'Fix the login crash when email is empty',
    } as never;
    const body = buildPrBody({ agentName, card });
    expect(body).toContain('## Summary');
    expect(body).toContain('Fix the login crash when email is empty');
    expect(body).not.toContain(`Task completed by ${agentName}.`);
    // No commits → no "## Original task" duplication of the description.
    expect(body).not.toContain('## Original task');
  });

  it('prefers the commit subject for Summary over the card description (regression for PR #718)', () => {
    const card = {
      id: 'c1',
      description: 'Need a way to login to github. Also need to do this during setup.',
    } as never;
    const body = buildPrBody({
      agentName,
      card,
      commits: ['feat: per-user GitHub login via PAT + setup-wizard step'],
    });
    // Summary is the commit subject (what was done).
    expect(body).toMatch(/## Summary\nfeat: per-user GitHub login via PAT \+ setup-wizard step/);
    // Card description preserved as origin context.
    expect(body).toContain('## Original task');
    expect(body).toContain('Need a way to login to github. Also need to do this during setup.');
  });

  it('omits the Commits section when only one commit is present', () => {
    const body = buildPrBody({ agentName, commits: ['Fix login'] });
    expect(body).not.toContain('## Commits');
    // The single commit IS the Summary.
    expect(body).toMatch(/## Summary\nFix login/);
  });

  it('lists commits when there are multiple, with a one-line lede in Summary', () => {
    const body = buildPrBody({
      agentName,
      commits: ['Fix null pointer', 'Add regression test', 'Tidy imports'],
    });
    // Summary picks the most recent descriptive subject.
    expect(body).toMatch(/## Summary\nFix null pointer/);
    // ## Commits lists every subject for full visibility.
    expect(body).toContain('## Commits');
    expect(body).toContain('- Fix null pointer');
    expect(body).toContain('- Add regression test');
    expect(body).toContain('- Tidy imports');
  });

  it('omits "## Original task" when no card description is present', () => {
    const body = buildPrBody({ agentName, commits: ['Fix login crash'] });
    expect(body).not.toContain('## Original task');
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

  // ─── Commit-body support (acceptance criteria for "meaningful PRs from
  // commits") ─────────────────────────────────────────────────────────────
  // The legacy form passed `string[]` (subjects only). The new
  // `CommitInfo[]` form lets us surface the agent's commit *bodies* — which
  // is where the rationale usually lives — in the PR Summary and the
  // per-bullet detail. Empty bodies fall back to the subject-only behaviour
  // so legacy callers (handoff.ts, older tests) are unaffected.

  it('uses the commit body as the Summary when a single commit has a body', () => {
    const body = buildPrBody({
      agentName,
      commits: [
        {
          subject: 'feat: per-user GitHub login',
          body: 'Adds a setup-wizard step that PATs the user into GitHub.\n\nMotivation: shared OAuth was leaking org context.',
        },
      ],
    });
    expect(body).toContain('## Summary');
    expect(body).toContain('feat: per-user GitHub login');
    expect(body).toContain('Adds a setup-wizard step that PATs the user into GitHub.');
    expect(body).toContain('Motivation: shared OAuth was leaking org context.');
    // No commits-listing for a single commit — the body IS the summary.
    expect(body).not.toContain('## Commits');
  });

  it('falls back to subject-only Summary when a single commit has an empty body', () => {
    const body = buildPrBody({
      agentName,
      commits: [{ subject: 'Fix login crash', body: '' }],
    });
    expect(body).toMatch(/## Summary\nFix login crash\n/);
    expect(body).not.toContain('## Commits');
  });

  it('renders bodies as indented detail under each bullet for multi-commit PRs', () => {
    const body = buildPrBody({
      agentName,
      commits: [
        {
          subject: 'feat: decouple personal GitHub OAuth from the GitHub App',
          body: 'Splits the per-user PAT flow from the App install path so\nreviewer identity stays distinct from the human user.',
        },
        {
          subject: 'feat: per-user GitHub login via PAT + setup-wizard step',
          body: 'New /api/auth/github/pat endpoint backed by an encrypted store.',
        },
      ],
    });
    // Lede uses the newest descriptive subject.
    expect(body).toContain('## Summary\nfeat: decouple personal GitHub OAuth');
    expect(body).toContain('## Commits');
    expect(body).toContain('- feat: decouple personal GitHub OAuth from the GitHub App');
    // Body lines are indented 4 spaces under the bullet.
    expect(body).toContain('    Splits the per-user PAT flow from the App install path so');
    expect(body).toContain('    reviewer identity stays distinct from the human user.');
    expect(body).toContain('- feat: per-user GitHub login via PAT + setup-wizard step');
    expect(body).toContain('    New /api/auth/github/pat endpoint backed by an encrypted store.');
  });

  it('truncates very long commit bodies to a manageable per-commit cap', () => {
    const longBody = Array.from({ length: 25 }, (_, i) => `line ${i}`).join('\n');
    const body = buildPrBody({
      agentName,
      commits: [{ subject: 'feat: commit one', body: longBody }, { subject: 'feat: commit two' }],
    });
    // First 9 body lines are kept, then a single ellipsis line, capping at
    // MAX_BODY_LINES_PER_COMMIT (10) total rendered lines per commit.
    expect(body).toContain('    line 0');
    expect(body).toContain('    line 8');
    expect(body).toContain('    …');
    expect(body).not.toContain('    line 24');
  });

  it('mixes string subjects and CommitInfo objects in the same array', () => {
    // back-compat: callers (or tests) can mix forms freely.
    const body = buildPrBody({
      agentName,
      commits: [
        'feat: keep subject-only entries working',
        { subject: 'feat: structured commit', body: 'with rationale' },
      ],
    });
    expect(body).toContain('## Commits');
    expect(body).toContain('- feat: keep subject-only entries working');
    expect(body).toContain('- feat: structured commit');
    expect(body).toContain('    with rationale');
  });

  it('preserves the Original task (card description) section under the new path', () => {
    const card = {
      id: 'c1',
      description: 'Need a way to login to github. Also need to do this during setup.',
    } as never;
    const body = buildPrBody({
      agentName,
      card,
      commits: [
        {
          subject: 'feat: per-user GitHub login via PAT + setup-wizard step',
          body: 'Adds the setup-wizard step that captures a PAT.',
        },
      ],
    });
    // Summary is commit-driven (subject + body).
    expect(body).toContain('feat: per-user GitHub login via PAT + setup-wizard step');
    expect(body).toContain('Adds the setup-wizard step that captures a PAT.');
    // Card description preserved as origin context — diffstat / footer /
    // kanban-card linkage unchanged.
    expect(body).toContain('## Original task');
    expect(body).toContain('Need a way to login to github. Also need to do this during setup.');
    expect(body).toContain('_Automated PR from Agent Hub · kanban card c1_');
  });
});

describe('normalizeCommitInputs', () => {
  it('returns an empty array for undefined / empty inputs', () => {
    expect(normalizeCommitInputs(undefined)).toEqual([]);
    expect(normalizeCommitInputs([])).toEqual([]);
  });

  it('coerces strings into subject-only CommitInfo objects', () => {
    expect(normalizeCommitInputs(['feat: a', '  feat: b  '])).toEqual([
      { subject: 'feat: a' },
      { subject: 'feat: b' },
    ]);
  });

  it('preserves CommitInfo objects, trimming subject and body', () => {
    expect(normalizeCommitInputs([{ subject: '  feat: a  ', body: '  rationale  ' }])).toEqual([
      { subject: 'feat: a', body: 'rationale' },
    ]);
  });

  it('drops entries with empty subjects', () => {
    expect(
      normalizeCommitInputs(['', '   ', { subject: '' }, { subject: '  ', body: 'x' }]),
    ).toEqual([]);
  });

  it('omits the body field when the body is empty / whitespace', () => {
    expect(normalizeCommitInputs([{ subject: 'feat: a', body: '   ' }])).toEqual([
      { subject: 'feat: a' },
    ]);
  });

  it('accepts mixed string + object inputs', () => {
    expect(normalizeCommitInputs(['feat: a', { subject: 'feat: b', body: 'why' }])).toEqual([
      { subject: 'feat: a' },
      { subject: 'feat: b', body: 'why' },
    ]);
  });
});

describe('pickPrTitleFromCommits — CommitInfo form', () => {
  // Subject genericness still rules; bodies are irrelevant to title choice.
  it('picks the newest descriptive CommitInfo subject', () => {
    expect(
      pickPrTitleFromCommits([
        { subject: 'feat: ship the thing', body: 'rationale' },
        { subject: 'wip: poking', body: 'still poking' },
      ]),
    ).toBe('feat: ship the thing');
  });

  it('returns null when every CommitInfo subject is generic', () => {
    expect(
      pickPrTitleFromCommits([
        { subject: 'wip', body: 'long rationale that does NOT save it' },
        { subject: 'fix typo' },
      ]),
    ).toBeNull();
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

describe('manualCommitAndPR — duplicate card prevention', () => {
  // Regression for: "Duplicate kanban cards appear when PR moves to Review".
  // When a session is already linked to an existing kanban card (via
  // `session_id` — set by autonomous dispatch, bug-report intake, or manual
  // linking in the UI), clicking "Create PR" must NOT create a second card.
  // Previously `manualCommitAndPR` unconditionally called `createKanbanCard`,
  // producing a duplicate in Review while the original stayed behind in
  // To Do/In Progress.
  const mockBroadcast = vi.fn();

  function makeStmts(opts: {
    existingCard?: Record<string, unknown>;
    createKanbanCardRun: ReturnType<typeof vi.fn>;
  }) {
    const existing = opts.existingCard;
    const newCardRow = {
      id: 'generated-card-id',
      title: 'Fresh card',
      description: '',
      priority: 'medium',
      column_id: 'col-inprog',
      board_id: 'board-1',
      session_id: 'sess-dup',
      dispatched_by_autonomous: 0,
      epic_id: null,
      pr_url: null,
    };
    return {
      getKanbanCardBySession: { get: vi.fn(() => existing) },
      getSession: { get: vi.fn(() => ({ name: 'Some session title' })) },
      getKanbanBoard: { get: vi.fn(() => ({ id: 'board-1' })) },
      getKanbanColumns: {
        all: vi.fn(() => [
          { id: 'col-inprog', name: 'In Progress' },
          { id: 'col-review', name: 'Review' },
          { id: 'col-done', name: 'Done' },
        ]),
      },
      getMessages: { all: vi.fn(() => [] as MessageRow[]) },
      createKanbanCard: { run: opts.createKanbanCardRun },
      getKanbanCard: { get: vi.fn(() => newCardRow) },
      setCardPrUrl: { run: vi.fn() },
      moveKanbanCard: { run: vi.fn() },
      updateKanbanCard: { run: vi.fn() },
      updateSessionChangesReady: { run: vi.fn() },
      clearSessionChangesReady: { run: vi.fn() },
      addMessage: { run: vi.fn() },
      getMessageById: {
        get: vi.fn(() => ({
          id: 'm-1',
          session_id: 'sess-dup',
          role: 'system',
          content: 'PR created from these changes',
          engine: null,
          model: null,
          attachments: null,
          metadata: null,
          created_at: '2026-04-18T00:00:00.000Z',
        })),
      },
      createPrCreationLog: { run: vi.fn(() => ({ changes: 1 })) },
    } as Record<string, unknown>;
  }

  function installPrCreationMock(prUrl: string) {
    installExecAndGhMock(
      (
        cmd: string,
        _opts: Record<string, unknown>,
        callback?: (err: Error | null, result: { stdout: string; stderr: string }) => void,
      ) => {
        const ok = (stdout: string) => callback?.(null, { stdout, stderr: '' });
        if (cmd.includes('git status --porcelain')) return ok('M file.ts\n');
        if (cmd.includes('git log @{upstream}..HEAD')) return ok('abc123 fix: thing\n');
        if (cmd.includes('git rev-parse --abbrev-ref HEAD')) return ok('feature/dup-check\n');
        if (cmd.startsWith('git rev-parse HEAD')) return ok('abc123def\n');
        if (cmd.includes('git diff --stat')) return ok('');
        if (cmd.includes('git log main..HEAD')) return ok('');
        if (cmd.startsWith('gh pr view')) return ok('');
        if (cmd.startsWith('gh pr create')) return ok(`${prUrl}\n`);
        return ok('');
      },
    );
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('REUSES an existing card already linked to the session (no new card created)', async () => {
    const createKanbanCardRun = vi.fn();
    const existingCard = {
      id: 'existing-card-abc',
      title: 'Reassign a card even when a session is running',
      description: 'Original ticket description',
      priority: 'medium',
      column_id: 'col-inprog',
      board_id: 'board-1',
      session_id: 'sess-dup',
      dispatched_by_autonomous: 0,
      epic_id: null,
      pr_url: null,
    };
    const stmts = makeStmts({ existingCard, createKanbanCardRun });

    initAutoGit({
      stmts: stmts as never,
      broadcast: mockBroadcast,
      getConfig: vi.fn(() => ({}) as never),
      DEFAULT_SKILLS_DIR: '/tmp/skills',
    });
    installPrCreationMock('https://github.com/test/repo/pull/777');

    const project = { id: 'p', cwd: '/repo', githubRepo: 'test/repo' } as never;
    const agent = { name: 'dev', role: 'dev' } as never;
    const result = await manualCommitAndPR('sess-dup', 'agent-1', project, agent, '/worktree', {});

    // Core regression assertion: no new card was created.
    expect(createKanbanCardRun).not.toHaveBeenCalled();

    // The returned cardId MUST be the existing card's id — not a freshly
    // minted UUID. Otherwise the UI would show (and move to Review) a card
    // that doesn't exist in the DB.
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.cardId).toBe('existing-card-abc');
      expect(result.prUrl).toBe('https://github.com/test/repo/pull/777');
    }
  });

  it('CREATES a new card when the session has no linked card yet (ad-hoc flow)', async () => {
    const createKanbanCardRun = vi.fn();
    const stmts = makeStmts({ existingCard: undefined, createKanbanCardRun });

    initAutoGit({
      stmts: stmts as never,
      broadcast: mockBroadcast,
      getConfig: vi.fn(() => ({}) as never),
      DEFAULT_SKILLS_DIR: '/tmp/skills',
    });
    installPrCreationMock('https://github.com/test/repo/pull/888');

    const project = { id: 'p', cwd: '/repo', githubRepo: 'test/repo' } as never;
    const agent = { name: 'dev', role: 'dev' } as never;
    const result = await manualCommitAndPR('sess-noadhoc', 'agent-1', project, agent, '/worktree', {
      title: 'Fix the thing',
    });

    // Ad-hoc flow: exactly one new card was created, and the flow returned
    // its generated id (not null).
    expect(createKanbanCardRun).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.prUrl).toBe('https://github.com/test/repo/pull/888');
      expect(result.cardId).toBeTruthy();
    }
  });

  it('returns ok:false with commit_failed when git commit rejects (Create PR API can show this)', async () => {
    const createKanbanCardRun = vi.fn();
    const existingCard = {
      id: 'existing-card-commit-fail',
      title: 'Task with `backticks`\nand a newline in the title',
      description: 'Body has `code` and $(date) — must not require shell quoting.',
      priority: 'medium',
      column_id: 'col-inprog',
      board_id: 'board-1',
      session_id: 'sess-commit-fail',
      dispatched_by_autonomous: 0,
      epic_id: null,
      pr_url: null,
    };
    const stmts = makeStmts({ existingCard, createKanbanCardRun });

    initAutoGit({
      stmts: stmts as never,
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
        const ok = (stdout: string) => callback?.(null, { stdout, stderr: '' });
        const fail = (msg: string) => callback?.(new Error(msg), { stdout: '', stderr: '' });
        if (cmd.includes('git status --porcelain')) return ok('M file.ts\n');
        if (cmd.includes('git log @{upstream}..HEAD')) return ok('abc123 fix: thing\n');
        if (cmd.includes('git rev-parse --abbrev-ref HEAD')) return ok('feature/dup-check\n');
        if (cmd.startsWith('git rev-parse HEAD')) return ok('abc123def\n');
        if (cmd.includes('git diff --stat')) return ok('');
        if (cmd.includes('git log main..HEAD')) return ok('');
        if (cmd === 'git config user.name') return ok('Tester\n');
        // execFile joins argv with spaces — full -m body is still one argv element.
        if (cmd.startsWith('git commit -m')) return fail('pre-commit hook failed');
        if (cmd.startsWith('gh pr view')) return ok('');
        if (cmd.startsWith('gh pr create')) return ok('https://github.com/test/repo/pull/1\n');
        return ok('');
      },
    );

    const project = { id: 'p', cwd: '/repo', githubRepo: 'test/repo' } as never;
    const agent = { name: 'dev', role: 'dev' } as never;
    const result = await manualCommitAndPR(
      'sess-commit-fail',
      'agent-1',
      project,
      agent,
      '/worktree',
      {},
    );

    expect(createKanbanCardRun).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('commit_failed');
      expect(result.error).toMatch(/Git commit failed/);
    }

    const gitCommitSpawn = (spawn as unknown as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: unknown[]) => c[0] === 'git' && Array.isArray(c[1]) && (c[1] as string[])[0] === 'commit',
    );
    expect(gitCommitSpawn.length).toBeGreaterThanOrEqual(1);
    const argv = gitCommitSpawn[gitCommitSpawn.length - 1][1] as string[];
    expect(argv[1]).toBe('-m');
    const msgArg = argv[2];
    expect(msgArg).toContain('`backticks`');
    expect(msgArg).toContain('\n');
    expect(msgArg).toContain('$(date)');
  });
});

describe('runShellCommandStreaming — output byte cap', () => {
  afterEach(() => {
    wireSpawnToExecMocks();
  });

  it('matches the legacy exec maxBuffer size (10 MiB)', () => {
    expect(STREAM_OUTPUT_MAX_BYTES).toBe(10 * 1024 * 1024);
  });

  it('kills the child and rejects when stdout exceeds maxOutputBytes', async () => {
    vi.clearAllMocks();
    const killMock = vi.fn();
    (spawn as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => {
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
        kill: ReturnType<typeof vi.fn>;
      };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = killMock;
      queueMicrotask(() => {
        const chunk = Buffer.from('y'.repeat(200));
        for (let i = 0; i < 20; i++) {
          child.stdout.emit('data', chunk);
        }
        queueMicrotask(() => child.emit('close', null, 'SIGTERM'));
      });
      return child;
    });

    await expect(runShellCommandStreaming('noop', '/tmp', 3000, undefined, 1000)).rejects.toThrow(
      /exceeded 1000 bytes/i,
    );
    expect(killMock).toHaveBeenCalled();
  });

  it('uses Check heal wording for check_heal failures and does not throw CheckCommandFailedError', async () => {
    vi.clearAllMocks();
    (spawn as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => {
      const ee = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
      };
      ee.stdout = new EventEmitter();
      ee.stderr = new EventEmitter();
      queueMicrotask(() => ee.emit('close', 1, null));
      return ee;
    });
    let caught: unknown;
    try {
      await runShellCommandStreaming('false', '/tmp', 3000, undefined, {
        logKind: 'check_heal',
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/Check heal command failed/i);
    expect(caught).not.toBeInstanceOf(CheckCommandFailedError);
  });
});

describe('autoCommitAndPR — pr_base_branch override', () => {
  // The card may carry an explicit `pr_base_branch` for stacked / dependent
  // PRs. When set and the branch still exists on origin, the auto-PR flow
  // must pass `--base <branch>` to `gh pr create`. When the branch has been
  // deleted between selection and PR-open time, the flow must fall back to
  // the repo default (no `--base` arg) and post an explanatory comment on
  // the card so the user understands why their override didn't apply.
  const mockBroadcast = vi.fn();

  function makeAutonomousStmtsWithCard(card: Record<string, unknown>) {
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
      createPrCreationLog: { run: vi.fn(() => ({ changes: 1 })) },
      createKanbanCardComment: { run: vi.fn() },
      getKanbanEpic: { get: vi.fn(() => null) },
    } as Record<string, unknown>;
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('appends --base to gh pr create when card.pr_base_branch exists on origin', async () => {
    const execCalls: string[] = [];
    const stmts = makeAutonomousStmtsWithCard({
      id: 'card-stacked',
      title: 'Stacked PR card',
      description: 'desc',
      priority: 'medium',
      dispatched_by_autonomous: 1,
      epic_id: null,
      pr_base_branch: 'feature/parent-branch',
    });

    initAutoGit({
      stmts: stmts as never,
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
        if (cmd.includes('git log @{upstream}..HEAD')) return fail('no upstream');
        if (cmd.includes('git rev-parse --abbrev-ref HEAD')) return ok('feature/child\n');
        // Branch exists on origin → ls-remote returns a SHA + ref
        if (cmd.includes('git ls-remote --heads origin'))
          return ok('a'.repeat(40) + '\trefs/heads/feature/parent-branch\n');
        if (cmd.startsWith('gh pr view')) return fail('no pull requests found');
        if (cmd.startsWith('gh pr create')) return ok('https://github.com/test/repo/pull/123\n');
        return ok('');
      },
    );

    const project = { id: 'p', cwd: '/repo', githubRepo: 'test/repo' } as never;
    const agent = { name: 'dev', role: 'dev' } as never;
    await autoCommitAndPR('sess-stacked', 'agent-1', project, agent, '/worktree', '');

    const ghCreateCalls = execCalls.filter((c) => c.startsWith('gh pr create'));
    expect(ghCreateCalls).toHaveLength(1);
    expect(ghCreateCalls[0]).toContain('--base feature/parent-branch');
  });

  it('uses epic pr_base_branch when card omits pr_base_branch', async () => {
    const execCalls: string[] = [];
    const base = makeAutonomousStmtsWithCard({
      id: 'card-epic-base',
      title: 'Epic default base',
      description: 'desc',
      priority: 'medium',
      dispatched_by_autonomous: 1,
      epic_id: 'epic-1',
      pr_base_branch: null,
    });
    const stmts = {
      ...base,
      getKanbanEpic: {
        get: vi.fn(() => ({ id: 'epic-1', pr_base_branch: 'feature/from-epic' })),
      },
    };

    initAutoGit({
      stmts: stmts as never,
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
        if (cmd.includes('git log @{upstream}..HEAD')) return fail('no upstream');
        if (cmd.includes('git rev-parse --abbrev-ref HEAD')) return ok('feature/child\n');
        if (cmd.includes('git ls-remote --heads origin'))
          return ok('a'.repeat(40) + '\trefs/heads/feature/from-epic\n');
        if (cmd.startsWith('gh pr view')) return fail('no pull requests found');
        if (cmd.startsWith('gh pr create')) return ok('https://github.com/test/repo/pull/124\n');
        return ok('');
      },
    );

    const project = { id: 'p', cwd: '/repo', githubRepo: 'test/repo' } as never;
    const agent = { name: 'dev', role: 'dev' } as never;
    await autoCommitAndPR('sess-epic-base', 'agent-1', project, agent, '/worktree', '');

    const ghCreateCalls = execCalls.filter((c) => c.startsWith('gh pr create'));
    expect(ghCreateCalls).toHaveLength(1);
    expect(ghCreateCalls[0]).toContain('--base feature/from-epic');
  });

  it('falls back to default base + posts a card comment when override no longer exists', async () => {
    const execCalls: string[] = [];
    const stmts = makeAutonomousStmtsWithCard({
      id: 'card-deleted-base',
      title: 'Stacked PR — base deleted',
      description: 'desc',
      priority: 'medium',
      dispatched_by_autonomous: 1,
      epic_id: null,
      pr_base_branch: 'feature/since-deleted',
    });

    initAutoGit({
      stmts: stmts as never,
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
        if (cmd.includes('git log @{upstream}..HEAD')) return fail('no upstream');
        if (cmd.includes('git rev-parse --abbrev-ref HEAD')) return ok('feature/child\n');
        // Branch is gone — empty stdout means `gh pr create --base` would fail.
        if (cmd.includes('git ls-remote --heads origin')) return ok('');
        if (cmd.startsWith('gh pr view')) return fail('no pull requests found');
        if (cmd.startsWith('gh pr create')) return ok('https://github.com/test/repo/pull/124\n');
        return ok('');
      },
    );

    const project = { id: 'p', cwd: '/repo', githubRepo: 'test/repo' } as never;
    const agent = { name: 'dev', role: 'dev' } as never;
    await autoCommitAndPR('sess-fallback', 'agent-1', project, agent, '/worktree', '');

    const ghCreateCalls = execCalls.filter((c) => c.startsWith('gh pr create'));
    expect(ghCreateCalls).toHaveLength(1);
    // Fallback to repo default → no --base arg
    expect(ghCreateCalls[0]).not.toContain('--base');

    // Explanatory comment must be posted on the card.
    const commentRun = (stmts.createKanbanCardComment as { run: ReturnType<typeof vi.fn> }).run;
    expect(commentRun).toHaveBeenCalledTimes(1);
    const commentArgs = commentRun.mock.calls[0] as unknown[];
    // Args: id, cardId, author, content
    expect(commentArgs[1]).toBe('card-deleted-base');
    expect(String(commentArgs[3])).toMatch(/feature\/since-deleted/);
    expect(String(commentArgs[3])).toMatch(/falling back/i);
  });

  it('skips gh pr create when head has no commits ahead of resolved base (empty-diff guard)', async () => {
    // Regression: when `pr_base_branch` (or any non-default base GitHub
    // ends up comparing against) already contains every commit on the
    // head branch, `gh pr create` returns
    //   GraphQL: No commits between <head> and <base> (createPullRequest)
    // which used to cascade into the noisy `pr_failed` code. The
    // empty-diff guard inserted after the push must short-circuit BEFORE
    // `gh pr create` is invoked and return `no_diff_vs_base` instead.
    const execCalls: string[] = [];
    const stmts = makeAutonomousStmtsWithCard({
      id: 'card-empty-diff',
      title: 'Empty diff vs parent',
      description: 'desc',
      priority: 'medium',
      dispatched_by_autonomous: 1,
      epic_id: null,
      pr_base_branch: 'feature/parent-branch',
    });

    initAutoGit({
      stmts: stmts as never,
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
        if (cmd.includes('git log @{upstream}..HEAD')) return fail('no upstream');
        if (cmd.includes('git rev-parse --abbrev-ref HEAD')) return ok('feature/child\n');
        // Override branch exists on origin → ls-remote yields a SHA.
        if (cmd.includes('git ls-remote --heads origin'))
          return ok('a'.repeat(40) + '\trefs/heads/feature/parent-branch\n');
        // The guard's pre-flight fetch of the base ref.
        if (cmd.includes('git fetch') && cmd.includes('feature/parent-branch')) return ok('');
        // The empty-diff guard itself: head has 0 commits ahead of base.
        if (
          cmd.includes('git rev-list') &&
          cmd.includes('--count') &&
          cmd.includes('origin/feature/parent-branch..origin/feature/child')
        ) {
          return ok('0\n');
        }
        if (cmd.startsWith('gh pr view')) return fail('no pull requests found');
        // MUST NOT be called — fail loudly if the guard regresses.
        if (cmd.startsWith('gh pr create')) {
          return fail('gh pr create should not be called when head has no commits vs base');
        }
        return ok('');
      },
    );

    const project = { id: 'p', cwd: '/repo', githubRepo: 'test/repo' } as never;
    const agent = { name: 'dev', role: 'dev' } as never;
    await autoCommitAndPR('sess-empty-diff', 'agent-1', project, agent, '/worktree', '');

    const ghCreateCalls = execCalls.filter((c) => c.startsWith('gh pr create'));
    expect(ghCreateCalls).toHaveLength(0);

    // The guard must surface to the user via the create_pr_log broadcast so
    // the UI's "Create PR" log explains the skip.
    const prLogTexts = mockBroadcast.mock.calls
      .map((call: unknown[]) => call[0] as Record<string, unknown>)
      .filter((evt) => evt && evt.type === 'create_pr_log')
      .map((evt) => String(evt.text || ''));
    expect(prLogTexts.some((t) => /no commits ahead/i.test(t))).toBe(true);
  });

  it('no --base arg and no fallback comment when card has no pr_base_branch', async () => {
    const execCalls: string[] = [];
    const stmts = makeAutonomousStmtsWithCard({
      id: 'card-no-override',
      title: 'No base override',
      description: 'desc',
      priority: 'medium',
      dispatched_by_autonomous: 1,
      epic_id: null,
      pr_base_branch: null,
    });

    initAutoGit({
      stmts: stmts as never,
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
        if (cmd.includes('git log @{upstream}..HEAD')) return fail('no upstream');
        if (cmd.includes('git rev-parse --abbrev-ref HEAD')) return ok('feature/child\n');
        if (cmd.startsWith('gh pr view')) return fail('no pull requests found');
        if (cmd.startsWith('gh pr create')) return ok('https://github.com/test/repo/pull/125\n');
        return ok('');
      },
    );

    const project = { id: 'p', cwd: '/repo', githubRepo: 'test/repo' } as never;
    const agent = { name: 'dev', role: 'dev' } as never;
    await autoCommitAndPR('sess-no-override', 'agent-1', project, agent, '/worktree', '');

    const ghCreateCalls = execCalls.filter((c) => c.startsWith('gh pr create'));
    expect(ghCreateCalls).toHaveLength(1);
    expect(ghCreateCalls[0]).not.toContain('--base');

    // No ls-remote --heads call needed when there's no override
    const lsRemoteCalls = execCalls.filter((c) => c.includes('git ls-remote --heads origin'));
    expect(lsRemoteCalls).toHaveLength(0);

    // No fallback comment on the happy path
    const commentRun = (stmts.createKanbanCardComment as { run: ReturnType<typeof vi.fn> }).run;
    expect(commentRun).not.toHaveBeenCalled();
  });
});

describe('tasks-only project (no githubRepo) — auto/manual PR are no-ops', () => {
  // A "tasks-only" project is one with no `githubRepo` set: it has wiki,
  // kanban, sessions, crons, and heartbeats, but no git/PR lifecycle. Both
  // the auto-PR babysit (autoCommitAndPR) and the user-clicked manual PR
  // path (manualCommitAndPR) must short-circuit cleanly when there is no
  // GitHub repo to push to.
  const mockBroadcast = vi.fn();
  const mockStmts = {
    getKanbanCardBySession: { get: vi.fn(() => undefined) },
    updateSessionChangesReady: { run: vi.fn() },
    clearSessionChangesReady: { run: vi.fn() },
    getKanbanBoard: { get: vi.fn(() => ({ id: 'board-1' })) },
  } as Record<string, unknown>;

  beforeEach(() => {
    vi.clearAllMocks();
    initAutoGit({
      stmts: mockStmts as never,
      broadcast: mockBroadcast,
      getConfig: vi.fn(() => ({}) as never),
      DEFAULT_SKILLS_DIR: '/tmp/skills',
    });
    // If anything tries to shell out, fail loudly — a tasks-only project
    // must not invoke git or gh at all.
    installExecAndGhMock(
      (
        cmd: string,
        _opts: Record<string, unknown>,
        callback?: (err: Error | null, result: { stdout: string; stderr: string }) => void,
      ) => {
        callback?.(new Error(`unexpected exec in tasks-only project: ${cmd}`), {
          stdout: '',
          stderr: '',
        });
      },
    );
  });

  it('autoCommitAndPR returns immediately when project has no githubRepo', async () => {
    const project = { id: 'tasks-only', cwd: '/anywhere' } as never;
    const agent = { name: 'tasker', role: 'dev' } as never;
    await autoCommitAndPR('sess-tasks', 'agent-1', project, agent, '/worktree', '');
    // No broadcasts at all — nothing happened.
    expect(mockBroadcast).not.toHaveBeenCalled();
  });

  it('manualCommitAndPR returns no_github_repo when project has no githubRepo', async () => {
    const project = { id: 'tasks-only', cwd: '/anywhere' } as never;
    const agent = { name: 'tasker', role: 'dev' } as never;
    const result = await manualCommitAndPR(
      'sess-tasks',
      'agent-1',
      project,
      agent,
      '/worktree',
      {},
    );
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.code).toBe('no_github_repo');
      expect(result.error).toMatch(/not connected to a GitHub repository/i);
    }
  });
});

describe('commitPushAndCreatePR — per-user GitHub token injection', () => {
  // Regression: autonomous-dispatch sessions deliberately strip GitHub
  // credentials from the agent's spawn env (anti-bypass). Auto-git runs in
  // the Hub server process, so it must resolve the session owner's per-user
  // token itself and inject it into every `git push` / `gh` child env.
  // Without this, pushes to private repos fail with "Authentication failed
  // for 'https://github.com/<owner>/<repo>.git/'".
  const mockBroadcast = vi.fn();
  const FAKE_TOKEN = 'gho_test_token_42';

  beforeEach(async () => {
    vi.clearAllMocks();
    const { getSessionOwner, getOrgOwnerUserId } = await import('./session-ownership.js');
    const { getActiveAccessToken } = await import('./github-connections-store.js');
    (getSessionOwner as unknown as Mock).mockReturnValue('owner-user-1');
    (getOrgOwnerUserId as unknown as Mock).mockReturnValue('owner-user-1');
    (getActiveAccessToken as unknown as Mock).mockResolvedValue(FAKE_TOKEN);
  });

  it('injects the session owner GH_TOKEN + credential helper into git push env', async () => {
    const mockCard = {
      id: 'card-token-1',
      title: 'Token-injection card',
      description: 'desc',
      priority: 'medium',
      dispatched_by_autonomous: 1,
      epic_id: null,
    };
    const mockStmts = {
      getKanbanCardBySession: { get: vi.fn(() => mockCard) },
      getKanbanCard: { get: vi.fn(() => mockCard) },
      getKanbanEpic: { get: vi.fn(() => undefined) },
      getSession: { get: vi.fn(() => ({ name: 'Token session' })) },
      getKanbanBoard: { get: vi.fn(() => ({ id: 'board-1' })) },
      getKanbanColumns: {
        all: vi.fn(() => [
          { id: 'col-inprog', name: 'In Progress' },
          { id: 'col-review', name: 'Review' },
          { id: 'col-done', name: 'Done' },
        ]),
      },
      getMessages: { all: vi.fn(() => [] as MessageRow[]) },
      setCardPrUrl: { run: vi.fn() },
      moveKanbanCard: { run: vi.fn() },
      updateKanbanCard: { run: vi.fn() },
      updateSessionChangesReady: { run: vi.fn() },
      clearSessionChangesReady: { run: vi.fn() },
      addMessage: { run: vi.fn() },
      createKanbanCardComment: { run: vi.fn() },
      createPrCreationLog: { run: vi.fn(() => ({ changes: 1 })) },
      getMessageById: {
        get: vi.fn(() => ({
          id: 'm-1',
          session_id: 'sess-token',
          role: 'system',
          content: '',
          engine: null,
          model: null,
          attachments: null,
          metadata: null,
          created_at: '2026-05-13T00:00:00.000Z',
        })),
      },
    } as Record<string, unknown>;

    initAutoGit({
      stmts: mockStmts as never,
      broadcast: mockBroadcast,
      getConfig: vi.fn(() => ({}) as never),
      DEFAULT_SKILLS_DIR: '/tmp/skills',
    });

    // Capture env for every spawned git/gh child so we can assert the push
    // child saw the resolved token in its env.
    const spawnEnvs: Array<{ file: string; args: string[]; env: NodeJS.ProcessEnv }> = [];

    (spawn as unknown as Mock).mockImplementation(
      (file: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv }) => {
        spawnEnvs.push({ file, args, env: options?.env ?? {} });
        const child = new EventEmitter() as EventEmitter & {
          stdout: EventEmitter;
          stderr: EventEmitter;
          kill: ReturnType<typeof vi.fn>;
        };
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.kill = vi.fn();
        queueMicrotask(() => {
          // gh pr create returns the URL; everything else exits 0 silently.
          if (file === 'gh' && args[0] === 'pr' && args[1] === 'create') {
            child.stdout.emit('data', Buffer.from('https://github.com/test/repo/pull/123\n'));
          }
          child.emit('close', 0, null);
        });
        return child;
      },
    );

    // exec/execFile cover `git config`, `git status`, `git log`, `git remote -v`,
    // and the `gh pr view` pre-check. Mirror the patterns used by other tests.
    (exec as unknown as Mock).mockImplementation(
      (
        cmd: string,
        _opts: Record<string, unknown>,
        cb?: (err: Error | null, r: { stdout: string; stderr: string }) => void,
      ) => {
        const ok = (stdout: string) => cb?.(null, { stdout, stderr: '' });
        if (cmd.includes('git remote -v'))
          return ok('origin\thttps://github.com/test/repo.git (fetch)\n');
        if (cmd.includes('git status --porcelain')) return ok('M file.ts\n');
        if (cmd.includes('git rev-parse --abbrev-ref HEAD')) return ok('feature/token-test\n');
        if (cmd.includes('git log @{upstream}..HEAD'))
          return cb?.(new Error('no upstream'), { stdout: '', stderr: '' });
        if (cmd.includes('git log main..HEAD')) return ok('');
        if (cmd.startsWith('git config user.name'))
          return cb?.(null, { stdout: 'CI Bot\n', stderr: '' });
        if (cmd.startsWith('git config user.email'))
          return cb?.(null, { stdout: 'ci@example.com\n', stderr: '' });
        return ok('');
      },
    );

    (execFile as unknown as Mock).mockImplementation(
      (
        file: string,
        args: string[],
        _opts: Record<string, unknown>,
        cb?: (err: Error | null, r: { stdout: string; stderr: string }) => void,
      ) => {
        if (file === 'gh' && args[0] === 'pr' && args[1] === 'view') {
          return cb?.(null, { stdout: '', stderr: '' });
        }
        cb?.(null, { stdout: '', stderr: '' });
      },
    );

    const project = { id: 'test', cwd: '/repo', githubRepo: 'test/repo' } as never;
    const agent = { name: 'token-agent', role: 'dev' } as never;

    await autoCommitAndPR('sess-token', 'agent-token', project, agent, '/worktree', '');

    const pushSpawn = spawnEnvs.find((s) => s.file === 'git' && s.args[0] === 'push');
    expect(pushSpawn).toBeDefined();
    // Token must be present so the credential helper / gh fall through to it.
    expect(pushSpawn?.env.GH_TOKEN).toBe(FAKE_TOKEN);
    expect(pushSpawn?.env.GITHUB_TOKEN).toBe(FAKE_TOKEN);
    // The "clear inherited helper" sentinel must be installed at index 0 so
    // host operator credentials in ~/.gitconfig can't shadow the injected
    // helper. The working helper is appended at the next index by
    // `applyGithubSpawnCredentials`.
    expect(pushSpawn?.env.GIT_CONFIG_KEY_0).toBe('credential.https://github.com.helper');
    expect(pushSpawn?.env.GIT_CONFIG_VALUE_0).toBe('');
    const countRaw = pushSpawn?.env.GIT_CONFIG_COUNT;
    const count = countRaw ? Number.parseInt(countRaw, 10) : NaN;
    expect(Number.isFinite(count) && count >= 2).toBe(true);
  });

  it('injects credentials into git ls-remote when resolving pr_base_branch', async () => {
    const lsRemoteEnvs: NodeJS.ProcessEnv[] = [];
    const mockCard = {
      id: 'card-ls-remote-token',
      title: 'PR base probe card',
      description: 'desc',
      priority: 'medium',
      dispatched_by_autonomous: 1,
      epic_id: null,
      pr_base_branch: 'feature/parent-branch',
    };
    const mockStmts = {
      getKanbanCardBySession: { get: vi.fn(() => mockCard) },
      getKanbanCard: { get: vi.fn(() => mockCard) },
      getKanbanEpic: { get: vi.fn(() => undefined) },
      getSession: { get: vi.fn(() => ({ name: 'Ls-remote session' })) },
      getKanbanBoard: { get: vi.fn(() => ({ id: 'board-1' })) },
      getKanbanColumns: {
        all: vi.fn(() => [
          { id: 'col-inprog', name: 'In Progress' },
          { id: 'col-review', name: 'Review' },
          { id: 'col-done', name: 'Done' },
        ]),
      },
      getMessages: { all: vi.fn(() => [] as MessageRow[]) },
      setCardPrUrl: { run: vi.fn() },
      moveKanbanCard: { run: vi.fn() },
      updateKanbanCard: { run: vi.fn() },
      updateSessionChangesReady: { run: vi.fn() },
      clearSessionChangesReady: { run: vi.fn() },
      addMessage: { run: vi.fn() },
      createKanbanCardComment: { run: vi.fn() },
      createPrCreationLog: { run: vi.fn(() => ({ changes: 1 })) },
      getMessageById: {
        get: vi.fn(() => ({
          id: 'm-lsr',
          session_id: 'sess-ls-remote',
          role: 'system',
          content: '',
          engine: null,
          model: null,
          attachments: null,
          metadata: null,
          created_at: '2026-05-13T00:00:00.000Z',
        })),
      },
    } as Record<string, unknown>;

    initAutoGit({
      stmts: mockStmts as never,
      broadcast: mockBroadcast,
      getConfig: vi.fn(() => ({}) as never),
      DEFAULT_SKILLS_DIR: '/tmp/skills',
    });

    (spawn as unknown as Mock).mockImplementation(
      (file: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv }) => {
        const child = new EventEmitter() as EventEmitter & {
          stdout: EventEmitter;
          stderr: EventEmitter;
          kill: ReturnType<typeof vi.fn>;
        };
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.kill = vi.fn();
        queueMicrotask(() => {
          if (file === 'gh' && args[0] === 'pr' && args[1] === 'create') {
            child.stdout.emit('data', Buffer.from('https://github.com/test/repo/pull/777\n'));
          }
          child.emit('close', 0, null);
        });
        return child;
      },
    );

    (exec as unknown as Mock).mockImplementation(
      (
        cmd: string,
        _opts: Record<string, unknown>,
        cb?: (err: Error | null, r: { stdout: string; stderr: string }) => void,
      ) => {
        const ok = (stdout: string) => cb?.(null, { stdout, stderr: '' });
        if (cmd.includes('git remote -v'))
          return ok('origin\thttps://github.com/test/repo.git (fetch)\n');
        if (cmd.includes('git status --porcelain')) return ok('M file.ts\n');
        if (cmd.includes('git rev-parse --abbrev-ref HEAD')) return ok('feature/child\n');
        if (cmd.includes('git log @{upstream}..HEAD'))
          return cb?.(new Error('no upstream'), { stdout: '', stderr: '' });
        if (cmd.includes('git log main..HEAD')) return ok('');
        if (cmd.startsWith('git config user.name'))
          return cb?.(null, { stdout: 'CI Bot\n', stderr: '' });
        if (cmd.startsWith('git config user.email'))
          return cb?.(null, { stdout: 'ci@example.com\n', stderr: '' });
        return ok('');
      },
    );

    (execFile as unknown as Mock).mockImplementation(
      (
        file: string,
        args: string[],
        opts: Record<string, unknown>,
        cb?: (err: Error | null, r: { stdout: string; stderr: string }) => void,
      ) => {
        if (file === 'git' && args[0] === 'ls-remote') {
          lsRemoteEnvs.push((opts.env ?? {}) as NodeJS.ProcessEnv);
          return cb?.(null, {
            stdout: 'abcdef012345678901234567890123456789abcd\trefs/heads/feature/parent-branch\n',
            stderr: '',
          });
        }
        if (file === 'gh' && args[0] === 'pr' && args[1] === 'view') {
          return cb?.(null, { stdout: '', stderr: '' });
        }
        cb?.(null, { stdout: '', stderr: '' });
      },
    );

    const project = { id: 'test', cwd: '/repo', githubRepo: 'test/repo' } as never;
    const agent = { name: 'ls-remote-agent', role: 'dev' } as never;

    await autoCommitAndPR('sess-ls-remote', 'agent-lsr', project, agent, '/worktree', '');

    expect(lsRemoteEnvs.length).toBeGreaterThanOrEqual(1);
    const probeEnv = lsRemoteEnvs[0];
    expect(probeEnv?.GH_TOKEN).toBe(FAKE_TOKEN);
    expect(probeEnv?.GITHUB_TOKEN).toBe(FAKE_TOKEN);
    expect(probeEnv?.GIT_CONFIG_KEY_0).toBe('credential.https://github.com.helper');
  });

  it('does NOT inject GH_TOKEN when no session owner is resolvable', async () => {
    // Regression guard: when the owner lookup yields nothing (legacy install,
    // tests, or a misconfigured row), `autoGitChildEnv` must NOT surface a
    // stale token from `process.env` and must NOT let the host operator's
    // gh auth identity (typically the GitHub-App installation
    // `app/agent-hub-reviewer`) bleed into `git push` / `gh pr create`.
    // The auto-git identity isolation guarantees env.GH_TOKEN / GITHUB_TOKEN
    // are undefined here so the push fails loudly instead of silently
    // shipping a bot-PR.
    const { getSessionOwner, getOrgOwnerUserId } = await import('./session-ownership.js');
    (getSessionOwner as unknown as Mock).mockReturnValue(null);
    (getOrgOwnerUserId as unknown as Mock).mockReturnValue(null);

    const mockCard = {
      id: 'card-no-token',
      title: 'No-token card',
      description: '',
      priority: 'medium',
      dispatched_by_autonomous: 1,
      epic_id: null,
    };
    const mockStmts = {
      getKanbanCardBySession: { get: vi.fn(() => mockCard) },
      getKanbanCard: { get: vi.fn(() => mockCard) },
      getKanbanEpic: { get: vi.fn(() => undefined) },
      getSession: { get: vi.fn(() => ({ name: 'No-token session' })) },
      getKanbanBoard: { get: vi.fn(() => ({ id: 'board-1' })) },
      getKanbanColumns: {
        all: vi.fn(() => [
          { id: 'col-inprog', name: 'In Progress' },
          { id: 'col-review', name: 'Review' },
          { id: 'col-done', name: 'Done' },
        ]),
      },
      getMessages: { all: vi.fn(() => [] as MessageRow[]) },
      setCardPrUrl: { run: vi.fn() },
      moveKanbanCard: { run: vi.fn() },
      updateKanbanCard: { run: vi.fn() },
      updateSessionChangesReady: { run: vi.fn() },
      clearSessionChangesReady: { run: vi.fn() },
      addMessage: { run: vi.fn() },
      createKanbanCardComment: { run: vi.fn() },
      createPrCreationLog: { run: vi.fn(() => ({ changes: 1 })) },
      getMessageById: {
        get: vi.fn(() => ({
          id: 'm-2',
          session_id: 'sess-no-token',
          role: 'system',
          content: '',
          engine: null,
          model: null,
          attachments: null,
          metadata: null,
          created_at: '2026-05-13T00:00:00.000Z',
        })),
      },
    } as Record<string, unknown>;

    initAutoGit({
      stmts: mockStmts as never,
      broadcast: mockBroadcast,
      getConfig: vi.fn(() => ({}) as never),
      DEFAULT_SKILLS_DIR: '/tmp/skills',
    });

    // Force a process-env baseline that has no inherited GH_TOKEN so we can
    // assert the push child also has none.
    const prevGhToken = process.env.GH_TOKEN;
    const prevGithubToken = process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
    delete process.env.GITHUB_TOKEN;

    try {
      const spawnEnvs: Array<{ file: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
      (spawn as unknown as Mock).mockImplementation(
        (file: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv }) => {
          spawnEnvs.push({ file, args, env: options?.env ?? {} });
          const child = new EventEmitter() as EventEmitter & {
            stdout: EventEmitter;
            stderr: EventEmitter;
            kill: ReturnType<typeof vi.fn>;
          };
          child.stdout = new EventEmitter();
          child.stderr = new EventEmitter();
          child.kill = vi.fn();
          queueMicrotask(() => {
            if (file === 'gh' && args[0] === 'pr' && args[1] === 'create') {
              child.stdout.emit('data', Buffer.from('https://github.com/test/repo/pull/123\n'));
            }
            child.emit('close', 0, null);
          });
          return child;
        },
      );
      (exec as unknown as Mock).mockImplementation(
        (
          cmd: string,
          _opts: Record<string, unknown>,
          cb?: (err: Error | null, r: { stdout: string; stderr: string }) => void,
        ) => {
          const ok = (stdout: string) => cb?.(null, { stdout, stderr: '' });
          if (cmd.includes('git remote -v'))
            return ok('origin\thttps://github.com/test/repo.git (fetch)\n');
          if (cmd.includes('git status --porcelain')) return ok('M file.ts\n');
          if (cmd.includes('git rev-parse --abbrev-ref HEAD')) return ok('feature/no-token\n');
          if (cmd.includes('git log @{upstream}..HEAD'))
            return cb?.(new Error('no upstream'), { stdout: '', stderr: '' });
          if (cmd.includes('git log main..HEAD')) return ok('');
          if (cmd.startsWith('git config user.name'))
            return cb?.(null, { stdout: 'CI Bot\n', stderr: '' });
          if (cmd.startsWith('git config user.email'))
            return cb?.(null, { stdout: 'ci@example.com\n', stderr: '' });
          return ok('');
        },
      );
      (execFile as unknown as Mock).mockImplementation(
        (
          _file: string,
          _args: string[],
          _opts: Record<string, unknown>,
          cb?: (err: Error | null, r: { stdout: string; stderr: string }) => void,
        ) => {
          cb?.(null, { stdout: '', stderr: '' });
        },
      );

      const project = { id: 'test', cwd: '/repo', githubRepo: 'test/repo' } as never;
      const agent = { name: 'no-token-agent', role: 'dev' } as never;
      await autoCommitAndPR('sess-no-token', 'agent-no-token', project, agent, '/worktree', '');

      const pushSpawn = spawnEnvs.find((s) => s.file === 'git' && s.args[0] === 'push');
      expect(pushSpawn).toBeDefined();
      expect(pushSpawn?.env.GH_TOKEN).toBeUndefined();
      expect(pushSpawn?.env.GITHUB_TOKEN).toBeUndefined();
    } finally {
      if (prevGhToken !== undefined) process.env.GH_TOKEN = prevGhToken;
      if (prevGithubToken !== undefined) process.env.GITHUB_TOKEN = prevGithubToken;
    }
  });
});

describe('commitPushAndCreatePR — existing-PR base retarget', () => {
  // Closes the gap where an agent runs `gh pr create` itself (against the
  // chat.ts prompt) BEFORE the server's auto-PR fires. The server discovers
  // the existing PR and previously rubber-stamped its base — including the
  // wrong default (`master`/`main`) when the card/epic specified an
  // integration branch via `pr_base_branch`. The retarget path now compares
  // the existing PR's `baseRefName` to the resolved override and runs
  // `gh pr edit --base <branch>` to fix it.
  const mockBroadcast = vi.fn();

  function makeStmtsWithCard(card: Record<string, unknown>, epic?: Record<string, unknown> | null) {
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
      createPrCreationLog: { run: vi.fn(() => ({ changes: 1 })) },
      createKanbanCardComment: { run: vi.fn() },
      getKanbanEpic: { get: vi.fn(() => epic ?? null) },
    } as Record<string, unknown>;
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('retargets the existing PR when card.pr_base_branch differs from current base (clean-worktree path)', async () => {
    const execCalls: string[] = [];
    const stmts = makeStmtsWithCard({
      id: 'card-retarget',
      title: 'Retarget card',
      description: 'desc',
      priority: 'medium',
      dispatched_by_autonomous: 1,
      epic_id: null,
      pr_base_branch: 'feature/auto-cad-engine',
    });

    initAutoGit({
      stmts: stmts as never,
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
        if (cmd.includes('git remote -v'))
          return ok('origin\thttps://github.com/test/repo.git (fetch)\n');
        // Clean worktree (no changes) → early-return adoption path.
        if (cmd.includes('git status --porcelain')) return ok('');
        if (cmd.includes('git log')) return ok('');
        if (cmd.includes('git rev-parse --abbrev-ref HEAD')) return ok('feature/child\n');
        if (cmd.includes('git ls-remote --heads origin'))
          return ok('a'.repeat(40) + '\trefs/heads/feature/auto-cad-engine\n');
        // PR-list (no args): the early-return existence check.
        if (/^gh pr view --json url,state/.test(cmd))
          return ok('https://github.com/test/repo/pull/658\n');
        // PR-detail: retarget helper checks current baseRefName.
        if (cmd.startsWith('gh pr view https://github.com/test/repo/pull/658 --json baseRefName'))
          return ok('master\n');
        if (cmd.startsWith('gh pr edit')) return ok('');
        return ok('');
      },
    );

    const project = { id: 'p', cwd: '/repo', githubRepo: 'test/repo' } as never;
    const agent = { name: 'dev', role: 'dev' } as never;
    await autoCommitAndPR('sess-retarget', 'agent-1', project, agent, '/worktree', '');

    const editCalls = execCalls.filter((c) => c.startsWith('gh pr edit'));
    expect(editCalls).toHaveLength(1);
    expect(editCalls[0]).toContain('https://github.com/test/repo/pull/658');
    expect(editCalls[0]).toContain('--base feature/auto-cad-engine');

    // Audit comment posted on the card explaining the retarget.
    const commentRun = (stmts.createKanbanCardComment as { run: ReturnType<typeof vi.fn> }).run;
    const retargetComments = commentRun.mock.calls.filter((args) =>
      String(args[3]).toLowerCase().includes('retargeted'),
    );
    expect(retargetComments).toHaveLength(1);
    expect(String(retargetComments[0][3])).toMatch(/master/);
    expect(String(retargetComments[0][3])).toMatch(/feature\/auto-cad-engine/);
  });

  it('uses epic.pr_base_branch when card omits an override and PR base differs', async () => {
    const execCalls: string[] = [];
    const stmts = makeStmtsWithCard(
      {
        id: 'card-epic-retarget',
        title: 'Epic-driven retarget',
        description: 'desc',
        priority: 'medium',
        dispatched_by_autonomous: 1,
        epic_id: 'epic-1',
        pr_base_branch: null,
      },
      { id: 'epic-1', pr_base_branch: 'feature/auto-cad-engine' },
    );

    initAutoGit({
      stmts: stmts as never,
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
        // Dirty worktree → goes through commit/push, pre-check sees existing PR.
        if (cmd.includes('git status --porcelain')) return ok('M file.ts\n');
        if (cmd.includes('git log @{upstream}..HEAD')) return fail('no upstream');
        if (cmd.includes('git rev-parse --abbrev-ref HEAD')) return ok('feature/child\n');
        if (cmd.includes('git ls-remote --heads origin'))
          return ok('a'.repeat(40) + '\trefs/heads/feature/auto-cad-engine\n');
        // Pre-check: existing PR on branch.
        if (cmd.startsWith('gh pr view feature/child --json url,state'))
          return ok('https://github.com/test/repo/pull/659\n');
        if (cmd.startsWith('gh pr view https://github.com/test/repo/pull/659 --json baseRefName'))
          return ok('master\n');
        if (cmd.startsWith('gh pr edit')) return ok('');
        return ok('');
      },
    );

    const project = { id: 'p', cwd: '/repo', githubRepo: 'test/repo' } as never;
    const agent = { name: 'dev', role: 'dev' } as never;
    await autoCommitAndPR('sess-epic-retarget', 'agent-1', project, agent, '/worktree', '');

    const editCalls = execCalls.filter((c) => c.startsWith('gh pr edit'));
    expect(editCalls).toHaveLength(1);
    expect(editCalls[0]).toContain('--base feature/auto-cad-engine');
    // And the adoption path must NOT invoke `gh pr create` for this branch
    // (we adopted the existing PR, only retargeting it).
    expect(execCalls.filter((c) => c.startsWith('gh pr create'))).toHaveLength(0);
  });

  it('skips retarget when the existing PR already targets the requested base', async () => {
    const execCalls: string[] = [];
    const stmts = makeStmtsWithCard({
      id: 'card-noop-retarget',
      title: 'Already on the right base',
      description: 'desc',
      priority: 'medium',
      dispatched_by_autonomous: 1,
      epic_id: null,
      pr_base_branch: 'feature/auto-cad-engine',
    });

    initAutoGit({
      stmts: stmts as never,
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
        if (cmd.includes('git remote -v'))
          return ok('origin\thttps://github.com/test/repo.git (fetch)\n');
        if (cmd.includes('git status --porcelain')) return ok('');
        if (cmd.includes('git log')) return ok('');
        if (cmd.includes('git rev-parse --abbrev-ref HEAD')) return ok('feature/child\n');
        if (cmd.includes('git ls-remote --heads origin'))
          return ok('a'.repeat(40) + '\trefs/heads/feature/auto-cad-engine\n');
        if (/^gh pr view --json url,state/.test(cmd))
          return ok('https://github.com/test/repo/pull/660\n');
        // Already on the requested base.
        if (cmd.startsWith('gh pr view https://github.com/test/repo/pull/660 --json baseRefName'))
          return ok('feature/auto-cad-engine\n');
        return ok('');
      },
    );

    const project = { id: 'p', cwd: '/repo', githubRepo: 'test/repo' } as never;
    const agent = { name: 'dev', role: 'dev' } as never;
    await autoCommitAndPR('sess-noop-retarget', 'agent-1', project, agent, '/worktree', '');

    expect(execCalls.filter((c) => c.startsWith('gh pr edit'))).toHaveLength(0);
    // No audit comment when nothing was changed.
    const commentRun = (stmts.createKanbanCardComment as { run: ReturnType<typeof vi.fn> }).run;
    const retargetComments = commentRun.mock.calls.filter((args) =>
      String(args[3]).toLowerCase().includes('retargeted'),
    );
    expect(retargetComments).toHaveLength(0);
  });

  it('skips retarget entirely when no card-or-epic base override is configured', async () => {
    const execCalls: string[] = [];
    const stmts = makeStmtsWithCard({
      id: 'card-no-override',
      title: 'No base override',
      description: 'desc',
      priority: 'medium',
      dispatched_by_autonomous: 1,
      epic_id: null,
      pr_base_branch: null,
    });

    initAutoGit({
      stmts: stmts as never,
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
        if (cmd.includes('git remote -v'))
          return ok('origin\thttps://github.com/test/repo.git (fetch)\n');
        if (cmd.includes('git status --porcelain')) return ok('');
        if (cmd.includes('git log')) return ok('');
        if (cmd.includes('git rev-parse --abbrev-ref HEAD')) return ok('feature/child\n');
        if (/^gh pr view --json url,state/.test(cmd))
          return ok('https://github.com/test/repo/pull/661\n');
        return ok('');
      },
    );

    const project = { id: 'p', cwd: '/repo', githubRepo: 'test/repo' } as never;
    const agent = { name: 'dev', role: 'dev' } as never;
    await autoCommitAndPR('sess-no-override-retarget', 'agent-1', project, agent, '/worktree', '');

    // No base-detail query, no edit. The retarget helper short-circuits on
    // `resolvedBaseBranch === null` before any `gh` call.
    expect(execCalls.some((c) => c.includes('--json baseRefName'))).toBe(false);
    expect(execCalls.filter((c) => c.startsWith('gh pr edit'))).toHaveLength(0);
  });

  it('posts a warning comment and still moves the card when gh pr edit fails', async () => {
    const execCalls: string[] = [];
    const stmts = makeStmtsWithCard({
      id: 'card-edit-fail',
      title: 'Retarget fails — warn but proceed',
      description: 'desc',
      priority: 'medium',
      dispatched_by_autonomous: 1,
      epic_id: null,
      pr_base_branch: 'feature/auto-cad-engine',
    });

    initAutoGit({
      stmts: stmts as never,
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
        if (cmd.includes('git status --porcelain')) return ok('');
        if (cmd.includes('git log')) return ok('');
        if (cmd.includes('git rev-parse --abbrev-ref HEAD')) return ok('feature/child\n');
        if (cmd.includes('git ls-remote --heads origin'))
          return ok('a'.repeat(40) + '\trefs/heads/feature/auto-cad-engine\n');
        if (/^gh pr view --json url,state/.test(cmd))
          return ok('https://github.com/test/repo/pull/662\n');
        if (cmd.startsWith('gh pr view https://github.com/test/repo/pull/662 --json baseRefName'))
          return ok('master\n');
        if (cmd.startsWith('gh pr edit')) return fail('forbidden — no permission to edit PR');
        return ok('');
      },
    );

    const project = { id: 'p', cwd: '/repo', githubRepo: 'test/repo' } as never;
    const agent = { name: 'dev', role: 'dev' } as never;
    await autoCommitAndPR('sess-edit-fail', 'agent-1', project, agent, '/worktree', '');

    // gh pr edit was attempted exactly once
    expect(execCalls.filter((c) => c.startsWith('gh pr edit'))).toHaveLength(1);
    // Warning comment posted (mentions the failure + the manual recovery command)
    const commentRun = (stmts.createKanbanCardComment as { run: ReturnType<typeof vi.fn> }).run;
    const warnings = commentRun.mock.calls.filter((args) =>
      String(args[3]).includes('Tried to retarget'),
    );
    expect(warnings).toHaveLength(1);
    expect(String(warnings[0][3])).toMatch(
      /gh pr edit https:\/\/github.com\/test\/repo\/pull\/662/,
    );
    // Card still moves to Review (non-fatal).
    const moveRun = (stmts.moveKanbanCard as { run: ReturnType<typeof vi.fn> }).run;
    expect(moveRun).toHaveBeenCalledWith('col-review', 0, 'card-edit-fail');
  });
});
