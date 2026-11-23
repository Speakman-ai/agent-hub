import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent, KanbanCardRow, Project } from '../types.js';
import {
  __resetDefaultBranchAutofixState,
  fixSessionOwnerCandidates,
  maybeDispatchDefaultBranchFix,
  pickDefaultBranchFixAgent,
  type DefaultBranchAutofixDeps,
} from './default-branch-autofix.js';
import type { RecordDefaultBranchResult } from './default-branch-health.js';

const agents = [
  { id: 'rev', name: 'Reviewer', role: 'reviewer' },
  { id: 'lead', name: 'Lead', role: 'lead' },
  { id: 'dev', name: 'Dev', role: 'dev' },
  { id: 'dev2', name: 'Dev 2', role: 'dev' },
] as Agent[];

function project(ciOnPush: Project['ciOnPush']): Project {
  return { id: 'p1', name: 'P1', agents, ciOnPush } as unknown as Project;
}

const RED: RecordDefaultBranchResult = {
  kind: 'recorded',
  failing: 2,
  breakageId: 'b1',
  cardId: 'card-1',
  opened: true,
  suspectSessionIds: ['s-new', 's-old'],
};

function makeDeps(card: Partial<KanbanCardRow> | null, assign: ReturnType<typeof vi.fn>) {
  const comments: string[] = [];
  const rows: Array<{ author: string; content: string }> = [];
  const deps = {
    stmts: {
      getKanbanCard: { get: vi.fn(() => (card ? { id: 'card-1', ...card } : undefined)) },
      getKanbanCardComments: { all: vi.fn(() => rows) },
      createKanbanCardComment: {
        run: vi.fn((_id: string, _card: string, author: string, body: string) => {
          comments.push(body);
          rows.push({ author, content: body });
        }),
      },
    },
    config: {},
    broadcast: vi.fn(),
    findAgent: vi.fn(),
    findProject: vi.fn(),
    handleChat: vi.fn(),
    assign,
    sessionOwner: (id: string) => ({ 's-new': 'alice', 's-old': 'bob' })[id] ?? null,
    fallbackOwner: () => 'owner',
  } as unknown as DefaultBranchAutofixDeps;
  return { deps, comments };
}

type AssignCall = [unknown, { ownerUserId: string | null; comment?: string }];
const callsOf = (fn: ReturnType<typeof vi.fn>): AssignCall[] =>
  fn.mock.calls as unknown as AssignCall[];

const ARGS = { branch: 'main', headSha: 'abcdef1234567890' };

beforeEach(() => __resetDefaultBranchAutofixState());

describe('maybeDispatchDefaultBranchFix', () => {
  it('assigns the breakage card to the dev agent as the newest merge session owner', async () => {
    const assign = vi.fn(async () => ({ ok: true, sessionId: 'fix-1' }));
    const { deps } = makeDeps({ session_id: null }, assign);
    const res = await maybeDispatchDefaultBranchFix(deps, {
      ...ARGS,
      project: project({ enabled: true, autoFix: true }),
      result: RED,
    });
    expect(res).toEqual({ outcome: 'dispatched', sessionId: 'fix-1' });
    expect(assign).toHaveBeenCalledTimes(1);
    expect(callsOf(assign)[0]![1]).toMatchObject({
      projectId: 'p1',
      agentId: 'dev',
      ownerUserId: 'alice',
    });
    expect(callsOf(assign)[0]![1].comment).toContain('`main` went red at `abcdef12`');
  });

  it('does nothing unless both CI on push and auto-fix are on', async () => {
    const assign = vi.fn();
    const { deps } = makeDeps({ session_id: null }, assign);
    for (const ci of [{ enabled: true }, { enabled: false, autoFix: true }, undefined]) {
      const res = await maybeDispatchDefaultBranchFix(deps, {
        ...ARGS,
        project: project(ci),
        result: RED,
      });
      expect(res.outcome).toBe('disabled');
    }
    expect(assign).not.toHaveBeenCalled();
  });

  it('skips a card that already has a fix session', async () => {
    const assign = vi.fn();
    const { deps } = makeDeps({ session_id: 'earlier' }, assign);
    const res = await maybeDispatchDefaultBranchFix(deps, {
      ...ARGS,
      project: project({ enabled: true, autoFix: true }),
      result: { ...RED, opened: false },
    });
    expect(res).toEqual({ outcome: 'already_assigned', sessionId: 'earlier' });
    expect(assign).not.toHaveBeenCalled();
  });

  it('skips a result with no open breakage', async () => {
    const assign = vi.fn();
    const { deps } = makeDeps({ session_id: null }, assign);
    const res = await maybeDispatchDefaultBranchFix(deps, {
      ...ARGS,
      project: project({ enabled: true, autoFix: true }),
      result: { kind: 'recorded', failing: 0, breakageId: 'b1', cardId: 'card-1' },
    });
    expect(res.outcome).toBe('no_breakage');
    expect(assign).not.toHaveBeenCalled();
  });

  it('tries the next owner when one has no engine login', async () => {
    const assign = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 409,
        body: { error: 'login needed', code: 'no_account_credentials' },
      })
      .mockResolvedValueOnce({ ok: true, sessionId: 'fix-2' });
    const { deps } = makeDeps({ session_id: null }, assign);
    const res = await maybeDispatchDefaultBranchFix(deps, {
      ...ARGS,
      project: project({ enabled: true, autoFix: true }),
      result: RED,
    });
    expect(res).toEqual({ outcome: 'dispatched', sessionId: 'fix-2' });
    expect(callsOf(assign).map((c) => c[1].ownerUserId)).toEqual(['alice', 'bob']);
  });

  it('comments on the card once when no owner can start the session', async () => {
    const assign = vi.fn(async () => ({
      ok: false,
      status: 409,
      body: { error: 'login needed', code: 'no_account_credentials' },
    }));
    const { deps, comments } = makeDeps({ session_id: null }, assign);
    const res = await maybeDispatchDefaultBranchFix(deps, {
      ...ARGS,
      project: project({ enabled: true, autoFix: true }),
      result: RED,
    });
    expect(res.outcome).toBe('failed');
    // alice, bob, the org owner, then no owner.
    expect(assign).toHaveBeenCalledTimes(4);
    expect(comments).toHaveLength(1);
    expect(comments[0]).toContain('Could not start a fix session automatically');

    await maybeDispatchDefaultBranchFix(deps, {
      ...ARGS,
      project: project({ enabled: true, autoFix: true }),
      result: { ...RED, opened: false },
    });
    expect(comments).toHaveLength(1);
  });

  it('stops after a failure that is not about the owner', async () => {
    const assign = vi.fn(async () => ({
      ok: false,
      status: 409,
      body: { error: 'card_already_done' },
    }));
    const { deps } = makeDeps({ session_id: null }, assign);
    const res = await maybeDispatchDefaultBranchFix(deps, {
      ...ARGS,
      project: project({ enabled: true, autoFix: true }),
      result: RED,
    });
    expect(res).toMatchObject({ outcome: 'failed', error: 'card_already_done' });
    expect(assign).toHaveBeenCalledTimes(1);
  });

  it('does not double-dispatch concurrent calls for the same card', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const assign = vi.fn(async () => {
      await gate;
      return { ok: true, sessionId: 'fix-3' };
    });
    const { deps } = makeDeps({ session_id: null }, assign);
    const p = project({ enabled: true, autoFix: true });
    const first = maybeDispatchDefaultBranchFix(deps, { ...ARGS, project: p, result: RED });
    const second = await maybeDispatchDefaultBranchFix(deps, { ...ARGS, project: p, result: RED });
    release();
    expect(second.outcome).toBe('in_flight');
    expect((await first).outcome).toBe('dispatched');
    expect(assign).toHaveBeenCalledTimes(1);
  });
});

describe('pickDefaultBranchFixAgent', () => {
  it('uses the configured agent, else the first dev agent, never the reviewer', () => {
    expect(pickDefaultBranchFixAgent(project({ autoFixAgentId: 'dev2' }))?.id).toBe('dev2');
    expect(pickDefaultBranchFixAgent(project({}))?.id).toBe('dev');
    expect(pickDefaultBranchFixAgent(project({ autoFixAgentId: 'rev' }))?.id).toBe('dev');
    expect(pickDefaultBranchFixAgent(project({ autoFixAgentId: 'gone' }))?.id).toBe('dev');
  });
});

describe('fixSessionOwnerCandidates', () => {
  it('orders merge-session owners, then the org owner, then no owner, without repeats', () => {
    const owners = { a: 'u1', b: 'u2', c: 'u1', d: null } as Record<string, string | null>;
    expect(
      fixSessionOwnerCandidates(
        ['a', 'b', 'c', 'd'],
        (id) => owners[id] ?? null,
        () => 'u2',
      ),
    ).toEqual(['u1', 'u2', null]);
  });
});

describe('failure comments', () => {
  const noLogin = async () => ({
    ok: false,
    status: 409,
    body: { error: 'login needed', code: 'no_account_credentials' },
  });

  it('comments on the first failed attempt for an existing breakage, then never again', async () => {
    const { deps, comments } = makeDeps({ session_id: null }, vi.fn(noLogin));
    const p = project({ enabled: true, autoFix: true });
    // Auto-fix switched on mid-streak: the breakage was opened by an earlier run.
    const later = { ...RED, opened: false };
    expect(
      (await maybeDispatchDefaultBranchFix(deps, { ...ARGS, project: p, result: later })).outcome,
    ).toBe('failed');
    expect(comments).toHaveLength(1);
    expect(comments[0]).toContain('Could not start a fix session automatically: login needed');
    await maybeDispatchDefaultBranchFix(deps, { ...ARGS, project: p, result: later });
    await maybeDispatchDefaultBranchFix(deps, { ...ARGS, project: p, result: RED });
    expect(comments).toHaveLength(1);
  });

  it('an exception during assignment comments once too', async () => {
    const assign = vi.fn(async () => {
      throw new Error('db locked');
    });
    const { deps, comments } = makeDeps({ session_id: null }, assign);
    const p = project({ enabled: true, autoFix: true });
    const res = await maybeDispatchDefaultBranchFix(deps, {
      ...ARGS,
      project: p,
      result: { ...RED, opened: false },
    });
    expect(res).toMatchObject({ outcome: 'failed', error: 'db locked' });
    await maybeDispatchDefaultBranchFix(deps, { ...ARGS, project: p, result: RED });
    expect(comments).toEqual([
      'Could not start a fix session automatically: db locked. Assign this card to start one.',
    ]);
  });
});
