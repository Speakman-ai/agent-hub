import { execFile } from 'child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startJobContainer, stopJobContainer } from './job-container.js';
import { jobWorktreePath } from './job-worktree.js';
import { createLocalRunnerBackend } from './runner-backend-local.js';
import type { JobClaimSpec } from './runner-backend.js';

vi.mock('./job-container.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./job-container.js')>();
  return {
    ...actual,
    startJobContainer: vi.fn().mockResolvedValue(undefined),
    stopJobContainer: vi.fn().mockResolvedValue(undefined),
    createJobScopedSpawnStep: vi.fn().mockReturnValue(vi.fn()),
  };
});

const execFileAsync = promisify(execFile);

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(cleanups.splice(0).map((fn) => fn().catch(() => {})));
});

async function tmpDir(tag: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), `local-be-${tag}-`));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout.trim();
}

function spec(worktreePath: string, runId = 'run-1'): JobClaimSpec {
  return {
    orgId: '',
    projectId: 'p',
    runId,
    jobId: 'frontend',
    matrixKey: '',
    image: 'runner:test',
    worktreePath,
    composeProjectName: 'finalize-run-1-frontend',
    env: {},
    labels: {},
  };
}

describe('createLocalRunnerBackend', () => {
  it('bind-mounts a per-job clone, not the shared staging checkout', async () => {
    const root = await tmpDir('iso');
    const src = path.join(root, 'staging');
    await execFileAsync('git', ['init', '--initial-branch=main', src]);
    await git(src, 'config', 'user.email', 'test@example.com');
    await git(src, 'config', 'user.name', 'Test');
    await writeFile(path.join(src, 'README.md'), 'shared\n');
    await git(src, 'add', '.');
    await git(src, 'commit', '-m', 'init');

    const sourceRoot = path.join(root, 'finalize-source');
    const backend = createLocalRunnerBackend({ sourceRoot });
    const lease = await backend.acquire(spec(src));

    expect(startJobContainer).toHaveBeenCalledTimes(1);
    const mounted = vi.mocked(startJobContainer).mock.calls[0]![0].worktreePath;
    expect(mounted).not.toBe(src);
    expect(mounted).toContain('run-1.job.frontend-default');
    expect(await readFile(path.join(mounted, 'README.md'), 'utf8')).toBe('shared\n');

    await writeFile(path.join(mounted, 'node_modules-marker'), 'job-local\n');
    await expect(readFile(path.join(src, 'node_modules-marker'), 'utf8')).rejects.toThrow();

    await lease.release();
    expect(stopJobContainer).toHaveBeenCalled();
    await expect(readFile(path.join(mounted, 'README.md'), 'utf8')).rejects.toThrow();
  });

  it('removes the per-job copy if the container fails to start', async () => {
    const root = await tmpDir('fail');
    const src = path.join(root, 'staging');
    await mkdir(src);
    await writeFile(path.join(src, 'README.md'), 'x\n');
    const sourceRoot = path.join(root, 'finalize-source');
    vi.mocked(startJobContainer).mockRejectedValueOnce(new Error('docker run failed'));

    const backend = createLocalRunnerBackend({ sourceRoot });
    await expect(backend.acquire(spec(src))).rejects.toThrow('docker run failed');

    const leftover = jobWorktreePath(sourceRoot, 'run-1', 'frontend', '');
    await expect(readFile(path.join(leftover, 'README.md'), 'utf8')).rejects.toThrow();
  });
});
