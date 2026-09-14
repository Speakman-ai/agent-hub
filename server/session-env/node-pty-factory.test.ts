import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node-pty', () => ({ spawn: vi.fn() }));
vi.mock('./node-pty-spawn-helper.js', () => ({ prepareNodePtySpawnHelper: vi.fn() }));

import { spawn } from 'node-pty';
import { prepareNodePtySpawnHelper } from './node-pty-spawn-helper.js';
import { defaultPtyFactory } from './node-pty-factory.js';

const opts = {
  command: '/bin/bash',
  args: ['-l'],
  cwd: '/worktree',
  env: { TERM: 'xterm-256color' },
  cols: 80,
  rows: 24,
  name: 'xterm-256color',
};

beforeEach(() => {
  vi.resetAllMocks();
});

describe('defaultPtyFactory', () => {
  it('prepares the native helper before spawning the terminal', async () => {
    vi.mocked(spawn).mockReturnValue({ pid: 42 } as ReturnType<typeof spawn>);
    expect((await defaultPtyFactory(opts)).pid).toBe(42);
    expect(prepareNodePtySpawnHelper).toHaveBeenCalledOnce();
    expect(vi.mocked(prepareNodePtySpawnHelper).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(spawn).mock.invocationCallOrder[0],
    );
    expect(spawn).toHaveBeenCalledWith('/bin/bash', ['-l'], {
      cwd: '/worktree',
      env: opts.env,
      cols: 80,
      rows: 24,
      name: 'xterm-256color',
    });
  });

  it('includes command and worktree context when native spawning fails', async () => {
    vi.mocked(spawn).mockImplementation(() => {
      throw new Error('posix_spawnp failed.');
    });
    await expect(defaultPtyFactory(opts)).rejects.toThrow(
      'Could not start terminal command /bin/bash in /worktree: posix_spawnp failed.',
    );
  });

  it('does not spawn after launcher preparation fails', async () => {
    vi.mocked(prepareNodePtySpawnHelper).mockImplementation(() => {
      throw new Error('Cannot execute terminal launcher');
    });
    await expect(defaultPtyFactory(opts)).rejects.toThrow('Cannot execute terminal launcher');
    expect(spawn).not.toHaveBeenCalled();
  });
});
