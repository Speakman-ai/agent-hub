import { execFile } from 'child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import { afterEach, describe, expect, it } from 'vitest';
import {
  jobWorktreePath,
  materializeJobWorktree,
  sanitizeJobWorktreeSlug,
} from './job-worktree.js';

const execFileAsync = promisify(execFile);

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((fn) => fn().catch(() => {})));
});

async function tmpDir(tag: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), `job-wt-${tag}-`));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout.trim();
}

describe('sanitizeJobWorktreeSlug', () => {
  it('turns matrix keys into a docker/fs-safe slug', () => {
    expect(sanitizeJobWorktreeSlug('component', 'group=3')).toBe('component-group-3');
    expect(sanitizeJobWorktreeSlug('e2e', 'Core Workflows')).toBe('e2e-Core-Workflows');
  });

  it('uses default when matrixKey is empty', () => {
    expect(sanitizeJobWorktreeSlug('frontend', '')).toBe('frontend-default');
  });
});

describe('jobWorktreePath', () => {
  it('nests under the run id so the source reaper can keep/drop the family', () => {
    expect(jobWorktreePath('/src', 'run-1', 'backend-tests', '0')).toBe(
      path.join('/src', 'run-1.job.backend-tests-0'),
    );
  });
});

describe('materializeJobWorktree', () => {
  it('gives each job an independent worktree (writes do not leak back)', async () => {
    const root = await tmpDir('git');
    const src = path.join(root, 'src');
    await execFileAsync('git', ['init', '--initial-branch=main', src]);
    await git(src, 'config', 'user.email', 'test@example.com');
    await git(src, 'config', 'user.name', 'Test');
    await writeFile(path.join(src, 'README.md'), 'hello\n');
    await git(src, 'add', '.');
    await git(src, 'commit', '-m', 'init');

    const a = path.join(root, 'job-a');
    const b = path.join(root, 'job-b');
    await materializeJobWorktree(src, a);
    await materializeJobWorktree(src, b);

    await writeFile(path.join(a, 'frontend-marker'), 'npm ci was here\n');
    await mkdir(path.join(a, '.venv'));
    expect(await readFile(path.join(src, 'README.md'), 'utf8')).toBe('hello\n');
    await expect(readFile(path.join(b, 'frontend-marker'), 'utf8')).rejects.toThrow();
    await expect(readFile(path.join(src, 'frontend-marker'), 'utf8')).rejects.toThrow();
  });

  it('copies git objects instead of hardlinking them so a job-container chown cannot mutate the source repo', async () => {
    const root = await tmpDir('nohl');
    const src = path.join(root, 'src');
    await execFileAsync('git', ['init', '--initial-branch=main', src]);
    await git(src, 'config', 'user.email', 'test@example.com');
    await git(src, 'config', 'user.name', 'Test');
    await writeFile(path.join(src, 'README.md'), 'hello\n');
    await git(src, 'add', '.');
    await git(src, 'commit', '-m', 'init');

    const dest = path.join(root, 'job');
    await materializeJobWorktree(src, dest);

    const objectsRoot = path.join(src, '.git', 'objects');
    let srcObj: string | null = null;
    for (const dir of await readdir(objectsRoot)) {
      if (dir.length !== 2) continue;
      const files = await readdir(path.join(objectsRoot, dir));
      const file = files[0];
      if (file) {
        srcObj = path.join(objectsRoot, dir, file);
        break;
      }
    }
    expect(srcObj).not.toBeNull();
    const destObj = path.join(dest, '.git', 'objects', path.relative(objectsRoot, srcObj!));
    expect((await stat(srcObj!)).ino).not.toBe((await stat(destObj)).ino);
  });

  it('falls back to a recursive copy when src is not a git checkout', async () => {
    const root = await tmpDir('cp');
    const src = path.join(root, 'plain');
    await mkdir(src);
    await writeFile(path.join(src, 'file.txt'), 'plain\n');
    const dest = path.join(root, 'copy');
    await materializeJobWorktree(src, dest);
    expect(await readFile(path.join(dest, 'file.txt'), 'utf8')).toBe('plain\n');
  });
});
