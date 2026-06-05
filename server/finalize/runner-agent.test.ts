import { describe, expect, it } from 'vitest';
import {
  runAgentJob,
  type AgentDocker,
  type AgentLogFrame,
  type AgentPollResult,
  type AgentTransport,
} from './runner-agent.js';
import type { TaskProtection } from './ecs-task-protection.js';
import type { RunnerJobWireSpec } from './runner-backend-remote.js';

/** Records the on/off protection calls so we can assert the job lifecycle. */
function fakeProtection(): TaskProtection & { calls: boolean[] } {
  const calls: boolean[] = [];
  return {
    calls,
    async set(enabled) {
      calls.push(enabled);
    },
  };
}

const wire = (over: Partial<RunnerJobWireSpec> = {}): RunnerJobWireSpec => ({
  orgId: 'o',
  projectId: 'p',
  runId: 'r',
  jobId: 'e2e',
  matrixKey: '',
  image: 'img',
  composeProjectName: 'cp',
  env: {},
  worktreeRef: null,
  ...over,
});

function fakes(polls: AgentPollResult[], exitFor: (run: string) => number) {
  let i = 0;
  const logs: AgentLogFrame[] = [];
  const results: Array<{ stepIndex: number; exitCode: number | null }> = [];
  const events: string[] = [];
  const transport: AgentTransport = {
    claim: async () => null,
    poll: async () => polls[i++] ?? { type: 'finish' },
    postLogs: async (_j, frames) => {
      logs.push(...frames);
    },
    postStepResult: async (_j, stepIndex, exitCode) => {
      results.push({ stepIndex, exitCode });
    },
    postFinish: async () => {
      events.push('finish');
    },
    heartbeat: async () => {},
  };
  const docker: AgentDocker = {
    startContainer: async (_spec, mount) => {
      events.push(`start:${mount}`);
      return 'c1';
    },
    execStep: async (_c, run, _env, onLog) => {
      onLog('stdout', `out:${run}\n`);
      return exitFor(run);
    },
    stopContainer: async (c) => {
      events.push(`stop:${c}`);
    },
  };
  return { transport, docker, logs, results, events };
}

describe('runAgentJob', () => {
  it('runs steps in order, streams logs, reports exits, tears down on finish', async () => {
    const { transport, docker, logs, results, events } = fakes(
      [
        { type: 'run_step', stepIndex: 0, run: 'echo a', env: {} },
        { type: 'idle' }, // long-poll miss between steps — skipped
        { type: 'run_step', stepIndex: 1, run: 'echo b', env: {} },
        { type: 'finish' },
      ],
      (run) => (run.includes('b') ? 2 : 0),
    );

    const { stepExits } = await runAgentJob({
      jobId: 'j',
      spec: wire(),
      workspaceDir: '/ws',
      transport,
      docker,
      logFlushMs: 5,
    });

    expect(stepExits).toEqual([
      { stepIndex: 0, exitCode: 0 },
      { stepIndex: 1, exitCode: 2 },
    ]);
    expect(results).toEqual([
      { stepIndex: 0, exitCode: 0 },
      { stepIndex: 1, exitCode: 2 },
    ]);
    expect(logs.map((f) => f.data)).toEqual(['out:echo a\n', 'out:echo b\n']);
    expect(logs.map((f) => f.seq)).toEqual([0, 1]); // job-monotonic seq
    expect(events).toEqual(['start:/ws/repo', 'stop:c1', 'finish']);
  });

  it('treats a 410/gone poll as teardown', async () => {
    const { transport, docker, events } = fakes([{ type: 'gone' }], () => 0);
    await runAgentJob({ jobId: 'j', spec: wire(), workspaceDir: '/ws', transport, docker });
    expect(events).toEqual(['start:/ws/repo', 'stop:c1', 'finish']);
  });

  it('protects the task on start and releases it on finish', async () => {
    const { transport, docker } = fakes(
      [{ type: 'run_step', stepIndex: 0, run: 'echo a', env: {} }, { type: 'finish' }],
      () => 0,
    );
    const protection = fakeProtection();
    await runAgentJob({
      jobId: 'j',
      spec: wire(),
      workspaceDir: '/ws',
      transport,
      docker,
      protection,
    });
    // First call protects (true); the final call (in finally) releases (false).
    expect(protection.calls[0]).toBe(true);
    expect(protection.calls.at(-1)).toBe(false);
  });

  it('still releases protection when the job throws', async () => {
    const { transport, docker } = fakes([{ type: 'finish' }], () => 0);
    docker.startContainer = async () => {
      throw new Error('dind boot failed');
    };
    const protection = fakeProtection();
    await expect(
      runAgentJob({ jobId: 'j', spec: wire(), workspaceDir: '/ws', transport, docker, protection }),
    ).rejects.toThrow('dind boot failed');
    expect(protection.calls[0]).toBe(true);
    expect(protection.calls.at(-1)).toBe(false);
  });

  it('materializes the worktree when a bundle ref is present', async () => {
    const { transport, docker } = fakes([{ type: 'finish' }], () => 0);
    const materialized: string[] = [];
    await runAgentJob({
      jobId: 'j',
      spec: wire({ worktreeRef: { key: 'worktrees/o/r.bundle', sha256: 'x', sizeBytes: 1 } }),
      workspaceDir: '/ws',
      transport,
      docker,
      materialize: async (_spec, dest) => {
        materialized.push(dest);
      },
    });
    expect(materialized).toEqual(['/ws/repo']);
  });
});
