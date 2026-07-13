import { describe, it, expect } from 'vitest';
import { classifyWorktreeFailure } from './worktree-failure-cause.js';

describe('classifyWorktreeFailure', () => {
  it('classifies GitHub auth rejection as auth', () => {
    const d = classifyWorktreeFailure(
      'fatal: Authentication failed for https://github.com/acme/private.git',
    );
    expect(d.cause).toBe('auth');
    expect(d.prevention).toMatch(/Settings → GitHub/);
  });

  it('classifies HTTP 403 and "could not read Username" as auth', () => {
    expect(classifyWorktreeFailure('error: RPC failed; HTTP 403 curl 22').cause).toBe('auth');
    expect(
      classifyWorktreeFailure("fatal: could not read Username for 'https://github.com'").cause,
    ).toBe('auth');
  });

  it('classifies ENOSPC as disk-full', () => {
    const d = classifyWorktreeFailure('fatal: write error: No space left on device (ENOSPC)');
    expect(d.cause).toBe('disk-full');
    expect(d.prevention).toMatch(/disk/i);
  });

  it('classifies EACCES as permissions (and not as auth publickey)', () => {
    expect(classifyWorktreeFailure('EACCES: permission denied, mkdir').cause).toBe('permissions');
    // SSH publickey denial is auth, not a filesystem permissions problem.
    expect(classifyWorktreeFailure('git@github.com: Permission denied (publickey).').cause).toBe(
      'auth',
    );
  });

  it('classifies a non-git project cwd as not-a-git-repo', () => {
    expect(classifyWorktreeFailure('/srv/project is not a git repo').cause).toBe('not-a-git-repo');
  });

  it('classifies leftover clone dir as destination-exists', () => {
    expect(
      classifyWorktreeFailure(
        "fatal: destination path 'session-abcd1234' already exists and is not an empty directory.",
      ).cause,
    ).toBe('destination-exists');
  });

  it('classifies transient remote errors as network', () => {
    expect(classifyWorktreeFailure('error: RPC failed; HTTP 500 curl 22').cause).toBe('network');
    expect(classifyWorktreeFailure('fatal: the remote end hung up unexpectedly').cause).toBe(
      'network',
    );
    expect(
      classifyWorktreeFailure('fatal: unable to access: Could not resolve host: github.com').cause,
    ).toBe('network');
  });

  it('prefers auth over network when an HTTP 401 rides on an RPC failure', () => {
    expect(classifyWorktreeFailure('error: RPC failed; HTTP 401 Unauthorized').cause).toBe('auth');
  });

  it('falls back to unknown with an operator pointer', () => {
    const d = classifyWorktreeFailure('some totally unexpected git explosion');
    expect(d.cause).toBe('unknown');
    expect(d.prevention).toMatch(/\[worktree-failed\]/);
  });

  it('handles an empty error string without throwing', () => {
    expect(classifyWorktreeFailure('').cause).toBe('unknown');
  });
});
