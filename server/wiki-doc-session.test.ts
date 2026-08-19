import './test/setup.js';
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  buildWikiDocOnMergePrompt,
  buildWikiDocBackfillPrompt,
  resolveDocsAgent,
  findActiveWikiDocSession,
  dispatchWikiDocOnMerge,
  dispatchWikiDocBackfill,
  maybeMarkLinkedCardDocumented,
  maybeDispatchWikiDocOnMerge,
  initWikiDocMergeHook,
  resetWikiDocMergeHook,
  wikiDocSessionNameForCard,
  wikiDocBackfillSessionName,
  WIKI_DOC_SESSION_PREFIX,
  isWikiDocSkip,
} from './wiki-doc-session.js';
import type { Agent, KanbanCardRow, Project, SessionRow, Stmts } from './types.js';

function agent(over: Partial<Agent> = {}): Agent {
  return { id: 'docs-1', name: 'Docs', role: 'docs', engine: 'claude-code', ...over } as Agent;
}

function project(over: Partial<Project> = {}): Project {
  return {
    id: 'p1',
    name: 'Test Project',
    agents: [agent()],
    ...over,
  } as Project;
}

function card(over: Partial<KanbanCardRow> = {}): KanbanCardRow {
  return {
    id: 'card-uuid-1',
    title: 'Add wiki merge hook',
    description: 'Ship auto-docs on merge',
    documented: 0,
    ...over,
  } as KanbanCardRow;
}

function fakeStmts(overrides: Record<string, unknown> = {}) {
  const sessionRow = {
    id: 'sess',
    name: wikiDocSessionNameForCard('card-uuid-1'),
    agent_id: 'docs-1',
  };
  return {
    createSession: { run: vi.fn() },
    getSession: { get: vi.fn(() => sessionRow) },
    insertBackgroundTask: { run: vi.fn() },
    updateBackgroundTaskStatus: { run: vi.fn() },
    getRunningBackgroundTasks: { all: vi.fn(() => []) },
    createKanbanCardComment: { run: vi.fn() },
    getKanbanCardBySession: { get: vi.fn(() => undefined) },
    markCardDocumented: { run: vi.fn() },
    ...overrides,
  } as unknown as Stmts;
}

afterEach(() => {
  resetWikiDocMergeHook();
});

describe('resolveDocsAgent', () => {
  it('picks the docs-role agent and ignores others', () => {
    const p = project({
      agents: [
        agent({ id: 'dev', role: 'dev' }),
        agent({ id: 'docs-1', role: 'docs' }),
        agent({ id: 'rev', role: 'reviewer' }),
      ],
    });
    expect(resolveDocsAgent(p)?.id).toBe('docs-1');
  });

  it('returns null when the project has no docs agent', () => {
    expect(resolveDocsAgent(project({ agents: [agent({ id: 'dev', role: 'dev' })] }))).toBeNull();
  });
});

describe('buildWikiDocOnMergePrompt', () => {
  it('names the card, forbids a changelog, and requires the documented stamp', () => {
    const prompt = buildWikiDocOnMergePrompt({
      projectId: 'agent-hub',
      projectName: 'Agent Hub',
      card: { id: 'c1', title: 'Retire heartbeats', description: 'Use crons instead' },
      prNumber: 42,
      prTitle: 'Retire per-agent heartbeats',
      prUrl: '/projects/agent-hub/pulls/42',
    });
    expect(prompt).toContain('Retire heartbeats');
    expect(prompt).toContain('PR #42');
    expect(prompt).toMatch(/at most one/i);
    expect(prompt).toMatch(/not a changelog/i);
    expect(prompt).toContain('/board/cards/c1/documented');
    expect(prompt).toMatch(/skipped:/i);
    expect(prompt).toMatch(/Do not open a PR/i);
  });
});

describe('buildWikiDocBackfillPrompt', () => {
  it('lists the queued cards oldest-first and caps writes at one page', () => {
    const prompt = buildWikiDocBackfillPrompt({
      projectId: 'p1',
      projectName: 'Test Project',
      cards: [
        { id: 'old', title: 'Oldest', updated_at: '2026-07-01' },
        { id: 'new', title: 'Newer', updated_at: '2026-08-01' },
      ],
    });
    expect(prompt).toContain('Oldest');
    expect(prompt).toContain('Newer');
    expect(prompt.indexOf('old')).toBeLessThan(prompt.indexOf('new'));
    expect(prompt).toMatch(/at most one/i);
    expect(prompt).toMatch(/documented = 1/i);
    expect(prompt).toContain('/board/cards/<cardId>/documented');
  });
});

describe('findActiveWikiDocSession', () => {
  const p = project();

  function mk(
    tasks: Array<{ session_id: string; agent_id: string }>,
    sessions: Record<string, Partial<SessionRow>>,
  ) {
    return {
      getRunningBackgroundTasks: { all: () => tasks },
      getSession: {
        get: (id: string) => sessions[id],
      },
    } as unknown as Stmts;
  }

  it('matches a running merge session for the same card', () => {
    const s = mk([{ session_id: 'x', agent_id: 'docs-1' }], {
      x: { id: 'x', agent_id: 'docs-1', name: wikiDocSessionNameForCard('card-uuid-1') },
    });
    expect(findActiveWikiDocSession(s, p, { cardId: 'card-uuid-1' })?.id).toBe('x');
  });

  it('does not match a different card', () => {
    const s = mk([{ session_id: 'x', agent_id: 'docs-1' }], {
      x: { id: 'x', agent_id: 'docs-1', name: wikiDocSessionNameForCard('other-card') },
    });
    expect(findActiveWikiDocSession(s, p, { cardId: 'card-uuid-1' })).toBeNull();
  });

  it('matches a running backfill session', () => {
    const s = mk([{ session_id: 'b', agent_id: 'docs-1' }], {
      b: { id: 'b', agent_id: 'docs-1', name: wikiDocBackfillSessionName() },
    });
    expect(findActiveWikiDocSession(s, p, { backfill: true })?.id).toBe('b');
  });

  it('ignores a soft-deleted session', () => {
    const s = mk([{ session_id: 'x', agent_id: 'docs-1' }], {
      x: {
        id: 'x',
        agent_id: 'docs-1',
        name: wikiDocSessionNameForCard('card-uuid-1'),
        deleted_at: '2026-01-01',
      },
    });
    expect(findActiveWikiDocSession(s, p, { cardId: 'card-uuid-1' })).toBeNull();
  });
});

describe('dispatchWikiDocOnMerge', () => {
  const p = project();
  const docs = agent();

  function deps(stmts: Stmts, handleChat = vi.fn().mockResolvedValue(undefined)) {
    return {
      stmts,
      config: {} as never,
      findProject: () => p,
      findAgent: () => ({ agent: docs, project: p }),
      handleChat,
      broadcast: vi.fn(),
    };
  }

  it('creates a no-worktree session, comments the card, and kicks the docs agent', () => {
    const stmts = fakeStmts();
    const handleChat = vi.fn().mockResolvedValue(undefined);
    const result = dispatchWikiDocOnMerge(deps(stmts, handleChat), {
      projectId: 'p1',
      card: card(),
      prNumber: 7,
      prTitle: 'Add hook',
    });
    expect(isWikiDocSkip(result)).toBe(false);
    if (isWikiDocSkip(result)) return;
    expect(result.reused).toBe(false);
    expect(result.kind).toBe('merge');
    expect(stmts.createSession.run).toHaveBeenCalledWith(
      expect.any(String),
      'docs-1',
      wikiDocSessionNameForCard('card-uuid-1'),
      'claude-code',
      expect.anything(),
      0,
      0,
      1,
    );
    expect(stmts.insertBackgroundTask.run).toHaveBeenCalledOnce();
    expect(stmts.createKanbanCardComment.run).toHaveBeenCalledOnce();
    expect(handleChat).toHaveBeenCalledOnce();
    const msg = handleChat.mock.calls[0]![1] as { content: string };
    expect(msg.content).toContain('Add wiki merge hook');
  });

  it('skips when the card is already documented', () => {
    const result = dispatchWikiDocOnMerge(deps(fakeStmts()), {
      projectId: 'p1',
      card: card({ documented: 1 }),
    });
    expect(result).toEqual({ skipped: true, reason: 'already_documented' });
  });

  it('skips when there is no docs agent', () => {
    const pNoDocs = project({ agents: [agent({ id: 'dev', role: 'dev' })] });
    const result = dispatchWikiDocOnMerge(
      {
        stmts: fakeStmts(),
        config: {} as never,
        findProject: () => pNoDocs,
        findAgent: () => null,
        handleChat: vi.fn(),
      },
      { projectId: 'p1', card: card() },
    );
    expect(result).toEqual({ skipped: true, reason: 'no_docs_agent' });
  });

  it('skips when there is no card', () => {
    const result = dispatchWikiDocOnMerge(deps(fakeStmts()), { projectId: 'p1', card: null });
    expect(result).toEqual({ skipped: true, reason: 'no_card' });
  });

  it('reuses an already-running session for the same card', () => {
    const active = {
      id: 'existing',
      agent_id: 'docs-1',
      name: wikiDocSessionNameForCard('card-uuid-1'),
    };
    const stmts = fakeStmts({
      getRunningBackgroundTasks: { all: () => [{ session_id: 'existing', agent_id: 'docs-1' }] },
      getSession: { get: () => active },
    });
    const handleChat = vi.fn();
    const result = dispatchWikiDocOnMerge(deps(stmts, handleChat), {
      projectId: 'p1',
      card: card(),
    });
    expect(isWikiDocSkip(result)).toBe(false);
    if (isWikiDocSkip(result)) return;
    expect(result.reused).toBe(true);
    expect(result.sessionId).toBe('existing');
    expect(handleChat).not.toHaveBeenCalled();
    expect(stmts.createSession.run).not.toHaveBeenCalled();
  });

  it('marks a rejected handleChat as error so a later merge starts a new review', async () => {
    const ALLOWED = new Set(['running', 'done', 'error']);
    const tasks: Array<{ id: string; session_id: string; agent_id: string; status: string }> = [];
    const sessions: Record<string, Partial<SessionRow>> = {};
    const stmts = fakeStmts({
      createSession: {
        run: vi.fn((id: string, agentId: string, name: string) => {
          sessions[id] = { id, agent_id: agentId, name };
        }),
      },
      getSession: {
        get: vi.fn((id: string) => sessions[id]),
      },
      insertBackgroundTask: {
        run: vi.fn((id: string, sessionId: string, agentId: string) => {
          tasks.push({ id, session_id: sessionId, agent_id: agentId, status: 'running' });
        }),
      },
      updateBackgroundTaskStatus: {
        run: vi.fn((status: string, taskId: string) => {
          if (!ALLOWED.has(status)) {
            throw new Error("CHECK constraint failed: status IN ('running','done','error')");
          }
          const task = tasks.find((t) => t.id === taskId);
          if (task) task.status = status;
        }),
      },
      getRunningBackgroundTasks: {
        all: vi.fn(() => tasks.filter((t) => t.status === 'running')),
      },
    });
    const handleChat = vi.fn().mockRejectedValue(new Error('kickoff boom'));
    const d = deps(stmts, handleChat);

    const first = dispatchWikiDocOnMerge(d, { projectId: 'p1', card: card() });
    expect(isWikiDocSkip(first)).toBe(false);
    if (isWikiDocSkip(first)) return;
    expect(first.reused).toBe(false);

    await vi.waitFor(() => {
      expect(stmts.updateBackgroundTaskStatus.run).toHaveBeenCalledWith(
        'error',
        expect.any(String),
      );
    });
    expect(tasks.every((t) => t.status === 'error')).toBe(true);
    expect(stmts.getRunningBackgroundTasks.all()).toEqual([]);

    const second = dispatchWikiDocOnMerge(d, { projectId: 'p1', card: card() });
    expect(isWikiDocSkip(second)).toBe(false);
    if (isWikiDocSkip(second)) return;
    expect(second.reused).toBe(false);
    expect(second.sessionId).not.toBe(first.sessionId);
    expect(handleChat).toHaveBeenCalledTimes(2);
  });
});

describe('dispatchWikiDocBackfill', () => {
  const p = project();
  const docs = agent();

  it('skips an empty queue', () => {
    const result = dispatchWikiDocBackfill(
      {
        stmts: fakeStmts(),
        config: {} as never,
        findProject: () => p,
        findAgent: () => ({ agent: docs, project: p }),
        handleChat: vi.fn(),
      },
      { project: p, cards: [] },
    );
    expect(result).toEqual({ skipped: true, reason: 'none_undocumented' });
  });

  it('kicks a backfill session named with the backfill prefix', () => {
    const stmts = fakeStmts({
      getSession: { get: () => ({ id: 'sess', name: wikiDocBackfillSessionName() }) },
    });
    const handleChat = vi.fn().mockResolvedValue(undefined);
    const result = dispatchWikiDocBackfill(
      {
        stmts,
        config: {} as never,
        findProject: () => p,
        findAgent: () => ({ agent: docs, project: p }),
        handleChat,
      },
      { project: p, cards: [{ id: 'c1', title: 'Old ticket' }] },
    );
    expect(isWikiDocSkip(result)).toBe(false);
    if (isWikiDocSkip(result)) return;
    expect(result.kind).toBe('backfill');
    expect(stmts.createSession.run).toHaveBeenCalledWith(
      expect.any(String),
      'docs-1',
      wikiDocBackfillSessionName(),
      'claude-code',
      expect.anything(),
      0,
      0,
      1,
    );
    const msg = handleChat.mock.calls[0]![1] as { content: string };
    expect(msg.content).toContain('Old ticket');
  });
});

describe('maybeMarkLinkedCardDocumented', () => {
  it('no-ops without a session id', () => {
    const stmts = fakeStmts();
    expect(maybeMarkLinkedCardDocumented(stmts, null)).toEqual({ marked: false });
    expect(stmts.markCardDocumented.run).not.toHaveBeenCalled();
  });

  it('no-ops when the session has no linked card', () => {
    const stmts = fakeStmts();
    expect(maybeMarkLinkedCardDocumented(stmts, 'sess-1')).toEqual({ marked: false });
  });

  it('stamps an undocumented linked card', () => {
    const stmts = fakeStmts({
      getKanbanCardBySession: { get: () => card({ id: 'c-linked', documented: 0 }) },
    });
    expect(maybeMarkLinkedCardDocumented(stmts, 'sess-1')).toEqual({
      marked: true,
      cardId: 'c-linked',
    });
    expect(stmts.markCardDocumented.run).toHaveBeenCalledWith('c-linked');
  });

  it('does not re-stamp an already-documented card', () => {
    const stmts = fakeStmts({
      getKanbanCardBySession: { get: () => card({ id: 'c-linked', documented: 1 }) },
    });
    expect(maybeMarkLinkedCardDocumented(stmts, 'sess-1')).toEqual({
      marked: false,
      cardId: 'c-linked',
    });
    expect(stmts.markCardDocumented.run).not.toHaveBeenCalled();
  });
});

describe('maybeDispatchWikiDocOnMerge', () => {
  it('no-ops when the merge hook is not wired', () => {
    expect(maybeDispatchWikiDocOnMerge({ projectId: 'p1', card: card() })).toEqual({
      skipped: true,
      reason: 'no_hook',
    });
  });

  it('dispatches through the wired hook', () => {
    const stmts = fakeStmts();
    const handleChat = vi.fn().mockResolvedValue(undefined);
    const p = project();
    initWikiDocMergeHook({
      stmts,
      config: {} as never,
      findProject: () => p,
      findAgent: () => ({ agent: agent(), project: p }),
      handleChat,
    });
    const result = maybeDispatchWikiDocOnMerge({ projectId: 'p1', card: card() });
    expect(isWikiDocSkip(result)).toBe(false);
    expect(handleChat).toHaveBeenCalledOnce();
  });

  it('reports a thrown createSession failure as dispatch_error, not no_project', () => {
    const stmts = fakeStmts({
      createSession: {
        run: vi.fn(() => {
          throw new Error('UNIQUE constraint failed: sessions.id');
        }),
      },
    });
    const p = project();
    initWikiDocMergeHook({
      stmts,
      config: {} as never,
      findProject: () => p,
      findAgent: () => ({ agent: agent(), project: p }),
      handleChat: vi.fn(),
    });
    const result = maybeDispatchWikiDocOnMerge({ projectId: 'p1', card: card() });
    expect(result).toEqual({
      skipped: true,
      reason: 'dispatch_error',
      message: 'UNIQUE constraint failed: sessions.id',
    });
  });
});

describe('session name helpers', () => {
  it('keeps card ids in the merge session name so reuse can match', () => {
    expect(wikiDocSessionNameForCard('abc')).toBe(`${WIKI_DOC_SESSION_PREFIX} abc`);
  });
});
