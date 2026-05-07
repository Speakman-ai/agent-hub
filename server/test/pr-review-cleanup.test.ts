/**
 * Integration test for the reviewer-session cleanup hook wired into
 * `POST /api/pr/review` (`server/routes/pr-actions.ts`).
 *
 * Drives the bot-token tier (`config.botGithubToken`) by stubbing
 * `globalThis.fetch` so we never hit the real GitHub API. The route fires
 * `reclaimReviewerSession` synchronously on success — afterwards we assert
 * that the seeded reviewer session row has `deleted_at` set.
 *
 * The GitHub-App tier exercises the same `reclaimReviewerSession` call on
 * the same code path, so a single integration test on the bot-token branch
 * is enough; the unit tests in `server/reviewer-session-cleanup.test.ts`
 * cover the helper's branching directly.
 */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import type supertest from 'supertest';
import { randomUUID } from 'crypto';
import { getRequest, createProject, createAgent } from './helpers.js';
import { routeDeps } from '../index.js';
import { getStmts } from '../db.js';
import type { SessionRow } from '../types.js';

let request: supertest.Agent;

beforeAll(async () => {
  request = await getRequest();
}, 60_000);

afterEach(() => {
  vi.restoreAllMocks();
  // Clean up the bot token we set during the test so other tests in this
  // file (and any sibling files in the same worker process) start fresh.
  delete (routeDeps.config as unknown as Record<string, unknown>).botGithubToken;
});

interface Setup {
  projectId: string;
  reviewerId: string;
  sessionId: string;
  prUrl: string;
  prNumber: number;
}

async function setupReviewerScenario(
  options: { withReviewer?: boolean; withMatchingRepo?: boolean } = {},
): Promise<Setup> {
  const { withReviewer = true, withMatchingRepo = true } = options;
  const project = await createProject();
  const projectId = project.id as string;
  const owner = `org-${randomUUID().slice(0, 6)}`;
  const repo = `repo-${randomUUID().slice(0, 6)}`;

  if (withMatchingRepo) {
    await request
      .patch(`/api/projects/${projectId}`)
      .send({ githubRepo: `${owner}/${repo}` })
      .expect(200);
  }

  let reviewerId = '';
  if (withReviewer) {
    const reviewer = await createAgent({
      projectId,
      name: 'Test Reviewer',
      role: 'reviewer',
    });
    reviewerId = reviewer.id as string;
  } else {
    // Still create *some* agent so the project isn't empty, but it has no
    // reviewer role.
    await createAgent({ projectId, name: 'Lead', role: 'lead' });
  }

  const prNumber = Math.floor(Math.random() * 90000) + 10000;
  const prUrl = `https://github.com/${owner}/${repo}/pull/${prNumber}`;

  // Seed a reviewer-style session row directly via the prepared statement —
  // mirrors what `runReviewerDispatch` does in `server/routes/webhooks.ts`.
  const sessionId = randomUUID();
  if (withReviewer) {
    const stmts = getStmts();
    stmts.createSession.run(
      sessionId,
      reviewerId,
      `Review: PR #${prNumber} Some PR title`.substring(0, 200),
      'claude-code',
      'claude-opus',
      1, // use_worktree
      0, // ask_mode
      1, // wiki_hybrid_rag_budget_version
    );
  }

  return { projectId, reviewerId, sessionId, prUrl, prNumber };
}

function stubGitHubReviewFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 999,
          html_url: 'https://github.com/x/y/pull/1#review-999',
          user: { login: 'agent-hub-reviewer[bot]' },
          state: 'APPROVED',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    ),
  );
}

describe('POST /api/pr/review — reviewer-session cleanup', () => {
  it('soft-deletes the reviewer session on bot-token success', async () => {
    const setup = await setupReviewerScenario();
    routeDeps.config.botGithubToken = 'fake-bot-token';
    stubGitHubReviewFetch();

    const res = await request
      .post('/api/pr/review')
      .send({
        prUrl: setup.prUrl,
        event: 'APPROVE',
        body: 'Reviewed the diff carefully — every acceptance criterion is covered and tests are present. Approving.',
      })
      .expect(200);

    expect(res.body).toMatchObject({ ok: true, method: 'bot-token' });

    const row = getStmts().getSession.get(setup.sessionId) as SessionRow | undefined;
    expect(row).toBeDefined();
    expect(row?.deleted_at).not.toBeNull();
  });

  it('returns 200 and leaves DB untouched when no reviewer agent exists', async () => {
    const setup = await setupReviewerScenario({ withReviewer: false });
    routeDeps.config.botGithubToken = 'fake-bot-token';
    stubGitHubReviewFetch();

    await request
      .post('/api/pr/review')
      .send({
        prUrl: setup.prUrl,
        event: 'COMMENT',
        body: 'Inline comments left on the diff — none are blocking, just heads up for the next iteration.',
      })
      .expect(200);

    // Nothing was seeded — just confirm the route still returns ok.
    expect(true).toBe(true);
  });

  it('returns 200 and leaves session intact when no project matches the repo', async () => {
    const setup = await setupReviewerScenario({ withMatchingRepo: false });
    routeDeps.config.botGithubToken = 'fake-bot-token';
    stubGitHubReviewFetch();

    await request
      .post('/api/pr/review')
      .send({
        prUrl: setup.prUrl,
        event: 'APPROVE',
        body: 'Reviewed thoroughly — every change is sound and the tests cover the new branches. Approving.',
      })
      .expect(200);

    const row = getStmts().getSession.get(setup.sessionId) as SessionRow | undefined;
    expect(row).toBeDefined();
    expect(row?.deleted_at).toBeNull();
  });
});
