import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import type { RouteDeps } from '../types.js';

// Mock the GitHub App module
vi.mock('../github-app.js', () => ({
  githubApiRequest: vi.fn(),
  resolveInstallationId: vi.fn(),
}));

// Mock child_process — keep `exec` because `../worktree.js` (pulled in via
// `removeWorkspace`) calls `promisify(exec)` at module load.
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    execFile: vi.fn(),
    exec: vi.fn((...args: unknown[]) => {
      const cb = args.find((a) => typeof a === 'function') as
        | ((err: unknown, stdout?: string, stderr?: string) => void)
        | undefined;
      if (cb) queueMicrotask(() => cb(null, '', ''));
      return {} as ReturnType<typeof actual.exec>;
    }),
  };
});

// Shared mock for the `gh` CLI fallback tier. Tests can call
// `cliMock.mockResolvedValue(...)` / `cliMock.mockRejectedValue(...)` to
// control how the CLI tier resolves. Mirrors the pattern in
// `pr-detail-fetch.test.ts` / `pr-read-fetch.test.ts`.
const cliMock = vi.fn();
vi.mock('util', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    promisify: () => cliMock,
  };
});

// We test the parsePrUrl logic and route shape directly

/** Meets `validateFormalReviewBody` rules (min length + alnum + not placeholder). */
const SUBSTANTIVE_REVIEW_BODY =
  '**[2/10]** `server/foo.ts:14` — trailing whitespace nit only. No findings above severity 3; mergeable.';

describe('PR Actions route', () => {
  describe('parsePrUrl (via route validation)', () => {
    let app: express.Express;

    beforeEach(async () => {
      // Reset module cache to get fresh mocks
      vi.resetModules();

      const { default: createPrActionRoutes } = await import('./pr-actions.js');

      const mockDeps = {
        config: {
          port: 3051,
          dataDir: '/tmp',
        },
        stmts: {},
        broadcast: vi.fn() as unknown,
        findProject: vi.fn(),
        findAgent: vi.fn(),
        getEnrichedAgent: vi.fn(),
        allAgents: vi.fn(),
        saveProjects: vi.fn(),
        ensureProjectRoom: vi.fn(),
        handleChat: vi.fn(),
        pendingReviewComments: new Map(),
        lastDispatchedReviewId: new Map(),
        scheduleAutonomousEpic: vi.fn(),
        autonomousCrons: new Map(),
        runAutonomousLoop: vi.fn(),
        getProjects: vi.fn().mockReturnValue([]),
        setProjects: vi.fn(),
        getGhBotUser: vi.fn().mockReturnValue(null),
        setGhBotUser: vi.fn(),
        getGhAppSlug: vi.fn().mockReturnValue(null),
        setGhAppSlug: vi.fn(),
        serverDir: '/tmp',
        buildTranscript: vi.fn(),
        summarizeTranscript: vi.fn(),
      } as unknown as RouteDeps;

      app = express();
      app.use(express.json());
      app.use(createPrActionRoutes(mockDeps));
    });

    it('rejects invalid PR URL on merge', async () => {
      const res = await request(app).post('/api/pr/merge').send({ prUrl: 'not-a-url' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/Invalid PR URL/);
    });

    it('rejects invalid PR URL on close', async () => {
      const res = await request(app).post('/api/pr/close').send({ prUrl: '' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/Invalid PR URL/);
    });

    it('rejects missing prUrl on status', async () => {
      const res = await request(app).get('/api/pr/status');
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/Invalid PR URL/);
    });

    it('rejects invalid prUrl query param on status', async () => {
      const res = await request(app).get('/api/pr/status?prUrl=garbage');
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/Invalid PR URL/);
    });

    it('accepts valid GitHub PR URL format on merge (even if API fails)', async () => {
      // With no GitHub App and no gh CLI, it should attempt and fail
      const res = await request(app)
        .post('/api/pr/merge')
        .send({ prUrl: 'https://github.com/owner/repo/pull/42' });
      // Should not be 400 (URL is valid) — might be 500 from CLI failure
      expect(res.status).not.toBe(400);
    });

    it('accepts valid GitHub PR URL format on close (even if API fails)', async () => {
      const res = await request(app)
        .post('/api/pr/close')
        .send({ prUrl: 'https://github.com/owner/repo/pull/42' });
      expect(res.status).not.toBe(400);
    });
  });

  describe('mergeMethod validation', () => {
    let app: express.Express;

    beforeEach(async () => {
      vi.resetModules();
      const { default: createPrActionRoutes } = await import('./pr-actions.js');
      const mockDeps = {
        config: { port: 3051, dataDir: '/tmp' },
        stmts: {},
        broadcast: vi.fn() as unknown,
        findProject: vi.fn(),
        findAgent: vi.fn(),
        getEnrichedAgent: vi.fn(),
        allAgents: vi.fn(),
        saveProjects: vi.fn(),
        ensureProjectRoom: vi.fn(),
        handleChat: vi.fn(),
        pendingReviewComments: new Map(),
        lastDispatchedReviewId: new Map(),
        scheduleAutonomousEpic: vi.fn(),
        autonomousCrons: new Map(),
        runAutonomousLoop: vi.fn(),
        getProjects: vi.fn().mockReturnValue([]),
        setProjects: vi.fn(),
        getGhBotUser: vi.fn().mockReturnValue(null),
        setGhBotUser: vi.fn(),
        getGhAppSlug: vi.fn().mockReturnValue(null),
        setGhAppSlug: vi.fn(),
        serverDir: '/tmp',
        buildTranscript: vi.fn(),
        summarizeTranscript: vi.fn(),
      } as unknown as RouteDeps;
      app = express();
      app.use(express.json());
      app.use(createPrActionRoutes(mockDeps));
    });

    it('rejects invalid merge method (command injection attempt)', async () => {
      const res = await request(app)
        .post('/api/pr/merge')
        .send({ prUrl: 'https://github.com/owner/repo/pull/42', mergeMethod: 'squash --admin' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/Invalid merge method/);
    });

    it('rejects arbitrary merge method strings', async () => {
      const res = await request(app)
        .post('/api/pr/merge')
        .send({ prUrl: 'https://github.com/owner/repo/pull/42', mergeMethod: 'foo' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/Invalid merge method/);
    });

    it('accepts squash, merge, and rebase methods', async () => {
      for (const method of ['squash', 'merge', 'rebase']) {
        const res = await request(app)
          .post('/api/pr/merge')
          .send({ prUrl: 'https://github.com/owner/repo/pull/42', mergeMethod: method });
        expect(res.status).not.toBe(400);
      }
    });
  });

  // ─── /api/pr/review ──────────────────────────────────────────────
  //
  // This endpoint exists because the reviewer/lead agent otherwise submits
  // reviews via `gh pr review`, which authenticates as the host's CLI identity
  // (usually the PR author). GitHub silently downgrades self-APPROVE to
  // COMMENTED. Routing reviews through the GitHub App installation gives the
  // review a distinct identity so self-approval works.

  describe('/api/pr/review — validation', () => {
    let app: express.Express;

    beforeEach(async () => {
      vi.resetModules();
      const { default: createPrActionRoutes } = await import('./pr-actions.js');
      const mockDeps = {
        config: { port: 3051, dataDir: '/tmp', botGithubToken: null, githubApp: null },
        stmts: {},
        broadcast: vi.fn() as unknown,
        findProject: vi.fn(),
        findAgent: vi.fn(),
        getEnrichedAgent: vi.fn(),
        allAgents: vi.fn(),
        saveProjects: vi.fn(),
        ensureProjectRoom: vi.fn(),
        handleChat: vi.fn(),
        pendingReviewComments: new Map(),
        lastDispatchedReviewId: new Map(),
        scheduleAutonomousEpic: vi.fn(),
        autonomousCrons: new Map(),
        runAutonomousLoop: vi.fn(),
        getProjects: vi.fn().mockReturnValue([]),
        setProjects: vi.fn(),
        getGhBotUser: vi.fn().mockReturnValue(null),
        setGhBotUser: vi.fn(),
        getGhAppSlug: vi.fn().mockReturnValue(null),
        setGhAppSlug: vi.fn(),
        serverDir: '/tmp',
        buildTranscript: vi.fn(),
        summarizeTranscript: vi.fn(),
      } as unknown as RouteDeps;
      app = express();
      app.use(express.json());
      app.use(createPrActionRoutes(mockDeps));
    });

    it('rejects invalid PR URL', async () => {
      const res = await request(app)
        .post('/api/pr/review')
        .send({ prUrl: 'not-a-url', event: 'APPROVE' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/Invalid PR URL/);
    });

    it('rejects missing event', async () => {
      const res = await request(app)
        .post('/api/pr/review')
        .send({ prUrl: 'https://github.com/owner/repo/pull/42' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/Invalid review event/);
    });

    it('rejects bogus event values (guards against command injection / typos)', async () => {
      const res = await request(app)
        .post('/api/pr/review')
        .send({ prUrl: 'https://github.com/owner/repo/pull/42', event: 'APPROVE; rm -rf' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/Invalid review event/);
    });

    it('accepts APPROVE and REQUEST_CHANGES only with substantive bodies', async () => {
      const approveNoBody = await request(app)
        .post('/api/pr/review')
        .send({ prUrl: 'https://github.com/owner/repo/pull/42', event: 'APPROVE' });
      expect(approveNoBody.status).toBe(400);
      expect(approveNoBody.body.error).toMatch(/body is required|at least \d+ characters/);

      const approveTrivial = await request(app).post('/api/pr/review').send({
        prUrl: 'https://github.com/owner/repo/pull/42',
        event: 'APPROVE',
        body: 'test',
      });
      expect(approveTrivial.status).toBe(400);

      const approveRes = await request(app).post('/api/pr/review').send({
        prUrl: 'https://github.com/owner/repo/pull/42',
        event: 'APPROVE',
        body: SUBSTANTIVE_REVIEW_BODY,
      });
      // Will 501 because no App/bot token configured, but validation passed
      expect(approveRes.status).not.toBe(400);

      const rcNoBody = await request(app)
        .post('/api/pr/review')
        .send({ prUrl: 'https://github.com/owner/repo/pull/42', event: 'REQUEST_CHANGES' });
      expect(rcNoBody.status).toBe(400);
      expect(rcNoBody.body.error).toMatch(/body is required|at least \d+ characters/);

      const commentRejected = await request(app)
        .post('/api/pr/review')
        .send({
          prUrl: 'https://github.com/owner/repo/pull/42',
          event: 'COMMENT',
          body: `${SUBSTANTIVE_REVIEW_BODY} Non-blocking notes only — should still be APPROVE.`,
        });
      expect(commentRejected.status).toBe(400);
      expect(commentRejected.body.error).toMatch(
        /COMMENT reviews do not count toward required approval/,
      );
      expect(commentRejected.body.error).toMatch(/APPROVE/);
      expect(commentRejected.body.error).toMatch(/REQUEST_CHANGES/);
    });

    it('returns 501 when no GitHub App installation and no bot token are configured', async () => {
      const res = await request(app).post('/api/pr/review').send({
        prUrl: 'https://github.com/owner/repo/pull/42',
        event: 'APPROVE',
        body: SUBSTANTIVE_REVIEW_BODY,
      });
      expect(res.status).toBe(501);
      expect(res.body.error).toMatch(/No GitHub App installation/);
    });
  });

  describe('/api/pr/review — GitHub App path', () => {
    let app: express.Express;
    let githubApiRequest: ReturnType<typeof vi.fn>;
    let resolveInstallationId: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
      vi.resetModules();
      const mod = await import('../github-app.js');
      githubApiRequest = mod.githubApiRequest as unknown as ReturnType<typeof vi.fn>;
      resolveInstallationId = mod.resolveInstallationId as unknown as ReturnType<typeof vi.fn>;
      githubApiRequest.mockReset();
      resolveInstallationId.mockReset();

      const { default: createPrActionRoutes } = await import('./pr-actions.js');
      const mockDeps = {
        config: {
          port: 3051,
          dataDir: '/tmp',
          botGithubToken: null,
          githubApp: {
            appId: '1',
            privateKey: 'key',
            installationId: 42,
            installations: [{ id: 42, account: 'owner', accountType: 'Organization' }],
          },
        },
        stmts: {},
        broadcast: vi.fn() as unknown,
        findProject: vi.fn(),
        findAgent: vi.fn(),
        getEnrichedAgent: vi.fn(),
        allAgents: vi.fn(),
        saveProjects: vi.fn(),
        ensureProjectRoom: vi.fn(),
        handleChat: vi.fn(),
        pendingReviewComments: new Map(),
        lastDispatchedReviewId: new Map(),
        scheduleAutonomousEpic: vi.fn(),
        autonomousCrons: new Map(),
        runAutonomousLoop: vi.fn(),
        getProjects: vi.fn().mockReturnValue([]),
        setProjects: vi.fn(),
        getGhBotUser: vi.fn().mockReturnValue(null),
        setGhBotUser: vi.fn(),
        getGhAppSlug: vi.fn().mockReturnValue(null),
        setGhAppSlug: vi.fn(),
        serverDir: '/tmp',
        buildTranscript: vi.fn(),
        summarizeTranscript: vi.fn(),
      } as unknown as RouteDeps;
      app = express();
      app.use(express.json());
      app.use(createPrActionRoutes(mockDeps));
    });

    it('submits the review via githubApiRequest with event + App credentials', async () => {
      resolveInstallationId.mockReturnValue(42);
      githubApiRequest.mockResolvedValue({
        id: 99,
        html_url: 'https://github.com/owner/repo/pull/42#review-99',
        user: { login: 'ryan-s-agent-hub-reviewer[bot]' },
        state: 'APPROVED',
      });

      const res = await request(app).post('/api/pr/review').send({
        prUrl: 'https://github.com/owner/repo/pull/42',
        event: 'APPROVE',
        body: SUBSTANTIVE_REVIEW_BODY,
      });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        ok: true,
        method: 'github-app',
        pr: '42',
        event: 'APPROVE',
        reviewId: 99,
        reviewer: 'ryan-s-agent-hub-reviewer[bot]',
      });

      expect(githubApiRequest).toHaveBeenCalledTimes(1);
      const [endpoint, opts] = githubApiRequest.mock.calls[0];
      expect(endpoint).toBe('/repos/owner/repo/pulls/42/reviews');
      expect(opts).toMatchObject({
        method: 'POST',
        body: { event: 'APPROVE', body: SUBSTANTIVE_REVIEW_BODY },
        appId: '1',
        installationId: 42,
      });
    });

    it('forwards body + commit_id when provided', async () => {
      resolveInstallationId.mockReturnValue(42);
      githubApiRequest.mockResolvedValue({ id: 100, state: 'CHANGES_REQUESTED' });

      const rcBody =
        '**[6/10]** `server/bar.ts:3` — missing null guard on user input. Please fix the missing null check before merge; edge case when payload is undefined.';

      await request(app).post('/api/pr/review').send({
        prUrl: 'https://github.com/owner/repo/pull/42',
        event: 'REQUEST_CHANGES',
        body: rcBody,
        commitId: 'abc123',
      });

      const [, opts] = githubApiRequest.mock.calls[0];
      expect(opts.body).toMatchObject({
        event: 'REQUEST_CHANGES',
        body: rcBody,
        commit_id: 'abc123',
      });
    });

    it('falls back to 501 when the App path throws and no bot token is configured', async () => {
      resolveInstallationId.mockReturnValue(42);
      githubApiRequest.mockRejectedValue(new Error('GitHub API POST failed (403): forbidden'));

      const res = await request(app).post('/api/pr/review').send({
        prUrl: 'https://github.com/owner/repo/pull/42',
        event: 'APPROVE',
        body: SUBSTANTIVE_REVIEW_BODY,
      });

      expect(res.status).toBe(501);
      expect(res.body.error).toMatch(/No GitHub App installation|bot token/);
    });

    // Diagnostic surfacing — App tier was silently swallowing the GitHub
    // error into a console.warn, leaving operators staring at a generic
    // 501 with no clue what GitHub actually rejected. Surfacing the
    // first-line of the App-tier error in the response makes future
    // debugging tractable from outside the box.
    it('surfaces the App-tier error message in the 501 response body', async () => {
      resolveInstallationId.mockReturnValue(42);
      githubApiRequest.mockRejectedValue(
        new Error('GitHub API POST failed (403): Resource not accessible by integration'),
      );

      const res = await request(app).post('/api/pr/review').send({
        prUrl: 'https://github.com/owner/repo/pull/42',
        event: 'APPROVE',
        body: SUBSTANTIVE_REVIEW_BODY,
      });

      expect(res.status).toBe(501);
      expect(res.body.appTierError).toMatch(/403/);
      expect(res.body.appTierError).toMatch(/Resource not accessible/);
    });

    it('surfaces the App-tier error when no installation matches the owner', async () => {
      // Simulate the "App configured but installation not on this owner"
      // branch: resolveInstallationId returns null/0 → console.warn path
      resolveInstallationId.mockReturnValue(null);

      const res = await request(app).post('/api/pr/review').send({
        prUrl: 'https://github.com/owner/repo/pull/42',
        event: 'APPROVE',
        body: SUBSTANTIVE_REVIEW_BODY,
      });

      expect(res.status).toBe(501);
      expect(res.body.appTierError).toMatch(/no installation matched/i);
      expect(res.body.appTierError).toMatch(/owner/);
    });
  });

  // Diagnostic-surfacing coverage for merge/close/status — same swallow
  // pattern as /api/pr/review but with a gh-CLI tier 2 instead of a bot
  // token tier. Verifies the App-tier error reaches the final 500.
  describe('appTierError surfacing on /api/pr/{merge,close,status}', () => {
    let app: express.Express;
    let githubApiRequest: ReturnType<typeof vi.fn>;
    let resolveInstallationId: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
      vi.resetModules();
      const mod = await import('../github-app.js');
      githubApiRequest = mod.githubApiRequest as unknown as ReturnType<typeof vi.fn>;
      resolveInstallationId = mod.resolveInstallationId as unknown as ReturnType<typeof vi.fn>;
      githubApiRequest.mockReset();
      resolveInstallationId.mockReset();
      cliMock.mockReset();

      const { default: createPrActionRoutes } = await import('./pr-actions.js');
      const mockDeps = {
        config: {
          port: 3051,
          dataDir: '/tmp',
          botGithubToken: null,
          githubApp: {
            appId: '1',
            privateKey: 'key',
            installationId: 42,
            installations: [{ id: 42, account: 'owner', accountType: 'Organization' }],
          },
        },
        stmts: {},
        broadcast: vi.fn() as unknown,
        findProject: vi.fn(),
        findAgent: vi.fn(),
        getEnrichedAgent: vi.fn(),
        allAgents: vi.fn(),
        saveProjects: vi.fn(),
        ensureProjectRoom: vi.fn(),
        handleChat: vi.fn(),
        pendingReviewComments: new Map(),
        lastDispatchedReviewId: new Map(),
        scheduleAutonomousEpic: vi.fn(),
        autonomousCrons: new Map(),
        runAutonomousLoop: vi.fn(),
        getProjects: vi.fn().mockReturnValue([]),
        setProjects: vi.fn(),
        getGhBotUser: vi.fn().mockReturnValue(null),
        setGhBotUser: vi.fn(),
        getGhAppSlug: vi.fn().mockReturnValue(null),
        setGhAppSlug: vi.fn(),
        serverDir: '/tmp',
        buildTranscript: vi.fn(),
        summarizeTranscript: vi.fn(),
      } as unknown as RouteDeps;
      app = express();
      app.use(express.json());
      app.use(createPrActionRoutes(mockDeps));
    });

    it('/api/pr/merge surfaces App-tier error in 500 when both tiers fail', async () => {
      resolveInstallationId.mockReturnValue(42);
      githubApiRequest.mockRejectedValue(new Error('GitHub API 403: permission denied'));
      cliMock.mockRejectedValue(new Error('gh: not authenticated'));

      const res = await request(app)
        .post('/api/pr/merge')
        .send({ prUrl: 'https://github.com/owner/repo/pull/42' });

      expect(res.status).toBe(500);
      expect(res.body.error).toMatch(/Merge failed/);
      expect(res.body.appTierError).toMatch(/403/);
      expect(res.body.appTierError).toMatch(/permission denied/);
    });

    it('/api/pr/close surfaces App-tier error in 500 when both tiers fail', async () => {
      resolveInstallationId.mockReturnValue(42);
      githubApiRequest.mockRejectedValue(new Error('GitHub API 404: not found'));
      cliMock.mockRejectedValue(new Error('gh: command not found'));

      const res = await request(app)
        .post('/api/pr/close')
        .send({ prUrl: 'https://github.com/owner/repo/pull/42' });

      expect(res.status).toBe(500);
      expect(res.body.error).toMatch(/Close failed/);
      expect(res.body.appTierError).toMatch(/404/);
      expect(res.body.appTierError).toMatch(/not found/);
    });

    it('/api/pr/status surfaces App-tier error in 500 when both tiers fail', async () => {
      resolveInstallationId.mockReturnValue(42);
      githubApiRequest.mockRejectedValue(new Error('GitHub API 403: forbidden'));
      cliMock.mockRejectedValue(new Error('gh: command not found'));

      const res = await request(app).get(
        '/api/pr/status?prUrl=https%3A%2F%2Fgithub.com%2Fowner%2Frepo%2Fpull%2F42',
      );

      expect(res.status).toBe(500);
      expect(res.body.error).toMatch(/Status check failed/);
      expect(res.body.appTierError).toMatch(/403/);
      expect(res.body.appTierError).toMatch(/forbidden/);
    });

    // Confirms the 501 message we just rewrote correctly distinguishes
    // "App was never installed" from "App was installed but threw" — the
    // first half of R2 must-fix #1 from the review.
    it('/api/pr/review 501 message reflects App-tier failure when the App actually ran and threw', async () => {
      resolveInstallationId.mockReturnValue(42);
      githubApiRequest.mockRejectedValue(new Error('GitHub API 422: Unprocessable Entity'));

      const res = await request(app).post('/api/pr/review').send({
        prUrl: 'https://github.com/owner/repo/pull/42',
        event: 'APPROVE',
        body: SUBSTANTIVE_REVIEW_BODY,
      });

      expect(res.status).toBe(501);
      // Old message said "No GitHub App installation" — factually wrong
      // when App was configured but failed. New copy: explicitly names
      // the rejection while still pointing at the bot-token escape hatch.
      expect(res.body.error).toMatch(/GitHub App review request failed/);
      expect(res.body.error).not.toMatch(/No GitHub App installation/);
      expect(res.body.appTierError).toMatch(/422/);
    });
  });

  // Regression test for the "Reviews panel stopped updating" bug.
  // The prepared statement `createReviewLog` existed in db.ts but had no
  // caller, so `review_logs` never grew and the kanban Reviews activity
  // panel stayed frozen. This test verifies that a successful PR review
  // submission persists a row with the expected fields.
  describe('/api/pr/review — review_logs persistence', () => {
    let app: express.Express;
    let githubApiRequest: ReturnType<typeof vi.fn>;
    let resolveInstallationId: ReturnType<typeof vi.fn>;
    let createReviewLogRun: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
      vi.resetModules();
      const mod = await import('../github-app.js');
      githubApiRequest = mod.githubApiRequest as unknown as ReturnType<typeof vi.fn>;
      resolveInstallationId = mod.resolveInstallationId as unknown as ReturnType<typeof vi.fn>;
      githubApiRequest.mockReset();
      resolveInstallationId.mockReset();

      const { default: createPrActionRoutes } = await import('./pr-actions.js');

      createReviewLogRun = vi.fn();
      const getKanbanCardByPrUrl = vi.fn().mockReturnValue({
        id: 'card-1',
        board_id: 'board-1',
        assignee: 'agent-hub-backend',
        session_id: 'session-abc',
      });
      const getKanbanBoardById = vi.fn().mockReturnValue({
        id: 'board-1',
        project_id: 'project-xyz',
        name: 'Agent Hub Board',
        created_at: '2026-04-15T00:00:00Z',
      });

      const mockDeps = {
        config: {
          port: 3051,
          dataDir: '/tmp',
          botGithubToken: null,
          githubApp: {
            appId: '1',
            privateKey: 'key',
            installationId: 42,
            installations: [{ id: 42, account: 'owner', accountType: 'Organization' }],
          },
        },
        stmts: {
          createReviewLog: { run: createReviewLogRun },
          getKanbanCardByPrUrl: { get: getKanbanCardByPrUrl },
          getKanbanBoardById: { get: getKanbanBoardById },
        },
        broadcast: vi.fn() as unknown,
        findProject: vi.fn(),
        findAgent: vi.fn(),
        getEnrichedAgent: vi.fn(),
        allAgents: vi.fn(),
        saveProjects: vi.fn(),
        ensureProjectRoom: vi.fn(),
        handleChat: vi.fn(),
        pendingReviewComments: new Map(),
        lastDispatchedReviewId: new Map(),
        scheduleAutonomousEpic: vi.fn(),
        autonomousCrons: new Map(),
        runAutonomousLoop: vi.fn(),
        getProjects: vi.fn().mockReturnValue([]),
        setProjects: vi.fn(),
        getGhBotUser: vi.fn().mockReturnValue(null),
        setGhBotUser: vi.fn(),
        getGhAppSlug: vi.fn().mockReturnValue(null),
        setGhAppSlug: vi.fn(),
        serverDir: '/tmp',
        buildTranscript: vi.fn(),
        summarizeTranscript: vi.fn(),
      } as unknown as RouteDeps;

      app = express();
      app.use(express.json());
      app.use(createPrActionRoutes(mockDeps));
    });

    it('persists a review_logs row when APPROVE succeeds via GitHub App', async () => {
      resolveInstallationId.mockReturnValue(42);
      githubApiRequest.mockResolvedValue({
        id: 99,
        user: { login: 'ryan-s-agent-hub-reviewer[bot]' },
        state: 'APPROVED',
      });

      const res = await request(app).post('/api/pr/review').send({
        prUrl: 'https://github.com/owner/repo/pull/42',
        event: 'APPROVE',
        body: SUBSTANTIVE_REVIEW_BODY,
      });

      expect(res.status).toBe(200);
      expect(createReviewLogRun).toHaveBeenCalledTimes(1);

      const args = createReviewLogRun.mock.calls[0];
      // Positional arg order matches the createReviewLog prepared statement:
      // (id, project_id, card_id, pr_url, reviewer_agent, author_agent,
      //  session_id, outcome, review_body, started_at, completed_at)
      expect(args[1]).toBe('project-xyz'); // project_id resolved via board join
      expect(args[2]).toBe('card-1'); // card_id
      expect(args[3]).toBe('https://github.com/owner/repo/pull/42');
      expect(args[4]).toBe('ryan-s-agent-hub-reviewer[bot]');
      expect(args[5]).toBe('agent-hub-backend'); // author_agent = card.assignee
      expect(args[6]).toBe('session-abc');
      expect(args[7]).toBe('approved'); // APPROVE → approved
    });

    it('maps REQUEST_CHANGES → changes_requested and records the body', async () => {
      resolveInstallationId.mockReturnValue(42);
      githubApiRequest.mockResolvedValue({
        id: 100,
        user: { login: 'reviewer-bot' },
        state: 'CHANGES_REQUESTED',
      });

      await request(app).post('/api/pr/review').send({
        prUrl: 'https://github.com/owner/repo/pull/42',
        event: 'REQUEST_CHANGES',
        body: '**[6/10]** `server/bar.ts:3` — missing null guard. Please fix the null check in server/bar.ts before merge; edge case when input is undefined.',
      });

      expect(createReviewLogRun).toHaveBeenCalledTimes(1);
      const args = createReviewLogRun.mock.calls[0];
      expect(args[7]).toBe('changes_requested');
      expect(args[8]).toContain('missing null guard');
    });

    it('skips persistence when the PR is not linked to any kanban card', async () => {
      vi.resetModules();
      const mod = await import('../github-app.js');
      const ghReq = mod.githubApiRequest as unknown as ReturnType<typeof vi.fn>;
      const resolveInst = mod.resolveInstallationId as unknown as ReturnType<typeof vi.fn>;
      ghReq.mockReset();
      resolveInst.mockReset();
      resolveInst.mockReturnValue(42);
      ghReq.mockResolvedValue({ id: 99, user: { login: 'reviewer-bot' }, state: 'APPROVED' });

      const { default: createPrActionRoutes } = await import('./pr-actions.js');

      const createRun = vi.fn();
      const getCard = vi.fn().mockReturnValue(undefined); // no card linked
      const getBoard = vi.fn();

      const deps = {
        config: {
          port: 3051,
          dataDir: '/tmp',
          botGithubToken: null,
          githubApp: {
            appId: '1',
            privateKey: 'key',
            installationId: 42,
            installations: [{ id: 42, account: 'owner', accountType: 'Organization' }],
          },
        },
        stmts: {
          createReviewLog: { run: createRun },
          getKanbanCardByPrUrl: { get: getCard },
          getKanbanBoardById: { get: getBoard },
        },
        broadcast: vi.fn(),
        findProject: vi.fn(),
        findAgent: vi.fn(),
        getEnrichedAgent: vi.fn(),
        allAgents: vi.fn(),
        saveProjects: vi.fn(),
        ensureProjectRoom: vi.fn(),
        handleChat: vi.fn(),
        pendingReviewComments: new Map(),
        lastDispatchedReviewId: new Map(),
        scheduleAutonomousEpic: vi.fn(),
        autonomousCrons: new Map(),
        runAutonomousLoop: vi.fn(),
        getProjects: vi.fn().mockReturnValue([]),
        setProjects: vi.fn(),
        getGhBotUser: vi.fn().mockReturnValue(null),
        setGhBotUser: vi.fn(),
        getGhAppSlug: vi.fn().mockReturnValue(null),
        setGhAppSlug: vi.fn(),
        serverDir: '/tmp',
        buildTranscript: vi.fn(),
        summarizeTranscript: vi.fn(),
      } as unknown as RouteDeps;

      const isolatedApp = express();
      isolatedApp.use(express.json());
      isolatedApp.use(createPrActionRoutes(deps));

      const res = await request(isolatedApp).post('/api/pr/review').send({
        prUrl: 'https://github.com/owner/repo/pull/42',
        event: 'APPROVE',
        body: SUBSTANTIVE_REVIEW_BODY,
      });

      expect(res.status).toBe(200); // review still succeeds
      expect(getCard).toHaveBeenCalledWith('https://github.com/owner/repo/pull/42');
      expect(getBoard).not.toHaveBeenCalled();
      expect(createRun).not.toHaveBeenCalled();
    });
  });
});
