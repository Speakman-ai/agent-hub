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

  it('installs shipping guards without branch protection when there is no worktree', () => {
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin' };
    applySessionGitGuards(env, null);
    expect(env.PATH).toMatch(/spawn-guards/);
    expect(env.AGENT_HUB_PROTECT_SESSION_BRANCH).toBeUndefined();
    expect(env.AGENT_HUB_REAL_GIT).toBeTruthy();
  });
});

// git shim: branch-creation enforcement
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

describe('session direct-shipping guards', () => {
  const stubDir = path.join(tmpWorktree, 'bin');
  const guardDir = path.dirname(GUARD_GIT);
  const skillScript = path.resolve(guardDir, '../../default-skills/github/scripts/gh-pr.sh');

  beforeEach(() => {
    mkdirSync(stubDir, { recursive: true });
    for (const name of ['git', 'gh']) {
      writeFileSync(path.join(stubDir, name), '#!/bin/sh\necho PASSTHROUGH\n', { mode: 0o755 });
    }
    writeFileSync(
      path.join(stubDir, 'curl'),
      '#!/bin/sh\nprintf "%s" "$TEST_GATE_RESPONSE"\nexit "${TEST_GATE_STATUS:-0}"\n',
      { mode: 0o755 },
    );
  });

  afterEach(() => rmSync(tmpWorktree, { recursive: true, force: true }));

  const commands = [
    { script: GUARD_GIT, args: ['push'] },
    { script: path.join(guardDir, 'gh'), args: ['pr', 'create'] },
    { script: skillScript, args: ['create', '--title', 'Test'] },
  ];

  it.each(commands)('denies $script $args without contacting real services', ({ script, args }) => {
    for (const extraEnv of [
      {
        TEST_GATE_RESPONSE: JSON.stringify({
          allowed: false,
          message: 'Use Finalize Code Changes.',
        }),
      },
      { TEST_GATE_STATUS: '7' },
      { TEST_GATE_RESPONSE: 'not JSON' },
      { AGENT_HUB_API_KEY: '' },
      { TEST_GATE_RESPONSE: '{}' },
      { TEST_GATE_RESPONSE: JSON.stringify({ allowed: true }) },
    ]) {
      const result = spawnSync('bash', [script, ...args], {
        encoding: 'utf8',
        env: {
          PATH: `${stubDir}:/usr/bin:/bin`,
          AGENT_HUB_SESSION_ID: 'test-session',
          AGENT_HUB_URL: 'http://127.0.0.1',
          AGENT_HUB_API_KEY: 'test-key',
          AGENT_HUB_REAL_GIT: path.join(stubDir, 'git'),
          AGENT_HUB_REAL_GH: path.join(stubDir, 'gh'),
          GH_TOKEN: 'gho_test',
          ...extraEnv,
        },
      });
      expect(result.status, result.stderr).toBe(2);
      expect(result.stderr).toContain('Finalize Code Changes');
      expect(result.stdout).not.toContain('PASSTHROUGH');
    }
  });

  it('leaves platform git/gh execution outside the session PATH untouched', () => {
    const platformEnv = { PATH: `${stubDir}:/usr/bin:/bin` };
    const sessionEnv = { ...platformEnv, AGENT_HUB_SESSION_ID: 'test-session' };
    applySessionGitGuards(sessionEnv, null);
    for (const [command, args] of [
      ['git', ['push']],
      ['gh', ['pr', 'create']],
    ] as const) {
      const result = spawnSync(command, [...args], { env: platformEnv, encoding: 'utf8' });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('PASSTHROUGH');
    }
    expect(platformEnv.PATH).not.toContain('spawn-guards');
    expect(sessionEnv.PATH).toContain('spawn-guards');
  });
});
