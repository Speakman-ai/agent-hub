import { describe, expect, it } from 'vitest';
import { resolveDefaultBranchIn } from './git-default-branch.js';
import { fakeEnvOwnedIo } from './test/fake-worktree-io.js';

describe('resolveDefaultBranchIn', () => {
  it('prefers the origin/HEAD symbolic ref', async () => {
    const io = fakeEnvOwnedIo({
      git: (args) =>
        args[0] === 'symbolic-ref' ? { stdout: 'refs/remotes/origin/develop\n' } : { exitCode: 1 },
    });
    expect(await resolveDefaultBranchIn(io)).toBe('develop');
  });

  it('falls back to main, then master, when origin/HEAD is unset', async () => {
    const noMain = fakeEnvOwnedIo({
      git: (args) => {
        if (args[0] === 'symbolic-ref') return { exitCode: 128 };
        if (args[0] === 'rev-parse' && args[2] === 'master') return { stdout: 'deadbeef\n' };
        return { exitCode: 128 };
      },
    });
    expect(await resolveDefaultBranchIn(noMain)).toBe('master');

    const hasMain = fakeEnvOwnedIo({
      git: (args) => (args[0] === 'symbolic-ref' ? { exitCode: 128 } : { stdout: 'deadbeef\n' }),
    });
    expect(await resolveDefaultBranchIn(hasMain)).toBe('main');
  });

  it('returns null when nothing resolves', async () => {
    const io = fakeEnvOwnedIo({ git: () => ({ exitCode: 128 }) });
    expect(await resolveDefaultBranchIn(io)).toBeNull();
  });

  // An empty stdout with exit 0 is not a branch name; treating it as one would
  // hand every downstream ref builder an `origin/` prefix and nothing else.
  it('ignores an empty symbolic-ref answer and keeps looking', async () => {
    const io = fakeEnvOwnedIo({
      git: (args) => (args[0] === 'symbolic-ref' ? { stdout: '\n' } : { stdout: 'deadbeef\n' }),
    });
    expect(await resolveDefaultBranchIn(io)).toBe('main');
  });
});
