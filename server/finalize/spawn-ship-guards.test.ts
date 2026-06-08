import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, chmodSync } from 'fs';
import { spawnSync } from 'child_process';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { applySessionGitGuards } from './spawn-ship-guards.js';
import { DEFAULT_CI_CONFIG_RELATIVE_PATH } from './finalize-keys.js';
import { worktreeHasFinalizeCi } from './worktree-has-ci.js';

const tmpWorktree = path.join(os.tmpdir(), `finalize-guards-${Date.now()}`);
const GUARD_GIT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'spawn-guards', 'git');

describe('worktreeHasFinalizeCi', () => {
  beforeEach(() => {
    mkdirSync(path.join(tmpWorktree, '.agent-hub'), { recursive: true });
    writeFileSync(path.join(tmpWorktree, DEFAULT_CI_CONFIG_RELATIVE_PATH), 'steps: []\n');
  });

  afterEach(() => {
    rmSync(tmpWorktree, { recursive: true, force: true });
  });

  it('detects ci.yaml in worktree', () => {
    expect(worktreeHasFinalizeCi(tmpWorktree)).toBe(true);
    expect(worktreeHasFinalizeCi(null)).toBe(false);
  });
});

describe('applySessionGitGuards', () => {
  afterEach(() => {
    rmSync(tmpWorktree, { recursive: true, force: true });
  });

  it('installs the shim + branch protection for a worktree WITH ci.yaml', () => {
    mkdirSync(path.join(tmpWorktree, '.agent-hub'), { recursive: true });
    writeFileSync(path.join(tmpWorktree, DEFAULT_CI_CONFIG_RELATIVE_PATH), 'steps: []\n');
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin' };
    applySessionGitGuards(env, tmpWorktree);
    expect(env.PATH).toMatch(/spawn-guards/);
    expect(env.AGENT_HUB_REAL_GIT).toBeTruthy();
    expect(env.AGENT_HUB_REAL_GH).toBeTruthy();
    expect(env.AGENT_HUB_PROTECT_SESSION_BRANCH).toBe('1');
    expect(env.AGENT_HUB_FINALIZE_CI_CONFIGURED).toBe('1');
  });

  it('installs branch protection even when the worktree has NO ci.yaml', () => {
    mkdirSync(tmpWorktree, { recursive: true });
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin' };
    applySessionGitGuards(env, tmpWorktree);
    // Branch protection is universal for worktree sessions...
    expect(env.PATH).toMatch(/spawn-guards/);
    expect(env.AGENT_HUB_PROTECT_SESSION_BRANCH).toBe('1');
    // ...but the Finalize-configured flag stays off for non-CI projects.
    expect(env.AGENT_HUB_FINALIZE_CI_CONFIGURED).toBeUndefined();
  });

  it('is a no-op when the session has no worktree', () => {
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin' };
    applySessionGitGuards(env, null);
    expect(env.PATH).toBe('/usr/bin:/bin');
    expect(env.AGENT_HUB_PROTECT_SESSION_BRANCH).toBeUndefined();
    expect(env.AGENT_HUB_REAL_GIT).toBeUndefined();
  });
});

// ─── git shim: branch-creation enforcement ───────────────────────────
// Exercises the actual shell shim (the mechanism that runs in the spawned
// agent's PATH), not just the installer. A fake REAL_GIT stands in for the
// real binary so the test is hermetic (no real repo, no real git/network).
describe('git spawn-guard shim — one-branch invariant', () => {
  const fakeGit = path.join(tmpWorktree, 'fake-git.sh');

  beforeEach(() => {
    mkdirSync(tmpWorktree, { recursive: true });
    // Fake git: report a current branch for symbolic-ref, otherwise echo a
    // marker + exit 0 so we can tell passthrough from a block.
    writeFileSync(
      fakeGit,
      [
        '#!/bin/sh',
        'if [ "$1" = "symbolic-ref" ]; then echo "session-branch"; exit 0; fi',
        'echo "PASSTHROUGH:$*"',
        'exit 0',
      ].join('\n') + '\n',
    );
    chmodSync(fakeGit, 0o755);
  });

  afterEach(() => {
    rmSync(tmpWorktree, { recursive: true, force: true });
  });

  function runShim(args: string[], extraEnv: Record<string, string> = {}) {
    return spawnSync('sh', [GUARD_GIT, ...args], {
      encoding: 'utf8',
      env: {
        PATH: '/usr/bin:/bin',
        AGENT_HUB_PROTECT_SESSION_BRANCH: '1',
        AGENT_HUB_REAL_GIT: fakeGit,
        ...extraEnv,
      },
    });
  }

  it.each([
    ['checkout', '-b', 'feature/x'],
    ['checkout', '-B', 'feature/x'],
    ['switch', '-c', 'feature/x'],
    ['switch', '--create', 'feature/x'],
    ['branch', 'feature/x'],
  ])('blocks `git %s %s ...`', (...args) => {
    const r = runShim(args);
    expect(r.status).toBe(3);
    expect(r.stderr).toMatch(/exactly one branch/);
    expect(r.stderr).toContain('session-branch');
    expect(r.stdout).not.toContain('PASSTHROUGH');
  });

  it.each([
    ['status'],
    ['commit', '-m', 'msg'],
    ['checkout', 'existing-branch'], // switch to existing, no -b
    ['checkout', '--', 'file.txt'], // restore a path
    ['branch'], // list
    ['branch', '--list'],
    ['branch', '--show-current'],
    ['branch', '-d', 'old'], // delete
    ['push'], // ship gate is a no-op without session env
  ])('passes through `git %s ...`', (...args) => {
    const r = runShim(args);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('PASSTHROUGH');
  });

  it('honors the AGENT_HUB_ALLOW_BRANCH_OPS operator override', () => {
    const r = runShim(['checkout', '-b', 'feature/x'], { AGENT_HUB_ALLOW_BRANCH_OPS: '1' });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('PASSTHROUGH');
  });

  it('does not block branch ops when protection is not enabled', () => {
    const r = spawnSync('sh', [GUARD_GIT, 'checkout', '-b', 'feature/x'], {
      encoding: 'utf8',
      env: { PATH: '/usr/bin:/bin', AGENT_HUB_REAL_GIT: fakeGit },
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('PASSTHROUGH');
  });
});
