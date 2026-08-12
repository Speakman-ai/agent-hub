import { describe, it, expect, vi } from 'vitest';
import {
  collectBaseDriftFacts,
  evaluateBaseDrift,
  resolveBaseSha,
  type BaseDriftFacts,
  type GitRunner,
} from './base-drift.js';

function facts(over: Partial<BaseDriftFacts> = {}): BaseDriftFacts {
  return {
    validatedBaseSha: 'base1',
    currentBaseSha: 'base2',
    basePaths: [],
    branchPaths: [],
    ...over,
  };
}

describe('evaluateBaseDrift', () => {
  it('clears when the run has no recorded base sha', () => {
    const out = evaluateBaseDrift(facts({ validatedBaseSha: null }));
    expect(out).toMatchObject({ kind: 'clear', reason: 'unknown_base' });
  });

  it('clears when the current base sha could not be resolved', () => {
    const out = evaluateBaseDrift(facts({ currentBaseSha: null }));
    expect(out).toMatchObject({ kind: 'clear', reason: 'unknown_base' });
  });

  it('clears when the base has not moved', () => {
    const out = evaluateBaseDrift(facts({ currentBaseSha: 'base1' }));
    expect(out).toMatchObject({ kind: 'clear', reason: 'no_drift' });
  });

  it('clears when the base moved somewhere this branch does not touch', () => {
    const out = evaluateBaseDrift(
      facts({
        basePaths: ['frontend/src/App.tsx'],
        branchPaths: ['backend/jobs/views.py'],
      }),
    );
    expect(out).toMatchObject({ kind: 'clear', reason: 'no_overlap' });
  });

  // The failure this module exists for: two sequence-numbered files that
  // never share a filename but cannot coexist.
  it('goes stale when both sides add different files in the same directory', () => {
    const out = evaluateBaseDrift(
      facts({
        basePaths: ['backend/jobs/migrations/0088_bar.py'],
        branchPaths: ['backend/jobs/migrations/0088_foo.py'],
      }),
    );
    expect(out.kind).toBe('stale');
    if (out.kind !== 'stale') return;
    expect(out.overlap).toEqual(['backend/jobs/migrations/']);
    expect(out.detail).toContain('base moved base1 → base2');
  });

  it('goes stale when both sides changed the same file', () => {
    const out = evaluateBaseDrift(
      facts({ basePaths: ['server/db.ts'], branchPaths: ['server/db.ts'] }),
    );
    expect(out.kind).toBe('stale');
    if (out.kind !== 'stale') return;
    expect(out.overlap).toContain('server/db.ts');
  });

  // Root-level edits are the noisiest thing in any repo (version bumps,
  // changelogs); matching them by directory would refuse constantly.
  it('does not treat two unrelated repository-root files as overlapping', () => {
    const out = evaluateBaseDrift(
      facts({ basePaths: ['package.json'], branchPaths: ['README.md'] }),
    );
    expect(out).toMatchObject({ kind: 'clear', reason: 'no_overlap' });
  });

  it('still catches the same repository-root file on both sides', () => {
    const out = evaluateBaseDrift(
      facts({ basePaths: ['package.json'], branchPaths: ['package.json'] }),
    );
    expect(out.kind).toBe('stale');
  });

  it('truncates the overlap list in the detail string', () => {
    const dirs = Array.from({ length: 7 }, (_, i) => `pkg/mod${i}/file.ts`);
    const out = evaluateBaseDrift(facts({ basePaths: dirs, branchPaths: dirs }));
    expect(out.kind).toBe('stale');
    if (out.kind !== 'stale') return;
    expect(out.detail).toContain('more');
    expect(out.overlap.length).toBe(14);
  });
});

describe('collectBaseDriftFacts', () => {
  it('does no git work when there is no recorded base sha, but says so', async () => {
    const git = vi.fn<GitRunner>();
    const onWarn = vi.fn();
    const got = await collectBaseDriftFacts({
      baseBranch: 'main',
      validatedBaseSha: null,
      headSha: 'head1',
      git,
      onWarn,
    });
    expect(git).not.toHaveBeenCalled();
    expect(got.currentBaseSha).toBeNull();
    expect(onWarn).toHaveBeenCalledOnce();
    expect(onWarn.mock.calls[0][0]).toContain('base drift was NOT evaluated');
  });

  it('fetches and skips the diffs when the base has not moved', async () => {
    const git = vi.fn(async (args: string[]) =>
      args[0] === 'rev-parse' ? 'base1\n' : '',
    ) as unknown as GitRunner;
    const got = await collectBaseDriftFacts({
      baseBranch: 'main',
      validatedBaseSha: 'base1',
      headSha: 'head1',
      git,
    });
    expect(got.currentBaseSha).toBe('base1');
    expect(got.basePaths).toEqual([]);
    expect(evaluateBaseDrift(got)).toMatchObject({ reason: 'no_drift' });
  });

  it('diffs both sides against the recorded base when it moved', async () => {
    const calls: string[][] = [];
    const git: GitRunner = async (args) => {
      calls.push(args);
      if (args[0] === 'rev-parse') return 'base2\n';
      if (args[0] === 'diff' && args[3] === 'base2') return 'a/one.py\na/two.py\n';
      if (args[0] === 'diff' && args[3] === 'head1') return 'a/three.py\n';
      return '';
    };
    const got = await collectBaseDriftFacts({
      baseBranch: 'main',
      validatedBaseSha: 'base1',
      headSha: 'head1',
      git,
    });
    expect(calls[0]).toEqual(['fetch', '--no-tags', 'origin', 'main']);
    expect(got.basePaths).toEqual(['a/one.py', 'a/two.py']);
    expect(got.branchPaths).toEqual(['a/three.py']);
    expect(evaluateBaseDrift(got).kind).toBe('stale');
  });

  it('fails open and warns when git throws', async () => {
    const onWarn = vi.fn();
    const git: GitRunner = async () => {
      throw new Error('fatal: could not read from remote');
    };
    const got = await collectBaseDriftFacts({
      baseBranch: 'main',
      validatedBaseSha: 'base1',
      headSha: 'head1',
      git,
      onWarn,
    });
    expect(onWarn).toHaveBeenCalledOnce();
    expect(evaluateBaseDrift(got)).toMatchObject({ kind: 'clear', reason: 'unknown_base' });
  });

  it('fails open when a diff throws after a successful fetch', async () => {
    const onWarn = vi.fn();
    const git: GitRunner = async (a) => {
      if (a[0] === 'rev-parse') return 'base2\n';
      if (a[0] === 'diff') throw new Error('bad object');
      return '';
    };
    const got = await collectBaseDriftFacts({
      baseBranch: 'main',
      validatedBaseSha: 'base1',
      headSha: 'head1',
      git,
      onWarn,
    });
    expect(onWarn).toHaveBeenCalledOnce();
    expect(evaluateBaseDrift(got)).toMatchObject({ kind: 'clear', reason: 'unknown_base' });
  });
});

describe('resolveBaseSha', () => {
  // Regression: reading `origin/<base>` after the rebase records whatever the
  // tip is NOW. If the base advanced between the rebase and that read, the run
  // records the newer sha, a later drift check reports `no_drift`, and stale
  // validation lands. The merge base of the validated HEAD and the base ref
  // cannot be raced that way.
  it('prefers the merge base of the validated head and the base ref', async () => {
    const calls: string[][] = [];
    const git: GitRunner = async (args) => {
      calls.push(args);
      if (args[0] === 'merge-base') return 'base1\n';
      if (args[0] === 'rev-parse') return 'base2-advanced\n';
      return '';
    };

    const sha = await resolveBaseSha({
      worktreePath: '/tmp/wt',
      baseBranch: 'main',
      headSha: 'head1',
      git,
    });

    expect(sha).toBe('base1');
    expect(calls[0]).toEqual(['merge-base', 'head1', 'origin/main']);
  });

  it('falls back to the base tip when there is no remote-tracking ref', async () => {
    const git: GitRunner = async (args) => {
      if (args[0] === 'merge-base') throw new Error('not a valid object name');
      if (args[1] === 'origin/main') return 'base2\n';
      return '';
    };

    const sha = await resolveBaseSha({
      worktreePath: '/tmp/wt',
      baseBranch: 'main',
      headSha: 'head1',
      git,
    });

    expect(sha).toBe('base2');
  });

  it('warns when it falls back to the base tip, which can be raced', async () => {
    const onWarn = vi.fn();
    const git: GitRunner = async (args) => {
      if (args[0] === 'merge-base') throw new Error('not a valid object name');
      if (args[1] === 'origin/main') return 'base2\n';
      return '';
    };

    await resolveBaseSha({ worktreePath: '/tmp/wt', baseBranch: 'main', git, onWarn });

    expect(onWarn).toHaveBeenCalledOnce();
    expect(onWarn.mock.calls[0][0]).toContain('fell back to the origin/main tip');
  });

  // A gate that silently cannot read its baseline looks exactly like a clean
  // pass. The log line is the only evidence it was inert for that run.
  it('warns loudly when nothing resolves', async () => {
    const onWarn = vi.fn();
    const git: GitRunner = async () => {
      throw new Error('fatal: not a git repository');
    };

    const sha = await resolveBaseSha({ worktreePath: '/tmp/wt', baseBranch: 'main', git, onWarn });

    expect(sha).toBeNull();
    expect(onWarn).toHaveBeenCalledOnce();
    const message = onWarn.mock.calls[0][0] as string;
    expect(message).toContain('base drift will NOT be evaluated');
    expect(message).toContain('merge-base failed: fatal: not a git repository');
  });

  it('returns null when nothing resolves, so the drift check fails open', async () => {
    const git: GitRunner = async () => {
      throw new Error('fatal: not a git repository');
    };

    const sha = await resolveBaseSha({ worktreePath: '/tmp/wt', baseBranch: 'main', git });
    expect(sha).toBeNull();
    expect(evaluateBaseDrift({ ...facts(), validatedBaseSha: sha })).toMatchObject({
      kind: 'clear',
      reason: 'unknown_base',
    });
  });
});
