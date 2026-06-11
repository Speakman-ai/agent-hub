import { describe, it, expect, beforeEach } from 'vitest';
import {
  createGithubRepo,
  createGithubExecutor,
  resolveVisibility,
  GithubProvisioningError,
  type GithubSpawn,
  type GithubSpawnResult,
} from './github.js';
import {
  _resetJobsForTests,
  startProvisioningJob,
  subscribeToJob,
  type ProvisioningEvent,
  type ProvisioningExecutor,
} from './orchestrator.js';

/**
 * Build a scripted spawner: each call pops the next `GithubSpawnResult`
 * off the queue in order and records the argv that was invoked. Lets
 * the tests assert both the exact command sequence and the cwd, without
 * touching the real `gh` / `git` binaries or the network.
 */
function scriptedSpawn(steps: GithubSpawnResult[]): {
  spawn: GithubSpawn;
  calls: Array<{ command: string; args: readonly string[]; cwd: string }>;
} {
  const calls: Array<{ command: string; args: readonly string[]; cwd: string }> = [];
  const queue = [...steps];
  const spawn: GithubSpawn = async (command, args, { cwd }) => {
    calls.push({ command, args, cwd });
    const next = queue.shift();
    if (!next) {
      throw new Error(`scriptedSpawn exhausted — unexpected call: ${command} ${args.join(' ')}`);
    }
    return next;
  };
  return { spawn, calls };
}

const OK = (stdout = '', stderr = ''): GithubSpawnResult => ({
  exitCode: 0,
  signal: null,
  stdout,
  stderr,
});
const FAIL = (exitCode: number, stderr: string, stdout = ''): GithubSpawnResult => ({
  exitCode,
  signal: null,
  stdout,
  stderr,
});

describe('resolveVisibility', () => {
  it('defaults idk to private so we never accidentally go public', () => {
    expect(resolveVisibility('idk')).toBe('private');
    expect(resolveVisibility(null)).toBe('private');
    expect(resolveVisibility(undefined)).toBe('private');
    expect(resolveVisibility('')).toBe('private');
  });

  it('passes through the three valid gh repo visibility values', () => {
    expect(resolveVisibility('public')).toBe('public');
    expect(resolveVisibility('private')).toBe('private');
    expect(resolveVisibility('internal')).toBe('internal');
  });
});

describe('createGithubRepo — happy path', () => {
  it('runs preflight, create, and push in order with the correct cwd', async () => {
    const { spawn, calls } = scriptedSpawn([
      // preflight
      OK('gh version 2.50.0'),
      OK('Logged in to github.com as alice'),
      // gh repo create
      OK('https://github.com/alice/my-thing\n'),
      // rev-parse HEAD → has commits
      OK('abcd1234'),
      // git push
      OK(),
    ]);
    const logs: string[] = [];
    const result = await createGithubRepo({
      name: 'my-thing',
      visibility: 'idk',
      cwd: '/work/my-thing',
      emit: (line) => logs.push(line),
      spawn,
    });

    expect(result.repoUrl).toBe('https://github.com/alice/my-thing');

    expect(calls[0]).toMatchObject({ command: 'gh', args: ['--version'], cwd: '/work/my-thing' });
    expect(calls[1]).toMatchObject({ command: 'gh', args: ['auth', 'status'] });
    expect(calls[2]).toMatchObject({
      command: 'gh',
      args: ['repo', 'create', 'my-thing', '--private', '--source=.', '--remote=origin'],
      cwd: '/work/my-thing',
    });
    expect(calls[3]).toMatchObject({ command: 'git', args: ['rev-parse', '--verify', 'HEAD'] });
    expect(calls[4]).toMatchObject({ command: 'git', args: ['push', '-u', 'origin', 'HEAD'] });
  });

  it('creates an initial commit when the tree has no HEAD yet', async () => {
    const { spawn, calls } = scriptedSpawn([
      OK('gh version 2.50.0'),
      OK('Logged in'),
      OK('https://github.com/alice/brand-new\n'),
      // rev-parse HEAD fails → no commits yet
      FAIL(128, 'fatal: Needed a single revision'),
      OK(), // git add .
      OK(), // git commit -m
      OK(), // git push
    ]);
    const result = await createGithubRepo({
      name: 'brand-new',
      visibility: 'private',
      cwd: '/tmp/w',
      emit: () => {},
      spawn,
    });
    expect(result.repoUrl).toBe('https://github.com/alice/brand-new');

    const commands = calls.map((c) => `${c.command} ${c.args.join(' ')}`);
    expect(commands).toContain('git add .');
    expect(commands).toContain('git commit -m Initial scaffold by Agent Hub');
    expect(commands[commands.length - 1]).toBe('git push -u origin HEAD');
  });

  it('honours explicit --public when the user picked public', async () => {
    const { spawn, calls } = scriptedSpawn([
      OK('gh version'),
      OK('Logged in'),
      OK('https://github.com/alice/oss-thing\n'),
      OK('abc'),
      OK(),
    ]);
    await createGithubRepo({
      name: 'oss-thing',
      visibility: 'public',
      cwd: '/work',
      emit: () => {},
      spawn,
    });
    expect(calls[2]!.args).toEqual([
      'repo',
      'create',
      'oss-thing',
      '--public',
      '--source=.',
      '--remote=origin',
    ]);
  });

  it('falls back to git remote get-url when gh is quiet on stdout', async () => {
    const { spawn } = scriptedSpawn([
      OK('gh version'),
      OK('Logged in'),
      OK(''), // gh repo create: no URL on stdout
      OK('git@github.com:alice/ssh-style.git\n'), // git remote get-url
      OK('abc'),
      OK(),
    ]);
    const result = await createGithubRepo({
      name: 'ssh-style',
      visibility: 'private',
      cwd: '/work',
      emit: () => {},
      spawn,
    });
    // SSH-form origin URLs should be normalized to https://github.com/...
    expect(result.repoUrl).toBe('https://github.com/alice/ssh-style');
  });
});

describe('createGithubRepo — error classification', () => {
  it('throws GH_NOT_INSTALLED when `gh --version` fails', async () => {
    const { spawn } = scriptedSpawn([FAIL(-1, 'spawn gh ENOENT')]);
    await expect(
      createGithubRepo({
        name: 'x',
        visibility: 'private',
        cwd: '/w',
        emit: () => {},
        spawn,
      }),
    ).rejects.toMatchObject({
      code: 'GH_NOT_INSTALLED',
    });
  });

  it('throws GH_NOT_AUTHENTICATED when `gh auth status` fails', async () => {
    const { spawn } = scriptedSpawn([
      OK('gh version 2.50.0'),
      FAIL(1, 'You are not logged into any GitHub hosts.'),
    ]);
    await expect(
      createGithubRepo({
        name: 'x',
        visibility: 'private',
        cwd: '/w',
        emit: () => {},
        spawn,
      }),
    ).rejects.toMatchObject({
      code: 'GH_NOT_AUTHENTICATED',
      hint: expect.stringContaining('gh auth login'),
    });
  });

  it('throws GH_NAME_TAKEN when gh responds with a 422 name-taken error', async () => {
    const { spawn } = scriptedSpawn([
      OK('gh version'),
      OK('Logged in'),
      FAIL(1, 'GraphQL: Name already exists on this account (createRepository)'),
    ]);
    await expect(
      createGithubRepo({
        name: 'taken',
        visibility: 'private',
        cwd: '/w',
        emit: () => {},
        spawn,
      }),
    ).rejects.toMatchObject({
      code: 'GH_NAME_TAKEN',
      hint: expect.stringContaining('different'),
    });
  });

  it('throws GH_CREATE_FAILED for unrelated gh failures', async () => {
    const { spawn } = scriptedSpawn([
      OK('gh version'),
      OK('Logged in'),
      FAIL(1, 'some transient 500 error'),
    ]);
    await expect(
      createGithubRepo({
        name: 'x',
        visibility: 'private',
        cwd: '/w',
        emit: () => {},
        spawn,
      }),
    ).rejects.toMatchObject({ code: 'GH_CREATE_FAILED' });
  });

  it('throws GIT_PUSH_FAILED when the push step fails', async () => {
    const { spawn } = scriptedSpawn([
      OK('gh version'),
      OK('Logged in'),
      OK('https://github.com/alice/repo\n'),
      OK('abc'), // has HEAD
      FAIL(1, 'Authentication failed for https://github.com/'),
    ]);
    await expect(
      createGithubRepo({
        name: 'repo',
        visibility: 'private',
        cwd: '/w',
        emit: () => {},
        spawn,
      }),
    ).rejects.toBeInstanceOf(GithubProvisioningError);
  });
});

describe('createGithubExecutor', () => {
  it('handles mint-token as a noop (no token needed for local gh flow)', async () => {
    const { spawn } = scriptedSpawn([]); // zero spawn calls expected
    const executor = createGithubExecutor({
      resolveWorkspace: () => '/w',
      spawn,
    });

    const logs: string[] = [];
    const result = await executor.runPhase('mint-token', {
      jobId: 'j',
      projectId: 'p',
      payload: {},
      log: (line) => logs.push(line),
    });
    expect(result.status).toBe('ok');
    expect(logs.some((l) => l.includes('mint-token'))).toBe(true);
  });

  it('maps gh-create onto createGithubRepo and caches the repoUrl for gh-push', async () => {
    const { spawn, calls } = scriptedSpawn([
      OK('gh version'),
      OK('Logged in'),
      OK('https://github.com/alice/proj-x\n'),
      OK('abc'), // HEAD exists (we skip initial-commit)
      OK(), // git push
    ]);
    const executor = createGithubExecutor({
      resolveWorkspace: (projectId) => `/workspaces/${projectId}`,
      spawn,
    });

    const createResult = await executor.runPhase('gh-create', {
      jobId: 'job-xyz',
      projectId: 'proj-x',
      payload: { name: 'proj-x', visibility: 'public' },
      log: () => {},
    });
    expect(createResult).toMatchObject({
      status: 'ok',
      repoUrl: 'https://github.com/alice/proj-x',
    });
    // gh-create should have invoked preflight + gh repo create only —
    // NOT the push, which is its own phase.
    const ghCreateCmds = calls.map((c) => `${c.command} ${c.args.join(' ')}`);
    expect(ghCreateCmds).toEqual([
      'gh --version',
      'gh auth status',
      'gh repo create proj-x --public --source=. --remote=origin',
    ]);
    // And the cwd must be the workspace the resolver returned.
    expect(calls[0]!.cwd).toBe('/workspaces/proj-x');

    const pushResult = await executor.runPhase('gh-push', {
      jobId: 'job-xyz',
      projectId: 'proj-x',
      payload: { name: 'proj-x', visibility: 'public' },
      log: () => {},
    });
    expect(pushResult).toMatchObject({
      status: 'ok',
      repoUrl: 'https://github.com/alice/proj-x',
    });
  });

  it('falls back to project id when payload.name is "idk"', async () => {
    const { spawn, calls } = scriptedSpawn([
      OK('gh version'),
      OK('Logged in'),
      OK('https://github.com/alice/my-project-123\n'),
    ]);
    const executor = createGithubExecutor({
      resolveWorkspace: () => '/w',
      spawn,
    });
    await executor.runPhase('gh-create', {
      jobId: 'j',
      projectId: 'my-project-123',
      payload: { name: 'idk', visibility: 'idk' },
      log: () => {},
    });
    expect(calls[2]!.args).toEqual([
      'repo',
      'create',
      'my-project-123',
      '--private', // idk → private
      '--source=.',
      '--remote=origin',
    ]);
  });

  it('returns a structured PhaseResult on GH_NAME_TAKEN instead of throwing', async () => {
    const { spawn } = scriptedSpawn([
      OK('gh version'),
      OK('Logged in'),
      FAIL(1, 'HTTP 422: Name already exists on this account'),
    ]);
    const executor = createGithubExecutor({
      resolveWorkspace: () => '/w',
      spawn,
    });
    const result = await executor.runPhase('gh-create', {
      jobId: 'j',
      projectId: 'p',
      payload: { name: 'taken', visibility: 'private' },
      log: () => {},
    });
    expect(result.status).toBe('failed');
    expect(result.message).toContain('GH_NAME_TAKEN');
    expect(result.error?.hint).toBeTruthy();
  });

  it('delegates non-github phases to the fallback executor', async () => {
    const seen: string[] = [];
    const fallback: ProvisioningExecutor = {
      async runPhase(phase) {
        seen.push(phase);
        return { status: 'ok', message: 'fallback' };
      },
    };
    const executor = createGithubExecutor({
      resolveWorkspace: () => '/w',
      fallback,
    });
    const result = await executor.runPhase('copy-template', {
      jobId: 'j',
      projectId: 'p',
      payload: {},
      log: () => {},
    });
    expect(seen).toEqual(['copy-template']);
    expect(result.message).toBe('fallback');
  });
});

describe('orchestrator integration — GitHub phases wired through the executor', () => {
  beforeEach(() => {
    _resetJobsForTests();
  });

  async function waitForDone(events: ProvisioningEvent[], timeoutMs = 2000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (events.some((e) => e.type === 'done')) return;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error('timed out waiting for done');
  }

  it('emits skip events for gh-create/gh-push and never calls the github executor when integrations=[db]', async () => {
    // Scripted spawn that should never be called — any invocation fails the test.
    let spawnCalls = 0;
    const spawn: GithubSpawn = async () => {
      spawnCalls += 1;
      return OK();
    };
    const github = createGithubExecutor({
      resolveWorkspace: () => '/w',
      spawn,
      // For non-github phases, just ok them so the job completes.
      fallback: {
        async runPhase() {
          return { status: 'ok' };
        },
      },
    });

    startProvisioningJob({
      jobId: 'no-gh',
      payload: { description: 'local only', integrations: ['db'] },
      projectId: 'p',
      executor: github,
    });

    const events: ProvisioningEvent[] = [];
    subscribeToJob('no-gh', (ev) => events.push(ev));
    await waitForDone(events);

    // No spawn invocations for any github phase.
    expect(spawnCalls).toBe(0);

    const skipped = events.filter(
      (e) => e.type === 'phase' && (e as { status?: string }).status === 'skipped',
    ) as Array<{ phase: string }>;
    expect(skipped.map((s) => s.phase).sort()).toEqual(
      ['gh-create', 'gh-push', 'mint-token'].sort(),
    );

    const done = events.find((e) => e.type === 'done')!;
    expect((done as { error?: unknown }).error).toBeUndefined();
  });

  it('propagates repoUrl from gh-create through the terminal done event', async () => {
    const { spawn } = scriptedSpawn([
      OK('gh version'),
      OK('Logged in'),
      OK('https://github.com/alice/integrated\n'),
      OK('abc'),
      OK(), // push
    ]);
    const github = createGithubExecutor({
      resolveWorkspace: () => '/w',
      spawn,
      fallback: {
        async runPhase() {
          return { status: 'ok' };
        },
      },
    });

    startProvisioningJob({
      jobId: 'with-gh',
      payload: {
        description: 'scaffold me',
        name: 'integrated',
        visibility: 'private',
        integrations: ['github'],
        hostOnAgentHub: false,
      },
      projectId: 'integrated',
      executor: github,
    });

    const events: ProvisioningEvent[] = [];
    subscribeToJob('with-gh', (ev) => events.push(ev));
    await waitForDone(events);

    const done = events.find((e) => e.type === 'done') as {
      repoUrl?: string;
      error?: unknown;
    };
    expect(done.error).toBeUndefined();
    expect(done.repoUrl).toBe('https://github.com/alice/integrated');
  });

  it('emits a partial done when gh-create fails after git-init succeeded', async () => {
    const { spawn } = scriptedSpawn([
      OK('gh version'),
      OK('Logged in'),
      FAIL(1, 'GraphQL: Name already exists on this account'),
    ]);
    const github = createGithubExecutor({
      resolveWorkspace: () => '/w',
      spawn,
      fallback: {
        async runPhase() {
          return { status: 'ok' };
        },
      },
    });

    startProvisioningJob({
      jobId: 'partial',
      payload: { description: 'x', name: 'taken', integrations: ['github'], hostOnAgentHub: false },
      projectId: 'p',
      executor: github,
    });

    const events: ProvisioningEvent[] = [];
    subscribeToJob('partial', (ev) => events.push(ev));
    await waitForDone(events);

    const done = events.find((e) => e.type === 'done') as {
      partial?: boolean;
      error?: { message: string };
    };
    expect(done.partial).toBe(true);
    expect(done.error?.message).toMatch(/already exists/i);
  });
});
