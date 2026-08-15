/**
 * Unit tests for the two new POST endpoints on the finalize router:
 *
 *   - POST /api/projects/:projectId/cards/:cardId/finalize
 *   - POST /api/projects/:projectId/finalize/:runId/cancel
 *
 * We mount the router onto a minimal Express app and stub `runFinalize`,
 * `session-ownership`, and the prepared statements so the route logic is
 * exercised in isolation. The integration suite in `finalize.test.ts`
 * keeps the read-only routes covered against the real DB.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import supertest from 'supertest';

const { runFinalize, computeIdempotencyKey, buildOrchestratorDeps } = vi.hoisted(() => ({
  runFinalize: vi.fn(),
  computeIdempotencyKey: vi.fn((..._args: unknown[]) => 'idem-key-FAKE'),
  buildOrchestratorDeps: vi.fn(() => ({})),
}));

const { userCanReadSession, userOwnsSession } = vi.hoisted(() => ({
  userCanReadSession: vi.fn().mockReturnValue(true),
  userOwnsSession: vi.fn().mockReturnValue(true),
}));

const execFileAsyncMock = vi.hoisted(() => vi.fn());

/**
 * Worktree git now runs through `HostWorktreeIo`, i.e. `promisify(execFile)`
 * with an argv array — so fakes receive `(file, args)`, not a command string.
 */
function gitArgv(args: unknown): string[] {
  return Array.isArray(args) ? (args as string[]) : [];
}

/** A non-zero git exit, in the shape `execFile` actually rejects with. */
function gitExit(code: number, stdout = ''): Promise<never> {
  return Promise.reject(
    Object.assign(new Error(`git exited ${code}`), { code, stdout, stderr: '' }),
  );
}

// The Finalize gate's net-diff probe calls `execFile` with a callback (it does
// not go through the promisified path below), so the fake has to invoke it or
// the kickoff hangs. Canned answers: the base ref resolves, and HEAD differs
// from it, i.e. the branch has something to ship.
const execFileCallbackMock = vi.hoisted(() =>
  vi.fn((_file: unknown, args: string[], opts: unknown, cb?: unknown) => {
    const done = (typeof cb === 'function' ? cb : typeof opts === 'function' ? opts : null) as
      | ((err: unknown, stdout: string, stderr: string) => void)
      | null;
    if (!done) return;
    if (args?.[0] === 'diff') {
      done(Object.assign(new Error('differences found'), { code: 1 }), '', '');
      return;
    }
    done(null, 'deadbeef\n', '');
  }),
);

vi.mock('child_process', () => ({
  execFile: execFileCallbackMock,
  exec: vi.fn(),
}));

vi.mock('util', async () => {
  const real = await vi.importActual<typeof import('util')>('util');
  return {
    ...real,
    promisify: () => execFileAsyncMock,
  };
});

vi.mock('../session-ownership.js', () => ({
  userCanReadSession,
  userOwnsSession,
}));

const { cancelSessionChatRun } = vi.hoisted(() => ({
  cancelSessionChatRun: vi.fn(),
}));
vi.mock('../session-chat-cancel.js', () => ({
  cancelSessionChatRun,
}));

vi.mock('../finalize/orchestrator.js', () => ({
  runFinalize,
  computeIdempotencyKey,
}));

vi.mock('../finalize/orchestrator-deps.js', () => ({
  buildOrchestratorDeps,
}));

// The session lookup now flows through `stmts.getSession` (not a raw
// `getDb().prepare(...)`); we keep the `db.js` mock to neutralise any
// lingering imports but the real fixture lives on `makeStmts()` below.
const dbGetSession = vi.fn();
vi.mock('../db.js', () => ({
  getDb: () => ({
    prepare: () => ({ get: dbGetSession }),
  }),
  // Downstream modules now reachable in this test's import graph (e.g.
  // heartbeat.ts via workflow-runner.ts) read the `db`/`stmts` singletons
  // at module load; provide inert stand-ins so the module graph resolves.
  db: {},
  stmts: {},
  getStmts: () => ({}),
  initDb: () => {},
}));

// Import after all mocks so the route file binds to them.
import createFinalizeRoutes from './finalize.js';
import { resolveFinalizeAttempt } from '../finalize/trigger-run.js';
import { getSessionWorktreeLockOwner } from '../session-worktree-lock.js';
import type { FinalizeRunRow, RouteDeps } from '../types.js';

function makeStmts() {
  return {
    getFinalizeRun: { get: vi.fn() },
    getFinalizeRunByIdempotencyKey: { get: vi.fn() },
    getActiveFinalizeRunForSessionBranch: { get: vi.fn() },
    insertFinalizeKickoffClaim: { run: vi.fn(() => ({ changes: 1 })) },
    deleteFinalizeKickoffClaim: { run: vi.fn() },
    pruneStaleFinalizeKickoffClaims: { run: vi.fn() },
    getLatestFinalizeRunForSession: { get: vi.fn() },
    getKanbanCard: { get: vi.fn() },
    getKanbanBoard: { get: vi.fn() },
    getSession: { get: vi.fn() },
    listReviewerThreadsForRun: { all: vi.fn().mockReturnValue([]) },
    getPushedFinalizeRunForSession: { get: vi.fn() },
    failFinalizeRun: { run: vi.fn() },
  };
}

function makeApp() {
  const stmts = makeStmts();
  const broadcast = vi.fn();
  const findProject = vi.fn();
  const findAgent = vi.fn();
  const app = express();
  app.use(express.json());
  const activeProcesses = new Map();
  const deps = {
    stmts,
    broadcast,
    findProject,
    findAgent,
    activeProcesses,
    config: { personalOAuth: null },
  } as unknown as RouteDeps;
  app.use(createFinalizeRoutes(deps));
  return { app, stmts, broadcast, findProject, findAgent, activeProcesses };
}

beforeEach(() => {
  runFinalize.mockReset();
  computeIdempotencyKey.mockReturnValue('idem-key-FAKE');
  buildOrchestratorDeps.mockReturnValue({});
  userCanReadSession.mockReturnValue(true);
  userOwnsSession.mockReturnValue(true);
  cancelSessionChatRun.mockReset();
  execFileAsyncMock.mockReset();
  // Default: every ref resolves, and `diff --quiet` exits 1 — the branch has a
  // real net diff against its base, so the Finalize gate has something to ship.
  execFileAsyncMock.mockImplementation(async (_file: unknown, args: unknown) => {
    const argv = gitArgv(args);
    if (argv[0] === 'diff' && argv.includes('--quiet')) return gitExit(1);
    return { stdout: 'deadbeef\n', stderr: '' };
  });
  dbGetSession.mockReset();
});

describe('POST /api/projects/:projectId/cards/:cardId/finalize', () => {
  it('404 when project is missing', async () => {
    const { app, findProject } = makeApp();
    findProject.mockReturnValue(null);
    const res = await supertest(app)
      .post('/api/projects/proj-1/cards/card-1/finalize')
      .send({})
      .expect(404);
    expect(res.body.error).toMatch(/project/i);
  });

  it('404 when card is missing', async () => {
    const { app, findProject, stmts } = makeApp();
    findProject.mockReturnValue({ id: 'proj-1' });
    stmts.getKanbanCard.get.mockReturnValue(undefined);
    const res = await supertest(app)
      .post('/api/projects/proj-1/cards/card-1/finalize')
      .send({})
      .expect(404);
    expect(res.body.error).toMatch(/card/i);
  });

  it('404 when card belongs to a board in a different project', async () => {
    const { app, findProject, stmts } = makeApp();
    findProject.mockReturnValue({ id: 'proj-1' });
    stmts.getKanbanCard.get.mockReturnValue({
      id: 'card-1',
      board_id: 'board-other',
      session_id: 'sess-1',
    });
    stmts.getKanbanBoard.get.mockReturnValue({ id: 'board-1' });
    await supertest(app).post('/api/projects/proj-1/cards/card-1/finalize').send({}).expect(404);
  });

  it('400 no_session when card has no session_id', async () => {
    const { app, findProject, stmts } = makeApp();
    findProject.mockReturnValue({ id: 'proj-1' });
    stmts.getKanbanCard.get.mockReturnValue({
      id: 'card-1',
      board_id: 'board-1',
      session_id: null,
    });
    stmts.getKanbanBoard.get.mockReturnValue({ id: 'board-1' });
    const res = await supertest(app)
      .post('/api/projects/proj-1/cards/card-1/finalize')
      .send({})
      .expect(400);
    expect(res.body.error).toBe('no_session');
  });

  it('400 no_worktree when session has no worktree_path', async () => {
    const { app, findProject, stmts } = makeApp();
    findProject.mockReturnValue({ id: 'proj-1' });
    stmts.getKanbanCard.get.mockReturnValue({
      id: 'card-1',
      board_id: 'board-1',
      session_id: 'sess-1',
    });
    stmts.getKanbanBoard.get.mockReturnValue({ id: 'board-1' });
    stmts.getSession.get.mockReturnValue({
      id: 'sess-1',
      worktree_path: null,
      worktree_branch: 'feature/x',
    });
    const res = await supertest(app)
      .post('/api/projects/proj-1/cards/card-1/finalize')
      .send({})
      .expect(400);
    expect(res.body.error).toBe('no_worktree');
  });

  it('400 no_branch when session has no worktree_branch', async () => {
    const { app, findProject, stmts } = makeApp();
    findProject.mockReturnValue({ id: 'proj-1' });
    stmts.getKanbanCard.get.mockReturnValue({
      id: 'card-1',
      board_id: 'board-1',
      session_id: 'sess-1',
    });
    stmts.getKanbanBoard.get.mockReturnValue({ id: 'board-1' });
    stmts.getSession.get.mockReturnValue({
      id: 'sess-1',
      worktree_path: '/tmp/wt',
      worktree_branch: null,
    });
    const res = await supertest(app)
      .post('/api/projects/proj-1/cards/card-1/finalize')
      .send({})
      .expect(400);
    expect(res.body.error).toBe('no_branch');
  });

  // Regression: the reported "session finalized with no changes but says 7
  // changes". The agent edited files and never committed, so the branch was
  // identical to its base. Finalize started anyway, rebased, reviewed, and ran
  // the whole CI suite before parking at a summary reading "No commits on this
  // branch, so nothing would ship" beside a Changes badge counting the edits.
  // The kickoff must refuse instead, and name the uncommitted work.
  it('400 no_pushable_commits when the worktree is dirty but has no commits', async () => {
    const { app, findProject, stmts } = makeApp();
    findProject.mockReturnValue({ id: 'proj-1' });
    stmts.getKanbanCard.get.mockReturnValue({
      id: 'card-1',
      board_id: 'board-1',
      session_id: 'sess-1',
    });
    stmts.getKanbanBoard.get.mockReturnValue({ id: 'board-1' });
    stmts.getSession.get.mockReturnValue({
      id: 'sess-1',
      worktree_path: '/tmp/wt',
      worktree_branch: 'feature/x',
    });
    // `git status --porcelain` reports edits; `git log <upstream>..HEAD` is empty.
    execFileAsyncMock.mockImplementation(async (_file: unknown, args: unknown) =>
      gitArgv(args)[0] === 'log'
        ? { stdout: '', stderr: '' }
        : { stdout: ' M server/index.ts\n', stderr: '' },
    );

    const res = await supertest(app)
      .post('/api/projects/proj-1/cards/card-1/finalize')
      .send({})
      .expect(400);

    expect(res.body.error).toBe('no_pushable_commits');
    expect(res.body.message).toContain('uncommitted');
    expect(res.body.message).toContain('commit them');
    expect(runFinalize).not.toHaveBeenCalled();
  });

  it('409 when the linked session already pushed code through Finalize', async () => {
    const { app, findProject, stmts } = makeApp();
    findProject.mockReturnValue({ id: 'proj-1' });
    stmts.getKanbanCard.get.mockReturnValue({
      id: 'card-1',
      board_id: 'board-1',
      session_id: 'sess-1',
    });
    stmts.getKanbanBoard.get.mockReturnValue({ id: 'board-1' });
    stmts.getSession.get.mockReturnValue({
      id: 'sess-1',
      worktree_path: '/tmp/wt',
      worktree_branch: 'feature/x',
    });
    stmts.getPushedFinalizeRunForSession.get.mockReturnValue({
      id: 'run-pushed',
      status: 'pushed',
    });

    const res = await supertest(app)
      .post('/api/projects/proj-1/cards/card-1/finalize')
      .send({ mode: 'checks' })
      .expect(409);

    expect(res.body).toMatchObject({ error: 'session_finalized_pushed' });
    expect(runFinalize).not.toHaveBeenCalled();
  });

  it('409 when push lands after the entry post-push check (inner kickoff TOCTOU)', async () => {
    const { app, findProject, stmts } = makeApp();
    findProject.mockReturnValue({ id: 'proj-1' });
    stmts.getKanbanCard.get.mockReturnValue({
      id: 'card-1',
      board_id: 'board-1',
      session_id: 'sess-1',
    });
    stmts.getKanbanBoard.get.mockReturnValue({ id: 'board-1' });
    stmts.getSession.get.mockReturnValue({
      id: 'sess-1',
      worktree_path: '/tmp/wt',
      worktree_branch: 'feature/x',
    });
    // Entry gate is clean; a sibling push marks the session pushed while
    // kickoff is still resolving the worktree / HEAD.
    let pushedLookups = 0;
    stmts.getPushedFinalizeRunForSession.get.mockImplementation(() => {
      pushedLookups += 1;
      if (pushedLookups === 1) return undefined;
      return { id: 'run-pushed', status: 'pushed' };
    });

    const res = await supertest(app)
      .post('/api/projects/proj-1/cards/card-1/finalize')
      .send({ mode: 'full' })
      .expect(409);

    expect(res.body).toMatchObject({ error: 'session_finalized_pushed' });
    expect(pushedLookups).toBeGreaterThan(1);
    expect(runFinalize).not.toHaveBeenCalled();
  });

  it.each([
    ['consult mode', { session_mode: 'consult', ask_mode: 0 }],
    ['legacy ask_mode', { session_mode: 'chat', ask_mode: 1 }],
  ])('400 when the linked session is in %s', async (_label, modeFields) => {
    const { app, findProject, stmts } = makeApp();
    findProject.mockReturnValue({ id: 'proj-1' });
    stmts.getKanbanCard.get.mockReturnValue({
      id: 'card-1',
      board_id: 'board-1',
      session_id: 'sess-1',
    });
    stmts.getKanbanBoard.get.mockReturnValue({ id: 'board-1' });
    stmts.getSession.get.mockReturnValue({
      id: 'sess-1',
      worktree_path: '/tmp/wt',
      worktree_branch: 'feature/x',
      ...modeFields,
    });

    const res = await supertest(app)
      .post('/api/projects/proj-1/cards/card-1/finalize')
      .send({ mode: 'checks' })
      .expect(400);

    expect(res.body).toMatchObject({ error: 'finalize_not_allowed_in_consult_session' });
    expect(runFinalize).not.toHaveBeenCalled();
  });

  it('404 when caller does not own the session (no leak)', async () => {
    const { app, findProject, stmts } = makeApp();
    findProject.mockReturnValue({ id: 'proj-1' });
    stmts.getKanbanCard.get.mockReturnValue({
      id: 'card-1',
      board_id: 'board-1',
      session_id: 'sess-1',
    });
    stmts.getKanbanBoard.get.mockReturnValue({ id: 'board-1' });
    userOwnsSession.mockReturnValue(false);
    await supertest(app).post('/api/projects/proj-1/cards/card-1/finalize').send({}).expect(404);
  });

  it('409 in_flight when an existing non-terminal row matches the idempotency key', async () => {
    const { app, findProject, stmts } = makeApp();
    findProject.mockReturnValue({ id: 'proj-1' });
    stmts.getKanbanCard.get.mockReturnValue({
      id: 'card-1',
      board_id: 'board-1',
      session_id: 'sess-1',
    });
    stmts.getKanbanBoard.get.mockReturnValue({ id: 'board-1' });
    stmts.getSession.get.mockReturnValue({
      id: 'sess-1',
      worktree_path: '/tmp/wt',
      worktree_branch: 'feature/x',
    });
    stmts.getFinalizeRunByIdempotencyKey.get.mockReturnValue({
      id: 'run-existing',
      status: 'rebasing',
    });
    const res = await supertest(app)
      .post('/api/projects/proj-1/cards/card-1/finalize')
      .send({})
      .expect(409);
    expect(res.body).toMatchObject({
      error: 'in_flight',
      run_id: 'run-existing',
      status: 'rebasing',
    });
  });

  it('409 in_flight when a same-session branch run is already active on a different head', async () => {
    const { app, findProject, stmts } = makeApp();
    findProject.mockReturnValue({ id: 'proj-1' });
    stmts.getKanbanCard.get.mockReturnValue({
      id: 'card-1',
      board_id: 'board-1',
      session_id: 'sess-1',
    });
    stmts.getKanbanBoard.get.mockReturnValue({ id: 'board-1' });
    stmts.getSession.get.mockReturnValue({
      id: 'sess-1',
      worktree_path: '/tmp/wt',
      worktree_branch: 'feature/x',
    });
    stmts.getFinalizeRunByIdempotencyKey.get.mockReturnValue(undefined);
    stmts.getActiveFinalizeRunForSessionBranch.get.mockReturnValue({
      id: 'run-active-old-head',
      status: 'dispatching',
      mode: 'full',
    });

    const res = await supertest(app)
      .post('/api/projects/proj-1/cards/card-1/finalize')
      .send({})
      .expect(409);

    expect(res.body).toMatchObject({
      error: 'in_flight',
      run_id: 'run-active-old-head',
      status: 'dispatching',
    });
    expect(stmts.getActiveFinalizeRunForSessionBranch.get).toHaveBeenCalledWith(
      'sess-1',
      'feature/x',
    );
    expect(runFinalize).not.toHaveBeenCalled();
  });

  it('409 in_flight when a stale review-only run is active on the same branch', async () => {
    const { app, findProject, stmts } = makeApp();
    findProject.mockReturnValue({ id: 'proj-1' });
    stmts.getKanbanCard.get.mockReturnValue({
      id: 'card-1',
      board_id: 'board-1',
      session_id: 'sess-1',
    });
    stmts.getKanbanBoard.get.mockReturnValue({ id: 'board-1' });
    stmts.getSession.get.mockReturnValue({
      id: 'sess-1',
      worktree_path: '/tmp/wt',
      worktree_branch: 'feature/x',
    });
    stmts.getFinalizeRunByIdempotencyKey.get.mockReturnValue(undefined);
    stmts.getActiveFinalizeRunForSessionBranch.get.mockReturnValue({
      id: 'run-stale-review',
      status: 'reviewing',
      mode: 'review',
    });

    const res = await supertest(app)
      .post('/api/projects/proj-1/cards/card-1/finalize')
      .send({ mode: 'full' })
      .expect(409);

    expect(res.body).toMatchObject({
      error: 'in_flight',
      run_id: 'run-stale-review',
      status: 'reviewing',
    });
    expect(stmts.getActiveFinalizeRunForSessionBranch.get).toHaveBeenCalledWith(
      'sess-1',
      'feature/x',
    );
    expect(runFinalize).not.toHaveBeenCalled();
  });

  it('409 in_flight when another kickoff holds the branch claim before its row is visible', async () => {
    const { app, findProject, stmts } = makeApp();
    findProject.mockReturnValue({ id: 'proj-1' });
    stmts.getKanbanCard.get.mockReturnValue({
      id: 'card-1',
      board_id: 'board-1',
      session_id: 'sess-1',
    });
    stmts.getKanbanBoard.get.mockReturnValue({ id: 'board-1' });
    stmts.getSession.get.mockReturnValue({
      id: 'sess-1',
      worktree_path: '/tmp/wt',
      worktree_branch: 'feature/x',
    });
    stmts.getFinalizeRunByIdempotencyKey.get.mockReturnValue(undefined);
    stmts.getActiveFinalizeRunForSessionBranch.get
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce({ id: 'run-created-by-racer', status: 'queued' });
    stmts.insertFinalizeKickoffClaim.run.mockReturnValue({ changes: 0 });

    const res = await supertest(app)
      .post('/api/projects/proj-1/cards/card-1/finalize')
      .send({})
      .expect(409);

    expect(res.body).toMatchObject({
      error: 'in_flight',
      run_id: 'run-created-by-racer',
      status: 'queued',
    });
    expect(stmts.insertFinalizeKickoffClaim.run).toHaveBeenCalledOnce();
    expect(stmts.deleteFinalizeKickoffClaim.run).not.toHaveBeenCalled();
    expect(runFinalize).not.toHaveBeenCalled();
  });

  it('ui_button re-run starts a NEW attempt (new bubble) when the prior run on the head is terminal', async () => {
    const { app, findProject, stmts } = makeApp();
    findProject.mockReturnValue({ id: 'proj-1', githubRepo: 'acme/proj' });
    stmts.getKanbanCard.get.mockReturnValue({
      id: 'card-1',
      board_id: 'board-1',
      session_id: 'sess-1',
      created_by: 'user-1',
      title: 't',
    });
    stmts.getKanbanBoard.get.mockReturnValue({ id: 'board-1' });
    stmts.getSession.get.mockReturnValue({
      id: 'sess-1',
      worktree_path: '/tmp/wt',
      worktree_branch: 'feature/x',
    });
    // Distinct key per attempt so the kickoff walk advances past the finished
    // attempt-1 run instead of reusing it.
    computeIdempotencyKey.mockImplementation(
      (a) => `idem-attempt-${(a as { attempt?: number })?.attempt ?? 1}`,
    );
    let attempt2Created = false;
    stmts.getFinalizeRunByIdempotencyKey.get.mockImplementation((key: string) => {
      if (key === 'idem-attempt-1') return { id: 'run-old', status: 'pushed' };
      if (key === 'idem-attempt-2') {
        return attempt2Created ? { id: 'run-new', status: 'queued' } : undefined;
      }
      return undefined;
    });
    runFinalize.mockImplementation(async () => {
      attempt2Created = true;
      return { kind: 'started', runId: 'run-new', status: 'queued' };
    });

    const res = await supertest(app)
      .post('/api/projects/proj-1/cards/card-1/finalize')
      .send({})
      .expect(200);

    // A fresh run id with reused:false — the client renders a new timeline bubble.
    expect(res.body).toEqual({
      run_id: 'run-new',
      status: 'queued',
      reused: false,
      card_id: 'card-1',
    });
    expect(runFinalize).toHaveBeenCalledOnce();
    // The orchestrator is told this is attempt 2 so it inserts under the new key.
    expect(runFinalize.mock.calls[0][1]).toMatchObject({ attempt: 2 });
  });

  it('200 with run_id when runFinalize fires and the row becomes visible during the poll', async () => {
    const { app, findProject, stmts } = makeApp();
    findProject.mockReturnValue({ id: 'proj-1', githubRepo: 'acme/proj' });
    stmts.getKanbanCard.get.mockReturnValue({
      id: 'card-1',
      board_id: 'board-1',
      session_id: 'sess-1',
      created_by: 'user-1',
      title: 't',
    });
    stmts.getKanbanBoard.get.mockReturnValue({ id: 'board-1' });
    stmts.getSession.get.mockReturnValue({
      id: 'sess-1',
      worktree_path: '/tmp/wt',
      worktree_branch: 'feature/x',
    });
    // First lookup misses; once runFinalize is invoked, the second poll-loop
    // lookup sees the row.
    let lookups = 0;
    stmts.getFinalizeRunByIdempotencyKey.get.mockImplementation(() => {
      lookups++;
      if (lookups === 1) return undefined;
      return { id: 'run-new', status: 'queued' };
    });
    runFinalize.mockResolvedValue({ kind: 'reused', runId: 'run-new', status: 'queued' });

    const res = await supertest(app)
      .post('/api/projects/proj-1/cards/card-1/finalize')
      .send({})
      .expect(200);
    expect(res.body).toEqual({
      run_id: 'run-new',
      status: 'queued',
      reused: false,
      card_id: 'card-1',
    });
    expect(runFinalize).toHaveBeenCalledOnce();
    expect(stmts.insertFinalizeKickoffClaim.run).toHaveBeenCalledOnce();
    expect(stmts.deleteFinalizeKickoffClaim.run).toHaveBeenCalledOnce();
  });

  it('202 keeps the branch claim when runFinalize starts but the row is not yet visible', async () => {
    const { app, findProject, stmts } = makeApp();
    findProject.mockReturnValue({ id: 'proj-1', githubRepo: 'acme/proj' });
    stmts.getKanbanCard.get.mockReturnValue({
      id: 'card-1',
      board_id: 'board-1',
      session_id: 'sess-1',
      created_by: 'user-1',
      title: 't',
    });
    stmts.getKanbanBoard.get.mockReturnValue({ id: 'board-1' });
    stmts.getSession.get.mockReturnValue({
      id: 'sess-1',
      worktree_path: '/tmp/wt',
      worktree_branch: 'feature/x',
    });
    stmts.getFinalizeRunByIdempotencyKey.get.mockReturnValue(undefined);
    let resolveRun!: () => void;
    runFinalize.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveRun = resolve;
      }),
    );

    const res = await supertest(app)
      .post('/api/projects/proj-1/cards/card-1/finalize')
      .send({})
      .expect(202);

    expect(res.body).toMatchObject({
      ok: true,
      run_id: null,
      status: 'queued',
      card_id: 'card-1',
    });
    expect(runFinalize).toHaveBeenCalledOnce();
    expect(stmts.insertFinalizeKickoffClaim.run).toHaveBeenCalledOnce();
    expect(stmts.deleteFinalizeKickoffClaim.run).not.toHaveBeenCalled();
    expect(getSessionWorktreeLockOwner('sess-1')).toBe('finalize');

    resolveRun();
    await vi.waitFor(() => expect(getSessionWorktreeLockOwner('sess-1')).toBeNull());
  });

  it('409 dedupes an overlapping kickoff once the first run row becomes visible', async () => {
    const { app, findProject, stmts } = makeApp();
    findProject.mockReturnValue({ id: 'proj-1', githubRepo: 'acme/proj' });
    stmts.getKanbanCard.get.mockReturnValue({
      id: 'card-1',
      board_id: 'board-1',
      session_id: 'sess-1',
      created_by: 'user-1',
      title: 't',
    });
    stmts.getKanbanBoard.get.mockReturnValue({ id: 'board-1' });
    stmts.getSession.get.mockReturnValue({
      id: 'sess-1',
      worktree_path: '/tmp/wt',
      worktree_branch: 'feature/x',
    });

    let runVisible = false;
    let runEntered = false;
    let resolveRun!: () => void;
    let notifyRunEntered!: () => void;
    let notifyDuplicatePolled!: () => void;
    const runEnteredPromise = new Promise<void>((resolve) => {
      notifyRunEntered = resolve;
    });
    const duplicatePolledPromise = new Promise<void>((resolve) => {
      notifyDuplicatePolled = resolve;
    });
    stmts.getFinalizeRunByIdempotencyKey.get.mockImplementation(() =>
      runVisible ? { id: 'run-first', status: 'running' } : undefined,
    );
    stmts.getActiveFinalizeRunForSessionBranch.get.mockImplementation(() => {
      if (runEntered && !runVisible) notifyDuplicatePolled();
      return runVisible ? { id: 'run-first', status: 'running' } : undefined;
    });
    runFinalize.mockImplementation(() => {
      runEntered = true;
      notifyRunEntered();
      return new Promise<void>((resolve) => {
        resolveRun = resolve;
      });
    });

    // Start request one, but hold its run row invisible after it owns the lock.
    // Request two must overlap this window; awaiting request one first would
    // miss the race and only exercise the already-visible-row path.
    const firstPromise = supertest(app)
      .post('/api/projects/proj-1/cards/card-1/finalize')
      .send({})
      .then((res) => res);
    await runEnteredPromise;
    expect(getSessionWorktreeLockOwner('sess-1')).toBe('finalize');

    const duplicatePromise = supertest(app)
      .post('/api/projects/proj-1/cards/card-1/finalize')
      .send({})
      .then((res) => res);
    await duplicatePolledPromise;
    runVisible = true;

    const [first, duplicate] = await Promise.all([firstPromise, duplicatePromise]);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ run_id: 'run-first', reused: false });
    expect(duplicate.status).toBe(409);

    expect(duplicate.body).toMatchObject({
      error: 'in_flight',
      run_id: 'run-first',
      status: 'running',
    });
    expect(runFinalize).toHaveBeenCalledOnce();

    resolveRun();
    await vi.waitFor(() => expect(getSessionWorktreeLockOwner('sess-1')).toBeNull());
  });

  it('reuses a fast terminal owner whose row predates the duplicate request', async () => {
    const { app, findProject, stmts } = makeApp();
    findProject.mockReturnValue({ id: 'proj-1', githubRepo: 'acme/proj' });
    stmts.getKanbanCard.get.mockReturnValue({
      id: 'card-1',
      board_id: 'board-1',
      session_id: 'sess-1',
      created_by: 'user-1',
      title: 't',
    });
    stmts.getKanbanBoard.get.mockReturnValue({ id: 'board-1' });
    stmts.getSession.get.mockReturnValue({
      id: 'sess-1',
      worktree_path: '/tmp/wt',
      worktree_branch: 'feature/x',
    });

    let firstRunVisible = false;
    let resolveFirstRun!: () => void;
    let notifyDuplicatePolled!: () => void;
    const duplicatePolledPromise = new Promise<void>((resolve) => {
      notifyDuplicatePolled = resolve;
    });
    stmts.getLatestFinalizeRunForSession.get.mockImplementation(() =>
      firstRunVisible
        ? { id: 'run-first', branch: 'feature/x', status: 'failed' }
        : { id: 'run-old', branch: 'feature/x', status: 'failed' },
    );
    stmts.getFinalizeRunByIdempotencyKey.get.mockImplementation(() =>
      firstRunVisible ? { id: 'run-first', status: 'failed' } : undefined,
    );
    stmts.getActiveFinalizeRunForSessionBranch.get.mockImplementation(() => {
      if (firstRunVisible) notifyDuplicatePolled();
      return undefined;
    });
    runFinalize.mockImplementation(() => {
      firstRunVisible = true;
      return new Promise<void>((resolve) => {
        resolveFirstRun = resolve;
      });
    });

    // The first request has already made its row terminal, but deliberately
    // keeps its promise unsettled so its worktree lock remains owned.
    const first = await supertest(app).post('/api/projects/proj-1/cards/card-1/finalize').send({});
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ run_id: 'run-first', reused: false });
    expect(getSessionWorktreeLockOwner('sess-1')).toBe('finalize');

    const duplicatePromise = supertest(app)
      .post('/api/projects/proj-1/cards/card-1/finalize')
      .send({})
      .then((res) => res);
    await duplicatePolledPromise;
    resolveFirstRun();

    const duplicate = await duplicatePromise;
    expect(duplicate.status).toBe(200);
    expect(duplicate.body).toMatchObject({
      run_id: 'run-first',
      status: 'failed',
      reused: true,
    });
    expect(runFinalize).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(getSessionWorktreeLockOwner('sess-1')).toBeNull());
  });

  it('retries after a pre-row failure instead of reusing an older same-branch run', async () => {
    const { app, findProject, stmts } = makeApp();
    findProject.mockReturnValue({ id: 'proj-1', githubRepo: 'acme/proj' });
    stmts.getKanbanCard.get.mockReturnValue({
      id: 'card-1',
      board_id: 'board-1',
      session_id: 'sess-1',
      created_by: 'user-1',
      title: 't',
    });
    stmts.getKanbanBoard.get.mockReturnValue({ id: 'board-1' });
    stmts.getSession.get.mockReturnValue({
      id: 'sess-1',
      worktree_path: '/tmp/wt',
      worktree_branch: 'feature/x',
    });
    stmts.getLatestFinalizeRunForSession.get.mockReturnValue({
      id: 'run-old',
      branch: 'feature/x',
      status: 'failed',
    });

    let orchestratorCalls = 0;
    let secondRunVisible = false;
    let resolveFirstRun!: () => void;
    let resolveSecondRun!: () => void;
    let notifyFirstRunEntered!: () => void;
    let notifyDuplicatePolled!: () => void;
    const firstRunEnteredPromise = new Promise<void>((resolve) => {
      notifyFirstRunEntered = resolve;
    });
    const duplicatePolledPromise = new Promise<void>((resolve) => {
      notifyDuplicatePolled = resolve;
    });
    stmts.getFinalizeRunByIdempotencyKey.get.mockImplementation(() =>
      secondRunVisible ? { id: 'run-retry', status: 'running' } : undefined,
    );
    stmts.getActiveFinalizeRunForSessionBranch.get.mockImplementation(() => {
      if (orchestratorCalls === 1) notifyDuplicatePolled();
      return secondRunVisible ? { id: 'run-retry', status: 'running' } : undefined;
    });
    runFinalize.mockImplementation(() => {
      orchestratorCalls += 1;
      if (orchestratorCalls === 1) {
        notifyFirstRunEntered();
        return new Promise<void>((resolve) => {
          resolveFirstRun = resolve;
        });
      }
      secondRunVisible = true;
      return new Promise<void>((resolve) => {
        resolveSecondRun = resolve;
      });
    });

    const firstPromise = supertest(app)
      .post('/api/projects/proj-1/cards/card-1/finalize')
      .send({})
      .then((res) => res);
    await firstRunEnteredPromise;

    const duplicatePromise = supertest(app)
      .post('/api/projects/proj-1/cards/card-1/finalize')
      .send({})
      .then((res) => res);
    await duplicatePolledPromise;
    resolveFirstRun();

    const duplicate = await duplicatePromise;
    expect(duplicate.status).toBe(200);
    expect(duplicate.body).toMatchObject({ run_id: 'run-retry', reused: false });
    expect(duplicate.body.run_id).not.toBe('run-old');
    expect(runFinalize).toHaveBeenCalledTimes(2);

    resolveSecondRun();
    await firstPromise;
    await vi.waitFor(() => expect(getSessionWorktreeLockOwner('sess-1')).toBeNull());
  });
});

describe('POST /api/projects/:projectId/sessions/:sessionId/finalize', () => {
  it.each([
    ['consult mode', { session_mode: 'consult', ask_mode: 0 }],
    ['legacy ask_mode', { session_mode: 'chat', ask_mode: 1 }],
  ])('400 when the session is in %s', async (_label, modeFields) => {
    const { app, findProject, findAgent, stmts } = makeApp();
    findProject.mockReturnValue({ id: 'proj-1' });
    findAgent.mockReturnValue({
      project: { id: 'proj-1' },
      agent: { id: 'agent-1', name: 'Dev' },
    });
    stmts.getSession.get.mockReturnValue({
      id: 'sess-1',
      agent_id: 'agent-1',
      worktree_path: '/tmp/wt',
      worktree_branch: 'feature/x',
      ...modeFields,
    });

    const res = await supertest(app)
      .post('/api/projects/proj-1/sessions/sess-1/finalize')
      .send({ mode: 'review' })
      .expect(400);

    expect(res.body).toMatchObject({ error: 'finalize_not_allowed_in_consult_session' });
    expect(runFinalize).not.toHaveBeenCalled();
  });
});

describe('Finalize trigger rejects the removed single-job `jobs` filter', () => {
  it('410 jobs_unsupported when the card route is sent a real `jobs` filter', async () => {
    const { app, findProject, stmts } = makeApp();
    // The guard fires before any lookup — a fully-valid card never gets read.
    findProject.mockReturnValue({ id: 'proj-1' });
    const res = await supertest(app)
      .post('/api/projects/proj-1/cards/card-1/finalize')
      .send({ jobs: ['e2e'] })
      .expect(410);
    expect(res.body.error).toBe('jobs_unsupported');
    // No work was started and no lookups happened — the request short-circuits.
    expect(runFinalize).not.toHaveBeenCalled();
    expect(stmts.getKanbanCard.get).not.toHaveBeenCalled();
  });

  it('410 jobs_unsupported when the session route is sent a real `jobs` filter', async () => {
    const { app, findProject, stmts } = makeApp();
    findProject.mockReturnValue({ id: 'proj-1' });
    const res = await supertest(app)
      .post('/api/projects/proj-1/sessions/sess-1/finalize')
      .send({ jobs: ['lint', 'test'], mode: 'checks' })
      .expect(410);
    expect(res.body.error).toBe('jobs_unsupported');
    expect(runFinalize).not.toHaveBeenCalled();
    // No kanban card is auto-created for a rejected request.
    expect(stmts.getSession.get).not.toHaveBeenCalled();
  });

  it('ignores an empty / blank `jobs` array and proceeds with the full run', async () => {
    // Legacy semantics: an empty (or all-blank) `jobs` array meant "no filter"
    // — a normal full run — and must still be accepted, not 410'd.
    const { app, findProject, stmts } = makeApp();
    findProject.mockReturnValue({ id: 'proj-1', githubRepo: 'acme/proj' });
    stmts.getKanbanCard.get.mockReturnValue({
      id: 'card-1',
      board_id: 'board-1',
      session_id: 'sess-1',
      created_by: 'user-1',
      title: 't',
    });
    stmts.getKanbanBoard.get.mockReturnValue({ id: 'board-1' });
    stmts.getSession.get.mockReturnValue({
      id: 'sess-1',
      worktree_path: '/tmp/wt',
      worktree_branch: 'feature/x',
    });
    stmts.getFinalizeRunByIdempotencyKey.get.mockReturnValue(undefined);
    runFinalize.mockReturnValue(new Promise(() => {}));

    await supertest(app)
      .post('/api/projects/proj-1/cards/card-1/finalize')
      .send({ jobs: ['', '  '] })
      .expect(202);
    expect(runFinalize).toHaveBeenCalledOnce();
  });
});

describe('POST /api/projects/:projectId/finalize/:runId/cancel', () => {
  it('404 when project is missing', async () => {
    const { app, findProject } = makeApp();
    findProject.mockReturnValue(null);
    await supertest(app).post('/api/projects/proj-1/finalize/run-1/cancel').send({}).expect(404);
  });

  it('404 when run not found', async () => {
    const { app, findProject, stmts } = makeApp();
    findProject.mockReturnValue({ id: 'proj-1' });
    stmts.getFinalizeRun.get.mockReturnValue(undefined);
    await supertest(app).post('/api/projects/proj-1/finalize/run-1/cancel').send({}).expect(404);
  });

  it('404 when run belongs to a different project (no leak)', async () => {
    const { app, findProject, stmts } = makeApp();
    findProject.mockReturnValue({ id: 'proj-1' });
    stmts.getFinalizeRun.get.mockReturnValue({
      id: 'run-1',
      project_id: 'proj-OTHER',
      status: 'rebasing',
      session_id: 'sess-1',
    });
    await supertest(app).post('/api/projects/proj-1/finalize/run-1/cancel').send({}).expect(404);
  });

  it('404 when caller does not own the linked session', async () => {
    const { app, findProject, stmts } = makeApp();
    findProject.mockReturnValue({ id: 'proj-1' });
    stmts.getFinalizeRun.get.mockReturnValue({
      id: 'run-1',
      project_id: 'proj-1',
      status: 'rebasing',
      session_id: 'sess-1',
    });
    userOwnsSession.mockReturnValue(false);
    await supertest(app).post('/api/projects/proj-1/finalize/run-1/cancel').send({}).expect(404);
  });

  it('409 terminal when the run is already pushed', async () => {
    const { app, findProject, stmts } = makeApp();
    findProject.mockReturnValue({ id: 'proj-1' });
    stmts.getFinalizeRun.get.mockReturnValue({
      id: 'run-1',
      project_id: 'proj-1',
      status: 'pushed',
      session_id: 'sess-1',
    });
    const res = await supertest(app)
      .post('/api/projects/proj-1/finalize/run-1/cancel')
      .send({})
      .expect(409);
    expect(res.body).toMatchObject({ error: 'terminal', status: 'pushed' });
  });

  it('200 ok cancelled — writes the row, halts the session turn, broadcasts terminal + interrupted', async () => {
    const { app, findProject, stmts, broadcast, activeProcesses } = makeApp();
    findProject.mockReturnValue({ id: 'proj-1' });
    stmts.getFinalizeRun.get.mockReturnValue({
      id: 'run-1',
      project_id: 'proj-1',
      status: 'rebasing',
      session_id: 'sess-1',
    });
    const res = await supertest(app)
      .post('/api/projects/proj-1/finalize/run-1/cancel')
      .send({})
      .expect(200);
    expect(res.body).toEqual({ ok: true, status: 'cancelled' });
    expect(stmts.failFinalizeRun.run).toHaveBeenCalledWith('cancelled', 'cancelled', 'run-1');

    // The originating session's agent turn is killed so the session falls idle.
    expect(cancelSessionChatRun).toHaveBeenCalledWith({
      sessionId: 'sess-1',
      activeProcesses,
    });

    const types = broadcast.mock.calls.map((c) => (c[0] as { type: string }).type);
    expect(types).toContain('finalize_run_phase_changed');
    expect(types).toContain('finalize_run_completed');
    // The session UI is told the turn was interrupted so it stops streaming.
    const interrupted = broadcast.mock.calls
      .map((c) => c[0] as { type: string; sessionId?: string })
      .find((e) => e.type === 'interrupted');
    expect(interrupted).toMatchObject({ type: 'interrupted', sessionId: 'sess-1' });
  });
});

describe('resolveFinalizeAttempt', () => {
  const base = {
    projectId: 'p',
    branch: 'feature/x',
    headSha: 'sha',
    mode: 'full' as const,
  };

  // Distinct, attempt-aware fake key so the walk advances deterministically.
  const keyOf = (attempt: number) => `k-${attempt}`;

  beforeEach(() => {
    computeIdempotencyKey.mockImplementation((a) =>
      keyOf((a as { attempt?: number })?.attempt ?? 1),
    );
  });

  /** lookup backed by an attempt→row map. */
  const lookupFrom = (rows: Record<number, FinalizeRunRow>) => (key: string) => {
    for (const [attempt, row] of Object.entries(rows)) {
      if (key === keyOf(Number(attempt))) return row;
    }
    return undefined;
  };

  it('starts attempt 1 when no run exists for the head', () => {
    const r = resolveFinalizeAttempt({
      ...base,
      triggerSource: 'ui_button',
      lookup: lookupFrom({}),
    });
    expect(r).toEqual({ kind: 'start', attempt: 1, idempotencyKey: keyOf(1) });
  });

  it('ui_button advances past a terminal run to a fresh attempt (new bubble)', () => {
    const r = resolveFinalizeAttempt({
      ...base,
      triggerSource: 'ui_button',
      lookup: lookupFrom({ 1: { id: 'r1', status: 'failed' } as FinalizeRunRow }),
    });
    expect(r).toEqual({ kind: 'start', attempt: 2, idempotencyKey: keyOf(2) });
  });

  it('ui_button walks past multiple finished attempts to the next free slot', () => {
    const r = resolveFinalizeAttempt({
      ...base,
      triggerSource: 'ui_button',
      lookup: lookupFrom({
        1: { id: 'r1', status: 'failed' } as FinalizeRunRow,
        2: { id: 'r2', status: 'cancelled' } as FinalizeRunRow,
      }),
    });
    expect(r).toEqual({ kind: 'start', attempt: 3, idempotencyKey: keyOf(3) });
  });

  it('agent_block reuses a finished run instead of starting a new attempt', () => {
    const terminal = { id: 'r1', status: 'pushed' } as FinalizeRunRow;
    const r = resolveFinalizeAttempt({
      ...base,
      triggerSource: 'agent_block',
      lookup: lookupFrom({ 1: terminal }),
    });
    expect(r).toEqual({ kind: 'reused', run: terminal });
  });

  it('returns in_flight for a non-terminal run regardless of trigger (no duplicate)', () => {
    const active = { id: 'r1', status: 'rebasing' } as FinalizeRunRow;
    for (const triggerSource of ['ui_button', 'agent_block'] as const) {
      const r = resolveFinalizeAttempt({
        ...base,
        triggerSource,
        lookup: lookupFrom({ 1: active }),
      });
      expect(r).toEqual({ kind: 'in_flight', run: active });
    }
  });

  it('short-circuits ready_to_push (push it, do not re-run)', () => {
    const ready = { id: 'r1', status: 'ready_to_push' } as FinalizeRunRow;
    const r = resolveFinalizeAttempt({
      ...base,
      triggerSource: 'ui_button',
      lookup: lookupFrom({ 1: ready }),
    });
    expect(r).toEqual({ kind: 'ready_to_push', run: ready });
  });

  it('a later in-flight attempt blocks a new ui_button attempt', () => {
    // attempt 1 finished, attempt 2 still running → re-click must not open #3.
    const active = { id: 'r2', status: 'reviewing' } as FinalizeRunRow;
    const r = resolveFinalizeAttempt({
      ...base,
      triggerSource: 'ui_button',
      lookup: lookupFrom({
        1: { id: 'r1', status: 'failed' } as FinalizeRunRow,
        2: active,
      }),
    });
    expect(r).toEqual({ kind: 'in_flight', run: active });
  });
});
