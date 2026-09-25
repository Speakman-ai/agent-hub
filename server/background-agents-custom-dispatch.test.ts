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
  dispatchSession: vi.fn(),
}));

vi.mock('./background-agent-session.js', () => ({
  dispatchBackgroundAgentSession: mocks.dispatchSession,
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
const { getBackgroundAgentRun, resetBackgroundAgentRuns } =
  await import('./background-agent-runs.js');

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
    resetBackgroundAgentRuns();
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

  it('test run (force) runs a disabled agent and records the output', async () => {
    mocks.getProjects.mockReturnValue([
      proj({
        backgroundAgents: {
          custom: [{ id: 'a1', name: 'Off', enabled: false, prompt: 'Do it' }],
        },
      }),
    ]);
    const result = await dispatchBackgroundCustomAgent('p1', 'a1', {
      force: true,
      trigger: 'manual',
    });
    expect(result).toEqual({ status: 'completed', ok: true });
    expect(mocks.runWithFailover).toHaveBeenCalledTimes(1);
    expect(getBackgroundAgentRun('p1', 'a1')).toMatchObject({
      status: 'succeeded',
      trigger: 'manual',
      output: 'ok',
    });
  });

  it('records a non-zero exit as a failed run', async () => {
    mocks.runWithFailover.mockResolvedValue({
      engine: 'claude-code',
      model: 'm',
      detailed: { code: 1, stdout: '', stderr: 'quota exceeded', timedOut: false },
      output: 'quota exceeded',
      failovers: [],
    });
    mocks.getProjects.mockReturnValue([
      proj({
        backgroundAgents: { custom: [{ id: 'a1', name: 'A', enabled: true, prompt: 'x' }] },
      }),
    ]);
    await dispatchBackgroundCustomAgent('p1', 'a1');
    expect(getBackgroundAgentRun('p1', 'a1')).toMatchObject({
      status: 'failed',
      trigger: 'schedule',
      error: 'quota exceeded',
    });
  });

  it('opens a session instead of a one-shot when runAsSession is on', async () => {
    mocks.dispatchSession.mockReturnValue({
      sessionId: 'sess-1',
      agentId: 'dev',
      skippedSkills: [],
    });
    mocks.getProjects.mockReturnValue([
      proj({
        backgroundAgents: {
          custom: [
            {
              id: 'a1',
              name: 'Triage',
              enabled: true,
              prompt: 'Triage',
              runAsSession: true,
              sessionMode: 'consult',
              skills: ['agent-hub-kanban'],
            },
          ],
        },
      }),
    ]);
    const result = await dispatchBackgroundCustomAgent('p1', 'a1');
    expect(result).toEqual({
      status: 'session',
      sessionId: 'sess-1',
      agentId: 'dev',
      skippedSkills: [],
    });
    expect(mocks.runWithFailover).not.toHaveBeenCalled();
    expect(mocks.dispatchSession.mock.calls[0]![1]).toMatchObject({
      sessionMode: 'consult',
      skills: ['agent-hub-kanban'],
    });
    expect(getBackgroundAgentRun('p1', 'a1')).toMatchObject({
      status: 'succeeded',
      sessionId: 'sess-1',
      sessionAgentId: 'dev',
    });
  });

  it('marks a session run failed, keeping the session link, when kickoff rejects', async () => {
    let fail!: (message: string) => void;
    mocks.dispatchSession.mockImplementation(
      (_p: unknown, _a: unknown, opts: { onKickoffError: (m: string) => void }) => {
        fail = opts.onKickoffError;
        return { sessionId: 'sess-2', agentId: 'dev', skippedSkills: [] };
      },
    );
    mocks.getProjects.mockReturnValue([
      proj({
        backgroundAgents: {
          custom: [{ id: 'a1', name: 'T', enabled: true, prompt: 'x', runAsSession: true }],
        },
      }),
    ]);
    await dispatchBackgroundCustomAgent('p1', 'a1');
    expect(getBackgroundAgentRun('p1', 'a1')?.status).toBe('succeeded');
    fail('engine unavailable');
    expect(getBackgroundAgentRun('p1', 'a1')).toMatchObject({
      status: 'failed',
      error: 'Session failed to start: engine unavailable',
      sessionId: 'sess-2',
      sessionAgentId: 'dev',
    });
  });

  it('skips a second run while one is in flight', async () => {
    let release!: (v: unknown) => void;
    mocks.runWithFailover.mockReturnValue(new Promise((r) => (release = r)));
    mocks.getProjects.mockReturnValue([
      proj({
        backgroundAgents: { custom: [{ id: 'a1', name: 'A', enabled: true, prompt: 'x' }] },
      }),
    ]);
    const first = dispatchBackgroundCustomAgent('p1', 'a1');
    await vi.waitFor(() => expect(mocks.runWithFailover).toHaveBeenCalled());
    expect(await dispatchBackgroundCustomAgent('p1', 'a1')).toEqual({
      status: 'skipped',
      reason: 'busy',
    });
    release({
      engine: 'claude-code',
      model: 'm',
      detailed: { code: 0, stdout: 'ok', stderr: '', timedOut: false },
      output: 'ok',
      failovers: [],
    });
    await first;
  });
});
