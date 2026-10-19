import { describe, expect, it, vi } from 'vitest';
import type { OrganizationAgent, OrganizationAgentApi } from './organization-agents';
import {
  createOrganizationPortfolioApi,
  dispatchDisplayState,
  dispatchSourceAgents,
  dispatchTargetProjects,
  OrganizationPortfolioController,
  type OrganizationDispatch,
  type OrganizationPortfolioApi,
  type PortfolioOverview,
  type PortfolioProject,
} from './organization-portfolio';

const project = (id: string): PortfolioProject => ({
  id,
  name: `Project ${id}`,
  source: {
    serverId: 's1',
    organizationId: 'org',
    projectId: id,
    projectName: `Project ${id}`,
    record: `project:${id}`,
  },
  timestamp: '2026-10-19T00:00:00.000Z',
  agents: [{ id: `${id}-dev`, name: 'Dev', role: null }],
  agentCount: 1,
  agentsTruncated: false,
  board: { columns: [], openCards: 2, totalCards: 3, epics: 1, phases: 0 },
  wiki: { pages: 4, updatedAt: null },
  sessions: { own: 0, updatedAt: null },
});
const view = (patch: Partial<OrganizationDispatch> = {}): OrganizationDispatch => ({
  requestId: 'r1',
  status: 'accepted',
  code: null,
  message: null,
  serverId: 's1',
  organizationId: 'org',
  organizationAgentId: 'assistant',
  initiatingSessionId: 'chat-1',
  projectId: 'a',
  agentId: 'a-dev',
  name: 'Fix it',
  sessionId: 'target-1',
  ref: '@[Fix it](session:target-1)',
  sessionState: 'working',
  createdAt: '2026-10-19T00:00:00.000Z',
  updatedAt: '2026-10-19T00:00:00.000Z',
  acceptedAt: '2026-10-19T00:00:00.000Z',
  ...patch,
});
const agent = (id: string, patch: Partial<OrganizationAgent> = {}): OrganizationAgent => ({
  id,
  name: id,
  engine: 'claude-code',
  organizationScope: {
    enabled: true,
    archivedAt: null,
    projects: 'all-linked',
    tools: ['projects:read', 'dispatch'],
  },
  ...patch,
});
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

function setup(scope = { value: 'server-1' }) {
  const api = {
    overview: vi.fn(async (_id: string, _offset?: number) => ({
      serverId: 's1',
      organizationId: 'org',
      retrievedAt: '2026-10-19T00:00:00.000Z',
      offset: 0,
      nextOffset: null as number | null,
      projects: [project('a'), project('b')],
    })),
    dispatches: vi.fn(async () => ({ dispatches: [] as OrganizationDispatch[], nextOffset: null })),
    dispatch: vi.fn(async () => view()),
  } satisfies OrganizationPortfolioApi;
  const agentsApi = {
    list: vi.fn(async () => ({ agents: [agent('assistant', { isAssistant: true })] })),
    chats: vi.fn(async () => ({
      sessions: [
        {
          id: 'chat-1',
          name: 'Chat',
          agentId: 'assistant',
          agentName: 'Assistant',
          agentAvailable: true,
          createdAt: '',
          updatedAt: '',
        },
      ],
    })),
    startChat: vi.fn(async () => ({
      session: { id: 'chat-new', name: 'New' },
      agent: agent('assistant'),
    })),
  } as unknown as OrganizationAgentApi & {
    startChat: ReturnType<typeof vi.fn>;
    list: ReturnType<typeof vi.fn>;
    chats: ReturnType<typeof vi.fn>;
  };
  const controller = new OrganizationPortfolioController(api, agentsApi, () => scope.value, 'org');
  return { api, agentsApi, controller, scope };
}
const httpError = (status: number, text = 'Organization not found') =>
  Object.assign(new Error(text), { status });

describe('dispatch display state', () => {
  it('maps request and session states to pending, running, completed and failed', () => {
    expect(dispatchDisplayState(view({ status: 'queued', sessionId: null }))).toBe('pending');
    expect(dispatchDisplayState(view({ status: 'starting' }))).toBe('pending');
    expect(dispatchDisplayState(view({ sessionState: 'working' }))).toBe('running');
    expect(dispatchDisplayState(view({ sessionState: null }))).toBe('running');
    expect(dispatchDisplayState(view({ sessionState: 'waiting_for_user_input' }))).toBe(
      'completed',
    );
    for (const status of ['failed', 'rejected', 'revoked', 'expired'] as const)
      expect(dispatchDisplayState(view({ status }))).toBe('failed');
  });
});

describe('dispatch choices', () => {
  it('offers only active agents with the dispatch tool and their scoped projects', () => {
    const subset = agent('scoped', { effectiveProjectIds: ['b'] });
    const agents = [
      agent('assistant'),
      subset,
      agent('reader', {
        organizationScope: { enabled: true, projects: 'all-linked', tools: ['projects:read'] },
      }),
      agent('off', {
        organizationScope: { enabled: false, projects: 'all-linked', tools: ['dispatch'] },
      }),
      agent('gone', {
        organizationScope: {
          enabled: true,
          archivedAt: '2026-10-01',
          projects: 'all-linked',
          tools: ['dispatch'],
        },
      }),
    ];
    expect(dispatchSourceAgents(agents).map((a) => a.id)).toEqual(['assistant', 'scoped']);
    const projects = [project('a'), project('b')];
    expect(dispatchTargetProjects(projects, subset).map((p) => p.id)).toEqual(['b']);
    expect(dispatchTargetProjects(projects, agent('none', { effectiveProjectIds: [] }))).toEqual(
      [],
    );
    expect(dispatchTargetProjects(projects, null)).toEqual([]);
  });
});

describe('portfolio api', () => {
  it('posts member dispatches to the organization chat route', async () => {
    const request = vi.fn(async () => ({}));
    const api = createOrganizationPortfolioApi(request);
    await api.dispatch('org 1', 'chat/1', {
      projectId: 'a',
      agentId: 'dev',
      prompt: 'Go',
      idempotencyKey: 'k',
    });
    expect(request).toHaveBeenCalledWith('/organizations/org%201/sessions/chat%2F1/dispatches', {
      method: 'POST',
      body: JSON.stringify({ projectId: 'a', agentId: 'dev', prompt: 'Go', idempotencyKey: 'k' }),
    });
    await api.overview('org', 20);
    expect(request).toHaveBeenLastCalledWith('/organizations/org/context?offset=20&limit=20');
  });
});

describe('OrganizationPortfolioController', () => {
  it('loads two linked projects with their sources, agents and dispatches', async () => {
    const { controller } = setup();
    await controller.load();
    expect(controller.state.ready).toBe(true);
    expect(controller.state.projects.map((p) => p.source.record)).toEqual([
      'project:a',
      'project:b',
    ]);
    expect(controller.state.agents.map((a) => a.id)).toEqual(['assistant']);
  });

  it('ignores a double tap and reuses the idempotency key for a retry', async () => {
    const { api, controller } = setup();
    await controller.load();
    const pending = deferred<OrganizationDispatch>();
    api.dispatch.mockImplementationOnce(() => pending.promise);
    const input = { projectId: 'a', agentId: 'a-dev', prompt: 'Fix it' };
    const first = controller.dispatch('assistant', input);
    expect(await controller.dispatch('assistant', input)).toBeNull();
    expect(api.dispatch).toHaveBeenCalledTimes(1);
    pending.reject(new TypeError('Network request failed'));
    expect(await first).toBeNull();
    expect(controller.state.dispatchError).toBe('Network request failed');

    const accepted = await controller.dispatch('assistant', input);
    const keys = api.dispatch.mock.calls.map(
      (c) => (c as unknown[])[2] as { idempotencyKey: string },
    );
    expect(keys[1].idempotencyKey).toBe(keys[0].idempotencyKey);
    expect(api.dispatch.mock.calls[0]).toEqual([
      'org',
      'chat-1',
      { projectId: 'a', agentId: 'a-dev', prompt: 'Fix it', idempotencyKey: expect.any(String) },
    ]);
    expect(accepted?.sessionId).toBe('target-1');

    // After success, a new dispatch is a new request.
    await controller.dispatch('assistant', input);
    const third = (api.dispatch.mock.calls[2] as unknown[])[2] as { idempotencyKey: string };
    expect(third.idempotencyKey).not.toBe(keys[0].idempotencyKey);
  });

  it('starts an organization chat when the agent has none yet', async () => {
    const { api, agentsApi, controller } = setup();
    agentsApi.chats.mockResolvedValueOnce({ sessions: [] }).mockResolvedValueOnce({
      sessions: [
        {
          id: 'chat-new',
          name: 'New',
          agentId: 'assistant',
          agentName: 'Assistant',
          agentAvailable: true,
          createdAt: '',
          updatedAt: '',
        },
      ],
    });
    await controller.load();
    await controller.dispatch('assistant', { projectId: 'a', agentId: 'a-dev', prompt: 'Go' });
    expect(agentsApi.startChat).toHaveBeenCalledWith('org', 'assistant');
    expect((api.dispatch.mock.calls[0] as unknown[])[1]).toBe('chat-new');
    await vi.waitFor(() => expect(controller.state.chats[0]?.id).toBe('chat-new'));
  });

  it('drops replies that land after a Server switch', async () => {
    const { api, controller, scope } = setup();
    await controller.load();
    const pending = deferred<OrganizationDispatch>();
    api.dispatch.mockImplementationOnce(() => pending.promise);
    const result = controller.dispatch('assistant', {
      projectId: 'a',
      agentId: 'a-dev',
      prompt: 'Go',
    });
    scope.value = 'server-2';
    pending.resolve(view());
    expect(await result).toBeNull();
    expect(controller.snapshot().projects).toEqual([]);

    scope.value = 'server-1';
    const slow = deferred<never>();
    api.overview.mockImplementationOnce(() => slow.promise);
    const loading = controller.load();
    controller.cancel();
    slow.resolve(undefined as never);
    await loading;
    expect(controller.state.dispatches).toEqual([]);
  });

  it('clears projects and dispatches when organization access is revoked', async () => {
    const { api, controller } = setup();
    api.dispatches.mockResolvedValueOnce({ dispatches: [view()], nextOffset: null });
    await controller.load();
    expect(controller.state.dispatches).toHaveLength(1);
    api.dispatches.mockRejectedValueOnce(httpError(404));
    await controller.refresh();
    expect(controller.state.projects).toEqual([]);
    expect(controller.state.dispatches).toEqual([]);
    expect(controller.state.error).toBe('Organization not found');
  });

  it('tracks live dispatches for polling and leaves the chat usable after a failure', async () => {
    const { api, controller } = setup();
    api.dispatches.mockResolvedValueOnce({
      dispatches: [view({ status: 'queued', sessionId: null })],
      nextOffset: null,
    });
    await controller.load();
    expect(controller.hasLiveDispatches()).toBe(true);
    api.dispatch.mockRejectedValueOnce(httpError(422, 'Agent "a-dev" is disabled'));
    api.dispatches.mockResolvedValueOnce({
      dispatches: [view({ status: 'failed', sessionId: null, message: 'disabled' })],
      nextOffset: null,
    });
    await controller.dispatch('assistant', { projectId: 'a', agentId: 'a-dev', prompt: 'Go' });
    expect(controller.state.dispatching).toBe(false);
    expect(controller.state.dispatchError).toBe('Agent "a-dev" is disabled');
    await vi.waitFor(() => expect(controller.hasLiveDispatches()).toBe(false));
    expect(controller.state.chats.map((c) => c.id)).toEqual(['chat-1']);
  });

  it('drops an unlinked or no-longer-accessible project on refresh while membership stays', async () => {
    const { api, controller } = setup();
    api.dispatches.mockResolvedValueOnce({
      dispatches: [
        view({ requestId: 'ra', projectId: 'a' }),
        view({ requestId: 'rb', projectId: 'b' }),
      ],
      nextOffset: null,
    });
    await controller.load();
    expect(controller.state.projects.map((p) => p.id)).toEqual(['a', 'b']);
    // Project b unlinked (or its ACL removed): the server answers 200 without it.
    api.overview.mockResolvedValueOnce({
      serverId: 's1',
      organizationId: 'org',
      retrievedAt: '2026-10-19T01:00:00.000Z',
      offset: 0,
      nextOffset: null,
      projects: [project('a')],
    });
    // The server already omits requests for projects the caller can no longer read.
    api.dispatches.mockResolvedValueOnce({
      dispatches: [view({ requestId: 'ra', projectId: 'a' })],
      nextOffset: null,
    });
    await controller.refresh();
    expect(controller.state.projects.map((p) => p.id)).toEqual(['a']);
    expect(controller.state.dispatches.map((d) => d.requestId)).toEqual(['ra']);
    expect(
      dispatchTargetProjects(controller.state.projects, agent('assistant')).map((p) => p.id),
    ).toEqual(['a']);
    expect(controller.state.retrievedAt).toBe('2026-10-19T01:00:00.000Z');
  });

  it('never lets an older poll overwrite a newer dispatch', async () => {
    const { api, controller } = setup();
    await controller.load();
    const stale = deferred<{ dispatches: OrganizationDispatch[]; nextOffset: null }>();
    api.dispatches.mockImplementationOnce(() => stale.promise);
    const poll = controller.refresh();
    const running = view({ requestId: 'new', sessionState: 'working' });
    api.dispatch.mockResolvedValueOnce(running);
    api.dispatches.mockResolvedValueOnce({ dispatches: [running], nextOffset: null });
    await controller.dispatch('assistant', { projectId: 'a', agentId: 'a-dev', prompt: 'Go' });
    await vi.waitFor(() => expect(api.dispatches).toHaveBeenCalledTimes(3));
    // The poll requested before the dispatch lands last with an older snapshot.
    stale.resolve({
      dispatches: [view({ requestId: 'old', sessionState: 'waiting_for_user_input' })],
      nextOffset: null,
    });
    await poll;
    await new Promise((r) => setTimeout(r, 0));
    expect(controller.state.dispatches.map((d) => d.requestId)).toEqual(['new']);
    expect(controller.hasLiveDispatches()).toBe(true);
  });

  it('keeps every expanded overview page on refresh', async () => {
    const { api, controller } = setup();
    api.overview.mockImplementation(async (_id: string, offset = 0) => ({
      serverId: 's1',
      organizationId: 'org',
      retrievedAt: '2026-10-19T00:00:00.000Z',
      offset,
      nextOffset: offset === 0 ? 1 : null,
      projects: [project(offset === 0 ? 'a' : 'b')],
    }));
    await controller.load();
    await controller.loadMore();
    expect(controller.state.projects.map((p) => p.id)).toEqual(['a', 'b']);
    await controller.refresh();
    expect(controller.state.projects.map((p) => p.id)).toEqual(['a', 'b']);
    expect(controller.state.nextOffset).toBeNull();
  });

  it('drops a deferred loadMore page that lands after a permission-changing refresh', async () => {
    const { api, controller } = setup();
    // A full first page, so only "load more" asks for the second.
    const firstPage = Array.from({ length: 20 }, (_, i) => project(`p${i}`));
    const lateB = deferred<PortfolioOverview>();
    let secondPageCalls = 0;
    let bAccessible = true;
    api.overview.mockImplementation(async (_id: string, offset = 0) => {
      const page = (projects: PortfolioProject[], nextOffset: number | null) => ({
        serverId: 's1',
        organizationId: 'org',
        retrievedAt: '2026-10-19T00:00:00.000Z',
        offset,
        nextOffset,
        projects,
      });
      // Access loss keeps the first page and its nextOffset unchanged.
      if (offset === 0) return page(firstPage, 20);
      secondPageCalls++;
      if (secondPageCalls === 1) return lateB.promise;
      return page(bAccessible ? [project('b')] : [], null);
    });
    await controller.load();
    expect(secondPageCalls).toBe(0);
    const more = controller.loadMore();
    await vi.waitFor(() => expect(secondPageCalls).toBe(1));
    bAccessible = false;
    await controller.refresh();
    expect(controller.state.projects).toHaveLength(20);
    // The page requested before the access change arrives last.
    lateB.resolve({
      serverId: 's1',
      organizationId: 'org',
      retrievedAt: '2026-10-19T00:00:00.000Z',
      offset: 20,
      nextOffset: null,
      projects: [project('b')],
    });
    await more;
    expect(controller.state.projects.map((p) => p.id)).not.toContain('b');
    expect(controller.state.projects.flatMap((p) => p.agents.map((a) => a.id))).not.toContain(
      'b-dev',
    );
  });

  it('keeps authorized dispatches for projects outside the expanded pages', async () => {
    const { api, controller } = setup();
    const many = Array.from({ length: 20 }, (_, i) => project(`p${i}`));
    api.overview.mockResolvedValue({
      serverId: 's1',
      organizationId: 'org',
      retrievedAt: '2026-10-19T00:00:00.000Z',
      offset: 0,
      nextOffset: 20,
      projects: many,
    });
    const later = view({ requestId: 'r21', projectId: 'p21', sessionState: 'working' });
    api.dispatches.mockResolvedValue({ dispatches: [later], nextOffset: null });
    await controller.load();
    await controller.refresh();
    expect(controller.state.projects).toHaveLength(20);
    expect(controller.state.dispatches.map((d) => d.requestId)).toEqual(['r21']);
    expect(controller.hasLiveDispatches()).toBe(true);
  });

  it('keeps the started chat and key when a response is lost and the refresh is still pending', async () => {
    const { api, agentsApi, controller } = setup();
    agentsApi.chats.mockResolvedValueOnce({ sessions: [] });
    await controller.load();
    // The refresh that follows the lost response never lands before the retry.
    agentsApi.chats.mockImplementation(() => new Promise(() => {}));
    api.dispatch.mockRejectedValueOnce(new TypeError('Network request failed'));
    const input = { projectId: 'a', agentId: 'a-dev', prompt: 'Fix it' };
    expect(await controller.dispatch('assistant', input)).toBeNull();
    expect(controller.state.chats).toEqual([]);

    const retried = await controller.dispatch('assistant', input);
    expect(retried?.sessionId).toBe('target-1');
    expect(agentsApi.startChat).toHaveBeenCalledTimes(1);
    const calls = api.dispatch.mock.calls as unknown as [
      string,
      string,
      { idempotencyKey: string },
    ][];
    expect(calls.map((c) => c[1])).toEqual(['chat-new', 'chat-new']);
    expect(calls[1][2].idempotencyKey).toBe(calls[0][2].idempotencyKey);
  });

  it('keeps the key when the retry fails its refresh too', async () => {
    const { api, agentsApi, controller } = setup();
    await controller.load();
    agentsApi.chats.mockRejectedValue(new TypeError('offline'));
    api.dispatch.mockRejectedValueOnce(new TypeError('Network request failed'));
    const input = { projectId: 'a', agentId: 'a-dev', prompt: 'Fix it' };
    await controller.dispatch('assistant', input);
    await new Promise((r) => setTimeout(r, 0));
    await controller.dispatch('assistant', input);
    const calls = api.dispatch.mock.calls as unknown as [
      string,
      string,
      { idempotencyKey: string },
    ][];
    expect(calls[1][1]).toBe(calls[0][1]);
    expect(calls[1][2].idempotencyKey).toBe(calls[0][2].idempotencyKey);
  });

  it('moves to another chat only when the server says the chat is gone', async () => {
    const { api, agentsApi, controller } = setup();
    await controller.load();
    api.dispatch.mockRejectedValueOnce(
      Object.assign(new Error('Organization chat not found'), {
        status: 404,
        code: 'session_not_found',
      }),
    );
    agentsApi.chats.mockResolvedValue({ sessions: [] });
    const input = { projectId: 'a', agentId: 'a-dev', prompt: 'Fix it' };
    await controller.dispatch('assistant', input);
    await vi.waitFor(() => expect(controller.state.chats).toEqual([]));
    await controller.dispatch('assistant', input);
    const calls = api.dispatch.mock.calls as unknown as [string, string][];
    expect(calls.map((c) => c[1])).toEqual(['chat-1', 'chat-new']);
  });

  it('settles loading when a dispatch completes during a reload', async () => {
    const { api, controller } = setup();
    await controller.load();
    const answer = deferred<OrganizationDispatch>();
    api.dispatch.mockImplementationOnce(() => answer.promise);
    const sending = controller.dispatch('assistant', {
      projectId: 'a',
      agentId: 'a-dev',
      prompt: 'Go',
    });
    // The user presses Refresh portfolio while the dispatch is in flight.
    const slowOverview = deferred<PortfolioOverview>();
    api.overview.mockImplementationOnce(() => slowOverview.promise);
    const loading = controller.load();
    expect(controller.state.busy).toBe(true);
    const accepted = view({ requestId: 'new' });
    api.dispatches.mockResolvedValue({ dispatches: [accepted], nextOffset: null });
    answer.resolve(accepted);
    expect(await sending).toEqual(accepted);
    slowOverview.resolve({
      serverId: 's1',
      organizationId: 'org',
      retrievedAt: '2026-10-19T00:00:00.000Z',
      offset: 0,
      nextOffset: null,
      projects: [project('a'), project('b')],
    });
    await loading;
    await vi.waitFor(() => expect(controller.state.busy).toBe(false));
    expect(controller.state.ready).toBe(true);
    expect(controller.state.dispatching).toBe(false);
    expect(controller.state.projects.map((p) => p.id)).toEqual(['a', 'b']);
    expect(controller.state.dispatches.map((d) => d.requestId)).toEqual(['new']);
    // Polling works again afterwards.
    const before = api.overview.mock.calls.length;
    await controller.refresh();
    expect(api.overview.mock.calls.length).toBe(before + 1);
  });

  it('settles loading when the superseding read fails', async () => {
    const { api, agentsApi, controller } = setup();
    await controller.load();
    const answer = deferred<OrganizationDispatch>();
    api.dispatch.mockImplementationOnce(() => answer.promise);
    const sending = controller.dispatch('assistant', {
      projectId: 'a',
      agentId: 'a-dev',
      prompt: 'Go',
    });
    const slowOverview = deferred<PortfolioOverview>();
    api.overview.mockImplementationOnce(() => slowOverview.promise);
    const loading = controller.load();
    agentsApi.list.mockRejectedValueOnce(new TypeError('offline'));
    answer.resolve(view());
    await sending;
    await vi.waitFor(() => expect(controller.state.busy).toBe(false));
    expect(controller.state.error).toBe('offline');
    slowOverview.resolve({
      serverId: 's1',
      organizationId: 'org',
      retrievedAt: '',
      offset: 0,
      nextOffset: null,
      projects: [project('a')],
    });
    await loading;
    expect(controller.state.busy).toBe(false);
    await controller.load();
    expect(controller.state.ready).toBe(true);
  });

  it('unlocks the dispatch form when its result is dropped by a remount', async () => {
    const { api, controller } = setup();
    await controller.load();
    const answer = deferred<OrganizationDispatch>();
    api.dispatch.mockImplementationOnce(() => answer.promise);
    const sending = controller.dispatch('assistant', {
      projectId: 'a',
      agentId: 'a-dev',
      prompt: 'Go',
    });
    expect(controller.state.dispatching).toBe(true);
    // StrictMode-style cleanup and re-run keep the same controller.
    controller.cancel();
    answer.resolve(view());
    expect(await sending).toBeNull();
    expect(controller.state.dispatching).toBe(false);
  });

  it('keeps the dispatch lock and draft across a reload until its own attempt ends', async () => {
    const { api, controller } = setup();
    await controller.load();
    const input = { projectId: 'a', agentId: 'a-dev', prompt: 'Fix it' };
    controller.setDraft({ sourceId: 'assistant', ...input });
    const answer = deferred<OrganizationDispatch>();
    api.dispatch.mockImplementationOnce(() => answer.promise);
    const first = controller.dispatch('assistant', input);
    // Refresh portfolio while the dispatch is outstanding: the form remounts.
    const slow = deferred<PortfolioOverview>();
    api.overview.mockImplementationOnce(() => slow.promise);
    const reloading = controller.load();
    expect(controller.state.busy).toBe(true);
    expect(controller.state.dispatching).toBe(true);
    expect(controller.state.draft.prompt).toBe('Fix it');
    slow.resolve({
      serverId: 's1',
      organizationId: 'org',
      retrievedAt: '',
      offset: 0,
      nextOffset: null,
      projects: [project('a')],
    });
    await reloading;
    expect(controller.state.dispatching).toBe(true);
    // The remounted form submits again: refused, nothing sent.
    expect(await controller.dispatch('assistant', input)).toBeNull();
    expect(api.dispatch).toHaveBeenCalledTimes(1);

    answer.resolve(view());
    await first;
    expect(controller.state.dispatching).toBe(false);
    // Accepted: the task is gone from the draft, so another tap sends nothing.
    expect(controller.state.draft).toEqual({
      sourceId: 'assistant',
      projectId: 'a',
      agentId: 'a-dev',
      prompt: '',
    });
    expect(api.dispatch).toHaveBeenCalledTimes(1);
  });

  it('keeps a draft the user edited while the dispatch was in flight', async () => {
    const { api, controller } = setup();
    await controller.load();
    const input = { projectId: 'a', agentId: 'a-dev', prompt: 'Fix it' };
    controller.setDraft(input);
    const answer = deferred<OrganizationDispatch>();
    api.dispatch.mockImplementationOnce(() => answer.promise);
    const first = controller.dispatch('assistant', input);
    controller.setDraft({ prompt: 'Next task' });
    answer.resolve(view());
    await first;
    expect(controller.state.draft.prompt).toBe('Next task');
  });

  it('keeps operation state when organization access is revoked mid-dispatch', async () => {
    const { api, controller } = setup();
    await controller.load();
    const answer = deferred<OrganizationDispatch>();
    api.dispatch.mockImplementationOnce(() => answer.promise);
    const first = controller.dispatch('assistant', {
      projectId: 'a',
      agentId: 'a-dev',
      prompt: 'Go',
    });
    api.dispatches.mockRejectedValueOnce(httpError(404));
    await controller.refresh();
    expect(controller.state.projects).toEqual([]);
    expect(controller.state.dispatching).toBe(true);
    answer.reject(httpError(404, 'Project not found'));
    await first;
    expect(controller.state.dispatching).toBe(false);
  });

  it('lets a slow poll finish instead of superseding it on every tick', async () => {
    const { api, controller } = setup();
    await controller.load();
    const slow: Array<ReturnType<typeof deferred<PortfolioOverview>>> = [];
    api.overview.mockImplementation(() => {
      const next = deferred<PortfolioOverview>();
      slow.push(next);
      return next.promise;
    });
    const first = controller.poll();
    // Further ticks arrive while the first read is still out.
    await controller.poll();
    await controller.poll();
    expect(slow).toHaveLength(1);
    slow[0].resolve({
      serverId: 's1',
      organizationId: 'org',
      retrievedAt: '2026-10-19T02:00:00.000Z',
      offset: 0,
      nextOffset: null,
      projects: [project('a')],
    });
    await first;
    expect(controller.state.projects.map((p) => p.id)).toEqual(['a']);
    expect(controller.state.retrievedAt).toBe('2026-10-19T02:00:00.000Z');
    // Ticks resume once it settled, and an explicit refresh still supersedes a running poll.
    void controller.poll();
    expect(slow).toHaveLength(2);
    void controller.refresh();
    expect(slow).toHaveLength(3);
  });

  it('never shows a delayed dispatch success after revocation when the follow-up read fails', async () => {
    const { api, controller } = setup();
    await controller.load();
    const answer = deferred<OrganizationDispatch>();
    api.dispatch.mockImplementationOnce(() => answer.promise);
    const sending = controller.dispatch('assistant', {
      projectId: 'a',
      agentId: 'a-dev',
      prompt: 'Go',
    });
    // Access is revoked while the dispatch is outstanding.
    api.dispatches.mockRejectedValueOnce(httpError(404));
    await controller.refresh();
    expect(controller.state.dispatches).toEqual([]);
    // The delayed success lands, and the follow-up read fails without an answer on access.
    api.overview.mockRejectedValueOnce(httpError(500, 'Server error'));
    answer.resolve(view({ requestId: 'late' }));
    await sending;
    await new Promise((r) => setTimeout(r, 0));
    expect(controller.state.dispatches).toEqual([]);
    expect(controller.state.projects).toEqual([]);
    // Only a successful, authorized snapshot brings data back.
    api.dispatches.mockResolvedValueOnce({
      dispatches: [view({ requestId: 'late' })],
      nextOffset: null,
    });
    await controller.refresh();
    expect(controller.state.dispatches.map((d) => d.requestId)).toEqual(['late']);
  });

  it('polls fast for an accepted request until a snapshot includes it', async () => {
    const { api, controller } = setup();
    await controller.load();
    expect(controller.hasLiveDispatches()).toBe(false);
    api.overview.mockRejectedValueOnce(new TypeError('offline'));
    await controller.dispatch('assistant', { projectId: 'a', agentId: 'a-dev', prompt: 'Go' });
    await new Promise((r) => setTimeout(r, 0));
    // Not shown (no snapshot yet), but polling stays fast.
    expect(controller.state.dispatches).toEqual([]);
    expect(controller.hasLiveDispatches()).toBe(true);
    api.dispatches.mockResolvedValueOnce({
      dispatches: [view({ sessionState: 'waiting_for_user_input' })],
      nextOffset: null,
    });
    await controller.poll();
    expect(controller.state.dispatches).toHaveLength(1);
    expect(controller.hasLiveDispatches()).toBe(false);
  });
});
