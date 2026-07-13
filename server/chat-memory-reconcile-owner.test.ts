import './test/setup.js';
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import type { ChildProcess } from 'child_process';
import { getDb, getStmts } from './db.js';
import type { Agent, EnrichedAgent, Project } from './types.js';

const ownerPinnedEnv = { HOME: '/tmp/owner-home', OWNER_ENV: 'owner-env' };

vi.mock('./per-user-cli-spawn.js', () => ({
  EngineAuthRequiredError: class EngineAuthRequiredError extends Error {},
  resolveSessionCliSpawnEnv: vi.fn(() => ownerPinnedEnv),
}));

vi.mock('./memory.js', () => ({
  getMemoryContext: vi.fn(() => ''),
  appendDailyNote: vi.fn(),
  reconcileMemoryAfterSession: vi.fn(async () => undefined),
}));

vi.mock('./wiki.js', async () => {
  const actual = await vi.importActual<typeof import('./wiki.js')>('./wiki.js');
  return {
    ...actual,
    getWikiContext: vi.fn(async () => ''),
  };
});

const { resolveSessionCliSpawnEnv } = await import('./per-user-cli-spawn.js');
const { reconcileMemoryAfterSession } = await import('./memory.js');
const { default: config } = await import('./config.js');
const { default: createChatHandler } = await import('./chat.js');

const testPrefix = `cmro-${randomUUID().slice(0, 8)}`;
let binDir: string;
let claudeBin: string;
let previousClaudeBin: string;

beforeAll(() => {
  binDir = mkdtempSync(path.join(tmpdir(), 'chat-memory-owner-'));
  claudeBin = path.join(binDir, 'claude-jsonl.sh');
  previousClaudeBin = config.claudeBin;
  const longText = `owner scoped memory reconcile ${'x'.repeat(360)}`;
  writeFileSync(
    claudeBin,
    [
      '#!/bin/sh',
      'case "$*" in',
      '  *"concise summarizer"*)',
      "    printf '%s\\n' 'summary for memory reconcile'",
      '    exit 0',
      '    ;;',
      'esac',
      'cat > /dev/null 2>&1',
      `printf '%s\\n' '${JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: longText }] },
      }).replaceAll("'", "'\\''")}'`,
      'exit 0',
      '',
    ].join('\n'),
  );
  chmodSync(claudeBin, 0o755);
  config.claudeBin = claudeBin;
});

afterAll(() => {
  config.claudeBin = previousClaudeBin;
  rmSync(binDir, { recursive: true, force: true });
});

function makeDeps(agentId: string): Parameters<typeof createChatHandler>[0] {
  const project = {
    id: `${testPrefix}-project`,
    name: 'Memory owner project',
    cwd: '/tmp',
    ahw: '/tmp/agent-hub-memory-owner-test',
    agents: [],
  } as unknown as Project;
  const agent = {
    id: agentId,
    name: 'Memory owner agent',
    engine: 'claude-code',
  } as Agent;
  const enriched = {
    id: agentId,
    name: 'Memory owner agent',
    engine: 'claude-code',
    projectId: project.id,
    cwd: '/tmp',
    ahw: project.ahw,
    workspace: '/tmp',
  } as unknown as EnrichedAgent;

  return {
    broadcast: vi.fn(),
    createCursorChat: undefined,
    findAgent: (id) => (id === agentId ? { project, agent } : null),
    getEnrichedAgent: (id) => (id === agentId ? enriched : null),
    activeProcesses: new Map<string, ChildProcess>(),
    activeDelegationSessions: new Set(),
    autonomousProjects: new Set(),
    getClaudeBin: () => claudeBin,
    getCursorBin: () => claudeBin,
    getGeminiBin: () => claudeBin,
    getCodexBin: () => claudeBin,
    getGrokBin: () => claudeBin,
    uploadsDir: '/tmp',
    resolveSlashSkill: vi.fn(),
    ensureWorktree: vi.fn(async () => '/tmp'),
    drainQueue: vi.fn(),
    handleDelegation: vi.fn(async () => []),
    handleDelegationCancel: vi.fn(),
    synthesizeResults: vi.fn(),
    parseDelegateBlock: vi.fn(),
    autoCommitAndPR: vi.fn(async () => undefined),
    tryAutonomousDispatch: vi.fn(),
  };
}

async function waitFor(cond: () => boolean, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe('handleChat post-session memory reconciliation', () => {
  it('uses the session owner and owner-pinned env for memory reconcile', async () => {
    const agentId = `${testPrefix}-agent`;
    const sessionId = `${testPrefix}-session`;
    const ownerId = `${testPrefix}-owner`;

    getStmts().createSession.run(
      sessionId,
      agentId,
      'memory owner test',
      'claude-code',
      'claude-opus-4-8',
      0,
      0,
      1,
    );
    getDb().prepare('UPDATE sessions SET owner_user_id = ? WHERE id = ?').run(ownerId, sessionId);

    const { handleChat } = createChatHandler(makeDeps(agentId));
    await handleChat(null, { type: 'chat', agentId, sessionId, content: 'summarize later' });

    await waitFor(() => vi.mocked(reconcileMemoryAfterSession).mock.calls.length > 0);

    expect(resolveSessionCliSpawnEnv).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerId,
        credsOwnerId: ownerId,
        sessionId,
        engine: 'claude-code',
      }),
    );
    expect(reconcileMemoryAfterSession).toHaveBeenCalledWith(
      '/tmp/agent-hub-memory-owner-test',
      'summary for memory reconcile',
      expect.objectContaining({
        spawnEnv: ownerPinnedEnv,
        cwd: '/tmp',
        spawnOwnerUserId: ownerId,
      }),
    );
  });
});
