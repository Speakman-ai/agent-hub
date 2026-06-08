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
  computeIdempotencyKey: vi.fn(() => 'idem-key-FAKE'),
  buildOrchestratorDeps: vi.fn(() => ({})),
}));

const { userCanReadSession, userOwnsSession } = vi.hoisted(() => ({
  userCanReadSession: vi.fn().mockReturnValue(true),
  userOwnsSession: vi.fn().mockReturnValue(true),
}));

const execFileAsyncMock = vi.hoisted(() => vi.fn());

vi.mock('child_process', () => ({
  execFile: vi.fn(),
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
import type { RouteDeps } from '../types.js';

function makeStmts() {
  return {
    getFinalizeRun: { get: vi.fn() },
    getFinalizeRunByIdempotencyKey: { get: vi.fn() },
    getActiveFinalizeRunForSessionBranchMode: { get: vi.fn() },
    insertFinalizeKickoffClaim: { run: vi.fn(() => ({ changes: 1 })) },
    deleteFinalizeKickoffClaim: { run: vi.fn() },
    pruneStaleFinalizeKickoffClaims: { run: vi.fn() },
    getLatestFinalizeRunForSession: { get: vi.fn() },
    getKanbanCard: { get: vi.fn() },
    getKanbanBoard: { get: vi.fn() },
    getSession: { get: vi.fn() },
    listReviewerThreadsForRun: { all: vi.fn().mockReturnValue([]) },
    failFinalizeRun: { run: vi.fn() },
  };
}

function makeApp() {
  const stmts = makeStmts();
  const broadcast = vi.fn();
  const findProject = vi.fn();
  const app = express();
  app.use(express.json());
  const activeProcesses = new Map();
  const deps = {
    stmts,
    broadcast,
    findProject,
    activeProcesses,
    config: { personalOAuth: null, githubApp: null },
  } as unknown as RouteDeps;
  app.use(createFinalizeRoutes(deps));
  return { app, stmts, broadcast, findProject, activeProcesses };
}

beforeEach(() => {
  runFinalize.mockReset();
  computeIdempotencyKey.mockReturnValue('idem-key-FAKE');
  buildOrchestratorDeps.mockReturnValue({});
  userCanReadSession.mockReturnValue(true);
  userOwnsSession.mockReturnValue(true);
  cancelSessionChatRun.mockReset();
  execFileAsyncMock.mockReset();
  execFileAsyncMock.mockResolvedValue({ stdout: 'deadbeef\n', stderr: '' });
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
    stmts.getActiveFinalizeRunForSessionBranchMode.get.mockReturnValue({
      id: 'run-active-old-head',
      status: 'dispatching',
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
    expect(stmts.getActiveFinalizeRunForSessionBranchMode.get).toHaveBeenCalledWith(
      'sess-1',
      'feature/x',
      'full',
      null,
      null,
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
    stmts.getActiveFinalizeRunForSessionBranchMode.get
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

  it('200 reused when an existing terminal row matches the idempotency key', async () => {
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
      id: 'run-old',
      status: 'pushed',
    });
    const res = await supertest(app)
      .post('/api/projects/proj-1/cards/card-1/finalize')
      .send({})
      .expect(200);
    expect(res.body).toEqual({
      run_id: 'run-old',
      status: 'pushed',
      reused: true,
      card_id: 'card-1',
    });
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
