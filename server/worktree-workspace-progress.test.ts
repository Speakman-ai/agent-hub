/**
 * Regression test for the "so many preparing session workspaces" bug.
 *
 * The open-time `POST /workspace/ensure` runs on every session activation and
 * calls `provisionSessionWorkspace`, which used to emit the "Preparing session
 * workspace" progress step unconditionally — so browsing the sidebar flashed
 * that step on every already-cloned session. `sessionWorkspaceNeedsProvisionProgress`
 * decides whether the step is warranted: only when a clone is actually pending.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { execSync } from 'child_process';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import path from 'path';
import os from 'os';

const { sessionWorkspaceNeedsProvisionProgress } = await import('./worktree.js');

describe('sessionWorkspaceNeedsProvisionProgress', () => {
  const created: string[] = [];

  afterEach(() => {
    for (const p of created.splice(0)) {
      try {
        rmSync(p, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
  });

  function makeTempDir(name: string): string {
    const dir = path.join(
      os.tmpdir(),
      `ws-progress-${name}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`,
    );
    mkdirSync(dir, { recursive: true });
    created.push(dir);
    return dir;
  }

  it('needs progress when the worktree path is empty / null / undefined', () => {
    expect(sessionWorkspaceNeedsProvisionProgress(null)).toBe(true);
    expect(sessionWorkspaceNeedsProvisionProgress(undefined)).toBe(true);
    expect(sessionWorkspaceNeedsProvisionProgress('')).toBe(true);
    expect(sessionWorkspaceNeedsProvisionProgress('   ')).toBe(true);
  });

  it('needs progress when the recorded path is gone (reaped clone, row survived)', () => {
    const missing = path.join(os.tmpdir(), `ws-progress-missing-${process.pid}-nope`);
    expect(sessionWorkspaceNeedsProvisionProgress(missing)).toBe(true);
  });

  it('needs progress when the dir exists but holds no finished clone', () => {
    const dir = makeTempDir('incomplete');
    writeFileSync(path.join(dir, 'README'), 'not a git clone\n');
    expect(sessionWorkspaceNeedsProvisionProgress(dir)).toBe(true);
  });

  it('does NOT need progress for an already-complete clone (the reuse-on-open case)', () => {
    const dir = makeTempDir('complete');
    execSync('git init --initial-branch=main', { cwd: dir, stdio: 'pipe' });
    execSync('git config user.email t@e.st && git config user.name test', {
      cwd: dir,
      stdio: 'pipe',
    });
    writeFileSync(path.join(dir, 'file.txt'), 'hello\n');
    execSync('git add -A && git commit -m init', { cwd: dir, stdio: 'pipe' });

    expect(sessionWorkspaceNeedsProvisionProgress(dir)).toBe(false);
  });
});
