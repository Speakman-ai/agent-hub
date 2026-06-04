import { getRequest } from './test/helpers.js';
import config from './config.js';
import { stmts } from './db.js';
import {
  migrateWebhookRepoToProject,
  findProject,
  getProjects,
  saveProjects,
  ensureReviewerAgents,
} from './project-model.js';
import type { Stmts, Project } from './types.js';

let originalApiKey: string | null;
const createdProjectIds: string[] = [];

beforeAll(async () => {
  await getRequest();
  originalApiKey = config.apiKey;
  config.apiKey = null;
});

afterAll(async () => {
  const request = await getRequest();
  for (const id of createdProjectIds) {
    await (request as { delete(url: string): Promise<unknown> })
      .delete(`/api/projects/${id}`)
      .catch(() => {});
  }
  config.apiKey = originalApiKey;
});

describe('migrateWebhookRepoToProject', () => {
  it('sets githubRepo on a project from webhook config repo_url', async () => {
    const request = await getRequest();

    const projId = `migrate-test-${Date.now()}`;
    createdProjectIds.push(projId);
    const res = await (
      request as {
        post(url: string): {
          send(body: Record<string, unknown>): {
            expect(code: number): Promise<{ body: Record<string, unknown> }>;
          };
        };
      }
    )
      .post('/api/projects')
      .send({ id: projId, name: 'Migrate Test', cwd: '/tmp', color: '#000' })
      .expect(201);

    const project = findProject(projId);
    expect(project).toBeTruthy();
    expect(project!.githubRepo).toBeUndefined();

    (stmts as Stmts).createWebhookConfig.run(
      projId,
      'https://github.com/test-org/test-repo',
      'secret123',
      '["pull_request.opened"]',
      1,
      '[]',
    );

    migrateWebhookRepoToProject();

    const updated = findProject(projId);
    expect(updated!.githubRepo).toBe('test-org/test-repo');
  });

  it('does not overwrite existing githubRepo', async () => {
    const request = await getRequest();

    const projId = `migrate-noop-${Date.now()}`;
    createdProjectIds.push(projId);
    await (
      request as {
        post(url: string): {
          send(body: Record<string, unknown>): { expect(code: number): Promise<unknown> };
        };
      }
    )
      .post('/api/projects')
      .send({ id: projId, name: 'No Overwrite Test', cwd: '/tmp', color: '#111' })
      .expect(201);

    const project = findProject(projId);
    project!.githubRepo = 'existing/repo';
    saveProjects();

    (stmts as Stmts).createWebhookConfig.run(
      projId,
      'https://github.com/other-org/other-repo',
      'secret456',
      '["push"]',
      1,
      '[]',
    );

    migrateWebhookRepoToProject();

    const updated = findProject(projId);
    expect(updated!.githubRepo).toBe('existing/repo');
  });

  it('only captures owner/repo, ignoring trailing path segments', async () => {
    const request = await getRequest();

    const projId = `migrate-trailing-${Date.now()}`;
    await (
      request as {
        post(url: string): {
          send(body: Record<string, unknown>): { expect(code: number): Promise<unknown> };
        };
      }
    )
      .post('/api/projects')
      .send({ id: projId, name: 'Trailing Path Test', cwd: '/tmp', color: '#222' })
      .expect(201);

    (stmts as Stmts).createWebhookConfig.run(
      projId,
      'https://github.com/some-org/some-repo/tree/main/extra',
      'secret789',
      '["push"]',
      1,
      '[]',
    );

    migrateWebhookRepoToProject();

    const updated = findProject(projId);
    expect(updated!.githubRepo).toBe('some-org/some-repo');
  });
});

describe('ensureReviewerAgents', () => {
  /**
   * Helper to create a project and seed a single dummy agent on it (the
   * ensure-* functions short-circuit on agentless projects, matching the
   * behaviour of ensureDocsAgents/ensureIntakeAgents).
   */
  async function createProjectWithAgent(
    projId: string,
    name: string,
    color: string,
  ): Promise<Project> {
    const request = await getRequest();
    await (
      request as {
        post(url: string): {
          send(body: Record<string, unknown>): { expect(code: number): Promise<unknown> };
        };
      }
    )
      .post('/api/projects')
      .send({ id: projId, name, cwd: '/tmp', color })
      .expect(201);
    createdProjectIds.push(projId);

    const project = findProject(projId)!;
    project.agents = project.agents || [];
    project.agents.push({
      id: `${projId}-dev`,
      name: 'Dev',
      role: 'sub',
      engine: 'claude-code',
    });
    saveProjects();
    return project;
  }

  it('seeds a reviewer agent when project has githubRepo', async () => {
    const projId = `reviewer-seed-${Date.now()}`;
    const project = await createProjectWithAgent(projId, 'Reviewer Seed Test', '#444');
    expect(project.agents?.some((a) => a.role === 'reviewer')).toBe(false);

    project.githubRepo = 'owner/seed-repo';
    saveProjects();

    ensureReviewerAgents();

    const updated = findProject(projId);
    const reviewer = updated!.agents?.find((a) => a.role === 'reviewer');
    expect(reviewer).toBeTruthy();
    expect(reviewer!.id).toBe(`${projId}-reviewer`);
    expect(reviewer!.canReview).toBe(true);
  });

  it('does NOT seed a reviewer when project has neither githubRepo nor enabled webhook', async () => {
    const projId = `reviewer-noseed-${Date.now()}`;
    await createProjectWithAgent(projId, 'No Reviewer Seed', '#555');

    ensureReviewerAgents();

    const updated = findProject(projId);
    expect(updated!.agents?.some((a) => a.role === 'reviewer')).toBe(false);
  });

  it('is idempotent — calling twice does not duplicate the reviewer', async () => {
    const projId = `reviewer-idem-${Date.now()}`;
    const project = await createProjectWithAgent(projId, 'Idempotent Reviewer', '#666');
    project.githubRepo = 'owner/idem-repo';
    saveProjects();

    ensureReviewerAgents();
    ensureReviewerAgents();

    const updated = findProject(projId);
    const reviewers = (updated!.agents || []).filter((a) => a.role === 'reviewer');
    expect(reviewers).toHaveLength(1);
  });

  it('seeds reviewer when project has an enabled webhook config but no githubRepo', async () => {
    const projId = `reviewer-webhook-${Date.now()}`;
    await createProjectWithAgent(projId, 'Webhook Only Reviewer', '#777');

    (stmts as Stmts).createWebhookConfig.run(
      projId,
      'https://github.com/whonly/repo',
      'sec',
      '["pull_request.opened"]',
      1,
      '[]',
    );

    ensureReviewerAgents();

    const updated = findProject(projId);
    expect(updated!.agents?.some((a) => a.role === 'reviewer')).toBe(true);
  });

  it('seeds a reviewer whose system prompt has a balanced decision tree (no approve-bias) and an in-session verdict contract', async () => {
    // Regression guard: the seeded system prompt has swung through several
    // biases. V1 hardcoded approval + "skip nits unless egregious". Later
    // revisions used a `POST /api/pr/review` event contract. The reviewer is
    // now an in-session advisor: it emits a structured `<agenthub:review-verdict>`
    // tail block (approved / changes_requested), never posting to GitHub.
    // This test pins the decision-tree contract: severity-driven, no
    // rubber-stamp, and the in-session verdict mechanism (no curl / no
    // /api/pr/review).
    const projId = `reviewer-nobias-${Date.now()}`;
    const project = await createProjectWithAgent(projId, 'No Bias Reviewer', '#888');
    project.githubRepo = 'owner/nobias-repo';
    saveProjects();

    ensureReviewerAgents();

    const updated = findProject(projId);
    const reviewer = updated!.agents?.find((a) => a.role === 'reviewer');
    expect(reviewer).toBeTruthy();
    const sp = reviewer!.systemPrompt || '';

    // The verdict is emitted in-session via the structured tail block — there
    // is no GitHub posting path anymore.
    expect(sp).toContain('<agenthub:review-verdict>');
    expect(sp).toContain('"verdict"');
    expect(sp).toContain('approved');
    expect(sp).toContain('changes_requested');
    expect(sp).not.toContain('/api/pr/review');

    // The prompt must present a decision TREE (walk in order) rather than a
    // flat rubric — the flat rubric is what caused the reviewer to pick
    // whichever verdict felt least committal.
    expect(sp).toMatch(/decision tree/i);

    // Blocking vs. non-blocking classification is the hinge of the tree.
    expect(sp).toMatch(/blocking/i);
    expect(sp).toMatch(/non-blocking/i);

    // "approved" must be scoped to "mergeable as-is", explicitly compatible
    // with non-blocking feedback.
    expect(sp).toMatch(/mergeable as-is/i);

    expect(sp).toMatch(/don't rubber-stamp/i);

    // The old "skip nits unless egregious" line was a subtle approval nudge
    // that should stay gone.
    expect(sp).not.toMatch(/Skip nits unless egregious/);
  });

  it('seeds a reviewer whose system prompt requires a 1–10 severity score and blocks on >3', async () => {
    // Regression guard: the reviewer kept letting real issues slip under an
    // APPROVE because "blocking vs non-blocking" was a judgment call with no
    // calibration. The 1–10 rubric anchors the judgment, and the hard
    // ">3 → REQUEST_CHANGES" rule removes the escape hatch.
    const projId = `reviewer-severity-${Date.now()}`;
    const project = await createProjectWithAgent(projId, 'Severity Reviewer', '#0EA5E9');
    project.githubRepo = 'owner/severity-repo';
    saveProjects();

    ensureReviewerAgents();

    const updated = findProject(projId);
    const reviewer = updated!.agents?.find((a) => a.role === 'reviewer');
    expect(reviewer).toBeTruthy();
    const sp = reviewer!.systemPrompt || '';

    // Rubric must be presented as a 1–10 scale.
    expect(sp).toMatch(/severity (score|rubric)/i);
    expect(sp).toMatch(/1\s*[–-]\s*10/);

    // All six calibration bands present.
    expect(sp).toMatch(/\b1\s*[–-]\s*2\b/);
    expect(sp).toMatch(/\b3\b/);
    expect(sp).toMatch(/\b4\s*[–-]\s*5\b/);
    expect(sp).toMatch(/\b6\s*[–-]\s*7\b/);
    expect(sp).toMatch(/\b8\s*[–-]\s*9\b/);
    expect(sp).toMatch(/\b10\b/);

    // Hard threshold: >3 forces a changes_requested verdict.
    expect(sp).toMatch(/>\s*3/);
    expect(sp).toMatch(/changes_requested/);

    // Tie-break rule prevents under-scoring as an escape hatch.
    expect(sp).toMatch(/round up/i);

    // Decision tree must branch on the score, not on vibes.
    expect(sp).toMatch(/score\b[^.]*\b(greater than|>)\s*3/i);
  });

  // Regression guard: the function must report whether it changed anything so
  // route handlers can decide whether to broadcast `projects_updated` to
  // WebSocket clients. If this returns void again, the broadcast wiring
  // in server/routes/config.ts silently no-ops and the sidebar never refreshes.
  it('returns true when a reviewer is seeded', async () => {
    const projId = `reviewer-ret-true-${Date.now()}`;
    const project = await createProjectWithAgent(projId, 'Return True Reviewer', '#111');
    project.githubRepo = 'owner/ret-true-repo';
    saveProjects();

    const changed = ensureReviewerAgents();
    expect(changed).toBe(true);
  });

  it('returns false when no reviewer needs to be seeded', async () => {
    const projId = `reviewer-ret-false-${Date.now()}`;
    const project = await createProjectWithAgent(projId, 'Return False Reviewer', '#222');
    project.githubRepo = 'owner/ret-false-repo';
    saveProjects();

    // First call seeds the reviewer.
    expect(ensureReviewerAgents()).toBe(true);
    // Second call is a no-op — idempotent and must report no change so
    // callers don't emit a spurious `projects_updated` broadcast.
    expect(ensureReviewerAgents()).toBe(false);
  });

  it('returns false when project has no GitHub integration', async () => {
    const projId = `reviewer-ret-nogh-${Date.now()}`;
    await createProjectWithAgent(projId, 'No GitHub Reviewer', '#333');
    // No githubRepo → nothing to seed.
    expect(ensureReviewerAgents()).toBe(false);
  });
});
