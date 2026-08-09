/**
 * These drive real git against real repositories on purpose.
 *
 * The module's whole job is moving a branch out of a session and back again,
 * and a scripted git double would assert that we typed the commands we meant
 * to type rather than that they do what we think. The microVM hop is the only
 * thing stubbed: `envOwnedOverHostDir` presents a real directory with the
 * sharing mode and null `hostPath` of a guest.
 */
import { execFile } from 'child_process';
import { mkdtemp, readFile, rm, writeFile, mkdir, utimes } from 'fs/promises';
import { existsSync } from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import { afterEach, describe, expect, it } from 'vitest';
import { acquireFinalizeSource, reapFinalizeSourceCheckouts } from './session-source.js';
import { envOwnedOverHostDir, fakeHostSharedIo } from '../test/fake-worktree-io.js';

const execFileAsync = promisify(execFile);

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((fn) => fn().catch(() => {})));
});

async function tmpDir(tag: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), `finalize-src-${tag}-`));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout.trim();
}

/** A repo on `branch` with one commit, plus a bare `origin` it can reach. */
async function makeSessionRepo(branch = 'feature/x'): Promise<{ repo: string; origin: string }> {
  const root = await tmpDir('repo');
  const origin = path.join(root, 'origin.git');
  const repo = path.join(root, 'work');
  await execFileAsync('git', ['init', '--bare', '--initial-branch=main', origin]);
  await execFileAsync('git', ['init', '--initial-branch=main', repo]);
  await git(repo, 'config', 'user.email', 'test@example.com');
  await git(repo, 'config', 'user.name', 'Test');
  await writeFile(path.join(repo, 'README.md'), 'base\n');
  await git(repo, 'add', '.');
  await git(repo, 'commit', '-m', 'base');
  await git(repo, 'remote', 'add', 'origin', origin);
  await git(repo, 'push', '-q', 'origin', 'main');
  await git(repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
  await git(repo, 'checkout', '-q', '-b', branch);
  await writeFile(path.join(repo, 'feature.txt'), 'session work\n');
  await git(repo, 'add', '.');
  await git(repo, 'commit', '-m', 'session work');
  return { repo, origin };
}

describe('acquireFinalizeSource', () => {
  it('hands back the session worktree untouched when the host shares it', async () => {
    const source = await acquireFinalizeSource({
      runId: 'run-1',
      sessionId: 'sess-1',
      worktreePath: '/wt',
      branch: 'feature/x',
      io: fakeHostSharedIo(),
    });
    expect(source.staged).toBe(false);
    expect(source.path).toBe('/wt');
    // Nothing to materialize, so nothing to carry back either.
    await expect(source.syncBack('feature/x')).resolves.toEqual({ synced: true });
    await expect(source.sessionHeadAtMaterialize()).resolves.toBeNull();
  });

  it('materializes the session branch, its history, and its origin', async () => {
    const { repo, origin } = await makeSessionRepo();
    const root = await tmpDir('root');
    const sessionHead = await git(repo, 'rev-parse', 'HEAD');

    const source = await acquireFinalizeSource({
      runId: 'run-2',
      sessionId: 'sess-2',
      worktreePath: repo,
      branch: 'feature/x',
      io: envOwnedOverHostDir(repo),
      root,
    });

    expect(source.staged).toBe(true);
    expect(source.path).toBe(path.join(root, 'run-2'));
    // The commit under test is present and checked out by name — the pipeline
    // pushes the branch, so a detached HEAD would not do.
    expect(await git(source.path, 'rev-parse', 'HEAD')).toBe(sessionHead);
    expect(await git(source.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('feature/x');
    expect(await readFile(path.join(source.path, 'feature.txt'), 'utf8')).toBe('session work\n');
    // Pointed at the real remote, not at the bundle it was cloned from —
    // otherwise the rebase fetches nothing and the push has nowhere to go.
    expect(await git(source.path, 'remote', 'get-url', 'origin')).toBe(origin);
    // Default-branch detection has to survive the hop; a bundle carries no
    // remote HEAD, so a repo whose default is not `main` would be mis-based.
    expect(await git(source.path, 'symbolic-ref', 'refs/remotes/origin/HEAD')).toBe(
      'refs/remotes/origin/main',
    );
    await expect(source.sessionHeadAtMaterialize()).resolves.toBe(sessionHead);
  });

  it('leaves no bundle behind in the session', async () => {
    const { repo } = await makeSessionRepo();
    const root = await tmpDir('root');
    await acquireFinalizeSource({
      runId: 'run-3',
      sessionId: 'sess-3',
      worktreePath: repo,
      branch: 'feature/x',
      io: envOwnedOverHostDir(repo),
      root,
    });
    expect(existsSync(path.join(repo, '.git/agent-hub-finalize-source.bundle'))).toBe(false);
  });

  it('reuses an existing checkout instead of rebuilding over it', async () => {
    // By push time the checkout holds rebased commits that exist nowhere else.
    // Re-materializing from the session would silently replace them with the
    // pre-rebase history and ship code no gate ever looked at.
    const { repo } = await makeSessionRepo();
    const root = await tmpDir('root');
    const args = {
      runId: 'run-4',
      sessionId: 'sess-4',
      worktreePath: repo,
      branch: 'feature/x',
      io: envOwnedOverHostDir(repo),
      root,
    };
    const first = await acquireFinalizeSource(args);
    await writeFile(path.join(first.path, 'rebased.txt'), 'produced by the run\n');
    await git(first.path, 'config', 'user.email', 'test@example.com');
    await git(first.path, 'config', 'user.name', 'Test');
    await git(first.path, 'add', '.');
    await git(first.path, 'commit', '-m', 'rebase result');
    const rebasedHead = await git(first.path, 'rev-parse', 'HEAD');

    const second = await acquireFinalizeSource(args);
    expect(second.path).toBe(first.path);
    expect(await git(second.path, 'rev-parse', 'HEAD')).toBe(rebasedHead);
  });

  it('refresh picks up a commit the session made after the last copy', async () => {
    const { repo } = await makeSessionRepo();
    const root = await tmpDir('root');
    const source = await acquireFinalizeSource({
      runId: 'run-5',
      sessionId: 'sess-5',
      worktreePath: repo,
      branch: 'feature/x',
      io: envOwnedOverHostDir(repo),
      root,
    });

    await writeFile(path.join(repo, 'fix.txt'), 'the fix\n');
    await git(repo, 'add', '.');
    await git(repo, 'commit', '-m', 'fix round');
    const fixedHead = await git(repo, 'rev-parse', 'HEAD');

    await source.refresh();
    expect(await git(source.path, 'rev-parse', 'HEAD')).toBe(fixedHead);
    await expect(source.sessionHeadAtMaterialize()).resolves.toBe(fixedHead);
  });

  it('release removes the checkout', async () => {
    const { repo } = await makeSessionRepo();
    const root = await tmpDir('root');
    const source = await acquireFinalizeSource({
      runId: 'run-6',
      sessionId: 'sess-6',
      worktreePath: repo,
      branch: 'feature/x',
      io: envOwnedOverHostDir(repo),
      root,
    });
    await source.release();
    expect(existsSync(source.path)).toBe(false);
  });
});

describe('syncBack', () => {
  /** Materialize, rewrite history the way a rebase does, and push it. */
  async function runThroughRebaseAndPush(): Promise<{
    repo: string;
    source: Awaited<ReturnType<typeof acquireFinalizeSource>>;
  }> {
    const { repo } = await makeSessionRepo();
    const root = await tmpDir('root');
    const source = await acquireFinalizeSource({
      runId: 'run-sync',
      sessionId: 'sess-sync',
      worktreePath: repo,
      branch: 'feature/x',
      io: envOwnedOverHostDir(repo),
      root,
    });
    await git(source.path, 'config', 'user.email', 'test@example.com');
    await git(source.path, 'config', 'user.name', 'Test');
    // `commit --amend` rewrites the SHA exactly as a rebase does, which is the
    // condition that makes a fast-forward impossible.
    await git(source.path, 'commit', '--amend', '-m', 'session work (rebased)');
    await git(source.path, 'push', '-q', '--force', 'origin', 'feature/x');
    return { repo, source };
  }

  it('moves the session onto the rewritten commits', async () => {
    const { repo, source } = await runThroughRebaseAndPush();
    const pushedHead = await git(source.path, 'rev-parse', 'HEAD');

    await expect(source.syncBack('feature/x')).resolves.toEqual({ synced: true });

    expect(await git(repo, 'rev-parse', 'HEAD')).toBe(pushedHead);
    expect(await git(repo, 'log', '-1', '--format=%s')).toBe('session work (rebased)');
  });

  it('leaves a dirty session alone rather than discarding its edits', async () => {
    const { repo, source } = await runThroughRebaseAndPush();
    const before = await git(repo, 'rev-parse', 'HEAD');
    await writeFile(path.join(repo, 'feature.txt'), 'edited since the run started\n');

    const result = await source.syncBack('feature/x');
    expect(result.synced).toBe(false);
    expect(result.reason).toMatch(/uncommitted/);
    expect(await git(repo, 'rev-parse', 'HEAD')).toBe(before);
    expect(await readFile(path.join(repo, 'feature.txt'), 'utf8')).toBe(
      'edited since the run started\n',
    );
  });

  it('leaves the session alone when it holds a commit the push did not carry', async () => {
    const { repo, source } = await runThroughRebaseAndPush();
    await writeFile(path.join(repo, 'later.txt'), 'committed after the run started\n');
    await git(repo, 'add', '.');
    await git(repo, 'commit', '-m', 'later work');
    const before = await git(repo, 'rev-parse', 'HEAD');

    const result = await source.syncBack('feature/x');
    expect(result.synced).toBe(false);
    expect(result.reason).toMatch(/not part of this push/);
    expect(await git(repo, 'rev-parse', 'HEAD')).toBe(before);
    expect(existsSync(path.join(repo, 'later.txt'))).toBe(true);
  });
});

describe('reapFinalizeSourceCheckouts', () => {
  const OLD = Date.now() - 60 * 60_000;

  async function stagedDir(root: string, runId: string, mtimeMs: number): Promise<string> {
    const dir = path.join(root, runId);
    await mkdir(dir, { recursive: true });
    await utimes(dir, new Date(mtimeMs), new Date(mtimeMs));
    return dir;
  }

  it('keeps a parked run checkout and removes an abandoned one', async () => {
    // A run at ready_to_push has `ended_at` set but still owns the only copy of
    // its rebased commits, so the container reaper's "active" rule would delete
    // exactly the thing push needs.
    const root = await tmpDir('reap');
    const parked = await stagedDir(root, 'parked', OLD);
    const abandoned = await stagedDir(root, 'abandoned', OLD);

    const reaped = await reapFinalizeSourceCheckouts({
      retainRunIds: () => new Set(['parked']),
      root,
      logger: { warn: () => {} },
    });

    expect(reaped).toEqual(['abandoned']);
    expect(existsSync(parked)).toBe(true);
    expect(existsSync(abandoned)).toBe(false);
  });

  it('spares a checkout younger than the grace window', async () => {
    // Guards the race where a checkout is created a tick before its run row is
    // observable.
    const root = await tmpDir('reap');
    const fresh = await stagedDir(root, 'fresh', Date.now());

    const reaped = await reapFinalizeSourceCheckouts({
      retainRunIds: () => new Set(),
      root,
      logger: { warn: () => {} },
    });

    expect(reaped).toEqual([]);
    expect(existsSync(fresh)).toBe(true);
  });

  it('is a no-op when nothing was ever staged on this host', async () => {
    await expect(
      reapFinalizeSourceCheckouts({
        retainRunIds: () => new Set(),
        root: path.join(os.tmpdir(), 'finalize-source-does-not-exist'),
        logger: { warn: () => {} },
      }),
    ).resolves.toEqual([]);
  });
});
