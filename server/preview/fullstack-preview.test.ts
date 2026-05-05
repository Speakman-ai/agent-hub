/**
 * Unit tests for `<agenthub:preview target="fullstack">` handler.
 *
 * Acceptance criteria from kanban card 3ea62a10:
 *   - target="fullstack" path opens a draft PR via gh CLI
 *   - polls PR-env status and emits attachment once container is healthy
 *   - falls back gracefully when project-level PR-env feature is disabled
 *     ("PR-env not configured — only client previews available")
 *   - full sequence test: <agenthub:preview target="fullstack"> →
 *     draft PR → preview attachment (mocked PR-env)
 *
 * The git/gh runners and the pool_slots reader are all injected, so the
 * tests don't shell out or touch SQLite. The runner fakes record their
 * argv lists so we can assert on idempotency (no double `git push`,
 * `gh pr create --draft` always invoked first).
 */

import { describe, it, expect } from 'vitest';
import {
  handleFullstackPreviewBlock,
  buildPrEnvPreviewUrl,
  type CommandRunner,
  type FullstackPreviewDeps,
  type PoolSlotRow,
} from './fullstack-preview.js';
import type { PreviewBroadcastEvent } from './preview-block.js';
import type { Project } from '../types.js';

// ─── Test doubles ──────────────────────────────────────────────────────

function recordBroadcast(): {
  broadcast: (e: Record<string, unknown>) => void;
  events: PreviewBroadcastEvent[];
} {
  const events: PreviewBroadcastEvent[] = [];
  return {
    broadcast(e) {
      events.push(e as unknown as PreviewBroadcastEvent);
    },
    events,
  };
}

interface RunnerCall {
  args: string[];
  cwd: string;
}

function makeRunner(
  responses: Array<{
    match: (args: string[]) => boolean;
    result: { stdout?: string; stderr?: string };
    throws?: Error;
  }>,
): { runner: CommandRunner; calls: RunnerCall[] } {
  const calls: RunnerCall[] = [];
  const runner: CommandRunner = async (args, cwd) => {
    calls.push({ args: [...args], cwd });
    const handler = responses.find((r) => r.match([...args]));
    if (!handler) {
      throw new Error(`Unexpected runner call: ${args.join(' ')}`);
    }
    if (handler.throws) throw handler.throws;
    return {
      stdout: handler.result.stdout ?? '',
      stderr: handler.result.stderr ?? '',
    };
  };
  return { runner, calls };
}

function configuredProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'proj-1',
    name: 'Project One',
    cwd: '/repo',
    ahw: '/ahw',
    agents: [],
    prEnv: {
      enabled: true,
      startScript: './scripts/pr-env.sh',
      internalPort: 3000,
    },
    ...overrides,
  } as Project;
}

interface BuildDepsOpts {
  project?: Project;
  previewBaseUrl?: string;
  git: CommandRunner;
  gh: CommandRunner;
  slots?: Array<PoolSlotRow | null>;
}

function makeDeps(opts: BuildDepsOpts): FullstackPreviewDeps & {
  events: PreviewBroadcastEvent[];
  slotCalls: number[];
} {
  const { broadcast, events } = recordBroadcast();
  let slotCalls = 0;
  const slots = opts.slots ?? [];
  const slotCallsLog: number[] = [];
  const deps: FullstackPreviewDeps = {
    broadcast,
    project: opts.project ?? configuredProject(),
    worktreePath: '/wt/sess-1',
    previewBaseUrl: opts.previewBaseUrl ?? 'https://preview.example.com',
    git: opts.git,
    gh: opts.gh,
    getPoolSlotByPrNumber: (prNumber) => {
      slotCallsLog.push(prNumber);
      // Walk the script in order. Past the end, repeat the last value
      // (typical "stays in the terminal state forever" behaviour).
      const idx = slotCalls < slots.length ? slotCalls : slots.length - 1;
      slotCalls += 1;
      return slots[idx] ?? null;
    },
    readyTimeoutMs: 50,
    readyPollIntervalMs: 1,
    sleep: () => Promise.resolve(),
  };
  return Object.assign(deps, { events, slotCalls: slotCallsLog });
}

// ─── URL builder ───────────────────────────────────────────────────────

describe('buildPrEnvPreviewUrl', () => {
  it('joins base + pr-N without double slashes', () => {
    expect(buildPrEnvPreviewUrl('https://preview.example.com', 42)).toBe(
      'https://preview.example.com/pr-42',
    );
  });
  it('strips a trailing slash from the base', () => {
    expect(buildPrEnvPreviewUrl('https://preview.example.com/', 7)).toBe(
      'https://preview.example.com/pr-7',
    );
  });
});

// ─── Gates ─────────────────────────────────────────────────────────────

describe('handleFullstackPreviewBlock — gating', () => {
  it('emits preview_unavailable when project has no prEnv', async () => {
    const project = { id: 'p1', name: 'p', cwd: '/r', ahw: '/a', agents: [] } as Project;
    const { runner: git } = makeRunner([]);
    const { runner: gh } = makeRunner([]);
    const deps = makeDeps({ project, git, gh });

    await handleFullstackPreviewBlock('s1', { target: 'fullstack', route: '/' }, deps);

    expect(deps.events).toHaveLength(1);
    expect(deps.events[0].kind).toBe('preview_unavailable');
    expect(deps.events[0].unavailableReason).toBe('no-pr-env');
    expect(deps.events[0].target).toBe('fullstack');
    expect(deps.events[0].wizardUrl).toContain('/projects/p1/settings/');
  });

  it('emits preview_unavailable when project.prEnv.enabled is false', async () => {
    const project = configuredProject({
      prEnv: { enabled: false, startScript: 'x', internalPort: 3000 },
    });
    const { runner: git } = makeRunner([]);
    const { runner: gh } = makeRunner([]);
    const deps = makeDeps({ project, git, gh });

    await handleFullstackPreviewBlock('s1', { target: 'fullstack', route: '/' }, deps);

    expect(deps.events[0].kind).toBe('preview_unavailable');
    expect(deps.events[0].unavailableReason).toBe('no-pr-env');
  });

  it('emits preview_unavailable when previewBaseUrl is empty (PR-env not configured globally)', async () => {
    const { runner: git } = makeRunner([]);
    const { runner: gh } = makeRunner([]);
    const deps = makeDeps({ git, gh, previewBaseUrl: '   ' });

    await handleFullstackPreviewBlock('s1', { target: 'fullstack', route: '/' }, deps);

    expect(deps.events[0].kind).toBe('preview_unavailable');
    expect(deps.events[0].unavailableReason).toBe('no-pr-env');
  });
});

// ─── Pre-PR validation ─────────────────────────────────────────────────

describe('handleFullstackPreviewBlock — git/PR pre-checks', () => {
  it('rejects when worktree has no commits with the user-facing copy', async () => {
    const { runner: git, calls: gitCalls } = makeRunner([
      {
        match: (a) => a[0] === 'rev-list',
        result: { stdout: '0\n' },
      },
    ]);
    const { runner: gh, calls: ghCalls } = makeRunner([]);
    const deps = makeDeps({ git, gh });

    await handleFullstackPreviewBlock('s1', { target: 'fullstack', route: '/' }, deps);

    expect(deps.events[0].kind).toBe('preview_failed');
    expect(deps.events[0].error).toContain('Commit before requesting fullstack preview');
    // Should not have attempted any gh / branch resolution.
    expect(ghCalls).toHaveLength(0);
    expect(gitCalls.map((c) => c.args[0])).toEqual(['rev-list']);
  });

  it('rejects when HEAD is detached (branch resolves to "HEAD")', async () => {
    const { runner: git } = makeRunner([
      { match: (a) => a[0] === 'rev-list', result: { stdout: '5\n' } },
      {
        match: (a) => a[0] === 'rev-parse' && a.includes('--abbrev-ref'),
        result: { stdout: 'HEAD\n' },
      },
    ]);
    const { runner: gh } = makeRunner([]);
    const deps = makeDeps({ git, gh });

    await handleFullstackPreviewBlock('s1', { target: 'fullstack', route: '/' }, deps);

    expect(deps.events[0].kind).toBe('preview_failed');
    expect(deps.events[0].error).toContain('detached HEAD');
  });

  it('surfaces a push failure as preview_failed without proceeding to gh', async () => {
    const { runner: git, calls: gitCalls } = makeRunner([
      { match: (a) => a[0] === 'rev-list', result: { stdout: '5\n' } },
      { match: (a) => a[0] === 'rev-parse', result: { stdout: 'feature/foo\n' } },
      {
        match: (a) => a[0] === 'push',
        result: {},
        throws: new Error('fatal: remote rejected — branch protection'),
      },
    ]);
    const { runner: gh, calls: ghCalls } = makeRunner([]);
    const deps = makeDeps({ git, gh });

    await handleFullstackPreviewBlock('s1', { target: 'fullstack', route: '/' }, deps);

    expect(deps.events[0].kind).toBe('preview_failed');
    expect(deps.events[0].error).toContain('git push failed');
    expect(deps.events[0].error).toContain('branch protection');
    expect(ghCalls).toHaveLength(0);
    // git push must have used `-u origin <branch>`
    const pushCall = gitCalls.find((c) => c.args[0] === 'push');
    expect(pushCall?.args).toEqual(['push', '-u', 'origin', 'feature/foo']);
  });
});

// ─── Happy path + idempotency ──────────────────────────────────────────

describe('handleFullstackPreviewBlock — happy path', () => {
  it('opens a draft PR, polls until busy, and emits a preview event with prUrl/prNumber', async () => {
    const { runner: git, calls: gitCalls } = makeRunner([
      { match: (a) => a[0] === 'rev-list', result: { stdout: '3\n' } },
      { match: (a) => a[0] === 'rev-parse', result: { stdout: 'feature/x\n' } },
      { match: (a) => a[0] === 'push', result: {} },
    ]);
    const { runner: gh, calls: ghCalls } = makeRunner([
      {
        match: (a) => a[0] === 'pr' && a[1] === 'create',
        result: {
          stdout: 'https://github.com/acme/repo/pull/42\n',
        },
      },
    ]);
    const deps = makeDeps({
      git,
      gh,
      slots: [
        null, // first poll: no row yet (webhook hasn't fired)
        { slot_id: 'pr-1', class: 'pr_env', status: 'reserved', container_id: 'c1', pr_number: 42 },
        { slot_id: 'pr-1', class: 'pr_env', status: 'busy', container_id: 'c1', pr_number: 42 },
      ],
    });

    await handleFullstackPreviewBlock(
      's1',
      { target: 'fullstack', route: '/dashboard', reason: 'show new chart' },
      deps,
    );

    expect(deps.events).toHaveLength(1);
    const event = deps.events[0];
    expect(event.kind).toBe('preview');
    expect(event.target).toBe('fullstack');
    expect(event.prUrl).toBe('https://github.com/acme/repo/pull/42');
    expect(event.prNumber).toBe(42);
    expect(event.previewUrl).toBe('https://preview.example.com/pr-42');
    expect(event.fullUrl).toBe('https://preview.example.com/pr-42/dashboard');
    expect(event.agentReason).toBe('show new chart');
    expect(event.route).toBe('/dashboard');

    // Argv assertions: --draft must be present.
    const createCall = ghCalls.find((c) => c.args.includes('create'));
    expect(createCall?.args).toContain('--draft');
    expect(createCall?.args).toContain('--head');
    expect(createCall?.args).toContain('feature/x');

    // git ran rev-list, rev-parse, push — and only push uses -u origin.
    const pushCall = gitCalls.find((c) => c.args[0] === 'push');
    expect(pushCall?.args).toEqual(['push', '-u', 'origin', 'feature/x']);

    // We polled the slot reader at least until it returned busy.
    expect(deps.slotCalls.length).toBeGreaterThanOrEqual(3);
    expect(deps.slotCalls.every((n) => n === 42)).toBe(true);
  });

  it('omits the route segment from fullUrl when route is "/"', async () => {
    const { runner: git } = makeRunner([
      { match: (a) => a[0] === 'rev-list', result: { stdout: '1\n' } },
      { match: (a) => a[0] === 'rev-parse', result: { stdout: 'feature/y\n' } },
      { match: (a) => a[0] === 'push', result: {} },
    ]);
    const { runner: gh } = makeRunner([
      {
        match: (a) => a[0] === 'pr' && a[1] === 'create',
        result: { stdout: 'https://github.com/acme/repo/pull/7\n' },
      },
    ]);
    const deps = makeDeps({
      git,
      gh,
      slots: [
        { slot_id: 'pr-1', class: 'pr_env', status: 'busy', container_id: 'c1', pr_number: 7 },
      ],
    });

    await handleFullstackPreviewBlock('s1', { target: 'fullstack', route: '/' }, deps);

    expect(deps.events[0].fullUrl).toBe('https://preview.example.com/pr-7');
  });
});

// ─── PR already exists path ────────────────────────────────────────────

describe('handleFullstackPreviewBlock — idempotent PR creation', () => {
  it('recovers when gh pr create fails because a PR already exists (URL in error)', async () => {
    const { runner: git } = makeRunner([
      { match: (a) => a[0] === 'rev-list', result: { stdout: '2\n' } },
      { match: (a) => a[0] === 'rev-parse', result: { stdout: 'feature/dup\n' } },
      { match: (a) => a[0] === 'push', result: {} },
    ]);
    const { runner: gh, calls: ghCalls } = makeRunner([
      {
        match: (a) => a[0] === 'pr' && a[1] === 'create',
        result: {},
        throws: new Error(
          'a pull request for branch "feature/dup" already exists: https://github.com/acme/repo/pull/99',
        ),
      },
    ]);
    const deps = makeDeps({
      git,
      gh,
      slots: [
        { slot_id: 'pr-1', class: 'pr_env', status: 'busy', container_id: 'c1', pr_number: 99 },
      ],
    });

    await handleFullstackPreviewBlock('s1', { target: 'fullstack', route: '/' }, deps);

    expect(deps.events[0].kind).toBe('preview');
    expect(deps.events[0].prNumber).toBe(99);
    expect(deps.events[0].prUrl).toBe('https://github.com/acme/repo/pull/99');
    // Only the create call should have happened (URL was in the error
    // string, no fallback `gh pr view` needed).
    const ghCmds = ghCalls.map((c) => c.args.slice(0, 2).join(' '));
    expect(ghCmds).toEqual(['pr create']);
  });

  it('falls back to `gh pr view --json` when the create error has no URL', async () => {
    const { runner: git } = makeRunner([
      { match: (a) => a[0] === 'rev-list', result: { stdout: '2\n' } },
      { match: (a) => a[0] === 'rev-parse', result: { stdout: 'feature/dup\n' } },
      { match: (a) => a[0] === 'push', result: {} },
    ]);
    const { runner: gh, calls: ghCalls } = makeRunner([
      {
        match: (a) => a[0] === 'pr' && a[1] === 'create',
        result: {},
        throws: new Error('something else went wrong'),
      },
      {
        match: (a) => a[0] === 'pr' && a[1] === 'view',
        result: {
          stdout: JSON.stringify({
            url: 'https://github.com/acme/repo/pull/123',
            number: 123,
            state: 'OPEN',
          }),
        },
      },
    ]);
    const deps = makeDeps({
      git,
      gh,
      slots: [
        { slot_id: 'pr-1', class: 'pr_env', status: 'busy', container_id: 'c1', pr_number: 123 },
      ],
    });

    await handleFullstackPreviewBlock('s1', { target: 'fullstack', route: '/' }, deps);

    expect(deps.events[0].kind).toBe('preview');
    expect(deps.events[0].prNumber).toBe(123);
    const ghCmds = ghCalls.map((c) => c.args.slice(0, 2).join(' '));
    expect(ghCmds).toEqual(['pr create', 'pr view']);
  });

  it('reports preview_failed when neither create succeeds nor view recovers', async () => {
    const { runner: git } = makeRunner([
      { match: (a) => a[0] === 'rev-list', result: { stdout: '2\n' } },
      { match: (a) => a[0] === 'rev-parse', result: { stdout: 'feature/x\n' } },
      { match: (a) => a[0] === 'push', result: {} },
    ]);
    const { runner: gh } = makeRunner([
      {
        match: (a) => a[0] === 'pr' && a[1] === 'create',
        result: {},
        throws: new Error('oops'),
      },
      {
        match: (a) => a[0] === 'pr' && a[1] === 'view',
        result: {},
        throws: new Error('no pull requests found'),
      },
    ]);
    const deps = makeDeps({ git, gh });

    await handleFullstackPreviewBlock('s1', { target: 'fullstack', route: '/' }, deps);

    expect(deps.events[0].kind).toBe('preview_failed');
    expect(deps.events[0].error).toContain('no existing PR was found');
  });
});

// ─── Container never ready ─────────────────────────────────────────────

describe('handleFullstackPreviewBlock — container readiness', () => {
  it('times out with preview_failed when the slot never reaches busy', async () => {
    const { runner: git } = makeRunner([
      { match: (a) => a[0] === 'rev-list', result: { stdout: '2\n' } },
      { match: (a) => a[0] === 'rev-parse', result: { stdout: 'feature/slow\n' } },
      { match: (a) => a[0] === 'push', result: {} },
    ]);
    const { runner: gh } = makeRunner([
      {
        match: (a) => a[0] === 'pr' && a[1] === 'create',
        result: { stdout: 'https://github.com/acme/repo/pull/55\n' },
      },
    ]);
    const deps = makeDeps({
      git,
      gh,
      // Always reserved — never flips to busy.
      slots: [
        { slot_id: 'pr-1', class: 'pr_env', status: 'reserved', container_id: null, pr_number: 55 },
      ],
    });

    await handleFullstackPreviewBlock('s1', { target: 'fullstack', route: '/' }, deps);

    expect(deps.events[0].kind).toBe('preview_failed');
    expect(deps.events[0].prNumber).toBe(55);
    expect(deps.events[0].prUrl).toBe('https://github.com/acme/repo/pull/55');
    expect(deps.events[0].error).toMatch(/did not reach ready/);
  });

  it('short-circuits with preview_failed when slot transitions to failed', async () => {
    const { runner: git } = makeRunner([
      { match: (a) => a[0] === 'rev-list', result: { stdout: '2\n' } },
      { match: (a) => a[0] === 'rev-parse', result: { stdout: 'feature/broken\n' } },
      { match: (a) => a[0] === 'push', result: {} },
    ]);
    const { runner: gh } = makeRunner([
      {
        match: (a) => a[0] === 'pr' && a[1] === 'create',
        result: { stdout: 'https://github.com/acme/repo/pull/77\n' },
      },
    ]);
    const deps = makeDeps({
      git,
      gh,
      slots: [
        { slot_id: 'pr-1', class: 'pr_env', status: 'reserved', container_id: null, pr_number: 77 },
        { slot_id: 'pr-1', class: 'pr_env', status: 'failed', container_id: 'cX', pr_number: 77 },
      ],
    });

    await handleFullstackPreviewBlock('s1', { target: 'fullstack', route: '/' }, deps);

    expect(deps.events[0].kind).toBe('preview_failed');
    expect(deps.events[0].error).toContain('failed state');
    expect(deps.events[0].prNumber).toBe(77);
  });
});
