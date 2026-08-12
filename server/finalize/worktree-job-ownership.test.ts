import { describe, expect, it, vi } from 'vitest';
import {
  FINALIZE_JOB_RUNNER_GID,
  FINALIZE_JOB_RUNNER_UID,
  chownWorktreeForJobRunner,
} from './worktree-job-ownership.js';

describe('chownWorktreeForJobRunner', () => {
  it('sudo chowns the tree to the job-container runner uid/gid', async () => {
    const execFile = vi.fn(async () => ({ stdout: '', stderr: '' }));
    await chownWorktreeForJobRunner('/finalize-ws/repo', { execFile });
    expect(execFile).toHaveBeenCalledWith('sudo', [
      'chown',
      '-R',
      `${FINALIZE_JOB_RUNNER_UID}:${FINALIZE_JOB_RUNNER_GID}`,
      '/finalize-ws/repo',
    ]);
  });

  it('is a no-op for an empty path', async () => {
    const execFile = vi.fn(async () => ({ stdout: '', stderr: '' }));
    await chownWorktreeForJobRunner('', { execFile });
    expect(execFile).not.toHaveBeenCalled();
  });

  it('honors an explicit uid/gid override', async () => {
    const execFile = vi.fn(async () => ({ stdout: '', stderr: '' }));
    await chownWorktreeForJobRunner('/ws', { uid: 42, gid: 43, execFile });
    expect(execFile).toHaveBeenCalledWith('sudo', ['chown', '-R', '42:43', '/ws']);
  });
});
