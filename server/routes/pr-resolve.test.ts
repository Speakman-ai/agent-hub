import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import type { RouteDeps } from '../types.js';

// Mock the PR-detail fetcher — we drive scenarios by setting what it returns.
vi.mock('../pr-detail-fetch.js', () => ({
  fetchPrDetail: vi.fn(),
}));

// Autofix templates — mock so tests don't have to read files off disk.
vi.mock('../prompts/autofix/index.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    loadAutofixTemplate: (kind: string) => `TEMPLATE[${kind}]`,
  };
});

// config.ts — avoid touching real config loaders.
vi.mock('../config.js', () => ({
  default: { apiKey: null },
  defaultModelForEngine: () => 'sonnet',
  buildSpawnEnv: () => ({}),
}));

vi.mock('../session-ownership.js', () => ({
  setSessionOwner: vi.fn(),
  getOrgOwnerUserId: vi.fn(() => null),
  inheritOwnerFromSession: vi.fn(),
  resolveOwnerUserId: vi.fn(() => null),
  userOwnsSession: vi.fn(() => true),
}));

import { detectKinds, latestChangesRequestedReviews, buildResolvePrompt } from './pr-resolve.js';

describe('pr-resolve — pure helpers', () => {
  describe('detectKinds', () => {
    it('returns empty when PR is clean', () => {
      expect(
        detectKinds({ mergeable: true, mergeable_state: 'clean' }, [], [{ conclusion: 'success' }]),
      ).toEqual([]);
    });

    it('detects conflict via mergeable=false', () => {
      expect(detectKinds({ mergeable: false, mergeable_state: null }, [], [])).toEqual([
        'conflict',
      ]);
    });

    it('detects conflict via mergeable_state', () => {
      expect(detectKinds({ mergeable: null, mergeable_state: 'dirty' }, [], [])).toEqual([
        'conflict',
      ]);
      expect(detectKinds({ mergeable: null, mergeable_state: 'CONFLICTING' }, [], [])).toEqual([
        'conflict',
      ]);
    });

    it('detects ci for any failing check conclusion', () => {
      for (const c of ['failure', 'timed_out', 'action_required', 'cancelled']) {
        expect(detectKinds({ mergeable: true }, [], [{ conclusion: c }])).toEqual(['ci']);
      }
    });

    it('ignores green and neutral conclusions', () => {
      expect(detectKinds({ mergeable: true }, [], [{ conclusion: 'success' }])).toEqual([]);
      expect(detectKinds({ mergeable: true }, [], [{ conclusion: 'neutral' }])).toEqual([]);
    });

    it('detects review via CHANGES_REQUESTED review', () => {
      expect(
        detectKinds(
          { mergeable: true },
          [{ user: 'bob', state: 'CHANGES_REQUESTED', submitted_at: '2026-01-01' }],
          [],
        ),
      ).toEqual(['review']);
    });

    it('dedupes reviewer — only the latest review per user counts', () => {
      // Bob's latest is APPROVED — should not trigger review autofix
      const reviews = [
        { user: 'bob', state: 'CHANGES_REQUESTED', submitted_at: '2026-01-01' },
        { user: 'bob', state: 'APPROVED', submitted_at: '2026-01-02' },
      ];
      expect(detectKinds({ mergeable: true }, reviews, [])).toEqual([]);
    });

    it('emits kinds in stable canonical order regardless of detection order', () => {
      const reviews = [{ user: 'bob', state: 'CHANGES_REQUESTED' }];
      const checks = [{ conclusion: 'failure' }];
      expect(detectKinds({ mergeable: false }, reviews, checks)).toEqual([
        'review',
        'ci',
        'conflict',
      ]);
    });
  });

  describe('latestChangesRequestedReviews', () => {
    it('takes latest per user', () => {
      const out = latestChangesRequestedReviews([
        { user: 'a', state: 'CHANGES_REQUESTED', submitted_at: 't1' },
        { user: 'a', state: 'APPROVED', submitted_at: 't2' },
        { user: 'b', state: 'CHANGES_REQUESTED', submitted_at: 't3' },
      ]);
      expect(out).toHaveLength(1);
      expect(out[0].user).toBe('b');
    });
  });

  describe('buildResolvePrompt', () => {
    it('includes the context header and each template joined by ---', () => {
      const prompt = buildResolvePrompt(
        {
          number: 42,
          title: 'Fix thing',
          html_url: 'https://github.com/o/r/pull/42',
          head: 'feature/x',
          base: 'main',
          mergeable: false,
          mergeable_state: 'dirty',
        },
        [{ user: 'bob', state: 'CHANGES_REQUESTED', body: 'please fix' }],
        [{ name: 'lint', conclusion: 'failure', html_url: 'https://ci/log' }],
        [],
        'o/r',
        ['review', 'ci', 'conflict'],
      );
      expect(prompt).toContain('## PR Context');
      expect(prompt).toContain('PR: #42 — Fix thing');
      expect(prompt).toContain('feature/x → main');
      expect(prompt).toContain('Failing checks (1)');
      expect(prompt).toContain('lint: failure');
      expect(prompt).toContain('Review feedback (1 reviewer)');
      expect(prompt).toContain('**bob**: please fix');
      expect(prompt).toContain('TEMPLATE[review]');
      expect(prompt).toContain('TEMPLATE[ci]');
      expect(prompt).toContain('TEMPLATE[conflict]');
      expect((prompt.match(/\n\n---\n\n/g) || []).length).toBe(3);
    });

    it('includes the gh pr checkout setup directive so commits land on the PR branch (auto-push regression)', () => {
      // Regression for "Resolve sessions no longer auto-push commits".
      //
      // Resolve sessions spawn into a fresh worktree branch
      // (`agent-hub/<agent-id>/session-<id>`), not the PR's head branch.
      // Without an explicit `gh pr checkout` step the agent commits to the
      // worktree branch; at session end `autoCommitAndPR` runs `gh pr view`
      // against that branch, finds no PR, and falls through to a
      // `changes_ready` broadcast — the commits stay local and the PR is
      // never updated.
      //
      // The header MUST direct the agent to `gh pr checkout <num>` before
      // making any code changes so the existing auto-commit pipeline finds
      // the open PR via the pre-check in `commitPushAndCreatePR` and pushes
      // the fix. This test locks the directive into the prompt.
      const prompt = buildResolvePrompt(
        {
          number: 42,
          title: 'Fix thing',
          html_url: 'https://github.com/o/r/pull/42',
          head: 'feature/x',
          base: 'main',
        },
        [],
        [{ conclusion: 'failure' }],
        [],
        'o/r',
        ['ci'],
      );
      expect(prompt).toContain('## Setup — required first step');
      expect(prompt).toContain('gh pr checkout 42');
      // The directive must appear BEFORE the autofix templates so the agent
      // reads it before starting work.
      const setupIdx = prompt.indexOf('## Setup');
      const templateIdx = prompt.indexOf('TEMPLATE[ci]');
      expect(setupIdx).toBeGreaterThan(-1);
      expect(templateIdx).toBeGreaterThan(setupIdx);
    });

    it('omits the setup directive when the PR number is missing/invalid', () => {
      // Defensive — buildPrContextHeader is reused by other call sites and
      // must not blow up when `pr.number` is absent or non-numeric.
      const prompt = buildResolvePrompt(
        { title: 'Fix thing' },
        [],
        [{ conclusion: 'failure' }],
        [],
        'o/r',
        ['ci'],
      );
      expect(prompt).not.toContain('## Setup — required first step');
      expect(prompt).not.toContain('gh pr checkout');
    });
  });
});

// ─── Route integration ───────────────────────────────────────────

function buildDeps(overrides: Partial<RouteDeps> = {}): RouteDeps {
  return {
    config: { port: 3051, dataDir: '/tmp' },
    stmts: {
      createSession: { run: vi.fn() },
      insertBackgroundTask: { run: vi.fn() },
      getSession: { get: vi.fn().mockReturnValue({ id: 'fake-session' }) },
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
    ...overrides,
  } as unknown as RouteDeps;
}

async function mount(deps: RouteDeps) {
  vi.resetModules();
  const { default: createPrResolveRoutes } = await import('./pr-resolve.js');
  const app = express();
  app.use(express.json());
  app.use(createPrResolveRoutes(deps));
  return app;
}

describe('POST /api/projects/:projectId/pulls/:number/resolve', () => {
  beforeEach(async () => {
    const { fetchPrDetail } = await import('../pr-detail-fetch.js');
    (fetchPrDetail as ReturnType<typeof vi.fn>).mockReset();
  });

  it('returns 404 when the project is unknown', async () => {
    const app = await mount(buildDeps({ findProject: vi.fn().mockReturnValue(null) }));
    const res = await request(app)
      .post('/api/projects/ghost/pulls/1/resolve')
      .send({ agentId: 'a1' });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/Project not found/);
  });

  it('returns 400 when githubRepo is missing', async () => {
    const app = await mount(buildDeps({ findProject: vi.fn().mockReturnValue({ id: 'p' }) }));
    const res = await request(app).post('/api/projects/p/pulls/1/resolve').send({ agentId: 'a1' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/githubRepo/);
  });

  it('returns 400 when agentId is missing', async () => {
    const app = await mount(
      buildDeps({
        findProject: vi.fn().mockReturnValue({ id: 'p', githubRepo: 'o/r' }),
      }),
    );
    const res = await request(app).post('/api/projects/p/pulls/1/resolve').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/agentId is required/);
  });

  it('returns 404 when agent is unknown', async () => {
    const app = await mount(
      buildDeps({
        findProject: vi.fn().mockReturnValue({ id: 'p', githubRepo: 'o/r' }),
        findAgent: vi.fn().mockReturnValue(null),
      }),
    );
    const res = await request(app)
      .post('/api/projects/p/pulls/1/resolve')
      .send({ agentId: 'missing' });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/Unknown agent/);
  });

  it('returns no-action-needed for a clean PR without spawning a session', async () => {
    const { fetchPrDetail } = await import('../pr-detail-fetch.js');
    (fetchPrDetail as ReturnType<typeof vi.fn>).mockResolvedValue({
      source: 'github-app',
      pr: { number: 1, title: 't', mergeable: true, mergeable_state: 'clean' },
      reviews: [{ user: 'bob', state: 'APPROVED', submitted_at: 't' }],
      checks: [{ name: 'ci', conclusion: 'success' }],
      comments: [],
    });

    const handleChat = vi.fn();
    const createSessionRun = vi.fn();
    const deps = buildDeps({
      findProject: vi.fn().mockReturnValue({ id: 'p', githubRepo: 'o/r' }),
      findAgent: vi.fn().mockReturnValue({
        project: { id: 'p' },
        agent: { id: 'a1', engine: 'claude-code' },
      }),
      handleChat,
      stmts: {
        createSession: { run: createSessionRun },
        insertBackgroundTask: { run: vi.fn() },
        getSession: { get: vi.fn().mockReturnValue({ id: 'x' }) },
      } as unknown as RouteDeps['stmts'],
    });

    const app = await mount(deps);
    const res = await request(app).post('/api/projects/p/pulls/1/resolve').send({ agentId: 'a1' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      sessionId: null,
      triggered: [],
      reason: 'no-action-needed',
    });
    expect(handleChat).not.toHaveBeenCalled();
    expect(createSessionRun).not.toHaveBeenCalled();
  });

  it('spawns a session with the right template kinds when the PR has failures', async () => {
    const { fetchPrDetail } = await import('../pr-detail-fetch.js');
    (fetchPrDetail as ReturnType<typeof vi.fn>).mockResolvedValue({
      source: 'github-app',
      pr: {
        number: 42,
        title: 'Fix thing',
        mergeable: false,
        mergeable_state: 'dirty',
        html_url: 'https://github.com/o/r/pull/42',
        head: 'feature/x',
        base: 'main',
      },
      reviews: [{ user: 'bob', state: 'CHANGES_REQUESTED', body: 'no', submitted_at: 't' }],
      checks: [{ name: 'ci', conclusion: 'failure', html_url: 'u' }],
      comments: [],
    });

    const handleChat = vi.fn();
    const createSessionRun = vi.fn();
    const insertBackgroundTaskRun = vi.fn();
    const deps = buildDeps({
      findProject: vi.fn().mockReturnValue({ id: 'p', githubRepo: 'o/r' }),
      findAgent: vi.fn().mockReturnValue({
        project: { id: 'p' },
        agent: { id: 'a1', engine: 'claude-code' },
      }),
      handleChat,
      stmts: {
        createSession: { run: createSessionRun },
        insertBackgroundTask: { run: insertBackgroundTaskRun },
        getSession: {
          get: vi
            .fn()
            .mockReturnValue({ id: 'spawned-session', name: '[Resolve PR #42] Fix thing' }),
        },
      } as unknown as RouteDeps['stmts'],
    });

    const app = await mount(deps);
    const res = await request(app).post('/api/projects/p/pulls/42/resolve').send({ agentId: 'a1' });

    expect(res.status).toBe(201);
    expect(res.body.triggered).toEqual(['review', 'ci', 'conflict']);
    expect(res.body.sessionId).toBeTruthy();

    expect(createSessionRun).toHaveBeenCalledTimes(1);
    const sessionArgs = createSessionRun.mock.calls[0];
    expect(sessionArgs[2]).toMatch(/^\[Resolve PR #42\]/);

    expect(handleChat).toHaveBeenCalledTimes(1);
    const chatArgs = handleChat.mock.calls[0][1];
    expect(chatArgs.agentId).toBe('a1');
    expect(chatArgs.content).toContain('TEMPLATE[review]');
    expect(chatArgs.content).toContain('TEMPLATE[ci]');
    expect(chatArgs.content).toContain('TEMPLATE[conflict]');
    expect(chatArgs.content).toContain('## PR Context');
  });

  it('returns 502 when the PR fetch fails with a non-404 error', async () => {
    const { fetchPrDetail } = await import('../pr-detail-fetch.js');
    (fetchPrDetail as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('network boom'));

    const app = await mount(
      buildDeps({
        findProject: vi.fn().mockReturnValue({ id: 'p', githubRepo: 'o/r' }),
        findAgent: vi.fn().mockReturnValue({
          project: { id: 'p' },
          agent: { id: 'a1' },
        }),
      }),
    );
    const res = await request(app).post('/api/projects/p/pulls/5/resolve').send({ agentId: 'a1' });
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/network boom/);
  });

  it('returns 404 when the PR fetch reports "not found"', async () => {
    const { fetchPrDetail } = await import('../pr-detail-fetch.js');
    (fetchPrDetail as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('HTTP 404 Not Found'));

    const app = await mount(
      buildDeps({
        findProject: vi.fn().mockReturnValue({ id: 'p', githubRepo: 'o/r' }),
        findAgent: vi.fn().mockReturnValue({
          project: { id: 'p' },
          agent: { id: 'a1' },
        }),
      }),
    );
    const res = await request(app)
      .post('/api/projects/p/pulls/999/resolve')
      .send({ agentId: 'a1' });
    expect(res.status).toBe(404);
  });
});
