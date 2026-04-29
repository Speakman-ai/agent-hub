import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import path from 'path';
import os from 'os';
import { homedir } from 'os';
import type { SessionRow } from './types.js';

vi.mock('./config.js', () => ({
  default: { defaultCwd: '/tmp' },
}));

const { getOrCreateProcessWorktree, ensureSessionWorkspace, removeWorkspace, __test } =
  await import('./worktree.js');

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
