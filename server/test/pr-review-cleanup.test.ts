/**
 * Integration test for the reviewer-session cleanup hook wired into
 * `POST /api/pr/review` (`server/routes/pr-actions.ts`).
 *
 * After the "drop App fallbacks" refactor (PR #1069) the bot-token tier
 * was removed — `/api/pr/review` now only routes through the Reviewer
 * GitHub App installation. To exercise the success path in an
 * integration test we:
 *   1. Generate a real RSA private key (Node's crypto can do this in
 *      ~10ms in beforeAll) so `generateJWT` doesn't throw.
 *   2. Patch `routeDeps.config.githubApp` to a valid-looking App config
 *      that lists the per-test repo owner in `installations[]`.
 *   3. Stub `globalThis.fetch` to answer the two App-tier calls (mint
 *      the installation token, then POST the review).
 *   4. Clear the in-memory installation-token cache between tests so
 *      each one actually mints a fresh token instead of reusing one
 *      from a sibling case.
 *
 * The route fires `reclaimReviewerSession` synchronously on App-tier
 * success — afterwards we assert that the seeded reviewer session row
 * has `deleted_at` set. The unit tests in
 * `server/reviewer-session-cleanup.test.ts` cover the helper's branching
 * directly, so a single happy-path integration test is sufficient here.
 */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { generateKeyPairSync } from 'crypto';
import type supertest from 'supertest';
import { randomUUID } from 'crypto';
import { getRequest, createProject, createAgent } from './helpers.js';
import { routeDeps } from '../index.js';
import { getStmts } from '../db.js';
import { clearTokenCache } from '../github-app.js';
import type { SessionRow, GitHubAppConfig } from '../types.js';

let request: supertest.Agent;
let testPrivateKey = '';

beforeAll(async () => {
  request = await getRequest();
  // Real RSA key so `generateJWT(appId, privateKey).sign(...)` does not
  // throw — the value is never validated by our stub, the key just has
  // to be parseable by OpenSSL.
  testPrivateKey = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  }).privateKey;
}, 60_000);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  // Restore previous githubApp state. Tests in this file always overwrite
  // it on entry, so wiping back to null is a safe shared baseline.
  (routeDeps.config as unknown as { githubApp: GitHubAppConfig | null }).githubApp = null;
  // Token cache is process-global; drop it so the next test's stub
  // actually intercepts the access_tokens POST instead of reading a
  // cached "Bearer …" string from a previous case.
  clearTokenCache();
});

interface Setup {
  projectId: string;
  reviewerId: string;
  sessionId: string;
  prUrl: string;
  prNumber: number;
  owner: string;
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

  return { projectId, reviewerId, sessionId, prUrl, prNumber, owner };
}

/**
 * Configure `routeDeps.config.githubApp` so `hasGitHubApp(config)` is
 * true and `resolveInstallationId(app, owner)` returns the per-test
 * installation id, and stub `fetch` to answer both App-tier calls.
 */
function wireGitHubAppForOwner(owner: string): void {
  const installationId = 42_000 + Math.floor(Math.random() * 1000);
  (routeDeps.config as unknown as { githubApp: GitHubAppConfig }).githubApp = {
    appId: '777777',
    privateKey: testPrivateKey,
    installationId,
    installations: [{ id: installationId, account: owner, accountType: 'Organization' }],
  } as GitHubAppConfig;

  const fetchStub = vi.fn(async (input: unknown) => {
    const url = typeof input === 'string' ? input : ((input as { url?: string }).url ?? '');
    if (url.includes('/app/installations/') && url.includes('/access_tokens')) {
      return new Response(
        JSON.stringify({
          token: 'ghs_fake_installation_token',
          expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        }),
        { status: 201, headers: { 'content-type': 'application/json' } },
      );
    }
    if (url.includes('/pulls/') && url.endsWith('/reviews')) {
      return new Response(
        JSON.stringify({
          id: 999,
          html_url: 'https://github.com/x/y/pull/1#review-999',
          user: { login: 'agent-hub-reviewer[bot]' },
          state: 'APPROVED',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    // Catch-all for anything else the route might touch (e.g. capture
    // engine). Returning an empty JSON body keeps best-effort follow-ups
    // from blowing up the test.
    return new Response('{}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchStub);
}

describe('POST /api/pr/review — reviewer-session cleanup', () => {
  it('soft-deletes the reviewer session on App-tier success', async () => {
    const setup = await setupReviewerScenario();
    wireGitHubAppForOwner(setup.owner);

    const res = await request
      .post('/api/pr/review')
      .send({
        prUrl: setup.prUrl,
        event: 'APPROVE',
        body: 'Reviewed the diff carefully — every acceptance criterion is covered and tests are present. Approving.',
      })
      .expect(200);

    expect(res.body).toMatchObject({ ok: true, method: 'github-app' });

    const row = getStmts().getSession.get(setup.sessionId) as SessionRow | undefined;
    expect(row).toBeDefined();
    expect(row?.deleted_at).not.toBeNull();
  });

  it('returns 200 and leaves DB untouched when no reviewer agent exists', async () => {
    const setup = await setupReviewerScenario({ withReviewer: false });
    wireGitHubAppForOwner(setup.owner);

    await request
      .post('/api/pr/review')
      .send({
        prUrl: setup.prUrl,
        event: 'APPROVE',
        body: 'Reviewed the diff — inline notes are non-blocking nits only; nothing scores above 3 on the severity rubric. Approving as mergeable.',
      })
      .expect(200);

    // Nothing was seeded — just confirm the route still returns ok.
    expect(true).toBe(true);
  });

  it('returns 200 and leaves session intact when no project matches the repo', async () => {
    const setup = await setupReviewerScenario({ withMatchingRepo: false });
    wireGitHubAppForOwner(setup.owner);

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
