import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { applyFinalizeSpawnShipGuards } from './spawn-ship-guards.js';
import { DEFAULT_CI_CONFIG_RELATIVE_PATH } from './finalize-keys.js';
import { worktreeHasFinalizeCi } from './worktree-has-ci.js';

const tmpWorktree = path.join(os.tmpdir(), `finalize-guards-${Date.now()}`);

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

describe('applyFinalizeSpawnShipGuards', () => {
  beforeEach(() => {
    mkdirSync(path.join(tmpWorktree, '.agent-hub'), { recursive: true });
    writeFileSync(path.join(tmpWorktree, DEFAULT_CI_CONFIG_RELATIVE_PATH), 'steps: []\n');
  });

  afterEach(() => {
    rmSync(tmpWorktree, { recursive: true, force: true });
  });

  it('prepends guard dir to PATH when ci.yaml exists', () => {
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin' };
    applyFinalizeSpawnShipGuards(env, tmpWorktree);
    expect(env.AGENT_HUB_FINALIZE_CI_CONFIGURED).toBe('1');
    expect(env.PATH).toMatch(/spawn-guards/);
    expect(env.AGENT_HUB_REAL_GIT).toBeTruthy();
    expect(env.AGENT_HUB_REAL_GH).toBeTruthy();
  });

  it('is a no-op when worktree has no ci.yaml', () => {
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin' };
    applyFinalizeSpawnShipGuards(env, os.tmpdir());
    expect(env.AGENT_HUB_FINALIZE_CI_CONFIGURED).toBeUndefined();
    expect(env.PATH).toBe('/usr/bin:/bin');
  });
});
