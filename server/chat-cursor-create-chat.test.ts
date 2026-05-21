import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync } from 'fs';
import os from 'os';
import path from 'path';
import { buildSpawnEnv } from './config.js';

vi.mock('./host-cli-home.js', () => ({
  ensureHostCliHome: (dataDir: string) => path.join(dataDir, 'host-creds', 'home'),
  hostCliHomePath: (dataDir: string) => path.join(dataDir, 'host-creds', 'home'),
  hostCodexHomePath: (dataDir: string) => path.join(dataDir, 'host-creds', 'home', '.codex'),
  resolveCodexHomeForProbe: (_env: NodeJS.ProcessEnv | undefined, dataDir: string) =>
    path.join(dataDir, 'host-creds', 'home', '.codex'),
}));

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
  let isolatedHome: string;

  beforeEach(() => {
    execFileMock.mockClear();
    isolatedHome = mkdtempSync(path.join(os.tmpdir(), 'ah-chat-cursor-home-'));
    process.env.HOME = isolatedHome;
    delete process.env.CODEX_HOME;
  });

  it('passes cwd through and uses buildSpawnEnv (merged PATH) for execFile', async () => {
    const { createCursorChat } = createChatHandler(stubChatHandlerDeps());
    const cwd = '/tmp/agent-hub-worktree-xyz';
    const spawnEnv = buildSpawnEnv();
    const id = await createCursorChat(cwd, spawnEnv);
    expect(id).toBe('cursor-engine-session-abc');

    expect(execFileMock).toHaveBeenCalledTimes(1);
    const call = execFileMock.mock.calls[0];
    const opts = call[2] as { cwd: string; env: NodeJS.ProcessEnv };
    expect(opts.cwd).toBe(cwd);
    expect(opts.env).toBe(spawnEnv);
    expect(opts.env.PATH).toBe(spawnEnv.PATH);
  });
});
