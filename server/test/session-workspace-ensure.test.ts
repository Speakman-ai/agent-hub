import { describe, it, expect, vi, afterEach } from 'vitest';
import type supertest from 'supertest';
import { getRequest, createAgent, createProject, createSession } from './helpers.js';
import { routeDeps } from '../index.js';
import createChatHandler, { type ChatHandlerDeps } from '../chat.js';
import {
  getSessionWorktreeLockOwner,
  getSessionWorktreeLockWaiterCount,
} from '../session-worktree-lock.js';
import type { ActiveChatProcess } from '../active-chat-process.js';

vi.mock('../per-user-cli-spawn.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../per-user-cli-spawn.js')>();
  return {
    ...actual,
    resolveSessionCliSpawnEnv: vi.fn(() => ({})),
  };
});

function makeChatHandler(ensureWorktree: ChatHandlerDeps['ensureWorktree'], drainQueue = vi.fn()) {
  return createChatHandler({
    broadcast: vi.fn(),
    findAgent: routeDeps.findAgent,
    getEnrichedAgent: routeDeps.getEnrichedAgent,
    activeProcesses: new Map<string, ActiveChatProcess>(),
    autonomousProjects: new Set<string>(),
    getClaudeBin: () => '/bin/true',
    getCursorBin: () => '/bin/true',
    getGeminiBin: () => '/bin/true',
    getCodexBin: () => '/bin/true',
    getGrokBin: () => '/bin/true',
    uploadsDir: '/tmp',
    resolveSlashSkill: vi.fn(() => null),
    createCursorChat: undefined,
    ensureWorktree,
    drainQueue,
    autoCommitAndPR: vi.fn(async () => undefined),
    tryAutonomousDispatch: vi.fn(),
  });
}

describe('POST /api/sessions/:sessionId/workspace/ensure', () => {
  let request: supertest.Agent;

  beforeAll(async () => {
    request = await getRequest();
  });

  afterEach(async () => {
    // Workspace setup drains on setImmediate after releasing the response
    // lock. Let that callback hit the mocks owned by this test before they are
    // restored, rather than leaking into the next case's spies.
    await new Promise<void>((resolve) => setImmediate(resolve));
    vi.restoreAllMocks();
  });

  it('returns 404 for unknown session', async () => {
    await request
      .post('/api/sessions/00000000-0000-4000-8000-000000000099/workspace/ensure')
      .expect(404);
  });

  it('provisions worktree and returns enriched session', async () => {
    const session = (await createSession()) as { id: string };
    const worktreePath = `/tmp/agent-hub-test-wt-${session.id.slice(0, 8)}`;
    const spy = vi.spyOn(routeDeps, 'provisionSessionWorkspace').mockImplementation(async (sid) => {
      routeDeps.stmts.updateSessionWorktreePath.run(
        worktreePath,
        `agent-hub/test/session-${sid.slice(0, 8)}`,
        sid,
      );
      return worktreePath;
    });
    // Stub the env boot so the route does not try to mount a real VM/container.
    vi.spyOn(routeDeps, 'ensureSessionEnvironment').mockResolvedValue(undefined);

    const res = await request.post(`/api/sessions/${session.id}/workspace/ensure`).expect(200);

    expect(spy).toHaveBeenCalledWith(session.id);
    expect((res.body as { ok: boolean }).ok).toBe(true);
    expect((res.body as { worktreePath: string }).worktreePath).toBe(worktreePath);
    expect((res.body as { session: { worktree_path: string } }).session.worktree_path).toBe(
      worktreePath,
    );
  });

  it('boots the session environment after the clone, in order', async () => {
    // The interactive open must explicitly boot the VM/container as a step
    // distinct from the clone-only provisioning primitive. Non-interactive
    // clone callers (Finalize/RUM setup apply, design import) never receive
    // ensureSessionEnvironment, so they cannot boot an env.
    const session = (await createSession()) as { id: string };
    const worktreePath = `/tmp/agent-hub-test-wt-${session.id.slice(0, 8)}`;
    const order: string[] = [];
    const provisionSpy = vi
      .spyOn(routeDeps, 'provisionSessionWorkspace')
      .mockImplementation(async (sid) => {
        order.push('provision');
        routeDeps.stmts.updateSessionWorktreePath.run(
          worktreePath,
          `agent-hub/test/session-${sid.slice(0, 8)}`,
          sid,
        );
        return worktreePath;
      });
    const ensureEnvSpy = vi
      .spyOn(routeDeps, 'ensureSessionEnvironment')
      .mockImplementation(async () => {
        order.push('ensureEnv');
      });

    await request.post(`/api/sessions/${session.id}/workspace/ensure`).expect(200);

    expect(provisionSpy).toHaveBeenCalledWith(session.id);
    expect(ensureEnvSpy).toHaveBeenCalledWith(session.id);
    expect(order).toEqual(['provision', 'ensureEnv']);
  });

  it('queues an immediate chat while workspace setup owns the startup lock', async () => {
    const project = await createProject();
    const agent = await createAgent({ projectId: project.id as string });
    const session = (await createSession({ agentId: agent.id as string })) as { id: string };
    const worktreePath = `/tmp/agent-hub-test-wt-${session.id.slice(0, 8)}`;
    let releaseProvision!: () => void;
    let markProvisionStarted!: () => void;
    const provisionStarted = new Promise<void>((resolve) => {
      markProvisionStarted = resolve;
    });
    vi.spyOn(routeDeps, 'provisionSessionWorkspace').mockImplementation(async (sid) => {
      markProvisionStarted();
      await new Promise<void>((resolve) => {
        releaseProvision = resolve;
      });
      routeDeps.stmts.updateSessionWorktreePath.run(
        worktreePath,
        'agent-hub/test/setup-first',
        sid,
      );
      return worktreePath;
    });
    vi.spyOn(routeDeps, 'ensureSessionEnvironment').mockResolvedValue(undefined);
    const routeDrain = vi.spyOn(routeDeps, 'drainSessionQueue').mockImplementation(() => undefined);
    const chatDrain = vi.fn();
    const { handleChat } = makeChatHandler(
      vi.fn(async () => worktreePath),
      chatDrain,
    );

    const ensureResponse = request
      .post(`/api/sessions/${session.id}/workspace/ensure`)
      .then((response) => response);
    await provisionStarted;
    expect(getSessionWorktreeLockOwner(session.id)).toBe('workspace-setup');

    await handleChat(null, {
      type: 'chat',
      agentId: agent.id as string,
      sessionId: session.id,
      content: 'Start as soon as setup finishes',
    });

    const queued = routeDeps.stmts.getQueuedMessages.all(session.id) as Array<{ content: string }>;
    expect(queued).toHaveLength(1);
    expect(queued[0]?.content).toBe('Start as soon as setup finishes');
    expect(chatDrain).not.toHaveBeenCalled();

    releaseProvision();
    expect((await ensureResponse).status).toBe(200);
    await vi.waitFor(() => expect(routeDrain).toHaveBeenCalledWith(session.id));
    expect(getSessionWorktreeLockOwner(session.id)).toBeNull();
  });

  it('keeps queued chat pending after setup fails until Retry succeeds', async () => {
    const project = await createProject();
    const agent = await createAgent({ projectId: project.id as string });
    const session = (await createSession({ agentId: agent.id as string })) as { id: string };
    const worktreePath = `/tmp/agent-hub-test-wt-${session.id.slice(0, 8)}`;
    let rejectProvision!: () => void;
    let markProvisionStarted!: () => void;
    const provisionStarted = new Promise<void>((resolve) => {
      markProvisionStarted = resolve;
    });
    const provision = vi
      .spyOn(routeDeps, 'provisionSessionWorkspace')
      .mockImplementation(async () => {
        markProvisionStarted();
        await new Promise<void>((resolve) => {
          rejectProvision = resolve;
        });
        throw new Error('VM startup failed');
      });
    vi.spyOn(routeDeps, 'ensureSessionEnvironment').mockResolvedValue(undefined);
    const routeDrain = vi.spyOn(routeDeps, 'drainSessionQueue').mockImplementation(() => undefined);
    const { handleChat } = makeChatHandler(
      vi.fn(async () => worktreePath),
      vi.fn(),
    );

    const failedEnsure = request
      .post(`/api/sessions/${session.id}/workspace/ensure`)
      .then((response) => response);
    await provisionStarted;
    await handleChat(null, {
      type: 'chat',
      agentId: agent.id as string,
      sessionId: session.id,
      content: 'Keep this queued through failure',
    });

    rejectProvision();
    expect((await failedEnsure).status).toBe(500);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(routeDrain).not.toHaveBeenCalledWith(session.id);
    expect(routeDeps.stmts.getQueuedMessages.all(session.id)).toHaveLength(1);

    provision.mockImplementation(async (sid) => {
      routeDeps.stmts.updateSessionWorktreePath.run(worktreePath, 'agent-hub/test/retry', sid);
      return worktreePath;
    });
    await request.post(`/api/sessions/${session.id}/workspace/ensure`).expect(200);
    await vi.waitFor(() => expect(routeDrain).toHaveBeenCalledWith(session.id));
    expect(routeDrain.mock.calls.filter(([sid]) => sid === session.id)).toHaveLength(1);
  });

  it('waits when immediate chat wins the real turn-start race', async () => {
    const project = await createProject();
    const agent = await createAgent({ projectId: project.id as string });
    const session = (await createSession({ agentId: agent.id as string })) as { id: string };
    const worktreePath = `/tmp/agent-hub-test-wt-${session.id.slice(0, 8)}`;
    const order: string[] = [];
    let releaseChatProvision!: () => void;
    let markChatProvisionStarted!: () => void;
    const chatProvisionStarted = new Promise<void>((resolve) => {
      markChatProvisionStarted = resolve;
    });
    const chatEnsureWorktree = vi.fn(async () => {
      order.push('chat-provision-started');
      markChatProvisionStarted();
      await new Promise<void>((resolve) => {
        releaseChatProvision = resolve;
      });
      routeDeps.stmts.updateSessionWorktreePath.run(
        worktreePath,
        'agent-hub/test/chat-first',
        session.id,
      );
      order.push('chat-provision-finished');
      return worktreePath;
    });
    const { handleChat } = makeChatHandler(chatEnsureWorktree);
    const routeProvision = vi
      .spyOn(routeDeps, 'provisionSessionWorkspace')
      .mockImplementation(async () => {
        order.push('route-provision');
        return worktreePath;
      });
    vi.spyOn(routeDeps, 'ensureSessionEnvironment').mockResolvedValue(undefined);

    const chat = handleChat(null, {
      type: 'chat',
      agentId: agent.id as string,
      sessionId: session.id,
      content: 'Race workspace setup',
    });
    await chatProvisionStarted;
    expect(getSessionWorktreeLockOwner(session.id)).toBe('turn-start');

    const ensureResponse = request
      .post(`/api/sessions/${session.id}/workspace/ensure`)
      .then((response) => response);
    await vi.waitFor(() => expect(getSessionWorktreeLockWaiterCount(session.id)).toBe(1));
    expect(routeProvision).not.toHaveBeenCalled();

    releaseChatProvision();
    await chat;
    expect((await ensureResponse).status).toBe(200);
    expect(order).toEqual(['chat-provision-started', 'chat-provision-finished', 'route-provision']);
    expect(getSessionWorktreeLockOwner(session.id)).toBeNull();
  });

  it('coalesces fast overlapping successful ensures into one final drain', async () => {
    const session = (await createSession()) as { id: string };
    const worktreePath = `/tmp/agent-hub-test-wt-${session.id.slice(0, 8)}`;
    let releaseFirst!: () => void;
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const provision = vi
      .spyOn(routeDeps, 'provisionSessionWorkspace')
      .mockImplementation(async (sid) => {
        const index = provision.mock.calls.length - 1;
        if (index === 0) {
          markFirstStarted();
          await new Promise<void>((resolve) => {
            releaseFirst = resolve;
          });
        }
        routeDeps.stmts.updateSessionWorktreePath.run(worktreePath, 'agent-hub/test/overlap', sid);
        return worktreePath;
      });
    vi.spyOn(routeDeps, 'ensureSessionEnvironment').mockResolvedValue(undefined);
    const drain = vi.spyOn(routeDeps, 'drainSessionQueue').mockImplementation(() => undefined);

    const first = request
      .post(`/api/sessions/${session.id}/workspace/ensure`)
      .then((response) => response);
    await firstStarted;
    const second = request
      .post(`/api/sessions/${session.id}/workspace/ensure`)
      .then((response) => response);
    await vi.waitFor(() => expect(getSessionWorktreeLockWaiterCount(session.id)).toBe(1));
    expect(provision).toHaveBeenCalledTimes(1);

    releaseFirst();
    expect((await first).status).toBe(200);
    expect((await second).status).toBe(200);
    await vi.waitFor(() => expect(drain).toHaveBeenCalledWith(session.id));
    expect(drain.mock.calls.filter(([sid]) => sid === session.id)).toHaveLength(1);
    expect(getSessionWorktreeLockOwner(session.id)).toBeNull();
  });
});
