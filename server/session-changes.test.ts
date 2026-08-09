import { describe, it, expect, vi } from 'vitest';
import {
  computeSessionChanges,
  computeFileDiff,
  listSessionChangedPaths,
  resolveWorktreeRelativePath,
  UnsafePathError,
  GitCommandError,
  parseNameStatusZ,
  parseNumstatZ,
  MAX_CHANGED_FILES,
  MAX_FILE_DIFF_BYTES,
  UNTRACKED_NUMSTAT_CONCURRENCY,
  type GitExec,
  type GitExecResult,
} from './session-changes.js';
import type { SessionWorktreeIo } from './session-env/worktree-io.js';
import { fakeEnvOwnedIo } from './test/fake-worktree-io.js';

const NUL = '\0';

/**
 * A worktree double. These tests inject `exec`, so the only call that ever
 * reaches the seam is the default base-branch resolution — answer "no such
 * ref" so it resolves to null, matching a checkout with no origin/HEAD.
 */
const io: SessionWorktreeIo = {
  sharing: 'host-shared',
  hostPath: '/wt',
  git: async () => ({ stdout: '', stderr: '', exitCode: 1 }),
  readFile: async () => Buffer.alloc(0),
  writeFile: async () => {},
  listDir: async () => [],
  stat: async () => null,
  exists: async () => false,
};

function ok(stdout: string, code = 0): GitExecResult {
  return { stdout, stderr: '', code };
}

/** Build a fake GitExec from a matcher list. First matching entry wins. */
function fakeExec(routes: Array<[(args: string[]) => boolean, GitExecResult]>): GitExec {
  return async (args) => {
    for (const [match, res] of routes) {
      if (match(args)) return res;
    }
    return ok('');
  };
}

const has =
  (...needles: string[]) =>
  (args: string[]) =>
    needles.every((n) => args.includes(n));

describe('parseNameStatusZ', () => {
  it('parses simple statuses', () => {
    const out = ['M', 'src/a.ts', 'A', 'src/b.ts', 'D', 'src/c.ts'].join(NUL) + NUL;
    expect(parseNameStatusZ(out)).toEqual([
      { status: 'modified', path: 'src/a.ts' },
      { status: 'added', path: 'src/b.ts' },
      { status: 'deleted', path: 'src/c.ts' },
    ]);
  });

  it('parses renames with old and new path', () => {
    const out = ['R100', 'old/name.ts', 'new/name.ts', 'M', 'other.ts'].join(NUL) + NUL;
    expect(parseNameStatusZ(out)).toEqual([
      { status: 'renamed', path: 'new/name.ts', oldPath: 'old/name.ts' },
      { status: 'modified', path: 'other.ts' },
    ]);
  });
});

describe('parseNumstatZ', () => {
  it('parses counts and binary markers', () => {
    const out = ['3\t1\tsrc/a.ts', '10\t0\tsrc/b.ts', '-\t-\tassets/logo.png'].join(NUL) + NUL;
    const map = parseNumstatZ(out);
    expect(map.get('src/a.ts')).toEqual({ additions: 3, deletions: 1, binary: false });
    expect(map.get('src/b.ts')).toEqual({ additions: 10, deletions: 0, binary: false });
    expect(map.get('assets/logo.png')).toEqual({ additions: 0, deletions: 0, binary: true });
  });

  it('keys renames by the new path', () => {
    // Rename numstat record: "<adds>\t<dels>\t" then NUL old NUL new.
    const out = '2\t2\t' + NUL + 'old/x.ts' + NUL + 'new/x.ts' + NUL;
    const map = parseNumstatZ(out);
    expect(map.get('new/x.ts')).toEqual({ additions: 2, deletions: 2, binary: false });
  });
});

// The Changes pane for a microVM session is exactly the case that used to
// render empty: git ran on the host, which holds only the tree the VM booted
// from. These assert the summary is built from the seam, whose `hostPath` is
// null, so nothing can quietly reach for a host directory again.
describe('computeSessionChanges — env-owned worktree', () => {
  it('runs every git command through the worktree seam, not a host path', async () => {
    const guest = fakeEnvOwnedIo({
      git: (args) => {
        if (args[0] === 'status') return { stdout: ' M src/a.ts\n' };
        if (args.includes('--name-status')) return { stdout: `M${NUL}src/a.ts${NUL}` };
        if (args.includes('--numstat')) return { stdout: `3\t1\tsrc/a.ts${NUL}` };
        if (args[0] === 'rev-parse' && args[1] === 'HEAD') return { stdout: 'guesthead\n' };
        if (args.includes('--abbrev-ref')) return { stdout: 'feature/in-vm\n' };
        return { stdout: '' };
      },
    });

    const summary = await computeSessionChanges({ io: guest, baseBranch: 'main' });

    expect(summary.headSha).toBe('guesthead');
    expect(summary.branch).toBe('feature/in-vm');
    expect(summary.files).toEqual([
      {
        path: 'src/a.ts',
        oldPath: undefined,
        status: 'modified',
        additions: 3,
        deletions: 1,
        binary: false,
        untracked: false,
      },
    ]);
    expect(guest.gitCalls.length).toBeGreaterThan(0);
  });

  it('diffs a single file through the seam', async () => {
    const patch = 'diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n';
    const guest = fakeEnvOwnedIo({
      git: (args) => {
        if (args[0] === 'rev-parse') return { stdout: 'basesha\n' };
        if (args[0] === 'merge-base') return { stdout: 'mergebase\n' };
        if (args[0] === 'diff') return { stdout: patch };
        return { stdout: '' };
      },
    });

    const res = await computeFileDiff({ io: guest, baseBranch: 'main', file: 'src/a.ts' });

    expect(res.unifiedDiff).toBe(patch);
    expect(res.status).toBe('modified');
  });
});

describe('computeSessionChanges', () => {
  const baseRoutes: Array<[(args: string[]) => boolean, GitExecResult]> = [
    [has('rev-parse', '--verify', 'origin/main'), ok('basesha111\n')],
    [has('merge-base'), ok('mergebase999\n')],
    [has('rev-parse', '--abbrev-ref', 'HEAD'), ok('agent-hub/dev/session-x\n')],
    [(a) => a[0] === 'rev-parse' && a[1] === 'HEAD', ok('headsha222\n')],
    [has('status', '--porcelain'), ok(' M src/a.ts\n?? src/new.ts\n')],
    [
      has('--name-status'),
      ok(['M', 'src/a.ts', 'A', 'src/b.ts', 'R100', 'old.ts', 'renamed.ts'].join(NUL) + NUL),
    ],
    // Main numstat is the `-z` form; disambiguate from the untracked
    // `--no-index --numstat` probe below (which has no `-z`).
    [
      has('--numstat', '-z'),
      ok(
        ['3\t1\tsrc/a.ts', '8\t0\tsrc/b.ts'].join(NUL) +
          NUL +
          '2\t2\t' +
          NUL +
          'old.ts' +
          NUL +
          'renamed.ts' +
          NUL,
      ),
    ],
    [has('ls-files', '--others'), ok('src/new.ts' + NUL)],
    // Per-file numstat for the untracked file (all-add patch vs /dev/null).
    [has('--no-index', '--numstat'), ok('5\t0\tsrc/new.ts\n', 1)],
  ];

  it('merges tracked + untracked into a sorted file list with counts', async () => {
    const summary = await computeSessionChanges({
      io,
      baseBranch: 'main',
      exec: fakeExec(baseRoutes),
    });

    expect(summary.baseBranch).toBe('main');
    expect(summary.baseSha).toBe('mergebase999');
    expect(summary.headSha).toBe('headsha222');
    expect(summary.branch).toBe('agent-hub/dev/session-x');
    expect(summary.dirty).toBe(true);
    expect(summary.truncated).toBe(false);

    const byPath = Object.fromEntries(summary.files.map((f) => [f.path, f]));
    expect(byPath['src/a.ts']).toMatchObject({ status: 'modified', additions: 3, deletions: 1 });
    expect(byPath['src/b.ts']).toMatchObject({ status: 'added', additions: 8 });
    expect(byPath['renamed.ts']).toMatchObject({ status: 'renamed', oldPath: 'old.ts' });
    // Untracked text file gets real add counts derived via --no-index numstat.
    expect(byPath['src/new.ts']).toMatchObject({
      status: 'added',
      untracked: true,
      additions: 5,
      deletions: 0,
      binary: false,
    });

    // sorted alphabetically by path
    const paths = summary.files.map((f) => f.path);
    expect(paths).toEqual([...paths].sort((a, b) => a.localeCompare(b)));
  });

  it('throws GitCommandError when a core git command fails', async () => {
    // Simulates a stale worktree path / non-repo directory — every command
    // exits 128. The helper must surface this, not return an empty change set.
    const routes: typeof baseRoutes = [
      [has('rev-parse', '--verify'), ok('', 128)],
      [has('rev-parse', '--abbrev-ref', 'HEAD'), ok('', 128)],
      [(a) => a[0] === 'rev-parse' && a[1] === 'HEAD', ok('', 128)],
      [has('status', '--porcelain'), ok('fatal: not a git repository\n', 128)],
      [has('--name-status'), ok('', 128)],
      [has('--numstat', '-z'), ok('', 128)],
      [has('ls-files', '--others'), ok('', 128)],
    ];
    await expect(
      computeSessionChanges({ io, baseBranch: 'main', exec: fakeExec(routes) }),
    ).rejects.toThrow(GitCommandError);
  });

  it('marks an untracked binary file as binary with zero adds', async () => {
    const routes: typeof baseRoutes = [
      [has('rev-parse', '--verify', 'origin/main'), ok('b\n')],
      [has('merge-base'), ok('mb\n')],
      [has('rev-parse', '--abbrev-ref', 'HEAD'), ok('br\n')],
      [(a) => a[0] === 'rev-parse' && a[1] === 'HEAD', ok('h\n')],
      [has('status', '--porcelain'), ok('?? logo.png\n')],
      [has('--name-status'), ok('')],
      [has('--numstat', '-z'), ok('')],
      [has('ls-files', '--others'), ok('logo.png' + NUL)],
      // git reports binary files as "-\t-" in numstat.
      [has('--no-index', '--numstat'), ok('-\t-\tlogo.png\n', 1)],
    ];
    const summary = await computeSessionChanges({
      io,
      baseBranch: 'main',
      exec: fakeExec(routes),
    });
    expect(summary.files).toHaveLength(1);
    expect(summary.files[0]).toMatchObject({
      path: 'logo.png',
      untracked: true,
      binary: true,
      additions: 0,
      deletions: 0,
    });
  });

  it('drops untracked paths that escape the worktree before diffing them', async () => {
    const routes: typeof baseRoutes = [
      [has('rev-parse', '--verify', 'origin/main'), ok('b\n')],
      [has('merge-base'), ok('mb\n')],
      [has('rev-parse', '--abbrev-ref', 'HEAD'), ok('br\n')],
      [(a) => a[0] === 'rev-parse' && a[1] === 'HEAD', ok('h\n')],
      [has('status', '--porcelain'), ok('')],
      [has('--name-status'), ok('')],
      [has('--numstat', '-z'), ok('')],
      // ls-files normally yields repo-relative names; a traversal path here
      // (defense-in-depth) must be filtered out, never handed to --no-index.
      [has('ls-files', '--others'), ok('../escape.ts' + NUL + 'safe.ts' + NUL)],
      [has('--no-index', '--numstat'), ok('2\t0\tsafe.ts\n', 1)],
    ];
    const summary = await computeSessionChanges({
      io,
      baseBranch: 'main',
      exec: fakeExec(routes),
    });
    const paths = summary.files.map((f) => f.path);
    expect(paths).toContain('safe.ts');
    expect(paths).not.toContain('../escape.ts');
  });

  it('bounds concurrent untracked numstat probes', async () => {
    const N = 50;
    const untracked =
      Array.from({ length: N }, (_, i) => `u${String(i).padStart(3, '0')}.ts`).join(NUL) + NUL;
    let inFlight = 0;
    let peak = 0;
    let completed = 0;
    const exec: GitExec = async (args) => {
      if (args.includes('--no-index') && args.includes('--numstat')) {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight -= 1;
        completed += 1;
        return ok('3\t0\t' + args[args.length - 1] + '\n', 1);
      }
      if (has('rev-parse', '--verify', 'origin/main')(args)) return ok('b\n');
      if (has('merge-base')(args)) return ok('mb\n');
      if (has('rev-parse', '--abbrev-ref', 'HEAD')(args)) return ok('br\n');
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') return ok('h\n');
      if (has('status', '--porcelain')(args)) return ok('');
      if (has('--name-status')(args)) return ok('');
      if (has('--numstat', '-z')(args)) return ok('');
      if (has('ls-files', '--others')(args)) return ok(untracked);
      return ok('');
    };
    const summary = await computeSessionChanges({ io, baseBranch: 'main', exec });
    // Every file is still processed...
    expect(completed).toBe(N);
    expect(summary.files.filter((f) => f.untracked)).toHaveLength(N);
    expect(summary.files.filter((f) => f.untracked).every((f) => f.additions === 3)).toBe(true);
    // ...but never more than the concurrency cap ran at once (and it WAS
    // parallel — not accidentally serialized).
    expect(peak).toBeLessThanOrEqual(UNTRACKED_NUMSTAT_CONCURRENCY);
    expect(peak).toBeGreaterThan(1);
  });

  it('does not double-count an untracked file already in the diff', async () => {
    const routes: typeof baseRoutes = [
      ...baseRoutes.filter((r) => !r[0](['ls-files', '--others'])),
      [has('ls-files', '--others'), ok('src/a.ts' + NUL)], // already tracked-modified
    ];
    const summary = await computeSessionChanges({
      io,
      baseBranch: 'main',
      exec: fakeExec(routes),
    });
    expect(summary.files.filter((f) => f.path === 'src/a.ts')).toHaveLength(1);
  });

  it('falls back to the empty tree when no base ref resolves', async () => {
    const routes: typeof baseRoutes = [
      [has('rev-parse', '--verify'), ok('', 1)], // every base candidate missing
      [has('rev-parse', '--abbrev-ref', 'HEAD'), ok('branch\n')],
      [(a) => a[0] === 'rev-parse' && a[1] === 'HEAD', ok('head\n')],
      [has('status', '--porcelain'), ok('')],
      [has('--name-status'), ok('A' + NUL + 'only.ts' + NUL)],
      [has('--numstat'), ok('5\t0\tonly.ts' + NUL)],
      [has('ls-files', '--others'), ok('')],
    ];
    const summary = await computeSessionChanges({
      io,
      baseBranch: 'main',
      exec: fakeExec(routes),
    });
    expect(summary.baseSha).toBeNull();
    expect(summary.dirty).toBe(false);
    expect(summary.files).toHaveLength(1);
  });

  it('caps the file list and flags truncated', async () => {
    const many =
      Array.from({ length: MAX_CHANGED_FILES + 50 }, (_, i) => `A${NUL}f${i}.ts`).join(NUL) + NUL;
    const routes: typeof baseRoutes = [
      [has('rev-parse', '--verify', 'origin/main'), ok('b\n')],
      [has('merge-base'), ok('mb\n')],
      [has('rev-parse', '--abbrev-ref', 'HEAD'), ok('br\n')],
      [(a) => a[0] === 'rev-parse' && a[1] === 'HEAD', ok('h\n')],
      [has('status', '--porcelain'), ok('')],
      [has('--name-status'), ok(many)],
      [has('--numstat'), ok('')],
      [has('ls-files', '--others'), ok('')],
    ];
    const summary = await computeSessionChanges({
      io,
      baseBranch: 'main',
      exec: fakeExec(routes),
    });
    expect(summary.truncated).toBe(true);
    expect(summary.files).toHaveLength(MAX_CHANGED_FILES);
  });
});

describe('computeFileDiff', () => {
  it('returns a unified diff for a tracked file', async () => {
    const patch = 'diff --git a/x.ts b/x.ts\n@@ -1 +1 @@\n-old\n+new\n';
    const exec = fakeExec([
      [has('rev-parse', '--verify', 'origin/main'), ok('b\n')],
      [has('merge-base'), ok('mb\n')],
      [has('diff', '-M', '--', 'x.ts'), ok(patch)],
    ]);
    const res = await computeFileDiff({
      io,
      baseBranch: 'main',
      file: 'x.ts',
      exec,
    });
    expect(res.unifiedDiff).toBe(patch);
    expect(res.binary).toBe(false);
    expect(res.tooLarge).toBe(false);
  });

  it('uses --no-index for untracked files and infers added', async () => {
    const patch = 'diff --git a/new.ts b/new.ts\nnew file mode 100644\n@@ -0,0 +1 @@\n+hello\n';
    const exec = fakeExec([[has('--no-index'), ok(patch, 1)]]);
    const res = await computeFileDiff({
      io,
      file: 'new.ts',
      untracked: true,
      exec,
    });
    expect(res.unifiedDiff).toBe(patch);
    expect(res.status).toBe('added');
  });

  it('flags binary diffs and withholds the body', async () => {
    const exec = fakeExec([
      [has('rev-parse', '--verify', 'origin/main'), ok('b\n')],
      [has('merge-base'), ok('mb\n')],
      [
        has('diff', '-M'),
        ok('diff --git a/logo.png b/logo.png\nBinary files a/logo.png and b/logo.png differ\n'),
      ],
    ]);
    const res = await computeFileDiff({
      io,
      baseBranch: 'main',
      file: 'logo.png',
      exec,
    });
    expect(res.binary).toBe(true);
    expect(res.unifiedDiff).toBe('');
  });

  it('withholds oversized diffs and sets tooLarge', async () => {
    const huge = 'x'.repeat(MAX_FILE_DIFF_BYTES + 10);
    const exec = fakeExec([
      [has('rev-parse', '--verify', 'origin/main'), ok('b\n')],
      [has('merge-base'), ok('mb\n')],
      [has('diff', '-M'), ok(huge)],
    ]);
    const res = await computeFileDiff({
      io,
      baseBranch: 'main',
      file: 'big.ts',
      exec,
    });
    expect(res.tooLarge).toBe(true);
    expect(res.unifiedDiff).toBe('');
  });

  it('throws GitCommandError when the tracked diff exits non-zero', async () => {
    const exec = fakeExec([
      [has('rev-parse', '--verify', 'origin/main'), ok('b\n')],
      [has('merge-base'), ok('mb\n')],
      [has('diff', '-M'), ok('fatal: bad object\n', 128)],
    ]);
    await expect(computeFileDiff({ io, baseBranch: 'main', file: 'x.ts', exec })).rejects.toThrow(
      GitCommandError,
    );
  });

  it('throws on a fatal --no-index exit but tolerates the diff-found exit', async () => {
    // 128 = fatal (e.g. the file vanished after the membership check) → throw.
    const fatal = fakeExec([[has('--no-index'), ok('fatal: could not read\n', 128)]]);
    await expect(
      computeFileDiff({ io, file: 'new.ts', untracked: true, exec: fatal }),
    ).rejects.toThrow(GitCommandError);
    // 1 = differences found → the expected, tolerated case.
    const found = fakeExec([
      [has('--no-index'), ok('diff --git a/new.ts b/new.ts\n@@ -0,0 +1 @@\n+x\n', 1)],
    ]);
    const res = await computeFileDiff({
      io,
      file: 'new.ts',
      untracked: true,
      exec: found,
    });
    expect(res.status).toBe('added');
    expect(res.unifiedDiff).toContain('+x');
  });

  // ── Path-safety guard (reviewer hardening) ────────────────────────
  // computeFileDiff must never hand an absolute or traversal path to git,
  // or `git diff --no-index` becomes an arbitrary file-read oracle.
  it.each([
    ['/etc/passwd', true],
    ['../../../../etc/passwd', true],
    ['src/../../secret', true],
    ['', true],
  ])('rejects unsafe path %s without spawning git', async (file, untracked) => {
    const exec = vi.fn(async () => ok('should not run', 0));
    await expect(
      computeFileDiff({ io, baseBranch: 'main', file, untracked, exec }),
    ).rejects.toThrow(UnsafePathError);
    expect(exec).not.toHaveBeenCalled();
  });

  it('accepts a nested safe relative path and normalizes it', async () => {
    const patch = 'diff --git a/src/x.ts b/src/x.ts\n@@ -1 +1 @@\n-a\n+b\n';
    const exec = fakeExec([
      [has('rev-parse', '--verify', 'origin/main'), ok('b\n')],
      [has('merge-base'), ok('mb\n')],
      [has('diff', '-M', '--', 'src/x.ts'), ok(patch)],
    ]);
    const res = await computeFileDiff({
      io,
      baseBranch: 'main',
      file: './src/x.ts',
      exec,
    });
    expect(res.path).toBe('src/x.ts');
    expect(res.unifiedDiff).toBe(patch);
  });
});

describe('resolveWorktreeRelativePath', () => {
  it('returns the normalized relative path for in-worktree files', () => {
    expect(resolveWorktreeRelativePath('src/a.ts')).toBe('src/a.ts');
    expect(resolveWorktreeRelativePath('./src/a.ts')).toBe('src/a.ts');
    expect(resolveWorktreeRelativePath('src/sub/../a.ts')).toBe('src/a.ts');
  });

  it('rejects absolute paths and traversal that escapes the worktree', () => {
    expect(resolveWorktreeRelativePath('/etc/passwd')).toBeNull();
    expect(resolveWorktreeRelativePath('../outside')).toBeNull();
    expect(resolveWorktreeRelativePath('../../etc/passwd')).toBeNull();
    expect(resolveWorktreeRelativePath('src/../../escape')).toBeNull();
    expect(resolveWorktreeRelativePath('')).toBeNull();
  });
});

describe('listSessionChangedPaths', () => {
  it('returns the full UNTRUNCATED membership set (gate past the UI cap)', async () => {
    // More changed files than the UI payload cap — every one must remain
    // diffable, so the membership map is not truncated to MAX_CHANGED_FILES.
    const overCap = MAX_CHANGED_FILES + 25;
    const many =
      Array.from({ length: overCap }, (_, i) => `A${NUL}f${String(i).padStart(5, '0')}.ts`).join(
        NUL,
      ) + NUL;
    const routes: Array<[(args: string[]) => boolean, GitExecResult]> = [
      [has('rev-parse', '--verify', 'origin/main'), ok('b\n')],
      [has('merge-base'), ok('mb\n')],
      [has('--name-status'), ok(many)],
      [has('ls-files', '--others'), ok('untracked-new.ts' + NUL)],
    ];
    const membership = await listSessionChangedPaths({
      io,
      baseBranch: 'main',
      exec: fakeExec(routes),
    });
    expect(membership.size).toBe(overCap + 1);
    // A tracked file well past the UI cap is still a member.
    expect(membership.get('f00610.ts')).toEqual({ untracked: false });
    expect(membership.get(`f${String(overCap - 1).padStart(5, '0')}.ts`)).toEqual({
      untracked: false,
    });
    // Untracked files are flagged.
    expect(membership.get('untracked-new.ts')).toEqual({ untracked: true });
  });

  it('normalizes untracked names and drops worktree escapes', async () => {
    const routes: Array<[(args: string[]) => boolean, GitExecResult]> = [
      [has('rev-parse', '--verify', 'origin/main'), ok('b\n')],
      [has('merge-base'), ok('mb\n')],
      [has('--name-status'), ok('M' + NUL + 'tracked.ts' + NUL)],
      [has('ls-files', '--others'), ok('./safe.ts' + NUL + '../escape.ts' + NUL)],
    ];
    const membership = await listSessionChangedPaths({
      io,
      baseBranch: 'main',
      exec: fakeExec(routes),
    });
    expect(membership.get('tracked.ts')).toEqual({ untracked: false });
    expect(membership.get('safe.ts')).toEqual({ untracked: true }); // './safe.ts' normalized
    expect(membership.has('../escape.ts')).toBe(false);
  });

  it('throws GitCommandError when name-status fails', async () => {
    const routes: Array<[(args: string[]) => boolean, GitExecResult]> = [
      [has('rev-parse', '--verify', 'origin/main'), ok('b\n')],
      [has('merge-base'), ok('mb\n')],
      [has('--name-status'), ok('fatal: bad revision\n', 128)],
      [has('ls-files', '--others'), ok('')],
    ];
    await expect(
      listSessionChangedPaths({ io, baseBranch: 'main', exec: fakeExec(routes) }),
    ).rejects.toThrow(GitCommandError);
  });
});
