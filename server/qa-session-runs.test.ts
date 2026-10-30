import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDb, getStmts, initDb } from './db.js';
import { getOrCreateBoard } from './routes/board.js';
import { createQaEnvironment, updateQaProjectSettings } from './qa-environments.js';
import { __testResetGithubMergeReconcile, recordGithubPrMerge } from './github-pr-merges.js';
import { cancelQaRun, markQaRunRunning, QaStatusError, startQaRun } from './qa-status.js';
import type { Project, SessionRow } from './types.js';

const launchQaRun = vi.fn();
/** Runs the mocked launcher reports as still being launched in this process. */
const launchesInFlight = new Set<string>();
vi.mock('./qa-run-launch.js', () => ({
  launchQaRun: (...a: unknown[]) => launchQaRun(...a),
  isQaRunLaunchInFlight: (id: string) => launchesInFlight.has(id),
}));
const kickoffSeededTurn = vi.fn();
vi.mock('./seeded-session-kickoff.js', async (orig) => ({
  ...(await orig<typeof import('./seeded-session-kickoff.js')>()),
  kickoffSeededTurn: (...a: unknown[]) => kickoffSeededTurn(...a),
}));

const {
  __testResetQaSessionRuns,
  buildQaSessionAuthoringSeed,
  finishQaSessionAuthoring,
  getQaSessionRequest,
  processQaSessionRequest,
  qaSessionRequestProjectFor,
  reconcileSessionMerge,
  runQaSessionRequestNow,
  sessionMergedAt,
  setQaSessionRequestArmed,
  sweepAllQaSessionRequests,
  sweepProjectQaSessionRequests,
} = await import('./qa-session-runs.js');

const PROJECT = 'qa-session-runs-proj';
const project: Project = {
  id: PROJECT,
  name: 'Proj',
  cwd: '/tmp/proj',
  ahw: '/tmp/ahw',
  agents: [
    { id: 'dev-agent', name: 'Dev', role: 'dev' },
    { id: 'qa-agent', name: 'QA', role: 'qa' },
  ],
} as unknown as Project;
const broadcast = vi.fn();
const deps = {
  broadcast,
  findProject: (id: string) => (id === PROJECT ? project : null),
  handleChat: vi.fn(),
  config: {},
} as never;

let boardId: string;
let todoColumn: string;
let doneColumn: string;

beforeAll(() => {
  initDb(mkdtempSync(path.join(tmpdir(), 'ah-qa-session-runs-')));
  const { board, columns } = getOrCreateBoard(getStmts(), PROJECT);
  boardId = board.id;
  todoColumn = columns.find((c) => c.name === 'To Do')!.id;
  doneColumn = columns.find((c) => c.name === 'Done')!.id;
});

beforeEach(() => {
  __testResetQaSessionRuns();
  __testResetGithubMergeReconcile();
  launchesInFlight.clear();
  const db = getDb();
  db.exec('DELETE FROM qa_session_requests');
  db.exec('DELETE FROM qa_plans');
  db.exec('DELETE FROM qa_environments');
  db.exec('DELETE FROM qa_project_settings');
  db.exec('DELETE FROM pull_requests');
  db.exec('DELETE FROM github_pr_merges');
  db.exec('DELETE FROM pr_creation_logs');
  db.exec(`DELETE FROM kanban_cards WHERE board_id = '${boardId}'`);
  broadcast.mockClear();
  launchQaRun.mockReset().mockResolvedValue({ ok: true, run: { id: 'run-1' } });
  kickoffSeededTurn.mockReset().mockResolvedValue(undefined);
});

function devSession(): { session: SessionRow; cardId: string } {
  const s = getStmts();
  const id = randomUUID();
  s.createSession.run(id, 'dev-agent', 'Add QA button', 'claude-code', 'sonnet', 1, 0, 1);
  const cardId = randomUUID();
  s.createKanbanCard.run(
    cardId,
    todoColumn,
    boardId,
    'Run QA from sessions',
    'Users can run QA tests from a session.',
    'medium',
    null,
    null,
    null,
    null,
    'owner-1',
    id,
    0,
  );
  getDb().prepare('UPDATE kanban_cards SET session_id = ? WHERE id = ?').run(id, cardId);
  return { session: s.getSession.get(id) as SessionRow, cardId };
}

const hosted = { ...project, gitHost: 'agenthub' } as Project;
const hostedDeps = { ...(deps as object), findProject: () => hosted } as never;

/** A dev session on its own branch, with or without a linked card. */
function branchSession(withCard: boolean): { session: SessionRow; cardId: string | null } {
  const { session, cardId } = devSession();
  const branch = `agent-hub/dev-agent/session-${session.id.slice(0, 8)}`;
  getDb().prepare('UPDATE sessions SET worktree_branch = ? WHERE id = ?').run(branch, session.id);
  if (!withCard) getDb().prepare('DELETE FROM kanban_cards WHERE id = ?').run(cardId);
  return {
    session: getStmts().getSession.get(session.id) as SessionRow,
    cardId: withCard ? cardId : null,
  };
}

function pr(session: SessionRow, status: 'open' | 'merged', mergedAt: number | null = null) {
  const now = Date.now();
  getDb()
    .prepare(
      `INSERT INTO pull_requests (id, project_id, number, title, head_branch, base_branch, head_sha,
         status, author, created_at, updated_at, merged_at)
       VALUES (?, ?, ?, 'PR', ?, 'main', 'abc', ?, 'dev', ?, ?, ?)`,
    )
    .run(
      randomUUID(),
      PROJECT,
      Math.floor(Math.random() * 1e9),
      session.worktree_branch,
      status,
      now,
      now,
      mergedAt,
    );
}

/** A github.com merge of the session's branch, as handleGithubCardOnMerge records it. */
function githubMerge(session: SessionRow, mergedAt = Date.now()) {
  recordGithubPrMerge({
    projectId: PROJECT,
    prUrl: `https://github.com/o/r/pull/${Math.floor(Math.random() * 1e9)}`,
    headRef: session.worktree_branch,
    mergedAt,
  });
}

function cardDone(cardId: string, at = new Date().toISOString()) {
  getDb()
    .prepare('UPDATE kanban_cards SET column_id = ?, completed_at = ? WHERE id = ?')
    .run(doneColumn, at, cardId);
}

function defaultEnv() {
  createQaEnvironment(PROJECT, { name: 'Dev', baseUrl: 'https://dev.example.com' });
  return createQaEnvironment(PROJECT, {
    name: 'Staging',
    baseUrl: 'https://staging.example.com',
    isDefault: true,
  });
}

function addCase(planId: string) {
  getStmts().insertQaCase.run(randomUUID(), planId, 0, 'Button shows', '1. Open', 'Visible');
}

describe('qa session requests', () => {
  it('refuses to arm without a default environment', async () => {
    const { session } = devSession();
    await expect(
      setQaSessionRequestArmed(deps, session, project, true, 'u1'),
    ).rejects.toMatchObject({ status: 409, code: 'no_default_environment' });
    expect(getQaSessionRequest(session.id)).toBeNull();
  });

  it('stays armed until the session merges, then drafts a plan on the default env', async () => {
    defaultEnv();
    const { session, cardId } = branchSession(true);
    await setQaSessionRequestArmed(deps, session, project, true, 'u1');
    expect(getQaSessionRequest(session.id)?.status).toBe('armed');
    expect(kickoffSeededTurn).not.toHaveBeenCalled();

    githubMerge(session);
    expect(await processQaSessionRequest(deps, session.id)).toBe('authoring');
    const row = getQaSessionRequest(session.id)!;
    const plan = getStmts().getQaPlan.get(row.plan_id!)!;
    expect(plan.target_url).toBe('https://staging.example.com');
    expect(plan.auto_rerun).toBe(0);
    expect(plan.auto_fix).toBe(0);
    expect(plan.card_id).toBe(cardId);
    expect(plan.authoring_session_id).toBe(row.authoring_session_id);
    const authoring = getStmts().getSession.get(row.authoring_session_id!) as SessionRow & {
      hidden: number;
      session_mode: string;
    };
    expect(authoring.hidden).toBe(1);
    expect(authoring.session_mode).toBe('qa');
    const seed = kickoffSeededTurn.mock.calls[0][0].content as string;
    expect(seed).toContain('Run QA from sessions');
    expect(seed).toContain(`qa.sh case add ${plan.id}`);
  });

  it('unticking removes an armed request', async () => {
    defaultEnv();
    const { session } = devSession();
    await setQaSessionRequestArmed(deps, session, project, true, 'u1');
    await setQaSessionRequestArmed(deps, session, project, false, 'u1');
    expect(getQaSessionRequest(session.id)).toBeNull();
  });

  it('fails when the QA agent drafted no cases', async () => {
    defaultEnv();
    const { session } = branchSession(true);
    githubMerge(session);
    const row = await runQaSessionRequestNow(deps, session, project, 'u1');
    await finishQaSessionAuthoring(deps, row.authoring_session_id!, 'turn_ended');
    const after = getQaSessionRequest(session.id)!;
    expect(after.status).toBe('failed');
    expect(after.error).toMatch(/did not draft any cases/);
    expect(launchQaRun).not.toHaveBeenCalled();
  });

  it('approves after drafting and waits out the delay before running', async () => {
    defaultEnv();
    updateQaProjectSettings(PROJECT, { autoQaDelayMinutes: 10 });
    const { session } = branchSession(true);
    const mergedAt = Date.now();
    githubMerge(session, mergedAt);
    const row = await runQaSessionRequestNow(deps, session, project, 'u1');
    expect(row.due_at).toBe(mergedAt + 10 * 60_000);

    addCase(row.plan_id!);
    await finishQaSessionAuthoring(deps, row.authoring_session_id!, 'turn_ended');
    expect(getStmts().getQaPlan.get(row.plan_id!)!.approved_at).not.toBeNull();
    expect(getQaSessionRequest(session.id)!.status).toBe('waiting');
    expect(launchQaRun).not.toHaveBeenCalled();

    const status = await processQaSessionRequest(deps, session.id, row.due_at! + 1);
    expect(status).toBe('started');
    expect(launchQaRun).toHaveBeenCalledTimes(1);
    expect(launchQaRun.mock.calls[0][2]).toMatchObject({ scope: 'full', ownerUserId: 'u1' });
    expect(getQaSessionRequest(session.id)!.run_id).toBe('run-1');
  });

  it('runs at once with no delay and records a launch failure', async () => {
    defaultEnv();
    launchQaRun.mockResolvedValue({ ok: false, error: 'target unreachable' });
    const { session } = branchSession(true);
    githubMerge(session);
    const row = await runQaSessionRequestNow(deps, session, project, 'u1');
    addCase(row.plan_id!);
    await finishQaSessionAuthoring(deps, row.authoring_session_id!, 'turn_ended');
    const after = getQaSessionRequest(session.id)!;
    expect(after.status).toBe('failed');
    expect(after.error).toContain('target unreachable');
  });

  it('only one environment stays default', () => {
    const first = createQaEnvironment(PROJECT, { name: 'A', isDefault: true });
    createQaEnvironment(PROJECT, { name: 'B', isDefault: true });
    const rows = getDb()
      .prepare('SELECT name, is_default FROM qa_environments WHERE project_id = ? ORDER BY name')
      .all(PROJECT);
    expect(rows).toEqual([
      { name: 'A', is_default: 0 },
      { name: 'B', is_default: 1 },
    ]);
    expect(first.isDefault).toBe(true);
  });

  it('watches PR-merge broadcasts only', () => {
    expect(
      qaSessionRequestProjectFor({ type: 'native_pr_update', action: 'merged', projectId: 'p' }),
    ).toBe('p');
    expect(qaSessionRequestProjectFor({ type: 'webhook_pr_merged', projectId: 'p' })).toBe('p');
    expect(qaSessionRequestProjectFor({ type: 'kanban_update', projectId: 'p' })).toBeNull();
    expect(qaSessionRequestProjectFor({ type: 'qa_update', projectId: 'p' })).toBeNull();
  });

  it('seed tells the agent not to ask and not to approve', () => {
    const seed = buildQaSessionAuthoringSeed({
      project,
      plan: { id: 'plan-1', title: 'QA: x', target_url: 'https://staging.example.com' },
      environment: { name: 'Staging', baseUrl: 'https://staging.example.com' },
      environments: [],
      context: {
        session: { id: 's1', name: 'Work' },
        card: null,
        pr: { number: 7, title: 'Add thing', body: 'Body' },
        task: 'Build it',
        outcome: 'Built it',
      },
    });
    expect(seed).toContain('do not ask questions');
    expect(seed).toContain('Pull request #7: Add thing');
    expect(seed).toContain('do not approve it or start a run yourself');
  });

  describe('merge state', () => {
    it('ignores a card moved to Done while the PR is still open', async () => {
      defaultEnv();
      const { session, cardId } = branchSession(true);
      pr(session, 'open');
      cardDone(cardId!);
      expect(sessionMergedAt(session, hosted)).toBeNull();
      await setQaSessionRequestArmed(hostedDeps, session, hosted, true, 'u1');
      expect(getQaSessionRequest(session.id)?.status).toBe('armed');
      expect(kickoffSeededTurn).not.toHaveBeenCalled();
    });

    it('fires on a merged PR when the session has no card', async () => {
      defaultEnv();
      updateQaProjectSettings(PROJECT, { autoQaDelayMinutes: 5 });
      const { session } = branchSession(false);
      await setQaSessionRequestArmed(hostedDeps, session, hosted, true, 'u1');
      expect(getQaSessionRequest(session.id)?.status).toBe('armed');
      const mergedAt = Date.now() - 60_000;
      pr(session, 'merged', mergedAt);
      expect(sessionMergedAt(session, hosted)).toBe(mergedAt);
      expect(await processQaSessionRequest(hostedDeps, session.id)).toBe('authoring');
      expect(getQaSessionRequest(session.id)!.due_at).toBe(mergedAt + 5 * 60_000);
    });

    it('fires on a merged PR while the card is still outside Done', () => {
      const { session } = branchSession(true);
      pr(session, 'merged', 1_700_000_000_000);
      expect(sessionMergedAt(session, hosted)).toBe(1_700_000_000_000);
    });

    it('trusts a native PR row over the card on a github project too', () => {
      const { session, cardId } = branchSession(true);
      pr(session, 'open');
      cardDone(cardId!);
      expect(sessionMergedAt(session, project)).toBeNull();
    });

    it('a card moved to Done is not a github merge', async () => {
      defaultEnv();
      const { session, cardId } = branchSession(true);
      await setQaSessionRequestArmed(deps, session, project, true, 'u1');
      cardDone(cardId!);
      expect(sessionMergedAt(session, project)).toBeNull();
      expect(await processQaSessionRequest(deps, session.id)).toBe('armed');
      expect(kickoffSeededTurn).not.toHaveBeenCalled();
    });

    it('fires on a recorded github merge when the session has no card', async () => {
      defaultEnv();
      const { session } = branchSession(false);
      await setQaSessionRequestArmed(deps, session, project, true, 'u1');
      githubMerge(session, 1_700_000_000_000);
      expect(sessionMergedAt(session, project)).toBe(1_700_000_000_000);
      expect(await processQaSessionRequest(deps, session.id)).toBe('authoring');
    });

    it('matches a github merge to the session through the PR the Hub opened for it', () => {
      const { session } = branchSession(true);
      const prUrl = 'https://github.com/o/r/pull/42';
      getDb()
        .prepare(
          `INSERT INTO pr_creation_logs (id, project_id, session_id, pr_url, pr_title, author_agent)
           VALUES (?, ?, ?, ?, 'PR', 'dev')`,
        )
        .run(randomUUID(), PROJECT, session.id, prUrl);
      recordGithubPrMerge({ projectId: PROJECT, prUrl, mergedAt: 1_700_000_000_123 });
      expect(sessionMergedAt(session, project)).toBe(1_700_000_000_123);
    });

    it('a hosted session with no PR is never merged, card or not', () => {
      const { session, cardId } = branchSession(true);
      cardDone(cardId!);
      expect(sessionMergedAt(session, hosted)).toBeNull();
    });
  });

  describe('serialized transitions', () => {
    it('a /run during an in-flight launch waits for it instead of resetting the row', async () => {
      defaultEnv();
      const { session } = branchSession(true);
      githubMerge(session);
      const row = await runQaSessionRequestNow(deps, session, project, 'u1');
      addCase(row.plan_id!);
      let resolveLaunch!: (v: unknown) => void;
      launchQaRun.mockImplementationOnce(() => new Promise((r) => (resolveLaunch = r)));
      const finishing = finishQaSessionAuthoring(deps, row.authoring_session_id!, 'turn_ended');
      await vi.waitFor(() => expect(launchQaRun).toHaveBeenCalledTimes(1));

      const second = runQaSessionRequestNow(deps, session, project, 'u1');
      await new Promise((r) => setTimeout(r, 10));
      // Still the first request: nothing reset it while the launch was pending.
      expect(getQaSessionRequest(session.id)!.plan_id).toBe(row.plan_id);
      expect(kickoffSeededTurn).toHaveBeenCalledTimes(1);

      resolveLaunch({ ok: true, run: { id: 'run-first' } });
      await finishing;
      const after = await second;
      // The first launch's run landed on its own plan before the next request began.
      expect(after.plan_id).not.toBe(row.plan_id);
      expect(after.status).toBe('authoring');
      expect(getStmts().getQaPlan.get(row.plan_id!)).toBeTruthy();
      expect(launchQaRun).toHaveBeenCalledTimes(1);
      expect(kickoffSeededTurn).toHaveBeenCalledTimes(2);
    });

    it('a second /run while drafting returns the same request', async () => {
      defaultEnv();
      const { session } = branchSession(true);
      githubMerge(session);
      const [a, b] = await Promise.all([
        runQaSessionRequestNow(deps, session, project, 'u1'),
        runQaSessionRequestNow(deps, session, project, 'u1'),
      ]);
      expect(a.plan_id).toBeTruthy();
      expect(b.plan_id).toBe(a.plan_id);
      expect(kickoffSeededTurn).toHaveBeenCalledTimes(1);
    });
  });

  describe('github merge reconciliation', () => {
    const ghProject = { ...project, githubRepo: 'acme/web' } as Project;
    const mergedPull = (branch: string, at: string) =>
      new Response(
        JSON.stringify([
          {
            number: 9,
            html_url: 'https://github.com/acme/web/pull/9',
            merged_at: at,
            head: { ref: branch },
          },
          { number: 8, html_url: 'https://github.com/acme/web/pull/8', merged_at: null },
        ]),
        { status: 200 },
      );

    it('backfills a merge made on github.com and fires the armed request', async () => {
      defaultEnv();
      const { session } = branchSession(false);
      const githubFetch = vi.fn(async () =>
        mergedPull(session.worktree_branch!, '2026-01-02T03:04:05Z'),
      );
      const ghDeps = {
        ...(deps as object),
        findProject: () => ghProject,
        resolveGithubToken: async () => 'tok',
        githubFetch,
      } as never;
      await setQaSessionRequestArmed(ghDeps, session, ghProject, true, 'u1');
      expect(getQaSessionRequest(session.id)?.status).toBe('authoring');
      const url = String((githubFetch.mock.calls[0] as unknown[])[0]);
      expect(url).toContain('/repos/acme/web/pulls?state=closed');
      expect(url).toContain(encodeURIComponent(`acme:${session.worktree_branch}`));
      expect(sessionMergedAt(session, ghProject)).toBe(Date.parse('2026-01-02T03:04:05Z'));
    });

    it('stays armed when GitHub has no merge, and throttles repeat lookups', async () => {
      defaultEnv();
      const { session } = branchSession(true);
      const githubFetch = vi.fn(async () => new Response('[]', { status: 200 }));
      const ghDeps = {
        ...(deps as object),
        findProject: () => ghProject,
        resolveGithubToken: async () => 'tok',
        githubFetch,
      } as never;
      await setQaSessionRequestArmed(ghDeps, session, ghProject, true, 'u1');
      await processQaSessionRequest(ghDeps, session.id);
      expect(getQaSessionRequest(session.id)?.status).toBe('armed');
      expect(githubFetch).toHaveBeenCalledTimes(1);
    });

    it('never asks GitHub for a Hub-hosted repo or without a token', async () => {
      const { session } = branchSession(true);
      const githubFetch = vi.fn();
      await reconcileSessionMerge(
        { resolveGithubToken: async () => 'tok', githubFetch } as never,
        session,
        { ...hosted, githubRepo: 'acme/web' },
      );
      await reconcileSessionMerge(
        { resolveGithubToken: async () => null, githubFetch } as never,
        session,
        ghProject,
      );
      expect(githubFetch).not.toHaveBeenCalled();
    });
  });

  describe('github PR context in the drafting seed', () => {
    const ghProject = { ...project, githubRepo: 'acme/web' } as Project;
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    const seedText = () => kickoffSeededTurn.mock.calls[0][0].content as string;

    it('puts the github.com PR title and body found by branch into the seed', async () => {
      defaultEnv();
      const { session } = branchSession(true);
      githubMerge(session);
      const githubFetch = vi.fn(async (url: string) =>
        String(url).includes('state=all')
          ? json([{ number: 31, title: 'Add QA button', body: 'Testing: click Run QA Tests' }])
          : json([]),
      );
      const ghDeps = {
        ...(deps as object),
        findProject: () => ghProject,
        resolveGithubToken: async () => 'tok',
        githubFetch,
      } as never;
      await runQaSessionRequestNow(ghDeps, session, ghProject, 'u1');
      expect(seedText()).toContain('Pull request #31: Add QA button');
      expect(seedText()).toContain('Testing: click Run QA Tests');
    });

    it('falls back to the PR number the Hub logged for the session', async () => {
      defaultEnv();
      const { session } = branchSession(true);
      githubMerge(session);
      getDb()
        .prepare(
          `INSERT INTO pr_creation_logs (id, project_id, session_id, pr_url, pr_number, pr_title, author_agent)
           VALUES (?, ?, ?, 'https://github.com/acme/web/pull/44', 44, 'Logged title', 'dev')`,
        )
        .run(randomUUID(), PROJECT, session.id);
      const githubFetch = vi.fn(async (url: string) =>
        String(url).endsWith('/pulls/44')
          ? json({ number: 44, title: 'Real title', body: 'Real body' })
          : json([]),
      );
      const ghDeps = {
        ...(deps as object),
        findProject: () => ghProject,
        resolveGithubToken: async () => 'tok',
        githubFetch,
      } as never;
      await runQaSessionRequestNow(ghDeps, session, ghProject, 'u1');
      expect(seedText()).toContain('Pull request #44: Real title');
      expect(seedText()).toContain('Real body');
    });

    it('uses the logged title when no GitHub token is available', async () => {
      defaultEnv();
      const { session } = branchSession(true);
      githubMerge(session);
      getDb()
        .prepare(
          `INSERT INTO pr_creation_logs (id, project_id, session_id, pr_url, pr_number, pr_title, author_agent)
           VALUES (?, ?, ?, 'https://github.com/acme/web/pull/45', 45, 'Logged title', 'dev')`,
        )
        .run(randomUUID(), PROJECT, session.id);
      const githubFetch = vi.fn();
      const ghDeps = {
        ...(deps as object),
        findProject: () => ghProject,
        resolveGithubToken: async () => null,
        githubFetch,
      } as never;
      await runQaSessionRequestNow(ghDeps, session, ghProject, 'u1');
      expect(seedText()).toContain('Pull request #45: Logged title');
      expect(githubFetch).not.toHaveBeenCalled();
    });
  });

  describe('deleted plan', () => {
    async function drafting() {
      defaultEnv();
      const { session } = branchSession(true);
      githubMerge(session);
      const row = await runQaSessionRequestNow(deps, session, project, 'u1');
      expect(row.status).toBe('authoring');
      getDb().prepare('DELETE FROM qa_plans WHERE id = ?').run(row.plan_id);
      expect(getQaSessionRequest(session.id)!.plan_id).toBeNull();
      broadcast.mockClear();
      return { session, row };
    }
    const expectFailedAndEmitted = (sessionId: string) => {
      const after = getQaSessionRequest(sessionId)!;
      expect(after.status).toBe('failed');
      expect(after.error).toMatch(/plan was deleted/);
      expect(broadcast).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'session_request_updated', sessionId }),
      );
    };

    it('fails the request when the drafting turn ends', async () => {
      const { session, row } = await drafting();
      await finishQaSessionAuthoring(deps, row.authoring_session_id!, 'turn_ended');
      expectFailedAndEmitted(session.id);
      expect(launchQaRun).not.toHaveBeenCalled();
    });

    it('fails the request on boot recovery', async () => {
      const { session } = await drafting();
      await sweepAllQaSessionRequests(deps);
      expectFailedAndEmitted(session.id);
    });

    it('fails the request as soon as the deletion is swept, and allows a retry', async () => {
      const { session } = await drafting();
      expect(
        qaSessionRequestProjectFor({
          type: 'qa_update',
          action: 'plan_deleted',
          projectId: PROJECT,
        }),
      ).toBe(PROJECT);
      await sweepProjectQaSessionRequests(deps, PROJECT);
      expectFailedAndEmitted(session.id);
      const retry = await runQaSessionRequestNow(deps, session, project, 'u1');
      expect(retry.status).toBe('authoring');
      expect(retry.plan_id).toBeTruthy();
    });

    it('fails a waiting request whose plan was deleted', async () => {
      defaultEnv();
      updateQaProjectSettings(PROJECT, { autoQaDelayMinutes: 30 });
      const { session } = branchSession(true);
      githubMerge(session);
      const row = await runQaSessionRequestNow(deps, session, project, 'u1');
      addCase(row.plan_id!);
      await finishQaSessionAuthoring(deps, row.authoring_session_id!, 'turn_ended');
      expect(getQaSessionRequest(session.id)!.status).toBe('waiting');
      getDb().prepare('DELETE FROM qa_plans WHERE id = ?').run(row.plan_id);
      broadcast.mockClear();
      await sweepProjectQaSessionRequests(deps, PROJECT);
      expectFailedAndEmitted(session.id);
      expect(launchQaRun).not.toHaveBeenCalled();
    });
  });

  describe('merge prerequisite', () => {
    it('/run refuses an unmerged session and leaves an armed request armed', async () => {
      defaultEnv();
      const { session } = branchSession(true);
      await setQaSessionRequestArmed(deps, session, project, true, 'u1');
      await expect(runQaSessionRequestNow(deps, session, project, 'u1')).rejects.toMatchObject({
        status: 409,
        code: 'not_merged',
      });
      expect(getQaSessionRequest(session.id)?.status).toBe('armed');
      expect(kickoffSeededTurn).not.toHaveBeenCalled();
    });

    it('/run refuses a Hub-hosted session whose PR is still open', async () => {
      defaultEnv();
      const { session } = branchSession(true);
      pr(session, 'open');
      await expect(runQaSessionRequestNow(hostedDeps, session, hosted, 'u1')).rejects.toMatchObject(
        {
          code: 'not_merged',
        },
      );
      expect(getQaSessionRequest(session.id)).toBeNull();
    });
  });

  describe('restart during launch', () => {
    /** An approved request whose server died after writing `launching`. */
    async function interruptedLaunch() {
      defaultEnv();
      updateQaProjectSettings(PROJECT, { autoQaDelayMinutes: 30 });
      const { session } = branchSession(true);
      githubMerge(session);
      const row = await runQaSessionRequestNow(deps, session, project, 'u1');
      addCase(row.plan_id!);
      await finishQaSessionAuthoring(deps, row.authoring_session_id!, 'turn_ended');
      expect(getQaSessionRequest(session.id)!.status).toBe('waiting');
      getDb()
        .prepare(`UPDATE qa_session_requests SET status = 'launching' WHERE session_id = ?`)
        .run(session.id);
      __testResetQaSessionRuns();
      return { session, planId: row.plan_id! };
    }

    it('relaunches on boot when the interrupted launch never created a run', async () => {
      const { session } = await interruptedLaunch();
      await sweepAllQaSessionRequests(deps);
      expect(launchQaRun).toHaveBeenCalledTimes(1);
      const after = getQaSessionRequest(session.id)!;
      expect(after).toMatchObject({ status: 'started', run_id: 'run-1' });
    });

    /** A run a dead launch created (not in flight), optionally with a seeded QA session. */
    function preBootRun(planId: string, opts: { seeded: boolean }) {
      const { run } = startQaRun(planId, { startedBy: 'u1' });
      markQaRunRunning(run.id);
      const runSession = randomUUID();
      getStmts().createSession.run(
        runSession,
        'qa-agent',
        '[QA run]',
        'claude-code',
        'sonnet',
        0,
        0,
        1,
      );
      getStmts().setQaRunSession.run(runSession, run.id);
      if (opts.seeded) {
        getDb()
          .prepare(
            `INSERT INTO messages (id, session_id, role, content) VALUES (?, ?, 'user', 'seed')`,
          )
          .run(randomUUID(), runSession);
      }
      getDb()
        .prepare(`UPDATE qa_runs SET created_at = '2000-01-01 00:00:00' WHERE id = ?`)
        .run(run.id);
      return { run, runSession };
    }

    it('replaces a run the interrupted launch left unstarted and starts execution', async () => {
      const { session, planId } = await interruptedLaunch();
      const { run, runSession } = preBootRun(planId, { seeded: false });
      launchQaRun.mockImplementation(async (_deps: unknown, plan: { id: string }) => {
        // The real launch refuses while another run is active; the stale one must be gone.
        const active = getDb()
          .prepare(
            `SELECT COUNT(*) AS n FROM qa_runs WHERE plan_id = ? AND status IN ('queued','running')`,
          )
          .get(plan.id) as { n: number };
        expect(active.n).toBe(0);
        return { ok: true, run: { id: 'run-relaunched' } };
      });
      await sweepAllQaSessionRequests(deps);
      expect(launchQaRun).toHaveBeenCalledTimes(1);
      expect(getStmts().getQaRun.get(run.id)!.status).toBe('cancelled');
      expect(getStmts().getSession.get(runSession)).toBeUndefined();
      expect(getQaSessionRequest(session.id)).toMatchObject({
        status: 'started',
        run_id: 'run-relaunched',
      });
    });

    it('links a run whose agent session was already seeded', async () => {
      const { session, planId } = await interruptedLaunch();
      const { run } = preBootRun(planId, { seeded: true });
      await sweepAllQaSessionRequests(deps);
      expect(launchQaRun).not.toHaveBeenCalled();
      expect(getQaSessionRequest(session.id)).toMatchObject({ status: 'started', run_id: run.id });
      expect(getStmts().getQaRun.get(run.id)!.status).toBe('running');
    });

    it('tracks a launch still in flight in this process until it reaches an agent', async () => {
      const { session, planId } = await interruptedLaunch();
      const { run } = startQaRun(planId, { startedBy: 'u1' });
      launchesInFlight.add(run.id);
      await sweepAllQaSessionRequests(deps);
      expect(launchQaRun).not.toHaveBeenCalled();
      expect(getStmts().getQaRun.get(run.id)!.status).toBe('queued');
      expect(getQaSessionRequest(session.id)).toMatchObject({
        status: 'launching',
        run_id: run.id,
      });

      // That launch seeds its session: the next check links it as started.
      markQaRunRunning(run.id);
      const runSession = randomUUID();
      getStmts().createSession.run(
        runSession,
        'qa-agent',
        '[QA run]',
        'claude-code',
        'sonnet',
        0,
        0,
        1,
      );
      getStmts().setQaRunSession.run(runSession, run.id);
      getDb()
        .prepare(
          `INSERT INTO messages (id, session_id, role, content) VALUES (?, ?, 'user', 'seed')`,
        )
        .run(randomUUID(), runSession);
      expect(
        qaSessionRequestProjectFor({
          type: 'qa_update',
          action: 'run_started',
          projectId: PROJECT,
        }),
      ).toBe(PROJECT);
      await sweepProjectQaSessionRequests(deps, PROJECT);
      expect(getQaSessionRequest(session.id)).toMatchObject({ status: 'started', run_id: run.id });
      expect(launchQaRun).not.toHaveBeenCalled();
    });

    it('launches its own run when the in-flight launch it tracked is cancelled unseeded', async () => {
      const { session, planId } = await interruptedLaunch();
      const { run } = startQaRun(planId, { startedBy: 'u1' });
      launchesInFlight.add(run.id);
      await sweepAllQaSessionRequests(deps);
      cancelQaRun(run.id);
      await sweepProjectQaSessionRequests(deps, PROJECT);
      expect(launchQaRun).toHaveBeenCalledTimes(1);
      expect(getQaSessionRequest(session.id)).toMatchObject({ status: 'started', run_id: 'run-1' });
    });

    it('restart between cancelling the stale run and creating its replacement still runs QA', async () => {
      const { session, planId } = await interruptedLaunch();
      preBootRun(planId, { seeded: false });
      // First recovery: the discard lands, then the process dies inside launchQaRun.
      launchQaRun.mockImplementationOnce(() => new Promise(() => undefined));
      void sweepAllQaSessionRequests(deps);
      await vi.waitFor(() => expect(launchQaRun).toHaveBeenCalledTimes(1));
      const stale = getStmts().getLatestQaRun.get(planId)!;
      expect(stale.status).toBe('cancelled');
      expect(getQaSessionRequest(session.id)!.status).toBe('launching');

      // Next boot: the only run is the cancelled, never-seeded one.
      __testResetQaSessionRuns();
      await sweepAllQaSessionRequests(deps);
      expect(launchQaRun).toHaveBeenCalledTimes(2);
      expect(getQaSessionRequest(session.id)).toMatchObject({ status: 'started', run_id: 'run-1' });
    });

    it('links a run a person cancelled after it reached its agent', async () => {
      const { session, planId } = await interruptedLaunch();
      const { run } = preBootRun(planId, { seeded: true });
      cancelQaRun(run.id);
      await sweepAllQaSessionRequests(deps);
      expect(launchQaRun).not.toHaveBeenCalled();
      expect(getQaSessionRequest(session.id)).toMatchObject({ status: 'started', run_id: run.id });
    });

    it('a launching request is never replaced by /run or the checkbox', async () => {
      const { session } = await interruptedLaunch();
      const viaRun = await runQaSessionRequestNow(deps, session, project, 'u1');
      expect(viaRun.status).toBe('launching');
      const viaBox = await setQaSessionRequestArmed(deps, session, project, true, 'u1');
      expect(viaBox!.status).toBe('launching');
      expect(kickoffSeededTurn).toHaveBeenCalledTimes(1);
    });
  });

  describe('launch liveness', () => {
    it('discards an unseeded run created moments ago by a launch that is not in flight', async () => {
      defaultEnv();
      updateQaProjectSettings(PROJECT, { autoQaDelayMinutes: 30 });
      const { session } = branchSession(true);
      githubMerge(session);
      const row = await runQaSessionRequestNow(deps, session, project, 'u1');
      addCase(row.plan_id!);
      await finishQaSessionAuthoring(deps, row.authoring_session_id!, 'turn_ended');
      // A launch created this run this very second, then its process died.
      const { run } = startQaRun(row.plan_id!, { startedBy: 'u1' });
      getDb()
        .prepare(`UPDATE qa_session_requests SET status = 'launching' WHERE session_id = ?`)
        .run(session.id);
      __testResetQaSessionRuns();
      await sweepAllQaSessionRequests(deps);
      expect(getStmts().getQaRun.get(run.id)!.status).toBe('cancelled');
      expect(launchQaRun).toHaveBeenCalledTimes(1);
      expect(getQaSessionRequest(session.id)).toMatchObject({ status: 'started', run_id: 'run-1' });
    });

    it('a run_active refusal tracks the other launch instead of claiming it started', async () => {
      defaultEnv();
      const { session } = branchSession(true);
      githubMerge(session);
      const row = await runQaSessionRequestNow(deps, session, project, 'u1');
      addCase(row.plan_id!);
      launchQaRun.mockImplementationOnce(async (_d: unknown, plan: { id: string }) => {
        // A person's launch wins the race and is still seeding.
        const { run } = startQaRun(plan.id, { startedBy: 'someone' });
        launchesInFlight.add(run.id);
        throw new QaStatusError('run_active', 'A run is already active');
      });
      await finishQaSessionAuthoring(deps, row.authoring_session_id!, 'turn_ended');
      const after = getQaSessionRequest(session.id)!;
      expect(after.status).toBe('launching');
      expect(after.run_id).toBe(getStmts().getLatestQaRun.get(row.plan_id!)!.id);
    });
  });
});
