import { vi, type Mock, describe, it, expect, beforeEach } from 'vitest';
import os from 'os';
import type { Project } from './types.js';

vi.mock('./skill-credentials-spawn.js', () => ({
  mergeSkillCredentialSpawnEnv: vi.fn(),
}));

vi.mock('child_process', () => {
  const mockSpawn = vi.fn();
  const noopExec = vi.fn(
    (
      _file: unknown,
      _args: unknown,
      _opts: unknown,
      cb: (err: Error | null, value: { stdout: string; stderr: string }) => void,
    ) => {
      if (typeof cb === 'function') cb(null, { stdout: '', stderr: '' });
    },
  );
  return { spawn: mockSpawn, execFile: noopExec, exec: noopExec };
});

const { spawn } = await import('child_process');
const { mergeSkillCredentialSpawnEnv } = await import('./skill-credentials-spawn.js');
const { runClaude } = await import('./heartbeat.js');

const spawnMock = spawn as Mock;
const mergeMock = mergeSkillCredentialSpawnEnv as Mock;

interface MockProc {
  stdout: { on: Mock };
  stderr: { on: Mock };
  on: Mock;
  kill: Mock;
}

function setupSpawnSuccess(stdout: string): void {
  spawnMock.mockImplementation((): MockProc => {
    const proc: MockProc = {
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      on: vi.fn(),
      kill: vi.fn(),
    };
    setTimeout(() => {
      const dataCb = proc.stdout.on.mock.calls.find((c: unknown[]) => c[0] === 'data')?.[1] as
        | ((buf: Buffer) => void)
        | undefined;
      if (dataCb) dataCb(Buffer.from(stdout));
      const closeCb = proc.on.mock.calls.find((c: unknown[]) => c[0] === 'close')?.[1] as
        | ((code: number) => void)
        | undefined;
      if (closeCb) closeCb(0);
    }, 1);
    return proc;
  });
}

const tmp = os.tmpdir();

const fakeProject = {
  id: 'proj-skill-cred-test',
  name: 'T',
  cwd: tmp,
  agents: [],
  ahw: `${tmp}/ahw-skill-test`,
} as unknown as Project;

beforeEach(() => {
  spawnMock.mockReset();
  mergeMock.mockReset();
});

describe('runClaude — skill credential merge', () => {
  it('invokes mergeSkillCredentialSpawnEnv on the spawn env when skillCredentialMerge is set', async () => {
    setupSpawnSuccess('ok');
    await runClaude('hello', tmp, undefined, {
      skillCredentialMerge: {
        ownerId: 'user-1',
        agentId: 'agent-1',
        project: fakeProject,
      },
    });

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(mergeMock).toHaveBeenCalledTimes(1);
    const spawnOpts = spawnMock.mock.calls[0][2] as { env: NodeJS.ProcessEnv };
    expect(mergeMock.mock.calls[0][0]).toBe(spawnOpts.env);
    expect(mergeMock.mock.calls[0][1]).toEqual({
      ownerId: 'user-1',
      agentId: 'agent-1',
      project: fakeProject,
    });
  });

  it('does not call mergeSkillCredentialSpawnEnv when skillCredentialMerge is omitted', async () => {
    setupSpawnSuccess('ok');
    await runClaude('hello', tmp, undefined, {});
    expect(mergeMock).not.toHaveBeenCalled();
  });
});
