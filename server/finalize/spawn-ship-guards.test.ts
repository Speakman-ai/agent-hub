import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync, chmodSync } from 'fs';
import { spawnSync } from 'child_process';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { applySessionGitGuards } from './spawn-ship-guards.js';
import { DEFAULT_CI_CONFIG_RELATIVE_PATH } from './finalize-keys.js';
import { worktreeHasFinalizeCi } from './worktree-has-ci.js';

const tmpWorktree = path.join(os.tmpdir(), `finalize-guards-${Date.now()}`);
const GUARD_GIT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'spawn-guards', 'git');
// Real git, skipping any spawn-guards shim on PATH (a test run inside a Hub
// session has one first, and delegating to it would loop back into the fake).
const REAL_GIT_BIN =
  (process.env.PATH ?? '')
    .split(path.delimiter)
    .filter((dir) => dir && !dir.endsWith('spawn-guards'))
    .map((dir) => path.join(dir, 'git'))
    .find((candidate) => existsSync(candidate)) ?? 'git';

/**
 * Fake "real git" for shim tests: alias and command-list lookups go to the
 * real git binary so the shim resolves aliases exactly as git would; every
 * other call echoes a marker so a test can tell passthrough from a block.
 */
function fakeGitScript(extraLines: string[] = []): string {
  return (
    [
      '#!/bin/sh',
      ...extraLines,
      '_prev=""',
      'for _a in "$@"; do',
      '  case "$_prev:$_a" in',
      `    --get:alias.* | *:--list-cmds=*) exec "${REAL_GIT_BIN}" "$@" ;;`,
      '  esac',
      '  _prev="$_a"',
      'done',
      'echo "PASSTHROUGH:$*"',
      'exit 0',
    ].join('\n') + '\n'
  );
}

/** Keeps host git config (and its aliases) out of shim tests. */
const ISOLATED_GIT_CONFIG = { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };

/** Env that defines configured aliases the way a user's gitconfig would. */
function configuredAliases(aliases: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = { GIT_CONFIG_COUNT: String(Object.keys(aliases).length) };
  Object.entries(aliases).forEach(([name, value], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = `alias.${name}`;
    env[`GIT_CONFIG_VALUE_${i}`] = value;
  });
  return env;
}

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

  it('sets the No Guardrails flag only when asked, and clears an inherited one', () => {
    const on: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin' };
    applySessionGitGuards(on, null, { noGuardrails: true });
    expect(on.AGENT_HUB_NO_GUARDRAILS).toBe('1');

    const inherited: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin', AGENT_HUB_NO_GUARDRAILS: '1' };
    applySessionGitGuards(inherited, null);
    expect(inherited.AGENT_HUB_NO_GUARDRAILS).toBeUndefined();
  });

  it('sets the git write block only when asked, and clears an inherited one', () => {
    const on: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin' };
    applySessionGitGuards(on, null, { blockGitWrites: true });
    expect(on.AGENT_HUB_BLOCK_GIT_WRITES).toBe('1');

    const inherited: NodeJS.ProcessEnv = {
      PATH: '/usr/bin:/bin',
      AGENT_HUB_BLOCK_GIT_WRITES: '1',
    };
    applySessionGitGuards(inherited, null);
    expect(inherited.AGENT_HUB_BLOCK_GIT_WRITES).toBeUndefined();
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
      fakeGitScript([
        // The shim passes the caller's global options first, so look past them.
        'for _x in "$@"; do [ "$_x" = "symbolic-ref" ] && { echo "session-branch"; exit 0; }; done',
      ]),
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
        ...ISOLATED_GIT_CONFIG,
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
    // Global options before the command must not hide it.
    ['-C', '.', 'checkout', '-b', 'feature/x'],
    ['-c', 'core.pager=cat', 'switch', '-c', 'feature/x'],
    ['--no-pager', 'branch', 'feature/x'],
    // Combined short flags and abbreviated long options.
    ['checkout', '-qb', 'feature/x'],
    ['checkout', '-bfeature/x'],
    ['checkout', '--orph', 'feature/x'],
    ['checkout', '-t', 'origin/feature/x'],
    ['checkout', '--tra', 'origin/feature/x'],
    ['switch', '-qc', 'feature/x'],
    ['switch', '--cre', 'feature/x'],
    ['switch', '--force-cr', 'feature/x'],
    // Other ways to create a branch.
    ['branch', '-c', 'feature/x'],
    ['branch', '--cop', 'feature/x'],
    ['branch', '--format=%(refname)', 'feature/x'],
    ['branch', '-f', 'feature/x'],
    ['worktree', 'add', '../elsewhere'],
    // A known global option that takes a value does not hide the command.
    ['--attr-source', 'HEAD', 'checkout', '-b', 'feature/x'],
    // --format takes the next word as its value, so `-d` here is not delete.
    ['branch', '--format', '-d', 'feature/x'],
    ['branch', '--sor', '-v', 'feature/x'],
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
    ['-c', 'color.ui=never', 'branch'], // global -c is not the branch copy flag
    ['branch', '--list', '--format=%(refname)', 'x'],
    ['branch', '--format=%(refname:short) %(upstream)'],
    ['branch', '-qd', 'old'],
    ['branch', '--del', 'old'],
    ['branch', '-vv'],
    ['branch', '--contains', 'abc123'],
    ['push'], // ship gate is a no-op without session env
  ])('passes through `git %s ...`', (...args) => {
    const r = runShim(args);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('PASSTHROUGH');
  });

  it('ignores an alias that names a real command, as git does', () => {
    const r = runShim(['status'], configuredAliases({ status: 'checkout -b feature/x' }));
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('PASSTHROUGH:status');
  });

  it.each([['--frobnicate', 'checkout', '-b', 'feature/x']])(
    'refuses what it cannot read exactly: `git %s %s %s`',
    (...args: string[]) => {
      const r = runShim(args);
      expect(r.status).toBe(5);
      expect(r.stderr).toContain('cannot verify');
      expect(r.stdout).not.toContain('PASSTHROUGH');
    },
  );

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
    writeFileSync(path.join(stubDir, 'git'), fakeGitScript(), { mode: 0o755 });
    writeFileSync(
      path.join(stubDir, 'gh'),
      [
        '#!/bin/sh',
        // `gh alias list` output for alias tests.
        'if [ "$1" = "alias" ] && [ "$2" = "list" ]; then cat "${GH_ALIAS_FIXTURE:-$(dirname "$0")/aliases.txt}"; exit 0; fi',
        'echo PASSTHROUGH',
      ].join('\n') + '\n',
      { mode: 0o755 },
    );
    writeFileSync(
      path.join(stubDir, 'aliases.txt'),
      [
        'pc: pr create',
        "pq: pr 'create'",
        'pe: "pr" new',
        'pp: pr $1',
        'p2: $1 $2',
        'co: pr checkout',
      ].join('\n') + '\n',
    );
    writeFileSync(
      path.join(stubDir, 'curl'),
      '#!/bin/sh\nprintf "%s" "$TEST_GATE_RESPONSE"\nexit "${TEST_GATE_STATUS:-0}"\n',
      { mode: 0o755 },
    );
  });

  afterEach(() => rmSync(tmpWorktree, { recursive: true, force: true }));

  const commands = [
    { script: GUARD_GIT, args: ['push'] },
    { script: GUARD_GIT, args: ['-C', '.', 'push', 'origin', 'HEAD'] },
    { script: GUARD_GIT, args: ['-c', 'push.default=current', 'push'] },
    { script: path.join(guardDir, 'gh'), args: ['pr', '-R', 'owner/repo', 'create'] },
    { script: path.join(guardDir, 'gh'), args: ['pr', '--repo=owner/repo', 'create'] },
    { script: path.join(guardDir, 'gh'), args: ['pr', 'new', '--title', 'x'] },
    { script: path.join(guardDir, 'gh'), args: ['pc', '--title', 'x'] },
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

  it.each(commands)('lets $script $args through in a No Guardrails session', ({ script, args }) => {
    const result = spawnSync('bash', [script, ...args], {
      encoding: 'utf8',
      env: {
        PATH: `${stubDir}:/usr/bin:/bin`,
        AGENT_HUB_SESSION_ID: 'test-session',
        AGENT_HUB_URL: 'http://127.0.0.1',
        AGENT_HUB_API_KEY: 'test-key',
        AGENT_HUB_REAL_GIT: path.join(stubDir, 'git'),
        AGENT_HUB_REAL_GH: path.join(stubDir, 'gh'),
        AGENT_HUB_NO_GUARDRAILS: '1',
        GH_TOKEN: 'gho_test',
        TEST_GATE_RESPONSE: JSON.stringify({ allowed: false, message: 'blocked' }),
      },
    });
    expect(result.stderr).not.toContain('blocked');
    expect(result.stdout).toContain('PASSTHROUGH');
  });

  // gh fills $1, $2, … from the caller's arguments, so `gh pp create` runs
  // `pr create`. The shim cannot know the command and refuses.
  it.each([
    ['pp', 'create'],
    ['pp', 'new', '--title', 'x'],
    ['p2', 'pr', 'create'],
  ])('refuses gh alias with placeholders: gh %s %s', (...args: string[]) => {
    const result = spawnSync('bash', [path.join(guardDir, 'gh'), ...args], {
      encoding: 'utf8',
      env: {
        PATH: `${stubDir}:/usr/bin:/bin`,
        AGENT_HUB_SESSION_ID: 'test-session',
        AGENT_HUB_URL: 'http://127.0.0.1',
        AGENT_HUB_API_KEY: 'test-key',
        AGENT_HUB_REAL_GH: path.join(stubDir, 'gh'),
        TEST_GATE_RESPONSE: JSON.stringify({ allowed: true }),
      },
    });
    expect(result.status, result.stderr).toBe(5);
    expect(result.stderr).toContain('placeholders');
    expect(result.stdout).not.toContain('PASSTHROUGH');
  });

  // gh ships `co` as a configurable alias, not a command, so it gets the
  // same lookup as any other name.
  function runGhWithAliases(aliasLines: string[], args: string[]) {
    const fixture = path.join(stubDir, 'aliases-case.txt');
    writeFileSync(fixture, aliasLines.join('\n') + '\n');
    return spawnSync('bash', [path.join(guardDir, 'gh'), ...args], {
      encoding: 'utf8',
      env: {
        PATH: `${stubDir}:/usr/bin:/bin`,
        AGENT_HUB_SESSION_ID: 'test-session',
        AGENT_HUB_URL: 'http://127.0.0.1',
        AGENT_HUB_API_KEY: 'test-key',
        AGENT_HUB_REAL_GH: path.join(stubDir, 'gh'),
        GH_ALIAS_FIXTURE: fixture,
        TEST_GATE_RESPONSE: JSON.stringify({
          allowed: false,
          message: 'Use Finalize Code Changes.',
        }),
      },
    });
  }

  it.each([
    [['co: pr create'], ['co']],
    [['co: pr new'], ['co', '--title', 'x']],
    // a name that is also a command, configured as an alias anyway
    [['pr: pr create'], ['pr', 'list']],
    // the name is matched as text, not a pattern
    [['p.: pr list', 'px: pr create'], ['px']],
  ])('consults the ship gate for alias %j: gh %j', (aliases, args) => {
    const result = runGhWithAliases(aliases as string[], args as string[]);
    expect(result.status, result.stderr).toBe(2);
    expect(result.stderr).toContain('Finalize Code Changes');
    expect(result.stdout).not.toContain('PASSTHROUGH');
  });

  it.each([
    [['co: !gh pr create'], ['co']],
    [['co: pr $1'], ['co', 'create']],
    [["co: pr 'create'"], ['co']],
    [['co: "pr" new'], ['co']],
    [["co: pr -R 'a b' create"], ['co']],
  ])('refuses alias %j it cannot verify: gh %j', (aliases, args) => {
    const result = runGhWithAliases(aliases as string[], args as string[]);
    expect(result.status, result.stderr).toBe(5);
    expect(result.stdout).not.toContain('PASSTHROUGH');
  });

  it('runs gh co as pr checkout without the gate', () => {
    const result = runGhWithAliases(['co: pr checkout'], ['co', '123']);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('PASSTHROUGH');
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

describe('git spawn-guard shim — no-code-change sessions', () => {
  const fakeDir = path.join(os.tmpdir(), `git-write-block-${process.pid}`);
  const fakeGit = path.join(fakeDir, 'fake-git.sh');

  beforeEach(() => {
    mkdirSync(fakeDir, { recursive: true });
    writeFileSync(fakeGit, fakeGitScript());
    chmodSync(fakeGit, 0o755);
  });

  afterEach(() => {
    rmSync(fakeDir, { recursive: true, force: true });
  });

  function runShim(args: string[], block = true, extraEnv: Record<string, string> = {}) {
    return spawnSync('sh', [GUARD_GIT, ...args], {
      encoding: 'utf8',
      env: {
        PATH: '/usr/bin:/bin',
        AGENT_HUB_REAL_GIT: fakeGit,
        ...ISOLATED_GIT_CONFIG,
        ...(block ? { AGENT_HUB_BLOCK_GIT_WRITES: '1' } : {}),
        ...extraEnv,
      },
    });
  }

  it.each([
    ['commit', '-m', 'wip'],
    ['add', '.'],
    ['-C', '/some/repo', 'commit', '-am', 'x'],
    ['-c', 'user.name=x', 'commit'],
    ['--no-pager', 'reset', '--hard'],
    ['checkout', '--', 'server/foo.ts'],
    ['restore', 'server/foo.ts'],
    ['merge', 'origin/main'],
    ['rebase', 'origin/main'],
    ['cherry-pick', 'abc123'],
    ['stash'],
    ['stash', 'pop'],
    ['worktree', 'add', '../x'],
    ['branch', '-D', 'other'],
    ['apply', 'fix.patch'],
    ['pull'],
    ['read-tree', '--reset', '-u', 'HEAD'],
    ['checkout-index', '-a', '-f'],
    ['commit-tree', 'HEAD^{tree}', '-m', 'x'],
    ['merge-file', 'a', 'base', 'b'],
    ['sparse-checkout', 'set', 'docs'],
    ['submodule', 'update'],
    ['bisect', 'start'],
    // Inline and configured aliases are unknown names, so the allowlist refuses them.
    ['save', '-m', 'wip'],
    ['co', 'main'],
    ['--exec-path=/tmp/evil', 'status'],
    ['fetch', 'origin', 'main:main'],
    // fetch writes refs from --refmap, refspecs and remote.*.fetch config.
    ['fetch', 'origin'],
    ['fetch', '--refmap=+refs/heads/main:refs/heads/review-target', 'origin', 'main'],
    ['-c', 'remote.origin.fetch=+refs/heads/*:refs/heads/*', 'fetch', 'origin'],
    // Read commands that would write a file.
    ['diff', '--output=server/foo.ts', 'HEAD'],
    ['diff', '--output', 'server/foo.ts', 'HEAD'],
    ['diff', '--outp=server/foo.ts'],
    ['log', '-p', '--ou', 'server/foo.ts'],
    ['show', '--output=x', 'HEAD'],
    ['stash', 'show', '--output=x'],
    ['range-diff', '--output=x', 'a...b'],
    ['config', '--get', 'user.name', '--edit'],
    ['config', '--list', '--add', 'user.name', 'x'],
    // Combined short flags and abbreviated long options on mixed commands.
    ['symbolic-ref', '-qd', 'refs/remotes/origin/HEAD'],
    ['symbolic-ref', '--del', 'refs/remotes/origin/HEAD'],
    ['symbolic-ref', '-d', 'refs/remotes/origin/HEAD'],
    ['branch', '-qD', 'old'],
    ['branch', '--del', 'old'],
    ['branch', '--mov', 'new-name'],
    ['branch', '-a', 'new-thing'],
    ['tag', '--del', 'v1'],
    ['tag', '-ld', 'v1'],
    ['config', '--get', 'user.name', '--ed'],
    ['config', '--unset-a', 'user.name'],
    ['config', '--file', 'x', '--get', 'user.name'],
    ['worktree', 'list', '--expire=now'],
    ['remote', '-v', 'add', 'x', 'https://example.com/x.git'],
    ['remote', 'show', '--foo', 'origin'],
    ['stash', '--', 'list'],
    ['reflog', 'delete', 'HEAD@{0}'],
    ['reflog', 'main'],
    ['diff', '--outpu=server/foo.ts'],
    ['reflog', 'expire', '--all'],
    ['remote', 'add', 'x', 'https://example.com/x.git'],
    ['config', 'user.name', 'x'],
    ['config', 'set', 'user.name', 'x'],
    ['branch', 'new-thing'],
    ['branch', '--set-upstream-to=origin/main'],
    ['tag', 'v1'],
    ['tag', '-a', 'v1', '-m', 'x'],
    ['symbolic-ref', 'HEAD', 'refs/heads/other'],
    ['hash-object', '-w', 'file'],
    ['some-future-command'],
  ])('blocks `git %s`', (...args: string[]) => {
    const result = runShim(args);
    expect(result.status).toBe(4);
    expect(result.stderr).toContain('this session cannot change code');
    expect(result.stdout).not.toContain('PASSTHROUGH');
  });

  it.each([
    ['status'],
    ['log', '--oneline', '-5'],
    ['diff', 'HEAD~1'],
    ['show', 'HEAD'],
    ['-C', '/some/repo', 'status'],
    ['stash', 'list'],
    ['worktree', 'list'],
    ['branch', '--show-current'],
    ['grep', 'commit'],
    ['--version'],
    ['-c', 'color.ui=never', 'branch'],
    ['branch', '-a'],
    ['branch', '--contains', 'abc123'],
    ['config', '--get', 'user.name'],
    ['config', 'get', 'user.name'],
    ['remote', '-v'],
    ['remote', 'get-url', 'origin'],
    ['tag', '-l', 'v*'],
    ['symbolic-ref', 'HEAD'],
    ['rev-parse', 'HEAD'],
    ['reflog'],
    ['diff', '--ours'],
    ['diff', '--stat', '*.ts'],
    ['log', '--oneline', '--', 'server/'],
  ])('lets read-only `git %s` through', (...args: string[]) => {
    const result = runShim(args);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('PASSTHROUGH');
  });

  // Git splits aliases with its own quoting rules, so a write-blocked
  // session refuses every alias instead of approximating them.
  it.each([
    ['-c', 'alias.save=commit', 'save', '-m', 'wip'],
    ['-c', 'alias.l=log --output=server/foo.ts', 'l'],
    ['-c', "alias.l=log '--output=server/foo.ts'", 'l'],
    ['-c', 'alias.l=log "--output=server/foo.ts"', 'l'],
    ['-c', 'alias.l=log \\--output=server/foo.ts', 'l'],
    ['-c', 'alias.s=-c x.y=z commit', 's', '-m', 'wip'],
    ['-c', 'alias.lg=log --oneline', 'lg'],
  ])('refuses alias `git %s %s %s`', (...args: string[]) => {
    const result = runShim(args);
    expect(result.status).toBe(5);
    expect(result.stderr).toContain('git aliases do not run');
    expect(result.stdout).not.toContain('PASSTHROUGH');
  });

  it('refuses a configured alias, even for a read command', () => {
    for (const aliases of [{ save: 'commit' }, { lg: 'log --oneline' }] as Record<
      string,
      string
    >[]) {
      const [name] = Object.keys(aliases);
      const result = runShim([name], true, configuredAliases(aliases));
      expect(result.status).toBe(5);
      expect(result.stdout).not.toContain('PASSTHROUGH');
    }
  });

  it('refuses a global option it does not know', () => {
    const result = runShim(['--frobnicate', 'HEAD', 'status']);
    expect(result.status).toBe(5);
    expect(result.stdout).not.toContain('PASSTHROUGH');
  });

  it('refuses a shell alias even when it only reads', () => {
    const result = runShim(['st'], true, configuredAliases({ st: '!git status' }));
    expect(result.status).toBe(5);
    expect(result.stdout).not.toContain('PASSTHROUGH');
  });

  it('leaves writes alone when the block is off', () => {
    const result = runShim(['commit', '-m', 'wip'], false);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('PASSTHROUGH:commit -m wip');
  });
});

// Git aliases are refused in every guarded session (branch protection,
// write block, push gate). Git resolves them with its own quoting, through
// chains of any length, and with `-c` inside an expansion changing the
// config the next lookup sees; the shim does not try to follow any of it.
describe('git spawn-guard shim — aliases', () => {
  const dir = path.join(os.tmpdir(), `git-alias-guard-${process.pid}`);
  const fakeGit = path.join(dir, 'fake-git.sh');
  const curl = path.join(dir, 'curl');

  beforeEach(() => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(fakeGit, fakeGitScript(), { mode: 0o755 });
    writeFileSync(curl, '#!/bin/sh\nprintf "%s" "$TEST_GATE_RESPONSE"\n', { mode: 0o755 });
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const GUARDS: Record<string, Record<string, string>> = {
    'branch protection': { AGENT_HUB_PROTECT_SESSION_BRANCH: '1' },
    'write block': { AGENT_HUB_BLOCK_GIT_WRITES: '1' },
    'push gate': {
      AGENT_HUB_SESSION_ID: 'test-session',
      AGENT_HUB_URL: 'http://127.0.0.1',
      AGENT_HUB_API_KEY: 'test-key',
      TEST_GATE_RESPONSE: JSON.stringify({ allowed: true }),
    },
  };

  function run(args: string[], guard: Record<string, string>, extra: Record<string, string> = {}) {
    return spawnSync('sh', [GUARD_GIT, ...args], {
      encoding: 'utf8',
      env: {
        PATH: `${dir}:/usr/bin:/bin`,
        AGENT_HUB_REAL_GIT: fakeGit,
        ...ISOLATED_GIT_CONFIG,
        ...guard,
        ...extra,
      },
    });
  }

  // A chain longer than any expansion limit, ending in push / branch -c.
  const chain = (end: string) => {
    const aliases: Record<string, string> = {};
    for (let i = 1; i <= 11; i++) aliases[`a${i}`] = `a${i + 1}`;
    aliases.a12 = end;
    return configuredAliases(aliases);
  };

  const INLINE: string[][] = [
    ['-c', 'alias.p=push', 'p', 'origin', 'HEAD'],
    ['-c', 'alias.nb=checkout -b', 'nb', 'feature/x'],
    ['-c', 'alias.nb=-c core.pager=cat switch -c', 'nb', 'feature/x'],
    // an alias that defines the next alias before git resolves it
    ['-c', 'alias.outer=-c alias.inner=push inner', 'outer', 'origin', 'HEAD'],
    ['-c', 'alias.outer=-c alias.inner=checkout\\ -b inner', 'outer', 'feature/x'],
    // quoted values with spaces that would move the command word
    ['-c', "alias.p=-c 'x.y=a b' push", 'p'],
    ['-c', 'alias.p=-c "x.y=a b" push', 'p'],
    ['-c', 'alias.p=-c x.y=a\\ b push', 'p'],
    ['-c', "alias.p='push'", 'p'],
    ['-c', 'alias.p=!git push', 'p'],
    ['-c', 'alias.lg=log --oneline', 'lg'],
  ];

  for (const [mode, guard] of Object.entries(GUARDS)) {
    it.each(INLINE)(`${mode}: refuses alias git %s %s %s`, (...args: string[]) => {
      const r = run(args, guard);
      expect(r.status, r.stderr).toBe(5);
      expect(r.stderr).toContain('git aliases do not run');
      expect(r.stdout).not.toContain('PASSTHROUGH');
    });

    it.each([
      ['push', ['a1', 'origin', 'HEAD']],
      ['branch -c feature/x', ['a1']],
      ['checkout -b feature/x', ['a1']],
    ])(`${mode}: refuses a 12-link alias chain ending in %s`, (end, args) => {
      const r = run(args as string[], guard, chain(end as string));
      expect(r.status, r.stderr).toBe(5);
      expect(r.stdout).not.toContain('PASSTHROUGH');
    });

    it(`${mode}: an alias named like a command still runs the command`, () => {
      const r = run(['status'], guard, configuredAliases({ status: 'push' }));
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toContain('PASSTHROUGH');
    });
  }

  it('runs aliases untouched outside a guarded session', () => {
    const r = run(['-c', 'alias.lg=log --oneline', 'lg'], {});
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('PASSTHROUGH');
  });
});
