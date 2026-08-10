/**
 * Interrupt-now on an existing queued row must hit the busy-session kill path.
 * The client frame must NOT set `_fromQueue` on the first hop — that flag is
 * only for the server's recursive re-entry after dequeue + kill.
 */
import './test/setup.js';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'crypto';
import { getStmts } from './db.js';
import createChatHandler, { type ChatHandlerDeps } from './chat.js';
import type { ChildProcess } from 'child_process';
import type { ActiveChatProcess } from './active-chat-process.js';
import { wrapHostChildProcess } from './active-chat-process.js';
import type { Agent, EnrichedAgent, Project } from './types.js';

const killProcessGroupMock = vi.hoisted(() => vi.fn());

vi.mock('./process-groups.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./process-groups.js')>();
  return { ...actual, killProcessGroup: killProcessGroupMock };
});

vi.mock('./per-user-cli-spawn.js', () => ({
  EngineAuthRequiredError: class EngineAuthRequiredError extends Error {},
  resolveSessionCliSpawnEnv: vi.fn(() => ({})),
}));

function makeAgent(id: string): Agent {
  return {
    id,
    name: 'Interrupt test agent',
    engine: 'claude-code',
  } as Agent;
}

function makeEnrichedAgent(id: string): EnrichedAgent {
  return {
    id,
    name: 'Interrupt test agent',
    engine: 'claude-code',
    projectId: 'proj-interrupt-q',
    cwd: '/tmp',
    ahw: '/tmp',
    workspace: '/tmp',
  } as EnrichedAgent;
}

function makeProject(): Project {
  return {
    id: 'proj-interrupt-q',
    name: 'Interrupt test project',
    cwd: '/tmp',
    ahw: '/tmp',
    agents: [],
  } as Project;
}

function stubChatDeps(
  sessionId: string,
  agentId: string,
  activeProcesses: Map<string, ActiveChatProcess>,
): ReturnType<typeof createChatHandler> & { broadcasts: Array<Record<string, unknown>> } {
  const agent = makeAgent(agentId);
  const project = makeProject();
  const enriched = makeEnrichedAgent(agentId);
  const broadcasts: Array<Record<string, unknown>> = [];

  const deps: ChatHandlerDeps = {
    broadcast: (data: Record<string, unknown>) => {
      broadcasts.push(data);
    },
    createCursorChat: undefined,
    findAgent: (id) => (id === agentId ? { project, agent } : null),
    getEnrichedAgent: (id) => (id === agentId ? enriched : null),
    activeProcesses,
    autonomousProjects: new Set(),
    getClaudeBin: () => '/bin/true',
    getCursorBin: () => '/bin/true',
    getGeminiBin: () => '/bin/true',
    getCodexBin: () => '/bin/true',
    getGrokBin: () => '/bin/true',
    uploadsDir: '/tmp',
    resolveSlashSkill: vi.fn(),
    ensureWorktree: vi.fn(async () => '/tmp'),
    drainQueue: vi.fn(),
    autoCommitAndPR: vi.fn(async () => undefined),
    tryAutonomousDispatch: vi.fn(),
  };

  const handler = createChatHandler(deps);
  return Object.assign(handler, { broadcasts });
}

describe('handleChat — interrupt-now existing queued row', () => {
  const testPrefix = `int-q-${randomUUID().slice(0, 8)}`;

  function seedQueuedSession(suffix: string) {
    const agentId = `${testPrefix}-agent-${suffix}`;
    const sessionId = `${testPrefix}-sess-${suffix}`;
    const queuedMsgId = `${testPrefix}-qmsg-${suffix}`;
    const stmts = getStmts();
    stmts.createSession.run(
      sessionId,
      agentId,
      'interrupt-q test',
      'claude-code',
      'claude-opus-4-8',
      0,
      0,
      1,
    );
    stmts.enqueueMessage.run(queuedMsgId, sessionId, agentId, 'queued content', null, 0);
    return { agentId, sessionId, queuedMsgId };
  }

  beforeEach(() => {
    killProcessGroupMock.mockClear();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('calls killProcessGroup when busy and frame has _existingMsgId without _fromQueue', async () => {
    const { agentId, sessionId, queuedMsgId } = seedQueuedSession('kill');
    const fakeProc = { pid: 42_4242 } as ChildProcess;
    const activeProcesses = new Map<string, ActiveChatProcess>([
      [sessionId, wrapHostChildProcess(fakeProc)],
    ]);
    const { handleChat, broadcasts } = stubChatDeps(sessionId, agentId, activeProcesses);

    vi.useFakeTimers();
    try {
      await handleChat(null, {
        type: 'chat',
        agentId,
        sessionId,
        content: 'queued content',
        interrupt: true,
        _existingMsgId: queuedMsgId,
      });

      expect(killProcessGroupMock).toHaveBeenCalledTimes(1);
      expect(killProcessGroupMock).toHaveBeenCalledWith(fakeProc, 'SIGTERM');
      expect(getStmts().getQueuedMessages.all(sessionId)).toHaveLength(0);
      expect(
        broadcasts.some(
          (b: Record<string, unknown>) => b.type === 'interrupted' && b.sessionId === sessionId,
        ),
      ).toBe(true);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('broadcasts primary agent metadata on ordinary thinking events', async () => {
    const agentId = `${testPrefix}-agent-meta`;
    const sessionId = `${testPrefix}-sess-meta`;
    const stmts = getStmts();
    stmts.createSession.run(
      sessionId,
      agentId,
      'metadata test',
      'claude-code',
      'claude-opus-4-8',
      0,
      0,
      1,
    );
    const { handleChat, broadcasts } = stubChatDeps(sessionId, agentId, new Map());

    await handleChat(null, {
      type: 'chat',
      agentId,
      sessionId,
      content: 'hello',
    });

    expect(broadcasts).toContainEqual(
      expect.objectContaining({
        type: 'thinking',
        sessionId,
        agentId,
        agentName: 'Interrupt test agent',
      }),
    );
  });
});
