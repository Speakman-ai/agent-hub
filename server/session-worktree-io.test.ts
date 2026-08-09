import { afterEach, describe, expect, it, vi } from 'vitest';
import { sessionWorktreeIoFor, setSessionWorktreeIoResolver } from './session-worktree-io.js';
import { HostWorktreeIo } from './session-env/worktree-io.js';
import { worktreeSharingForKind } from './session-env/session-env.js';
import { fakeEnvOwnedIo } from './test/fake-worktree-io.js';

afterEach(() => {
  setSessionWorktreeIoResolver(null);
});

describe('sessionWorktreeIoFor', () => {
  it('falls back to the host path when no resolver is installed', async () => {
    const io = await sessionWorktreeIoFor('sess-1', '/wt');
    expect(io).toBeInstanceOf(HostWorktreeIo);
    expect(io.sharing).toBe('host-shared');
    expect(io.hostPath).toBe('/wt');
  });

  it('prefers the installed resolver', async () => {
    const guest = fakeEnvOwnedIo();
    setSessionWorktreeIoResolver(async () => guest);
    const io = await sessionWorktreeIoFor('sess-1', '/wt');
    expect(io).toBe(guest);
    expect(io.hostPath).toBeNull();
  });

  it('passes the session id through to the resolver', async () => {
    const resolver = vi.fn(async () => null);
    setSessionWorktreeIoResolver(resolver);
    await sessionWorktreeIoFor('sess-42', '/wt');
    expect(resolver).toHaveBeenCalledWith('sess-42');
  });

  it('falls back when the resolver has no env for the session', async () => {
    setSessionWorktreeIoResolver(async () => null);
    const io = await sessionWorktreeIoFor('sess-1', '/wt');
    expect(io.hostPath).toBe('/wt');
  });

  // Silently answering from the host seed is the failure mode this seam exists
  // to prevent, so a resolver that cannot reach the env must surface, not
  // degrade into a stale-but-plausible answer.
  it('propagates a resolver failure instead of falling back to the stale host tree', async () => {
    setSessionWorktreeIoResolver(async () => {
      throw new Error('microVM failed to boot');
    });
    await expect(sessionWorktreeIoFor('sess-1', '/wt')).rejects.toThrow('microVM failed to boot');
  });
});

describe('worktreeSharingForKind', () => {
  it('reports host-shared for every backend that bind-mounts the worktree', () => {
    expect(worktreeSharingForKind('host')).toBe('host-shared');
    expect(worktreeSharingForKind('sysbox')).toBe('host-shared');
    expect(worktreeSharingForKind('container')).toBe('host-shared');
  });

  it('reports env-owned for firecracker, which has no shared filesystem', () => {
    expect(worktreeSharingForKind('firecracker')).toBe('env-owned');
  });
});
