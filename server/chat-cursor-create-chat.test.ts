import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildSpawnEnv } from './config.js';

const execFileMock = vi.hoisted(() =>
  vi.fn((...args: unknown[]) => {
    const cb = args.find((a) => typeof a === 'function') as
      | ((err: Error | null, stdout: string, stderr: string) => void)
      | undefined;
    if (cb) queueMicrotask(() => cb(null, 'cursor-engine-session-abc', ''));
    return {} as import('child_process').ChildProcess;
  }),
);

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    execFile: execFileMock as unknown as typeof actual.execFile,
  };
});

import createChatHandler, { type ChatHandlerDeps } from './chat.js';

function stubChatHandlerDeps(): ChatHandlerDeps {
  return {
    broadcast: vi.fn(),
    findAgent: vi.fn(),
    getEnrichedAgent: vi.fn(),
    activeProcesses: new Map(),
    activeDelegationSessions: new Set(),
    autonomousProjects: new Set(),
    getClaudeBin: () => '/tmp/claude',
    getCursorBin: () => '/tmp/cursor-agent',
    getGeminiBin: () => '/tmp/gemini',
    getCodexBin: () => '/tmp/codex',
    uploadsDir: '/tmp',
    resolveSlashSkill: vi.fn(),
    createCursorChat: undefined,
    ensureWorktree: vi.fn(async () => ''),
    drainQueue: vi.fn(),
    handleDelegation: vi.fn(async () => []),
    handleDelegationCancel: vi.fn(),
    synthesizeResults: vi.fn(),
    parseDelegateBlock: vi.fn(),
    autoCommitAndPR: vi.fn(),
    tryAutonomousDispatch: vi.fn(),
  };
}

describe('createCursorChat (chat handler)', () => {
  beforeEach(() => {
    execFileMock.mockClear();
  });

  it('passes cwd through and uses buildSpawnEnv (merged PATH) for execFile', async () => {
    const { createCursorChat } = createChatHandler(stubChatHandlerDeps());
    const cwd = '/tmp/agent-hub-worktree-xyz';
    const id = await createCursorChat(cwd);
    expect(id).toBe('cursor-engine-session-abc');

    expect(execFileMock).toHaveBeenCalledTimes(1);
    const call = execFileMock.mock.calls[0];
    const opts = call[2] as { cwd: string; env: NodeJS.ProcessEnv };
    expect(opts.cwd).toBe(cwd);
    expect(opts.env.PATH).toBe(buildSpawnEnv().PATH);
  });
});
