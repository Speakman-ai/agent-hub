/**
 * Regression: when a busy session receives a system-internal dispatch
 * (`_skipUserMessagePersist: true`, e.g. a Finalize fix-turn body), the
 * busy-enqueue branch must NOT persist a duplicate visible `user` message and
 * must NOT surface it in the human-visible queue. The turn still has to run
 * later, so the row is enqueued as `internal` and remains drainable.
 *
 * Before the fix, the branch ignored the flag: the reviewer-notes body landed
 * as an editable "Queued" user message (support ticket "Review message is auto
 * sent after test start running").
 */
import './test/setup.js';
import { describe, it, expect, vi } from 'vitest';
import { randomUUID } from 'crypto';
import { getStmts } from './db.js';
import createChatHandler, { type ChatHandlerDeps } from './chat.js';
import type { ChildProcess } from 'child_process';
import type { ActiveChatProcess } from './active-chat-process.js';
import { wrapHostChildProcess } from './active-chat-process.js';
import type { Agent, EnrichedAgent, MessageRow, Project } from './types.js';

vi.mock('./per-user-cli-spawn.js', () => ({
  EngineAuthRequiredError: class EngineAuthRequiredError extends Error {},
  resolveSessionCliSpawnEnv: vi.fn(() => ({})),
}));

function makeAgent(id: string): Agent {
  return { id, name: 'Queue test agent', engine: 'claude-code' } as Agent;
}

function makeEnrichedAgent(id: string, projectId: string): EnrichedAgent {
  return {
    id,
    name: 'Queue test agent',
    engine: 'claude-code',
    projectId,
    cwd: '/tmp',
    ahw: '/tmp',
    workspace: '/tmp',
  } as EnrichedAgent;
}

function makeProject(projectId: string): Project {
  return {
    id: projectId,
    name: 'Queue test project',
    cwd: '/tmp',
    ahw: '/tmp',
    agents: [],
  } as Project;
}

function stubChatDeps(
  agentId: string,
  projectId: string,
  activeProcesses: Map<string, ActiveChatProcess>,
): ReturnType<typeof createChatHandler> & { broadcasts: Array<Record<string, unknown>> } {
  const agent = makeAgent(agentId);
  const project = makeProject(projectId);
  const enriched = makeEnrichedAgent(agentId, projectId);
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

  return Object.assign(createChatHandler(deps), { broadcasts });
}

function seedBusySession(suffix: string) {
  const prefix = `iq-${randomUUID().slice(0, 8)}`;
  const agentId = `${prefix}-agent-${suffix}`;
  const sessionId = `${prefix}-sess-${suffix}`;
  const projectId = `${prefix}-proj-${suffix}`;
  const stmts = getStmts();
  // useWorktree = 0 so the enqueue path is gated purely by the active process.
  stmts.createSession.run(
    sessionId,
    agentId,
    'queue test',
    'claude-code',
    'claude-opus-4-8',
    0,
    0,
    1,
  );
  const activeProcesses = new Map<string, ActiveChatProcess>([
    [sessionId, wrapHostChildProcess({ pid: 4242 } as ChildProcess)],
  ]);
  return { agentId, sessionId, projectId, activeProcesses, stmts };
}

const BODY =
  'Finalize Code Changes: phase=review, reviewer requested changes.\n\nReviewer notes:\n- x';

describe('handleChat busy-enqueue — internal dispatch honors _skipUserMessagePersist', () => {
  it('hides an internal dispatch from the visible queue but keeps it drainable', async () => {
    const { agentId, sessionId, projectId, activeProcesses, stmts } = seedBusySession('int');
    const { handleChat, broadcasts } = stubChatDeps(agentId, projectId, activeProcesses);

    await handleChat(null, {
      type: 'chat',
      agentId,
      sessionId,
      content: BODY,
      _skipUserMessagePersist: true,
      _finalizeInternal: true,
    } as Parameters<typeof handleChat>[1]);

    // Not surfaced as a human-visible queued message.
    expect(stmts.getQueuedMessages.all(sessionId)).toHaveLength(0);
    // But it IS enqueued (internal) and remains drainable.
    expect((stmts.countQueuedMessages.get(sessionId) as { n: number }).n).toBe(1);
    expect(stmts.getNextQueuedMessage.get(sessionId)).toBeTruthy();

    // No duplicate visible `user` transcript row.
    const userRows = (stmts.getMessages.all(sessionId) as MessageRow[]).filter(
      (m) => m.role === 'user',
    );
    expect(userRows).toHaveLength(0);

    // No `message` broadcast carrying the body as a user message.
    const userMsgBroadcast = broadcasts.find(
      (b) => b.type === 'message' && (b.message as { role?: string } | undefined)?.role === 'user',
    );
    expect(userMsgBroadcast).toBeUndefined();
  });

  it('still persists and shows an ordinary (non-internal) busy dispatch', async () => {
    const { agentId, sessionId, projectId, activeProcesses, stmts } = seedBusySession('normal');
    const { handleChat, broadcasts } = stubChatDeps(agentId, projectId, activeProcesses);

    await handleChat(null, {
      type: 'chat',
      agentId,
      sessionId,
      content: 'a normal user message',
    });

    // Visible in the human queue and persisted as a user row.
    expect(stmts.getQueuedMessages.all(sessionId)).toHaveLength(1);
    const userRows = (stmts.getMessages.all(sessionId) as MessageRow[]).filter(
      (m) => m.role === 'user',
    );
    expect(userRows).toHaveLength(1);
    expect(
      broadcasts.some(
        (b) =>
          b.type === 'message' && (b.message as { role?: string } | undefined)?.role === 'user',
      ),
    ).toBe(true);
  });
});
