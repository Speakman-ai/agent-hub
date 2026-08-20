/**
 * Dispatch behaviour for user-authored custom background agents.
 *
 * Asserts the vertical slice that matters: a custom agent's *editable prompt*
 * is threaded through to the one-shot failover runner (the same path crons
 * use), as the configured owner. The runner and engine resolver are mocked so
 * no CLI is ever spawned.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from './types.js';

const mocks = vi.hoisted(() => ({
  getProjects: vi.fn<() => Project[]>(() => []),
  runWithFailover: vi.fn(),
  resolveOneShotEngine: vi.fn(),
}));

vi.mock('node-cron', () => ({
  default: { schedule: vi.fn(), validate: () => true },
}));

vi.mock('./db.js', () => ({ db: {}, stmts: { updateCronNextRun: { run: vi.fn() } } }));

vi.mock('./project-model.js', () => ({
  getProjects: mocks.getProjects,
  saveProjects: vi.fn(),
}));

vi.mock('./worktree.js', () => ({
  getOrCreateProcessWorktree: vi.fn(async (cwd: string) => cwd),
}));

vi.mock('./engine-resolver.js', () => ({
  resolveOneShotEngine: mocks.resolveOneShotEngine,
  NoEnginesAvailableError: class extends Error {},
}));

vi.mock('./one-shot-failover.js', () => ({
  runOneShotPromptWithFailover: mocks.runWithFailover,
  formatFailoverSummary: () => '',
}));

vi.mock('./per-user-cli-spawn.js', () => ({ resolveUserCliCredOverride: vi.fn(() => undefined) }));
vi.mock('./project-secrets-spawn.js', () => ({ mergeProjectSecretsSpawnEnv: vi.fn() }));
vi.mock('./project-aws-spawn.js', () => ({ mergeProjectAwsSpawnEnv: vi.fn() }));
vi.mock('./git-host/repo-store.js', () => ({ hostedBarePathForProject: () => null }));

const { dispatchBackgroundCustomAgent } = await import('./heartbeat.js');

function proj(over: Partial<Project> = {}): Project {
  return {
    id: 'p1',
    name: 'Test Project',
    cwd: '/tmp/p1',
    ahw: '/tmp/p1/.ahw',
    ...over,
  } as Project;
}

describe('dispatchBackgroundCustomAgent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveOneShotEngine.mockResolvedValue({
      engine: 'claude-code',
      model: 'claude-opus-4-8',
      fallbackUsed: false,
    });
    mocks.runWithFailover.mockResolvedValue({
      engine: 'claude-code',
      model: 'claude-opus-4-8',
      detailed: { code: 0, stdout: 'ok', stderr: '', timedOut: false },
      output: 'ok',
      failovers: [],
    });
  });

  it('runs the editable prompt as the configured owner', async () => {
    mocks.getProjects.mockReturnValue([
      proj({
        backgroundAgents: {
          custom: [
            {
              id: 'a1',
              name: 'Nightly digest',
              enabled: true,
              ownerUserId: 'user-9',
              prompt: 'Summarize open PRs',
            },
          ],
        },
      }),
    ]);

    await dispatchBackgroundCustomAgent('p1', 'a1');

    expect(mocks.runWithFailover).toHaveBeenCalledTimes(1);
    const input = mocks.runWithFailover.mock.calls[0]![0] as Record<string, unknown>;
    expect(input.prompt).toBe('Summarize open PRs');
    expect(input.userId).toBe('user-9');
    expect(input.scope).toContain('Nightly digest');
  });

  it('does nothing for a disabled agent', async () => {
    mocks.getProjects.mockReturnValue([
      proj({
        backgroundAgents: {
          custom: [{ id: 'a1', name: 'Off', enabled: false, prompt: 'x' }],
        },
      }),
    ]);
    await dispatchBackgroundCustomAgent('p1', 'a1');
    expect(mocks.runWithFailover).not.toHaveBeenCalled();
  });

  it('does nothing when the prompt is blank', async () => {
    mocks.getProjects.mockReturnValue([
      proj({
        backgroundAgents: {
          custom: [{ id: 'a1', name: 'Blank', enabled: true, prompt: '   ' }],
        },
      }),
    ]);
    await dispatchBackgroundCustomAgent('p1', 'a1');
    expect(mocks.runWithFailover).not.toHaveBeenCalled();
  });
});
