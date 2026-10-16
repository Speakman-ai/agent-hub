import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Project, PullRequestRow, Stmts } from '../types.js';

const spawnMock = vi.fn();
vi.mock('../routes/pr-resolve.js', () => ({
  spawnPrResolveSession: (...args: unknown[]) => spawnMock(...args),
}));
vi.mock('./author-user.js', () => ({
  isKnownHubUserId: (id: string | null | undefined) => id === 'user-1',
}));

const {
  __resetAutoResolveState,
  autoResolveOnBaseMoved,
  autoResolveOnChecksFailed,
  maybeAutoResolvePr,
  pickAutoResolveAgent,
  MAX_AUTO_RESOLVE_DISPATCHES_PER_PR,
} = await import('./auto-resolve.js');

const HEAD = 'a'.repeat(40);

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: 'proj',
    name: 'Proj',
    gitHost: 'agenthub',
    autoResolvePr: { enabled: true },
    agents: [
      { id: 'rev', name: 'Reviewer', role: 'reviewer' },
      { id: 'dev', name: 'Dev', role: 'dev' },
    ],
    ...overrides,
  } as unknown as Project;
}

function prRow(overrides: Partial<PullRequestRow> = {}): PullRequestRow {
  return {
    number: 7,
    project_id: 'proj',
    status: 'open',
    author: 'user-1',
    head_branch: 'feature',
    base_branch: 'main',
    head_sha: HEAD,
    ...overrides,
  } as PullRequestRow;
}

interface DetailOpts {
  headSha?: string;
  mergeable?: boolean | null;
  failing?: boolean;
  reviews?: Array<Record<string, unknown>>;
}

function makeDeps(rows: PullRequestRow[], detail: DetailOpts = {}) {
  const state = { detail };
  const stmts = {
    getPullRequestByNumber: {
      get: (_p: string, n: number) => rows.find((r) => r.number === n),
    },
    listPullRequestsForProject: { all: () => rows.filter((r) => r.status === 'open') },
    getOpenPullRequestByHeadBranch: {
      get: (_p: string, branch: string) =>
        rows.find((r) => r.head_branch === branch && r.status === 'open'),
    },
  } as unknown as Stmts;
  const handleChat = vi.fn();
  const getDetail = vi.fn(async ({ number }: { number: number }) => ({
    source: 'agenthub' as const,
    pr: {
      number,
      title: 'T',
      head: 'feature',
      base: 'main',
      mergeable: state.detail.mergeable ?? true,
    },
    reviews: state.detail.reviews ?? [],
    comments: [],
    checks: state.detail.failing
      ? [{ name: 'ci/test', status: 'completed', conclusion: 'failure' }]
      : [{ name: 'ci/test', status: 'in_progress', conclusion: null }],
    headSha: state.detail.headSha ?? HEAD,
  }));
  return {
    state,
    handleChat,
    getDetail,
    deps: {
      stmts,
      config: {} as never,
      broadcast: vi.fn(),
      handleChat,
      nativePr: { getDetail } as never,
    },
  };
}

beforeEach(() => {
  __resetAutoResolveState();
  spawnMock.mockReset();
  let n = 0;
  spawnMock.mockImplementation(() => ({ sessionId: `s${++n}`, triggered: [], session: {} }));
});

describe('maybeAutoResolvePr', () => {
  it('does nothing when the project has not opted in', async () => {
    const { deps, getDetail } = makeDeps([prRow()], { failing: true });
    const r = await maybeAutoResolvePr(
      project({ autoResolvePr: { enabled: false } }),
      7,
      { kind: 'ci', headSha: HEAD, reason: 'job test failed' },
      deps,
    );
    expect(r.outcome).toBe('disabled');
    expect(getDetail).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('dispatches on the first failed CI job and dedupes the rest for the same head', async () => {
    const { deps } = makeDeps([prRow()], { failing: true });
    const p = project();
    const [a, b] = await Promise.all([
      maybeAutoResolvePr(p, 7, { kind: 'ci', headSha: HEAD, reason: 'job a failed' }, deps),
      maybeAutoResolvePr(p, 7, { kind: 'ci', headSha: HEAD, reason: 'job b failed' }, deps),
    ]);
    expect(a.outcome).toBe('dispatched');
    expect(b.outcome).toBe('deduped');
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const args = spawnMock.mock.calls[0][1];
    expect(args.agentId).toBe('dev');
    expect(args.ownerUserId).toBe('user-1');
    expect(args.native).toBe(true);
    expect(args.preamble).toMatch(/PR CI went red \(job a failed\)/);
    expect(args.preamble).toMatch(/merge conflicts.*failing tests\/CI.*review/s);
  });

  it('ignores a CI failure for a head the PR has moved past', async () => {
    const { deps } = makeDeps([prRow()], { failing: true, headSha: 'b'.repeat(40) });
    const r = await maybeAutoResolvePr(
      project(),
      7,
      { kind: 'ci', headSha: HEAD, reason: 'x' },
      deps,
    );
    expect(r.outcome).toBe('stale_head');
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('dispatches on a conflict only when the PR no longer merges', async () => {
    const clean = makeDeps([prRow()], { mergeable: true });
    expect(
      (
        await maybeAutoResolvePr(
          project(),
          7,
          { kind: 'conflict', reason: 'main moved' },
          clean.deps,
        )
      ).outcome,
    ).toBe('no_signal');

    const dirty = makeDeps([prRow()], { mergeable: false });
    expect(
      (
        await maybeAutoResolvePr(
          project(),
          7,
          { kind: 'conflict', reason: 'main moved' },
          dirty.deps,
        )
      ).outcome,
    ).toBe('dispatched');
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('dispatches on changes requested and drops dismissed reviews from the prompt', async () => {
    const { deps } = makeDeps([prRow()], {
      reviews: [
        { user: 'old', state: 'CHANGES_REQUESTED', dismissed: true },
        { user: 'bob', state: 'CHANGES_REQUESTED', dismissed: false },
      ],
    });
    const r = await maybeAutoResolvePr(
      project(),
      7,
      { kind: 'review', reviewer: 'bob', body: 'rename it' },
      deps,
    );
    expect(r.outcome).toBe('dispatched');
    const detail = spawnMock.mock.calls[0][1].detail;
    expect(detail.reviews.map((x: { user: string }) => x.user)).toEqual(['bob']);
  });

  it('forwards a later changes-requested review into the session already working the head', async () => {
    const { deps, handleChat } = makeDeps([prRow()], { failing: true });
    const p = project();
    await maybeAutoResolvePr(p, 7, { kind: 'ci', headSha: HEAD, reason: 'x' }, deps);
    const r = await maybeAutoResolvePr(
      p,
      7,
      { kind: 'review', reviewer: 'bob', body: 'please add tests' },
      deps,
    );
    expect(r).toEqual({ outcome: 'forwarded', sessionId: 's1' });
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(handleChat).toHaveBeenCalledTimes(1);
    const msg = handleChat.mock.calls[0][1];
    expect(msg.sessionId).toBe('s1');
    expect(msg.content).toMatch(/please add tests/);
  });

  it('forwards a review to the agent that owns the session, not the newly configured one', async () => {
    const { deps, handleChat } = makeDeps([prRow()], { failing: true });
    const agents = [
      { id: 'dev', name: 'Dev', role: 'dev' },
      { id: 'dev2', name: 'Dev 2', role: 'dev' },
    ];
    const before = project({ agents: agents as never, autoResolvePr: { enabled: true } });
    await maybeAutoResolvePr(before, 7, { kind: 'ci', headSha: HEAD, reason: 'x' }, deps);
    expect(spawnMock.mock.calls[0][1].agentId).toBe('dev');

    const after = project({
      agents: agents as never,
      autoResolvePr: { enabled: true, agentId: 'dev2' },
    });
    const r = await maybeAutoResolvePr(
      after,
      7,
      { kind: 'review', reviewer: 'bob', body: 'rename it' },
      deps,
    );
    expect(r.outcome).toBe('forwarded');
    const msg = handleChat.mock.calls[0][1];
    expect(msg).toMatchObject({ sessionId: 's1', agentId: 'dev' });
  });

  it('dispatches again for a new head and stops at the per-PR cap', async () => {
    const { deps, state } = makeDeps([prRow()], { failing: true });
    const p = project();
    for (let i = 0; i < MAX_AUTO_RESOLVE_DISPATCHES_PER_PR; i++) {
      const sha = String(i).repeat(40);
      state.detail = { failing: true, headSha: sha };
      const r = await maybeAutoResolvePr(p, 7, { kind: 'ci', headSha: sha, reason: 'x' }, deps);
      expect(r.outcome).toBe('dispatched');
    }
    state.detail = { failing: true, headSha: 'f'.repeat(40) };
    const capped = await maybeAutoResolvePr(
      p,
      7,
      { kind: 'ci', headSha: 'f'.repeat(40), reason: 'x' },
      deps,
    );
    expect(capped.outcome).toBe('capped');
    expect(spawnMock).toHaveBeenCalledTimes(MAX_AUTO_RESOLVE_DISPATCHES_PER_PR);
  });

  it('skips closed PRs', async () => {
    const { deps } = makeDeps([prRow({ status: 'merged' })], { failing: true });
    const r = await maybeAutoResolvePr(
      project(),
      7,
      { kind: 'ci', headSha: HEAD, reason: 'x' },
      deps,
    );
    expect(r.outcome).toBe('not_open');
  });

  it('leaves the owner unset when the PR author is not a Hub user', async () => {
    const { deps } = makeDeps([prRow({ author: 'ghost' })], { failing: true });
    await maybeAutoResolvePr(project(), 7, { kind: 'ci', headSha: HEAD, reason: 'x' }, deps);
    expect(spawnMock.mock.calls[0][1].ownerUserId).toBeNull();
  });
});

describe('trigger fan-out', () => {
  it('maps a failed branch CI run to the open PR it backs', async () => {
    const { deps } = makeDeps([prRow()], { failing: true });
    const r = await autoResolveOnChecksFailed(
      project(),
      { branch: 'feature', headSha: HEAD, reason: 'job test failed' },
      deps,
    );
    expect(r.outcome).toBe('dispatched');
    const none = await autoResolveOnChecksFailed(
      project(),
      { branch: 'other', headSha: HEAD, reason: 'x' },
      deps,
    );
    expect(none.outcome).toBe('not_open');
  });

  it('probes only open PRs targeting the moved base branch', async () => {
    const rows = [
      prRow({ number: 1, base_branch: 'main', head_branch: 'a' }),
      prRow({ number: 2, base_branch: 'release', head_branch: 'b' }),
    ];
    const { deps, getDetail } = makeDeps(rows, { mergeable: false });
    await autoResolveOnBaseMoved(project(), 'main', deps);
    expect(getDetail).toHaveBeenCalledTimes(1);
    expect(getDetail.mock.calls[0][0].number).toBe(1);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });
});

describe('pickAutoResolveAgent', () => {
  it('prefers the configured agent, then a dev agent, never the reviewer', () => {
    expect(pickAutoResolveAgent(project())?.id).toBe('dev');
    expect(
      pickAutoResolveAgent(project({ autoResolvePr: { enabled: true, agentId: 'rev' } }))?.id,
    ).toBe('rev');
    expect(
      pickAutoResolveAgent(project({ autoResolvePr: { enabled: true, agentId: 'gone' } }))?.id,
    ).toBe('dev');
    expect(
      pickAutoResolveAgent(
        project({ agents: [{ id: 'rev', name: 'R', role: 'reviewer' }] as never }),
      ),
    ).toBeNull();
  });
});
