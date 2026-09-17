import './test/setup.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'crypto';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import type { ChildProcess } from 'child_process';
import type { ActiveChatProcess } from './active-chat-process.js';
import { getStmts } from './db.js';
import createChatHandler, { type ChatHandlerDeps } from './chat.js';
import type { Agent, EnrichedAgent, Project } from './types.js';

vi.mock('./per-user-cli-spawn.js', () => ({
  EngineAuthRequiredError: class EngineAuthRequiredError extends Error {},
  resolveSessionCliSpawnEnv: vi.fn(() => ({})),
}));

const testPrefix = `consult-perms-${randomUUID().slice(0, 8)}`;
let tmpRoot: string;

beforeAll(() => {
  tmpRoot = mkdtempSync(path.join(tmpdir(), 'consult-perms-'));
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function makeDeps(
  engine: string,
  activeProcesses: Map<string, ActiveChatProcess>,
  argvRecorderBin: string,
  projectMode = 'dev',
): ChatHandlerDeps {
  const agentId = `${testPrefix}-${engine}-agent`;
  const agent = { id: agentId, name: 'Consult read-only agent', engine } as Agent;
  const project = {
    id: `${testPrefix}-project`,
    name: 'Consult read-only project',
    cwd: tmpRoot,
    ahw: tmpRoot,
    mode: projectMode,
    agents: [],
  } as Project;
  const enriched = {
    id: agentId,
    name: 'Consult read-only agent',
    engine,
    projectId: project.id,
    cwd: tmpRoot,
    ahw: tmpRoot,
    workspace: tmpRoot,
  } as EnrichedAgent;

  return {
    broadcast: () => {},
    createCursorChat: undefined,
    findAgent: (id) => (id === agentId ? { project, agent } : null),
    getEnrichedAgent: (id) => (id === agentId ? enriched : null),
    activeProcesses,
    autonomousProjects: new Set(),
    getClaudeBin: () => argvRecorderBin,
    getCursorBin: () => argvRecorderBin,
    getGeminiBin: () => argvRecorderBin,
    getCodexBin: () => argvRecorderBin,
    getGrokBin: () => argvRecorderBin,
    uploadsDir: tmpRoot,
    resolveSlashSkill: vi.fn(),
    ensureWorktree: vi.fn(async () => tmpRoot),
    drainQueue: vi.fn(),
    autoCommitAndPR: vi.fn(async () => undefined),
    tryAutonomousDispatch: vi.fn(),
  };
}

function seedSession(
  engine: string,
  sessionMode: string,
  askMode = 0,
): { agentId: string; sessionId: string } {
  const agentId = `${testPrefix}-${engine}-agent`;
  const sessionId = `${testPrefix}-${engine}-session-${randomUUID().slice(0, 8)}`;
  getStmts().createSession.run(
    sessionId,
    agentId,
    'consult read-only test',
    engine,
    'auto',
    1,
    askMode,
    1,
  );
  getStmts().updateSessionMode.run(sessionMode, sessionId);
  return { agentId, sessionId };
}

async function waitFor(cond: () => boolean, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function spawnTurn(
  engine: string,
  options: { projectMode?: string; sessionMode?: string; askMode?: number } = {},
): Promise<string[]> {
  const argFile = path.join(tmpRoot, `${engine}-${randomUUID()}.args`);
  const argvRecorderBin = path.join(tmpRoot, `${engine}-${randomUUID()}-record-argv.sh`);
  writeFileSync(
    argvRecorderBin,
    `#!/bin/sh\nprintf "%s\\n" "$@" > "${argFile}"\ncat >/dev/null 2>&1\nexit 0\n`,
  );
  chmodSync(argvRecorderBin, 0o755);
  const activeProcesses = new Map<string, ActiveChatProcess>();
  const { handleChat } = createChatHandler(
    makeDeps(engine, activeProcesses, argvRecorderBin, options.projectMode),
  );
  const { agentId, sessionId } = seedSession(
    engine,
    options.sessionMode ?? 'consult',
    options.askMode ?? 0,
  );

  await handleChat(null, { type: 'chat', agentId, sessionId, content: 'Can you inspect this?' });
  await waitFor(() => existsSync(argFile));
  await waitFor(() => activeProcesses.size === 0);

  return readFileSync(argFile, 'utf8').trimEnd().split('\n');
}

describe('Consult session spawn permissions', () => {
  it('lets Claude run Hub wrappers while disabling direct edit tools', async () => {
    const args = await spawnTurn('claude-code');

    expect(args).toContain('--permission-mode');
    expect(args[args.indexOf('--permission-mode') + 1]).not.toBe('plan');
    expect(args).toContain('--disallowed-tools');
    expect(args).toEqual(expect.arrayContaining(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']));
  });

  it('keeps Gemini tool approval enabled so Hub wrapper commands can run', async () => {
    const args = await spawnTurn('gemini-cli');

    expect(args).toContain('--yolo');
  });

  it('keeps Grok tool approval enabled so Hub wrapper commands can run', async () => {
    const args = await spawnTurn('grok-cli');

    expect(args).toContain('--always-approve');
  });

  it('does not put Codex consult sessions in the read-only sandbox', async () => {
    const args = await spawnTurn('codex-cli');
    const sandboxIndex = args.indexOf('--sandbox');

    expect(sandboxIndex === -1 ? undefined : args[sandboxIndex + 1]).not.toBe('read-only');
    expect(
      args.includes('--full-auto') ||
        args.includes('--dangerously-bypass-approvals-and-sandbox') ||
        (sandboxIndex !== -1 && args[sandboxIndex + 1] !== 'read-only'),
    ).toBe(true);
  });

  it('keeps legacy workflow chat sessions Hub-capable with Claude edit tools disabled', async () => {
    const args = await spawnTurn('claude-code', {
      projectMode: 'workflow',
      sessionMode: 'chat',
    });

    expect(args).toContain('--permission-mode');
    expect(args[args.indexOf('--permission-mode') + 1]).not.toBe('plan');
    expect(args).toEqual(expect.arrayContaining(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']));
  });

  it('keeps legacy Ask-only rows in Claude plan permission mode', async () => {
    const args = await spawnTurn('claude-code', {
      sessionMode: 'chat',
      askMode: 1,
    });

    expect(args).toContain('--permission-mode');
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('plan');
  });
});
