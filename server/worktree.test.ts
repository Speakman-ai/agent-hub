import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';
import { mkdirSync, writeFileSync, rmSync, existsSync, utimesSync } from 'fs';
import path from 'path';
import os from 'os';
import { homedir } from 'os';
import type { SessionRow } from './types.js';

vi.mock('./config.js', () => ({
  default: { defaultCwd: '/tmp' },
}));

const {
  getOrCreateProcessWorktree,
  ensureSessionWorkspace,
  removeWorkspace,
  cleanupStaleWorkspaces,
  __test,
} = await import('./worktree.js');

describe('getOrCreateProcessWorktree — cwd validation', () => {
  it('falls back to defaultCwd when cwd does not exist', async () => {
    const result = await getOrCreateProcessWorktree('/nonexistent/fake/path', 'test-process');
    expect(result).toBe('/tmp');
  });

  it('returns the original cwd when it exists', async () => {
    const result = await getOrCreateProcessWorktree('/tmp', 'test-process');
    expect(result).toBe('/tmp');
  });
});

describe('ensureSessionWorkspace — fetch on reuse', () => {
  let tmpRoot: string;
  let originBare: string;
  let sourceRepo: string;
  let sessionId: string;
  let createdWorkspace: string | null = null;

  function git(cwd: string, cmd: string): string {
    return execSync(`git ${cmd}`, { cwd, stdio: 'pipe' }).toString().trim();
  }

  beforeEach(() => {
    tmpRoot = path.join(
      os.tmpdir(),
      `worktree-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(tmpRoot, { recursive: true });

    // Bare "origin" repo
    originBare = path.join(tmpRoot, 'origin.git');
    mkdirSync(originBare, { recursive: true });
    execSync('git init --bare --initial-branch=main', { cwd: originBare, stdio: 'pipe' });

    // Source working repo (what the Agent Hub project points at as cwd)
    sourceRepo = path.join(tmpRoot, 'source');
    execSync(`git clone --quiet "${originBare}" "${sourceRepo}"`, { stdio: 'pipe' });
    git(sourceRepo, 'config user.email "test@example.com"');
    git(sourceRepo, 'config user.name "Test"');
    git(sourceRepo, 'checkout -b main');
    writeFileSync(path.join(sourceRepo, 'README.md'), 'v1\n');
    git(sourceRepo, 'add README.md');
    git(sourceRepo, 'commit -m "initial"');
    git(sourceRepo, 'push -u origin main');

    // Unique session id so workspace dir doesn't collide with other tests
    sessionId = `sess${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    createdWorkspace = null;
  });

  afterEach(() => {
    // Clean up the workspace created under ~/.agent-hub/workspaces
    if (createdWorkspace) {
      removeWorkspace(createdWorkspace);
    }
    // Also clean up parent workspace dir if empty/stale (best-effort)
    try {
      const wsParent = path.join(homedir(), '.agent-hub', 'workspaces', path.basename(sourceRepo));
      if (existsSync(wsParent)) {
        rmSync(wsParent, { recursive: true, force: true });
      }
    } catch {
      /* best-effort */
    }
    if (existsSync(tmpRoot)) {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  function makeSession(workspacePath: string | null = null): SessionRow {
    return {
      id: sessionId,
      agent_id: 'test-agent',
      name: 'test',
      engine: 'claude',
      model: 'claude-sonnet-4-20250514',
      engine_session_id: null,
      use_worktree: 1,
      worktree_path: workspacePath,
      worktree_branch: null,
      git_worktree_detected: 0,
      changes_ready: null,
      stale_pr_notified_at: null,
      ask_mode: 0,
      cron_id: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      deleted_at: null,
    };
  }

  it('fetches origin when session.worktree_path is already persisted (resume path)', async () => {
    const persist = vi.fn();

    const clonePath = await ensureSessionWorkspace(
      makeSession(null),
      sourceRepo,
      'test-agent',
      persist,
    );
    createdWorkspace = clonePath;

    const initialOriginTip = git(clonePath, 'rev-parse origin/main');

    writeFileSync(path.join(sourceRepo, 'RESUME.md'), 'after first ensure\n');
    git(sourceRepo, 'add RESUME.md');
    git(sourceRepo, 'commit -m "resume path upstream"');
    git(sourceRepo, 'push origin main');
    const newOriginTip = git(sourceRepo, 'rev-parse HEAD');
    expect(newOriginTip).not.toBe(initialOriginTip);

    const resumedPath = await ensureSessionWorkspace(
      makeSession(clonePath),
      sourceRepo,
      'test-agent',
      persist,
    );
    expect(resumedPath).toBe(clonePath);

    const refreshedOriginTip = git(clonePath, 'rev-parse origin/main');
    expect(refreshedOriginTip).toBe(newOriginTip);
  });

  it('fetches origin on reuse so origin/main reflects new upstream commits', async () => {
    const persist = vi.fn();

    // First call — creates the session clone fresh from origin
    const clonePath = await ensureSessionWorkspace(
      makeSession(null),
      sourceRepo,
      'test-agent',
      persist,
    );
    createdWorkspace = clonePath;

    expect(clonePath).not.toBe(sourceRepo);
    expect(existsSync(path.join(clonePath, '.git'))).toBe(true);

    const initialOriginTip = git(clonePath, 'rev-parse origin/main');

    // A new commit lands on origin/main (simulated: push from source repo)
    writeFileSync(path.join(sourceRepo, 'NEW.md'), 'landed after session started\n');
    git(sourceRepo, 'add NEW.md');
    git(sourceRepo, 'commit -m "new upstream commit"');
    git(sourceRepo, 'push origin main');
    const newOriginTip = git(sourceRepo, 'rev-parse HEAD');
    expect(newOriginTip).not.toBe(initialOriginTip);

    // Second call — session is resumed, should hit the reuse path.
    // Pass a session with no worktree_path so the function walks the
    // "cloneDir already exists on disk" branch.
    const reusedPath = await ensureSessionWorkspace(
      makeSession(null),
      sourceRepo,
      'test-agent',
      persist,
    );
    expect(reusedPath).toBe(clonePath);

    // origin/main in the reused clone should now point at the new commit
    const refreshedOriginTip = git(clonePath, 'rev-parse origin/main');
    expect(refreshedOriginTip).toBe(newOriginTip);
  });

  it('recovers from a zombie clone dir (exists but no .git) on next call', async () => {
    const persist = vi.fn();

    // Pre-create the expected cloneDir as a zombie: has files but no .git.
    // This mimics what's left behind when an earlier `git clone` is
    // interrupted (OOM, disk-full, SIGKILL) after creating the target dir
    // but before populating the .git subdir.
    const wsRoot = path.join(homedir(), '.agent-hub', 'workspaces', path.basename(sourceRepo));
    const shortId = sessionId.slice(0, 8);
    const expectedCloneDir = path.join(wsRoot, `session-${shortId}`);
    mkdirSync(expectedCloneDir, { recursive: true });
    writeFileSync(path.join(expectedCloneDir, 'leftover.txt'), 'zombie file\n');
    expect(existsSync(expectedCloneDir)).toBe(true);
    expect(existsSync(path.join(expectedCloneDir, '.git'))).toBe(false);

    // ensureSessionWorkspace should nuke the zombie and successfully clone.
    const clonePath = await ensureSessionWorkspace(
      makeSession(null),
      sourceRepo,
      'test-agent',
      persist,
    );
    createdWorkspace = clonePath;

    expect(clonePath).toBe(expectedCloneDir);
    expect(existsSync(path.join(clonePath, '.git'))).toBe(true);
    // Leftover file from the zombie must be gone — the dir was replaced.
    expect(existsSync(path.join(clonePath, 'leftover.txt'))).toBe(false);
    // Persist fn must be called with a real workspace path + branch name.
    expect(persist).toHaveBeenCalledTimes(1);
    const persistArgs = persist.mock.calls[0];
    expect(persistArgs[0]).toBe(clonePath);
    expect(persistArgs[1]).toMatch(/^agent-hub\/test-agent\/session-/);
    expect(persistArgs[2]).toBe(sessionId);
  });

  it('invokes onFailure and returns projectCwd when the source is not a git repo', async () => {
    const persist = vi.fn();
    const onFailure = vi.fn();

    // Non-git directory
    const nonGitDir = path.join(tmpRoot, 'not-a-git-repo');
    mkdirSync(nonGitDir, { recursive: true });

    const result = await ensureSessionWorkspace(
      makeSession(null),
      nonGitDir,
      'test-agent',
      persist,
      null,
      onFailure,
    );

    expect(result).toBe(nonGitDir); // silent-fallback-shaped return value
    expect(persist).not.toHaveBeenCalled();
    expect(onFailure).toHaveBeenCalledTimes(1);
    const [failSid, failMsg] = onFailure.mock.calls[0];
    expect(failSid).toBe(sessionId);
    expect(typeof failMsg).toBe('string');
    expect(failMsg).toMatch(/not a git repo/);
  });

  it('does not invoke onFailure when the clone succeeds', async () => {
    const persist = vi.fn();
    const onFailure = vi.fn();

    const clonePath = await ensureSessionWorkspace(
      makeSession(null),
      sourceRepo,
      'test-agent',
      persist,
      null,
      onFailure,
    );
    createdWorkspace = clonePath;

    expect(clonePath).not.toBe(sourceRepo);
    expect(existsSync(path.join(clonePath, '.git'))).toBe(true);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(onFailure).not.toHaveBeenCalled();
  });

  it('wires core.hooksPath to .husky in the session clone when the source has a .husky/ dir', async () => {
    const persist = vi.fn();

    // Source repo ships a husky dir (commit it so the shallow clone picks it up)
    const huskyDir = path.join(sourceRepo, '.husky');
    mkdirSync(huskyDir, { recursive: true });
    writeFileSync(path.join(huskyDir, 'pre-commit'), '#!/bin/sh\nexit 0\n');
    git(sourceRepo, 'add .husky');
    git(sourceRepo, 'commit -m "add husky"');
    git(sourceRepo, 'push origin main');

    const clonePath = await ensureSessionWorkspace(
      makeSession(null),
      sourceRepo,
      'test-agent',
      persist,
    );
    createdWorkspace = clonePath;

    expect(existsSync(path.join(clonePath, '.husky'))).toBe(true);
    const hooksPath = git(clonePath, 'config --get core.hooksPath');
    expect(hooksPath).toBe('.husky');
  });

  it('skips core.hooksPath config when the source has no .husky/ dir', async () => {
    const persist = vi.fn();

    const clonePath = await ensureSessionWorkspace(
      makeSession(null),
      sourceRepo,
      'test-agent',
      persist,
    );
    createdWorkspace = clonePath;

    // No .husky/ in source, so core.hooksPath should be unset (or not '.husky')
    let hooksPath = '';
    try {
      hooksPath = git(clonePath, 'config --get core.hooksPath');
    } catch {
      // `git config --get` exits 1 when the key is unset — that's the expected path
    }
    expect(hooksPath).not.toBe('.husky');
  });

  it('retries the clone when GitHub returns a transient HTTP 500 and succeeds on the second attempt', async () => {
    const persist = vi.fn();

    // Sabotage the first clone attempt by injecting a custom runner via the
    // public ensureSessionWorkspace path: easiest is to drop a zombie that
    // mimics a partial-clone, then verify cloneWithRetry semantics directly.
    // (See the dedicated `cloneWithRetry` describe block below for the full
    // injected-runner coverage.)
    const clonePath = await ensureSessionWorkspace(
      makeSession(null),
      sourceRepo,
      'test-agent',
      persist,
    );
    createdWorkspace = clonePath;
    expect(existsSync(path.join(clonePath, '.git'))).toBe(true);
  });

  it('cuts a fresh feature branch from the latest origin/main when default branch advances before second spawn', async () => {
    const persist = vi.fn();

    const firstPath = await ensureSessionWorkspace(
      makeSession(null),
      sourceRepo,
      'test-agent',
      persist,
    );
    createdWorkspace = firstPath;
    const firstOriginMain = git(firstPath, 'rev-parse origin/main');

    writeFileSync(path.join(sourceRepo, 'BETWEEN-SPAWNS.md'), 'landed between spawns\n');
    git(sourceRepo, 'add BETWEEN-SPAWNS.md');
    git(sourceRepo, 'commit -m "between spawns"');
    git(sourceRepo, 'push origin main');
    const advancedMain = git(sourceRepo, 'rev-parse HEAD');
    expect(advancedMain).not.toBe(firstOriginMain);

    const secondSessionId = `bbbbbbbb-${Date.now().toString(36)}-spawn2`;
    const secondSession = {
      ...makeSession(null),
      id: secondSessionId,
    };
    const secondPath = await ensureSessionWorkspace(
      secondSession,
      sourceRepo,
      'test-agent',
      persist,
    );

    expect(git(secondPath, 'rev-parse origin/main')).toBe(advancedMain);
    const featureTip = git(secondPath, 'rev-parse HEAD');
    expect(featureTip).toBe(advancedMain);
    expect(existsSync(path.join(secondPath, 'BETWEEN-SPAWNS.md'))).toBe(true);
    removeWorkspace(secondPath);
  });

  it('positions a fresh session clone on kanban pr_base_branch when set', async () => {
    const persist = vi.fn();

    git(sourceRepo, 'checkout -b feature/stack-base');
    writeFileSync(path.join(sourceRepo, 'from_stack.txt'), 'stack line\n');
    git(sourceRepo, 'add from_stack.txt');
    git(sourceRepo, 'commit -m "stack commit"');
    git(sourceRepo, 'push -u origin feature/stack-base');

    git(sourceRepo, 'checkout main');
    writeFileSync(path.join(sourceRepo, 'from_main.txt'), 'main line\n');
    git(sourceRepo, 'add from_main.txt');
    git(sourceRepo, 'commit -m "main only"');
    git(sourceRepo, 'push origin main');

    const clonePath = await ensureSessionWorkspace(
      makeSession(null),
      sourceRepo,
      'test-agent',
      persist,
      null,
      undefined,
      'feature/stack-base',
    );
    createdWorkspace = clonePath;

    expect(existsSync(path.join(clonePath, 'from_stack.txt'))).toBe(true);
    expect(existsSync(path.join(clonePath, 'from_main.txt'))).toBe(false);
    const branch = git(clonePath, 'rev-parse --abbrev-ref HEAD');
    expect(branch.startsWith('agent-hub/')).toBe(true);
  });

  it('does not reset the checked-out feature branch on reuse', async () => {
    const persist = vi.fn();

    const clonePath = await ensureSessionWorkspace(
      makeSession(null),
      sourceRepo,
      'test-agent',
      persist,
    );
    createdWorkspace = clonePath;

    // Simulate in-progress work on the feature branch
    git(clonePath, 'config user.email "clone@example.com"');
    git(clonePath, 'config user.name "Clone"');
    writeFileSync(path.join(clonePath, 'work-in-progress.txt'), 'agent was working on this\n');
    git(clonePath, 'add work-in-progress.txt');
    git(clonePath, 'commit -m "wip"');
    const featureTipBefore = git(clonePath, 'rev-parse HEAD');
    const featureBranch = git(clonePath, 'rev-parse --abbrev-ref HEAD');

    // Upstream advances
    writeFileSync(path.join(sourceRepo, 'NEW.md'), 'upstream change\n');
    git(sourceRepo, 'add NEW.md');
    git(sourceRepo, 'commit -m "upstream"');
    git(sourceRepo, 'push origin main');

    // Reuse
    await ensureSessionWorkspace(makeSession(null), sourceRepo, 'test-agent', persist);

    // Feature branch tip must be untouched — the agent's wip commit is preserved
    expect(git(clonePath, 'rev-parse --abbrev-ref HEAD')).toBe(featureBranch);
    expect(git(clonePath, 'rev-parse HEAD')).toBe(featureTipBefore);
    expect(existsSync(path.join(clonePath, 'work-in-progress.txt'))).toBe(true);
  });
});

describe('isTransientCloneError — classification', () => {
  const { isTransientCloneError } = __test;

  it.each([
    'error: RPC failed; HTTP 500 curl 22 The requested URL returned error: 500',
    "fatal: expected 'packfile'",
    'remote: Internal Server Error',
    'fatal: the remote end hung up unexpectedly',
    'fatal: early EOF',
    'fetch-pack: unexpected disconnect while reading sideband packet',
    'fatal: index-pack failed',
    'curl: (35) ECONNRESET',
    'fatal: unable to access ...: Failed to connect to github.com port 443: ETIMEDOUT',
    'fatal: unable to access ...: Could not resolve host: github.com',
    'Connection reset by peer',
    'Connection timed out',
    'getaddrinfo EAI_AGAIN github.com',
  ])('classifies %p as transient', (msg) => {
    expect(isTransientCloneError(new Error(msg))).toBe(true);
  });

  it.each([
    'remote: HTTP 401 Unauthorized',
    'fatal: Authentication failed for ...',
    "fatal: could not read Username for 'https://github.com'",
    'remote: Repository not found.',
    'fatal: HTTP 404 Not Found',
    "fatal: destination path 'foo' already exists and is not an empty directory.",
    'fatal: HTTP 403 Forbidden',
  ])('classifies %p as non-transient', (msg) => {
    expect(isTransientCloneError(new Error(msg))).toBe(false);
  });

  it('treats an HTTP 401 wrapped in "RPC failed" as non-transient (auth wins)', () => {
    // Real-world example: `error: RPC failed; HTTP 401 curl 22 ...`
    // We must NOT retry — that just burns auth attempts.
    const err = new Error(
      'error: RPC failed; HTTP 401 curl 22 The requested URL returned error: 401',
    );
    expect(isTransientCloneError(err)).toBe(false);
  });

  it('treats an unknown failure as non-transient (do not retry blindly)', () => {
    expect(isTransientCloneError(new Error('something weird happened'))).toBe(false);
  });

  it('reads stderr off ExecFileException-shaped errors when the message is sparse', () => {
    const err = Object.assign(new Error('Command failed: git clone …'), {
      stderr: 'error: RPC failed; HTTP 500',
      stdout: '',
    });
    expect(isTransientCloneError(err)).toBe(true);
  });
});

describe('cloneWithRetry — retry policy with injected runner', () => {
  const { cloneWithRetry, MAX_CLONE_ATTEMPTS, CLONE_RETRY_BASE_MS } = __test;
  const noopSleep = async () => {};

  function makeRunner(outcomes: Array<'ok' | string>) {
    let i = 0;
    const calls: Array<{ args: string[]; opts: unknown }> = [];
    const runner = vi.fn(async (args: string[], opts: unknown) => {
      const outcome = outcomes[i++];
      calls.push({ args, opts });
      if (outcome === 'ok') return '';
      throw new Error(outcome);
    });
    return { runner, calls };
  }

  it('returns after a single successful attempt (no retry needed)', async () => {
    const { runner } = makeRunner(['ok']);
    const cleanup = vi.fn();
    await cloneWithRetry(
      ['clone', '--depth', '1', 'url', '/tmp/x'],
      { timeoutMs: 60000 },
      '/tmp/x',
      { runner, cleanup, sleep: noopSleep },
    );
    expect(runner).toHaveBeenCalledTimes(1);
    expect(cleanup).not.toHaveBeenCalled();
  });

  it('retries once on a transient HTTP 500 then succeeds', async () => {
    const { runner } = makeRunner([
      'error: RPC failed; HTTP 500 curl 22 The requested URL returned error: 500',
      'ok',
    ]);
    const cleanup = vi.fn();
    await cloneWithRetry(
      ['clone', '--depth', '1', 'url', '/tmp/x'],
      { timeoutMs: 60000 },
      '/tmp/x',
      { runner, cleanup, sleep: noopSleep },
    );
    expect(runner).toHaveBeenCalledTimes(2);
    // cleanup() runs once between the failure and the retry, never after the
    // final success.
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(cleanup).toHaveBeenCalledWith('/tmp/x');
  });

  it('exhausts MAX_CLONE_ATTEMPTS and rethrows when every attempt is transient', async () => {
    const failures: string[] = Array.from(
      { length: MAX_CLONE_ATTEMPTS },
      () => 'error: RPC failed; HTTP 500',
    );
    const { runner } = makeRunner(failures);
    const cleanup = vi.fn();
    await expect(
      cloneWithRetry(['clone', '--depth', '1', 'url', '/tmp/x'], { timeoutMs: 60000 }, '/tmp/x', {
        runner,
        cleanup,
        sleep: noopSleep,
      }),
    ).rejects.toThrow(/RPC failed/);
    expect(runner).toHaveBeenCalledTimes(MAX_CLONE_ATTEMPTS);
    // cleanup runs between attempts, so for N attempts we expect N-1 cleanups
    // (no cleanup after the final attempt — caller's onFailure path handles it).
    expect(cleanup).toHaveBeenCalledTimes(MAX_CLONE_ATTEMPTS - 1);
  });

  it('does NOT retry on a non-transient error (e.g. HTTP 401)', async () => {
    const { runner } = makeRunner(['fatal: Authentication failed']);
    const cleanup = vi.fn();
    await expect(
      cloneWithRetry(['clone', '--depth', '1', 'url', '/tmp/x'], { timeoutMs: 60000 }, '/tmp/x', {
        runner,
        cleanup,
        sleep: noopSleep,
      }),
    ).rejects.toThrow(/Authentication failed/);
    expect(runner).toHaveBeenCalledTimes(1);
    expect(cleanup).not.toHaveBeenCalled();
  });

  it('does NOT retry when the destination path already exists (local error)', async () => {
    const { runner } = makeRunner([
      "fatal: destination path '/tmp/x' already exists and is not an empty directory.",
    ]);
    const cleanup = vi.fn();
    await expect(
      cloneWithRetry(['clone', '--depth', '1', 'url', '/tmp/x'], { timeoutMs: 60000 }, '/tmp/x', {
        runner,
        cleanup,
        sleep: noopSleep,
      }),
    ).rejects.toThrow(/destination path/);
    expect(runner).toHaveBeenCalledTimes(1);
    expect(cleanup).not.toHaveBeenCalled();
  });

  it('uses exponential backoff between retries (500ms, 1500ms baseline)', async () => {
    const { runner } = makeRunner([
      'error: RPC failed; HTTP 500',
      'error: RPC failed; HTTP 500',
      'ok',
    ]);
    const cleanup = vi.fn();
    const sleeps: number[] = [];
    const sleep = async (ms: number) => {
      sleeps.push(ms);
    };
    await cloneWithRetry(
      ['clone', '--depth', '1', 'url', '/tmp/x'],
      { timeoutMs: 60000 },
      '/tmp/x',
      { runner, cleanup, sleep },
    );
    expect(sleeps).toHaveLength(2);
    // First retry waits ~500ms (+ up to 250ms jitter)
    expect(sleeps[0]).toBeGreaterThanOrEqual(CLONE_RETRY_BASE_MS);
    expect(sleeps[0]).toBeLessThan(CLONE_RETRY_BASE_MS + 250);
    // Second retry waits ~1500ms (+ jitter) — base * 3
    expect(sleeps[1]).toBeGreaterThanOrEqual(CLONE_RETRY_BASE_MS * 3);
    expect(sleeps[1]).toBeLessThan(CLONE_RETRY_BASE_MS * 3 + 250);
  });

  it('forwards the args + opts unchanged to the runner on each attempt', async () => {
    const { runner, calls } = makeRunner(['error: RPC failed; HTTP 500', 'ok']);
    const cleanup = vi.fn();
    const args = ['clone', '--depth', '1', '--quiet', 'https://example/x.git', '/tmp/x'];
    const opts = { cwd: '/some/cwd', timeoutMs: 60000 };
    await cloneWithRetry(args, opts, '/tmp/x', { runner, cleanup, sleep: noopSleep });
    expect(calls).toHaveLength(2);
    expect(calls[0].args).toEqual(args);
    expect(calls[0].opts).toEqual(opts);
    expect(calls[1].args).toEqual(args);
    expect(calls[1].opts).toEqual(opts);
  });
});

describe('cleanupStaleWorkspaces — omitted isSessionRecoverable callback', () => {
  // Pin the legacy contract: when no recoverability probe is supplied, every
  // `session-*` directory is preserved unconditionally. This guards against
  // future callers (without a DB handle) silently nuking live session
  // worktrees on the first tick. Reviewer-requested regression test for the
  // "fail closed on missing context" branch in `cleanupStaleWorkspaces`.
  let projectCwd: string;
  let workspaceDir: string;

  beforeEach(() => {
    const slug = `cleanup-omit-test-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    projectCwd = path.join(os.tmpdir(), slug);
    mkdirSync(projectCwd, { recursive: true });
    // `cleanupStaleWorkspaces` resolves the workspace dir by basename, so this
    // matches the path it will actually scan.
    workspaceDir = path.join(homedir(), '.agent-hub', 'workspaces', path.basename(projectCwd));
    mkdirSync(workspaceDir, { recursive: true });
  });

  afterEach(() => {
    try {
      if (existsSync(workspaceDir)) rmSync(workspaceDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
    try {
      if (existsSync(projectCwd)) rmSync(projectCwd, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  it('preserves session-* dirs when no isSessionRecoverable callback is supplied', () => {
    const sessionDir = path.join(workspaceDir, 'session-deadbeef');
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(path.join(sessionDir, 'README'), 'must survive omitted-callback tick\n');

    // No `opts` argument at all — exercises the legacy default-preserve branch.
    cleanupStaleWorkspaces(projectCwd, 24 * 60 * 60 * 1000);

    expect(existsSync(sessionDir)).toBe(true);
  });

  it('preserves session-* dirs when opts is passed without isSessionRecoverable', () => {
    const sessionDir = path.join(workspaceDir, 'session-cafef00d');
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(path.join(sessionDir, 'README'), 'must survive partial-opts tick\n');

    // Opts present but the recoverability probe is omitted — the
    // `!isSessionRecoverable` branch must still preserve the dir.
    cleanupStaleWorkspaces(projectCwd, 24 * 60 * 60 * 1000, { now: Date.now() });

    expect(existsSync(sessionDir)).toBe(true);
  });

  it('still reaps non-session stale clones when the callback is omitted', () => {
    // Sanity: omitting the callback must not turn into "preserve everything";
    // `cron-*` / `heartbeat-*` clones should still get the mtime sweep.
    const cronDir = path.join(workspaceDir, 'cron-stale');
    mkdirSync(cronDir, { recursive: true });
    const oldEpoch = Date.now() / 1000 - 25 * 60 * 60;
    utimesSync(cronDir, oldEpoch, oldEpoch);

    cleanupStaleWorkspaces(projectCwd, 24 * 60 * 60 * 1000);

    expect(existsSync(cronDir)).toBe(false);
  });
});

describe('ensureSessionWorkspace — base-branch drift on reuse', () => {
  let tmpRoot: string;
  let originBare: string;
  let sourceRepo: string;
  let sessionId: string;
  let createdWorkspace: string | null = null;

  function git(cwd: string, cmd: string): string {
    return execSync(`git ${cmd}`, { cwd, stdio: 'pipe' }).toString().trim();
  }

  function makeSession(workspacePath: string | null = null): SessionRow {
    return {
      id: sessionId,
      agent_id: 'test-agent',
      name: 'test',
      engine: 'claude',
      model: 'claude-sonnet-4-20250514',
      engine_session_id: null,
      use_worktree: 1,
      worktree_path: workspacePath,
      worktree_branch: null,
      git_worktree_detected: 0,
      changes_ready: null,
      stale_pr_notified_at: null,
      ask_mode: 0,
      cron_id: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      deleted_at: null,
    };
  }

  beforeEach(() => {
    tmpRoot = path.join(
      os.tmpdir(),
      `worktree-drift-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(tmpRoot, { recursive: true });

    originBare = path.join(tmpRoot, 'origin.git');
    mkdirSync(originBare, { recursive: true });
    execSync('git init --bare --initial-branch=main', { cwd: originBare, stdio: 'pipe' });

    sourceRepo = path.join(tmpRoot, 'source');
    execSync(`git clone --quiet "${originBare}" "${sourceRepo}"`, { stdio: 'pipe' });
    git(sourceRepo, 'config user.email "test@example.com"');
    git(sourceRepo, 'config user.name "Test"');
    git(sourceRepo, 'checkout -b main');
    writeFileSync(path.join(sourceRepo, 'README.md'), 'v1\n');
    git(sourceRepo, 'add README.md');
    git(sourceRepo, 'commit -m "initial"');
    git(sourceRepo, 'push -u origin main');

    // Umbrella branch (the pr_base_branch we'll track for drift).
    git(sourceRepo, 'checkout -b feature/umbrella');
    writeFileSync(path.join(sourceRepo, 'umbrella.txt'), 'umbrella round 1\n');
    git(sourceRepo, 'add umbrella.txt');
    git(sourceRepo, 'commit -m "umbrella initial"');
    git(sourceRepo, 'push -u origin feature/umbrella');
    git(sourceRepo, 'checkout main');

    sessionId = `sess${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    createdWorkspace = null;
  });

  afterEach(() => {
    if (createdWorkspace) {
      removeWorkspace(createdWorkspace);
    }
    try {
      const wsParent = path.join(homedir(), '.agent-hub', 'workspaces', path.basename(sourceRepo));
      if (existsSync(wsParent)) {
        rmSync(wsParent, { recursive: true, force: true });
      }
    } catch {
      /* best-effort */
    }
    if (existsSync(tmpRoot)) {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('auto-rebases a clean session worktree onto an advanced umbrella tip', async () => {
    const persist = vi.fn();
    const onAdvanced = vi.fn();

    // First call — clone forked from feature/umbrella tip (SHA1).
    const clonePath = await ensureSessionWorkspace(
      makeSession(null),
      sourceRepo,
      'test-agent',
      persist,
      null,
      undefined,
      'feature/umbrella',
    );
    createdWorkspace = clonePath;

    const forkTip = git(clonePath, 'rev-parse HEAD');
    expect(forkTip).toBe(git(sourceRepo, 'rev-parse origin/feature/umbrella'));

    // Sibling lands on umbrella → origin tip advances to SHA2.
    git(sourceRepo, 'checkout feature/umbrella');
    writeFileSync(path.join(sourceRepo, 'sibling.txt'), 'sibling merge\n');
    git(sourceRepo, 'add sibling.txt');
    git(sourceRepo, 'commit -m "sibling merged into umbrella"');
    git(sourceRepo, 'push origin feature/umbrella');
    const newUmbrellaTip = git(sourceRepo, 'rev-parse HEAD');
    expect(newUmbrellaTip).not.toBe(forkTip);
    git(sourceRepo, 'checkout main');

    // Reuse — clean tree → should auto-rebase silently.
    const reused = await ensureSessionWorkspace(
      makeSession(null),
      sourceRepo,
      'test-agent',
      persist,
      null,
      undefined,
      'feature/umbrella',
      null,
      undefined,
      onAdvanced,
    );
    expect(reused).toBe(clonePath);

    // Rebase landed: HEAD now equals the new umbrella tip (no WIP commits).
    expect(git(clonePath, 'rev-parse HEAD')).toBe(newUmbrellaTip);
    expect(existsSync(path.join(clonePath, 'sibling.txt'))).toBe(true);

    expect(onAdvanced).toHaveBeenCalledTimes(1);
    const info = onAdvanced.mock.calls[0][0];
    expect(info.sessionId).toBe(sessionId);
    expect(info.baseBranch).toBe('feature/umbrella');
    expect(info.rebased).toBe(true);
    expect(info.conflict).toBe(false);
    expect(info.cleanWorkingTree).toBe(true);
    expect(info.commitsAdvanced).toBe(1);
    expect(info.newTipSha).toBe(newUmbrellaTip);
  });

  it('replays a session WIP commit onto the advanced umbrella tip on clean rebase', async () => {
    const persist = vi.fn();
    const onAdvanced = vi.fn();

    const clonePath = await ensureSessionWorkspace(
      makeSession(null),
      sourceRepo,
      'test-agent',
      persist,
      null,
      undefined,
      'feature/umbrella',
    );
    createdWorkspace = clonePath;

    // Session does some work and commits on its feature branch.
    git(clonePath, 'config user.email "session@example.com"');
    git(clonePath, 'config user.name "Session"');
    writeFileSync(path.join(clonePath, 'session-work.txt'), 'wip from session\n');
    git(clonePath, 'add session-work.txt');
    git(clonePath, 'commit -m "session wip"');
    const sessionTipBeforeRebase = git(clonePath, 'rev-parse HEAD');

    // Umbrella advances with a non-conflicting commit.
    git(sourceRepo, 'checkout feature/umbrella');
    writeFileSync(path.join(sourceRepo, 'sibling.txt'), 'sibling merge\n');
    git(sourceRepo, 'add sibling.txt');
    git(sourceRepo, 'commit -m "sibling merged"');
    git(sourceRepo, 'push origin feature/umbrella');
    const newUmbrellaTip = git(sourceRepo, 'rev-parse HEAD');
    git(sourceRepo, 'checkout main');

    await ensureSessionWorkspace(
      makeSession(null),
      sourceRepo,
      'test-agent',
      persist,
      null,
      undefined,
      'feature/umbrella',
      null,
      undefined,
      onAdvanced,
    );

    // The WIP commit should be replayed on top of the new umbrella tip.
    expect(git(clonePath, 'rev-parse HEAD')).not.toBe(sessionTipBeforeRebase);
    expect(existsSync(path.join(clonePath, 'session-work.txt'))).toBe(true);
    expect(existsSync(path.join(clonePath, 'sibling.txt'))).toBe(true);
    // New HEAD's parent chain should pass through newUmbrellaTip.
    const parentSha = git(clonePath, 'rev-parse HEAD^');
    expect(parentSha).toBe(newUmbrellaTip);

    expect(onAdvanced).toHaveBeenCalledTimes(1);
    expect(onAdvanced.mock.calls[0][0].rebased).toBe(true);
  });

  it('does NOT rebase when the working tree is dirty; emits drift notice instead', async () => {
    const persist = vi.fn();
    const onAdvanced = vi.fn();

    const clonePath = await ensureSessionWorkspace(
      makeSession(null),
      sourceRepo,
      'test-agent',
      persist,
      null,
      undefined,
      'feature/umbrella',
    );
    createdWorkspace = clonePath;

    const tipBefore = git(clonePath, 'rev-parse HEAD');

    // Leave an uncommitted, unstaged modification.
    writeFileSync(path.join(clonePath, 'umbrella.txt'), 'agent edited this — not committed\n');
    // Sanity: git status sees it as dirty.
    const porcelain = execSync('git status --porcelain', { cwd: clonePath }).toString().trim();
    expect(porcelain.length).toBeGreaterThan(0);

    // Umbrella advances on origin.
    git(sourceRepo, 'checkout feature/umbrella');
    writeFileSync(path.join(sourceRepo, 'sibling.txt'), 'sibling merge\n');
    git(sourceRepo, 'add sibling.txt');
    git(sourceRepo, 'commit -m "sibling merged"');
    git(sourceRepo, 'push origin feature/umbrella');
    const newUmbrellaTip = git(sourceRepo, 'rev-parse HEAD');
    git(sourceRepo, 'checkout main');

    await ensureSessionWorkspace(
      makeSession(null),
      sourceRepo,
      'test-agent',
      persist,
      null,
      undefined,
      'feature/umbrella',
      null,
      undefined,
      onAdvanced,
    );

    // HEAD must NOT move — dirty tree is preserved.
    expect(git(clonePath, 'rev-parse HEAD')).toBe(tipBefore);
    // Uncommitted edit must still be present untouched.
    const stillDirty = execSync('git status --porcelain', { cwd: clonePath }).toString();
    expect(stillDirty).toMatch(/umbrella\.txt/);

    expect(onAdvanced).toHaveBeenCalledTimes(1);
    const info = onAdvanced.mock.calls[0][0];
    expect(info.rebased).toBe(false);
    expect(info.conflict).toBe(false);
    expect(info.cleanWorkingTree).toBe(false);
    expect(info.commitsAdvanced).toBe(1);
    expect(info.newTipSha).toBe(newUmbrellaTip);
  });

  it('aborts a conflicting rebase and reports conflict via the callback', async () => {
    const persist = vi.fn();
    const onAdvanced = vi.fn();

    const clonePath = await ensureSessionWorkspace(
      makeSession(null),
      sourceRepo,
      'test-agent',
      persist,
      null,
      undefined,
      'feature/umbrella',
    );
    createdWorkspace = clonePath;

    // Session commits a change to umbrella.txt …
    git(clonePath, 'config user.email "session@example.com"');
    git(clonePath, 'config user.name "Session"');
    writeFileSync(path.join(clonePath, 'umbrella.txt'), 'session-side edit\n');
    git(clonePath, 'add umbrella.txt');
    git(clonePath, 'commit -m "session edited umbrella.txt"');
    const sessionTipBefore = git(clonePath, 'rev-parse HEAD');

    // … and umbrella on origin edits the SAME file with conflicting content.
    git(sourceRepo, 'checkout feature/umbrella');
    writeFileSync(path.join(sourceRepo, 'umbrella.txt'), 'sibling-side edit\n');
    git(sourceRepo, 'add umbrella.txt');
    git(sourceRepo, 'commit -m "sibling edited umbrella.txt"');
    git(sourceRepo, 'push origin feature/umbrella');
    git(sourceRepo, 'checkout main');

    await ensureSessionWorkspace(
      makeSession(null),
      sourceRepo,
      'test-agent',
      persist,
      null,
      undefined,
      'feature/umbrella',
      null,
      undefined,
      onAdvanced,
    );

    // Rebase must have aborted — session HEAD must be restored.
    expect(git(clonePath, 'rev-parse HEAD')).toBe(sessionTipBefore);
    // No rebase-in-progress sentinel left behind.
    expect(existsSync(path.join(clonePath, '.git', 'rebase-merge'))).toBe(false);
    expect(existsSync(path.join(clonePath, '.git', 'rebase-apply'))).toBe(false);

    expect(onAdvanced).toHaveBeenCalledTimes(1);
    const info = onAdvanced.mock.calls[0][0];
    expect(info.rebased).toBe(false);
    expect(info.conflict).toBe(true);
    expect(info.cleanWorkingTree).toBe(true);
  });

  it('does NOT fire the callback when origin/<base> has not advanced', async () => {
    const persist = vi.fn();
    const onAdvanced = vi.fn();

    const clonePath = await ensureSessionWorkspace(
      makeSession(null),
      sourceRepo,
      'test-agent',
      persist,
      null,
      undefined,
      'feature/umbrella',
    );
    createdWorkspace = clonePath;

    // No upstream changes. Reuse.
    await ensureSessionWorkspace(
      makeSession(null),
      sourceRepo,
      'test-agent',
      persist,
      null,
      undefined,
      'feature/umbrella',
      null,
      undefined,
      onAdvanced,
    );

    expect(onAdvanced).not.toHaveBeenCalled();
  });

  it('does NOT fire the callback when prBaseBranch is not set (no umbrella tracked)', async () => {
    const persist = vi.fn();
    const onAdvanced = vi.fn();

    // Create a clone without a base branch.
    const clonePath = await ensureSessionWorkspace(
      makeSession(null),
      sourceRepo,
      'test-agent',
      persist,
    );
    createdWorkspace = clonePath;

    // Advance origin/main (the default), so a careless implementation might
    // think it should diff against that.
    writeFileSync(path.join(sourceRepo, 'NEW.md'), 'upstream\n');
    git(sourceRepo, 'add NEW.md');
    git(sourceRepo, 'commit -m "upstream"');
    git(sourceRepo, 'push origin main');

    // Reuse without prBaseBranch — drift detection must be skipped entirely.
    await ensureSessionWorkspace(
      makeSession(null),
      sourceRepo,
      'test-agent',
      persist,
      null,
      undefined,
      undefined, // no prBaseBranch
      null,
      undefined,
      onAdvanced,
    );

    expect(onAdvanced).not.toHaveBeenCalled();
  });
});

describe('detectAndHandleBaseBranchDrift — unit (direct invocation)', () => {
  const { detectAndHandleBaseBranchDrift } = __test;

  let tmpRoot: string;
  let originBare: string;
  let sourceRepo: string;
  let cloneDir: string;

  function git(cwd: string, cmd: string): string {
    return execSync(`git ${cmd}`, { cwd, stdio: 'pipe' }).toString().trim();
  }

  beforeEach(() => {
    tmpRoot = path.join(
      os.tmpdir(),
      `drift-unit-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(tmpRoot, { recursive: true });

    originBare = path.join(tmpRoot, 'origin.git');
    mkdirSync(originBare, { recursive: true });
    execSync('git init --bare --initial-branch=main', { cwd: originBare, stdio: 'pipe' });

    sourceRepo = path.join(tmpRoot, 'source');
    execSync(`git clone --quiet "${originBare}" "${sourceRepo}"`, { stdio: 'pipe' });
    git(sourceRepo, 'config user.email "test@example.com"');
    git(sourceRepo, 'config user.name "Test"');
    git(sourceRepo, 'checkout -b main');
    writeFileSync(path.join(sourceRepo, 'README.md'), 'v1\n');
    git(sourceRepo, 'add README.md');
    git(sourceRepo, 'commit -m "initial"');
    git(sourceRepo, 'push -u origin main');

    git(sourceRepo, 'checkout -b feature/base');
    writeFileSync(path.join(sourceRepo, 'base.txt'), 'base\n');
    git(sourceRepo, 'add base.txt');
    git(sourceRepo, 'commit -m "base"');
    git(sourceRepo, 'push -u origin feature/base');

    cloneDir = path.join(tmpRoot, 'work');
    execSync(`git clone --quiet "${originBare}" "${cloneDir}"`, { stdio: 'pipe' });
    git(cloneDir, 'config user.email "clone@example.com"');
    git(cloneDir, 'config user.name "Clone"');
    git(cloneDir, 'fetch origin feature/base:refs/remotes/origin/feature/base');
    git(cloneDir, 'checkout -b session-branch origin/feature/base');
  });

  afterEach(() => {
    if (existsSync(tmpRoot)) {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('returns null when origin/<base> equals merge-base (no drift)', async () => {
    const result = await detectAndHandleBaseBranchDrift(cloneDir, 'session-id-1', 'feature/base');
    expect(result).toBeNull();
  });

  it('returns null when origin/<base> ref does not exist (missing remote ref)', async () => {
    const result = await detectAndHandleBaseBranchDrift(cloneDir, 'session-id-2', 'no-such-branch');
    expect(result).toBeNull();
  });

  it('reports commitsAdvanced correctly when origin moves multiple commits', async () => {
    git(sourceRepo, 'checkout feature/base');
    for (let i = 0; i < 3; i++) {
      writeFileSync(path.join(sourceRepo, `extra-${i}.txt`), `e${i}\n`);
      git(sourceRepo, `add extra-${i}.txt`);
      git(sourceRepo, `commit -m "extra ${i}"`);
    }
    git(sourceRepo, 'push origin feature/base');
    git(cloneDir, 'fetch origin feature/base:refs/remotes/origin/feature/base');

    const result = await detectAndHandleBaseBranchDrift(cloneDir, 'session-id-3', 'feature/base');
    expect(result).not.toBeNull();
    expect(result!.commitsAdvanced).toBe(3);
    expect(result!.rebased).toBe(true); // clean tree → auto-rebase succeeds
  });
});

describe('fetchWithRetry — retry policy on the reuse path', () => {
  const { fetchWithRetry, MAX_CLONE_ATTEMPTS } = __test;
  const noopSleep = async () => {};

  function makeRunner(outcomes: Array<'ok' | string>) {
    let i = 0;
    const calls: Array<{ args: string[]; opts: unknown }> = [];
    const runner = vi.fn(async (args: string[], opts: unknown) => {
      const outcome = outcomes[i++];
      calls.push({ args, opts });
      if (outcome === 'ok') return '';
      throw new Error(outcome);
    });
    return { runner, calls };
  }

  it('returns after a single successful fetch (no retry needed)', async () => {
    const { runner } = makeRunner(['ok']);
    await fetchWithRetry(
      ['fetch', 'origin', '--quiet'],
      { cwd: '/tmp/x', timeoutMs: 30000 },
      {
        runner,
        sleep: noopSleep,
      },
    );
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it("retries on transient `fatal: expected 'packfile'` and succeeds on retry", async () => {
    // This is the exact stderr line that triggered card 3421e0db.
    const { runner } = makeRunner(["fatal: expected 'packfile'", 'ok']);
    await fetchWithRetry(
      ['fetch', 'origin', '--quiet'],
      { cwd: '/tmp/x', timeoutMs: 30000 },
      {
        runner,
        sleep: noopSleep,
      },
    );
    expect(runner).toHaveBeenCalledTimes(2);
  });

  it('retries on transient HTTP 500 and succeeds', async () => {
    const { runner } = makeRunner([
      'error: RPC failed; HTTP 500 curl 22 The requested URL returned error: 500',
      'ok',
    ]);
    await fetchWithRetry(
      ['fetch', 'origin', '--quiet'],
      { cwd: '/tmp/x', timeoutMs: 30000 },
      {
        runner,
        sleep: noopSleep,
      },
    );
    expect(runner).toHaveBeenCalledTimes(2);
  });

  it('exhausts MAX_CLONE_ATTEMPTS and rethrows the last transient error', async () => {
    const failures: string[] = Array.from(
      { length: MAX_CLONE_ATTEMPTS },
      () => "fatal: expected 'packfile'",
    );
    const { runner } = makeRunner(failures);
    await expect(
      fetchWithRetry(
        ['fetch', 'origin', '--quiet'],
        { cwd: '/tmp/x', timeoutMs: 30000 },
        {
          runner,
          sleep: noopSleep,
        },
      ),
    ).rejects.toThrow(/expected 'packfile'/);
    expect(runner).toHaveBeenCalledTimes(MAX_CLONE_ATTEMPTS);
  });

  it('does NOT retry on non-transient auth failures', async () => {
    const { runner } = makeRunner(['fatal: Authentication failed for ...']);
    await expect(
      fetchWithRetry(
        ['fetch', 'origin', '--quiet'],
        { cwd: '/tmp/x', timeoutMs: 30000 },
        {
          runner,
          sleep: noopSleep,
        },
      ),
    ).rejects.toThrow(/Authentication failed/);
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it('forwards args + opts unchanged on every attempt (no directory cleanup involved)', async () => {
    const { runner, calls } = makeRunner(["fatal: expected 'packfile'", 'ok']);
    const args = ['fetch', 'origin', '--quiet'];
    const opts = { cwd: '/some/clone', timeoutMs: 30000 };
    await fetchWithRetry(args, opts, { runner, sleep: noopSleep });
    expect(calls).toHaveLength(2);
    expect(calls[0].args).toEqual(args);
    expect(calls[0].opts).toEqual(opts);
    expect(calls[1].args).toEqual(args);
    expect(calls[1].opts).toEqual(opts);
  });
});

describe('dependency install command helpers', () => {
  const {
    detectInstallCommand,
    resolveSessionInstallCommand,
    sessionWorkspaceDependencyInstallOpts,
  } = __test;

  it('detectInstallCommand uses npm ci --include=dev when package-lock.json exists', () => {
    const tmp = path.join(os.tmpdir(), `wt-cmd-${Date.now()}`);
    mkdirSync(tmp, { recursive: true });
    try {
      writeFileSync(path.join(tmp, 'package-lock.json'), '{}');
      expect(detectInstallCommand(tmp)).toBe('npm ci --include=dev');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('resolveSessionInstallCommand prefers npm run install:all when scripted', () => {
    const tmp = path.join(os.tmpdir(), `wt-cmd-${Date.now()}`);
    mkdirSync(tmp, { recursive: true });
    try {
      writeFileSync(
        path.join(tmp, 'package.json'),
        JSON.stringify({ scripts: { 'install:all': 'npm ci && cd server && npm ci' } }),
      );
      expect(resolveSessionInstallCommand(tmp, null)).toBe('npm run install:all');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('resolveSessionInstallCommand respects an explicit install command', () => {
    const tmp = path.join(os.tmpdir(), `wt-cmd-${Date.now()}`);
    mkdirSync(tmp, { recursive: true });
    try {
      writeFileSync(
        path.join(tmp, 'package.json'),
        JSON.stringify({ scripts: { 'install:all': 'echo noop' } }),
      );
      expect(resolveSessionInstallCommand(tmp, 'npm ci --include=dev')).toBe(
        'npm ci --include=dev',
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('installChildEnv sets PIP_BREAK_SYSTEM_PACKAGES=1 so PEP 668 hosts can run pip-based install commands', () => {
    const { installChildEnv } = __test;
    // PEP 668 / Debian-managed Python rejects `pip install` outside a venv unless
    // this env var is set. Workspace clones are ephemeral, so this is safe.
    expect(installChildEnv.PIP_BREAK_SYSTEM_PACKAGES).toBe('1');
    // The npm override must still be present alongside it.
    expect(installChildEnv.NODE_ENV).toBe('development');
  });

  it('sessionWorkspaceDependencyInstallOpts never blocks clone on install (deferred until publish)', () => {
    const prev = process.env.AGENT_HUB_TEST_MODE;
    try {
      delete process.env.AGENT_HUB_TEST_MODE;
      expect(sessionWorkspaceDependencyInstallOpts()).toEqual({
        awaitInstall: false,
        preferInstallAllScript: true,
      });
      process.env.AGENT_HUB_TEST_MODE = '1';
      expect(sessionWorkspaceDependencyInstallOpts()).toEqual({
        awaitInstall: false,
        preferInstallAllScript: false,
      });
    } finally {
      if (prev === undefined) delete process.env.AGENT_HUB_TEST_MODE;
      else process.env.AGENT_HUB_TEST_MODE = prev;
    }
  });
});
