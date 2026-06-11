/**
 * `ensureOriginPointsAtHostedRepo` — heals clones whose origin predates a
 * project enabling Agent Hub git hosting (otherwise their pushes keep
 * landing on GitHub).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execSync } from 'child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import path from 'path';
import os from 'os';

vi.mock('./config.js', () => ({
  default: { defaultCwd: '/tmp', githubApp: null },
}));

const { ensureOriginPointsAtHostedRepo } = await import('./worktree.js');

function git(cwd: string, cmd: string): string {
  return execSync(`git ${cmd}`, { cwd, stdio: 'pipe' }).toString().trim();
}

describe('ensureOriginPointsAtHostedRepo', () => {
  let tmpRoot: string;
  let bare: string;
  let clone: string;

  beforeEach(() => {
    tmpRoot = path.join(
      os.tmpdir(),
      `origin-heal-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    bare = path.join(tmpRoot, 'hosted.git');
    mkdirSync(bare, { recursive: true });
    execSync('git init --bare --initial-branch=main', { cwd: bare, stdio: 'pipe' });

    clone = path.join(tmpRoot, 'clone');
    mkdirSync(clone, { recursive: true });
    execSync('git init --initial-branch=main', { cwd: clone, stdio: 'pipe' });
    git(clone, 'config user.email "t@example.com"');
    git(clone, 'config user.name "T"');
    writeFileSync(path.join(clone, 'f.txt'), 'x\n');
    git(clone, 'add f.txt');
    git(clone, 'commit -m one');
  });

  afterEach(() => {
    if (existsSync(tmpRoot)) rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('repoints a GitHub origin at the hosted bare repo so pushes land on the Hub', async () => {
    git(clone, 'remote add origin https://github.com/owner/repo.git');

    await ensureOriginPointsAtHostedRepo(clone, bare);

    expect(git(clone, 'remote get-url origin')).toBe(bare);
    git(clone, 'push -u origin main');
    expect(git(bare, 'rev-parse refs/heads/main')).toBe(git(clone, 'rev-parse HEAD'));
  });

  it('adds origin when missing and no-ops when already correct', async () => {
    await ensureOriginPointsAtHostedRepo(clone, bare); // no origin → add
    expect(git(clone, 'remote get-url origin')).toBe(bare);

    await ensureOriginPointsAtHostedRepo(clone, bare); // idempotent
    expect(git(clone, 'remote get-url origin')).toBe(bare);
  });

  it('never throws on a non-repo directory (best-effort)', async () => {
    const notRepo = path.join(tmpRoot, 'plain');
    mkdirSync(notRepo, { recursive: true });
    await expect(ensureOriginPointsAtHostedRepo(notRepo, bare)).resolves.toBeUndefined();
  });
});
