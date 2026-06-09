/**
 * Integration tests that exercise computeSessionChanges / computeFileDiff
 * against a REAL temporary git repository (default execFile-based GitExec),
 * not a mocked arg-matcher. This validates the actual git behaviour the
 * arg-matching unit tests can't: real `--no-index` headers for nested and
 * dash-like untracked paths, real numstat counts, exit-code handling, and the
 * committed + uncommitted + untracked merge end to end.
 *
 * `git` is permitted under the no-real-CLI test guard (only claude/cursor/
 * gemini/codex are blocked), so spawning it here is allowed.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import {
  computeSessionChanges,
  computeFileDiff,
  listSessionChangedPaths,
} from './session-changes.js';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_NOSYSTEM: '1',
    },
  }).toString();
}

describe('session-changes (real git)', () => {
  let repo: string;
  // The session "base" — we diff the working tree against this commit. We use
  // the base commit's SHA directly as `baseBranch` (a SHA is a valid ref) so
  // the test never creates/switches branches, which the worktree git shim
  // blocks under the one-branch rule.
  let baseSha: string;

  beforeAll(() => {
    repo = mkdtempSync(path.join(tmpdir(), 'agenthub-sc-'));
    git(repo, ['-c', 'init.defaultBranch=main', 'init']);
    git(repo, ['config', 'user.email', 'test@example.com']);
    git(repo, ['config', 'user.name', 'Test']);
    git(repo, ['config', 'commit.gpgsign', 'false']);

    // Base commit.
    writeFileSync(path.join(repo, 'a.txt'), 'line1\nline2\nline3\n');
    writeFileSync(path.join(repo, 'gone.txt'), 'delete me\n');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-m', 'init']);
    baseSha = git(repo, ['rev-parse', 'HEAD']).trim();

    // A later commit on the same branch (the session's committed work).
    writeFileSync(path.join(repo, 'a.txt'), 'line1\nline2 changed\nline3\nline4\n');
    git(repo, ['rm', '-q', 'gone.txt']);
    git(repo, ['commit', '-am', 'work']);

    // Untracked, nested new text file (the common "agent created a file" case).
    mkdirSync(path.join(repo, 'src'), { recursive: true });
    writeFileSync(path.join(repo, 'src', 'new.ts'), 'export const x = 1;\nexport const y = 2;\n');

    // Untracked file whose name begins with a dash — the brittle case the
    // `--` separator + `./` operand must handle.
    writeFileSync(path.join(repo, '-dash.txt'), 'a\nb\nc\n');
  });

  afterAll(() => {
    if (repo) rmSync(repo, { recursive: true, force: true });
  });

  it('reports committed + deleted + untracked files with real counts', async () => {
    const summary = await computeSessionChanges({ worktreePath: repo, baseBranch: baseSha });

    expect(summary.baseSha).toBeTruthy();
    expect(summary.headSha).toBeTruthy();
    expect(summary.branch).toBe('main');

    const byPath = Object.fromEntries(summary.files.map((f) => [f.path, f]));

    // Committed modification.
    expect(byPath['a.txt']).toMatchObject({ status: 'modified' });
    expect(byPath['a.txt'].additions).toBeGreaterThan(0);

    // Committed deletion.
    expect(byPath['gone.txt']).toMatchObject({ status: 'deleted' });

    // Untracked nested text file: real add count derived via --no-index.
    expect(byPath['src/new.ts']).toMatchObject({
      status: 'added',
      untracked: true,
      binary: false,
      additions: 2,
      deletions: 0,
    });

    // Untracked dash-prefixed file is handled (not mis-parsed as an option).
    expect(byPath['-dash.txt']).toMatchObject({
      status: 'added',
      untracked: true,
      additions: 3,
    });
  });

  it('produces an all-add unified diff for a nested untracked file', async () => {
    const res = await computeFileDiff({
      worktreePath: repo,
      baseBranch: baseSha,
      file: 'src/new.ts',
      untracked: true,
    });
    expect(res.status).toBe('added');
    expect(res.binary).toBe(false);
    expect(res.tooLarge).toBe(false);
    expect(res.unifiedDiff).toContain('+export const x = 1;');
    expect(res.unifiedDiff).toContain('+export const y = 2;');
  });

  it('lists the untruncated membership set with tracked/untracked flags', async () => {
    const membership = await listSessionChangedPaths({ worktreePath: repo, baseBranch: baseSha });
    expect(membership.get('a.txt')).toEqual({ untracked: false });
    expect(membership.get('gone.txt')).toEqual({ untracked: false });
    expect(membership.get('src/new.ts')).toEqual({ untracked: true });
    expect(membership.get('-dash.txt')).toEqual({ untracked: true });
  });

  it('produces a real diff for a tracked modified file', async () => {
    const res = await computeFileDiff({
      worktreePath: repo,
      baseBranch: baseSha,
      file: 'a.txt',
    });
    expect(res.binary).toBe(false);
    expect(res.unifiedDiff).toContain('+line2 changed');
    expect(res.unifiedDiff).toContain('+line4');
  });

  it('throws on a directory that is not a git repository', async () => {
    const notRepo = mkdtempSync(path.join(tmpdir(), 'agenthub-notrepo-'));
    try {
      await expect(
        computeSessionChanges({ worktreePath: notRepo, baseBranch: 'main' }),
      ).rejects.toThrow();
    } finally {
      rmSync(notRepo, { recursive: true, force: true });
    }
  });
});
