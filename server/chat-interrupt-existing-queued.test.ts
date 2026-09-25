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
import type { Agent, EnrichedAgent, MessageRow, Project } from './types.js';

vi.mock('./wiki-rag.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./wiki-rag.js')>();
  return {
    ...actual,
    runWikiHybridRagForUserTurn: vi.fn().mockResolvedValue({ promptSuffix: '', indicator: null }),
  };
});

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
    stmts.enqueueMessage.run(queuedMsgId, sessionId, agentId, 'queued content', null, 0, 0);
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
    const waitingId = `${sessionId}-waiting`;
    getStmts().enqueueMessage.run(waitingId, sessionId, agentId, 'other work', null, -2, 0);
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
      expect(getStmts().getQueuedMessages.all(sessionId)).toEqual([
        expect.objectContaining({ id: queuedMsgId }),
        expect.objectContaining({ id: waitingId }),
      ]);
      await vi.advanceTimersByTimeAsync(100);
      expect(broadcasts.some((event) => event.type === 'thinking')).toBe(false);
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

  it('queues Continue ahead of pending work and interrupts after a model change', async () => {
    const { agentId, sessionId, queuedMsgId } = seedQueuedSession('model');
    const stmts = getStmts();
    stmts.updateSessionModel.run('claude-sonnet-5', sessionId);
    const kill = vi.fn();
    const activeProcesses = new Map<string, ActiveChatProcess>([
      [sessionId, { kind: 'guest', kill }],
    ]);
    const { handleChat, broadcasts } = stubChatDeps(sessionId, agentId, activeProcesses);

    vi.useFakeTimers();
    await handleChat(null, {
      type: 'chat',
      agentId,
      sessionId,
      content: 'Continue',
      interrupt: true,
    });

    expect(kill).toHaveBeenCalledExactlyOnceWith('SIGTERM');
    expect(stmts.getQueuedMessages.all(sessionId)).toEqual([
      expect.objectContaining({ content: 'Continue', agent_id: agentId }),
      expect.objectContaining({ id: queuedMsgId, content: 'queued content' }),
    ]);
    expect(stmts.getSession.get(sessionId)).toMatchObject({ model: 'claude-sonnet-5' });
    expect(broadcasts).toContainEqual(
      expect.objectContaining({
        type: 'message',
        message: expect.objectContaining({ content: 'Continue', interrupted: true }),
      }),
    );
  });

  it('promotes a queued user message after the stopped assistant in live and paginated history', async () => {
    const { agentId, sessionId, queuedMsgId } = seedQueuedSession('order');
    const stmts = getStmts();
    const partialId = `${sessionId}-partial`;
    const attachments = JSON.stringify([{ url: '/uploads/image.png' }]);
    stmts.addMessage.run(
      queuedMsgId,
      sessionId,
      'user',
      'queued content',
      null,
      null,
      attachments,
      null,
      null,
      null,
      null,
    );
    stmts.addMessage.run(
      partialId,
      sessionId,
      'assistant',
      'Stopped response',
      'claude-code',
      null,
      null,
      null,
      null,
      null,
      null,
    );
    stmts.dequeueMessage.run(queuedMsgId);
    const { handleChat, broadcasts } = stubChatDeps(sessionId, agentId, new Map());

    await handleChat(null, {
      type: 'chat',
      agentId,
      sessionId,
      content: 'queued content',
      _fromQueue: true,
      _existingMsgId: queuedMsgId,
    });

    const rows = stmts.getMessages.all(sessionId) as MessageRow[];
    expect(rows.slice(0, 2).map((row) => row.id)).toEqual([partialId, queuedMsgId]);
    const latest = stmts.getMessagesPageLatest.all(sessionId, 1) as MessageRow[];
    expect(latest[0].id).toBe(queuedMsgId);
    expect(
      (stmts.getMessagesPageBeforeId.all(sessionId, queuedMsgId, sessionId, 1) as MessageRow[])[0]
        .id,
    ).toBe(partialId);
    expect(broadcasts).toContainEqual(
      expect.objectContaining({
        type: 'queue_item_processing',
        sessionId,
        messageId: queuedMsgId,
        message: expect.objectContaining({
          id: queuedMsgId,
          attachments,
          content: 'queued content',
        }),
      }),
    );
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
