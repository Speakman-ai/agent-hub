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
    );

    migrateWebhookRepoToProject();

    const updated = findProject(projId);
    expect(updated!.githubRepo).toBe('existing/repo');
  });

  it('auto-created webhook config uses object format for events', async () => {
    const request = await getRequest();

    const projId = `auto-webhook-${Date.now()}`;
    await (
      request as {
        post(url: string): {
          send(body: Record<string, unknown>): { expect(code: number): Promise<unknown> };
        };
      }
    )
      .post('/api/projects')
      .send({ id: projId, name: 'Auto Webhook Test', cwd: '/tmp', color: '#333' })
      .expect(201);

    await (
      request as { patch(url: string): { send(body: Record<string, unknown>): Promise<unknown> } }
    )
      .patch(`/api/projects/${projId}`)
      .send({ githubRepo: 'test-org/auto-repo' });

    const wh = (stmts as Stmts).getWebhookConfigByProjectAndRepo.get(
      projId,
      'https://github.com/test-org/auto-repo',
    ) as { events: string } | undefined;
    expect(wh).toBeTruthy();

    const events = JSON.parse(wh!.events) as Record<string, { enabled: boolean }>;
    expect(events).toBeTypeOf('object');
    expect(Array.isArray(events)).toBe(false);
    expect(events['pull_request.opened']).toEqual({ enabled: true });
    expect(events['pull_request_review.submitted']).toEqual({ enabled: true });
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
    );

    ensureReviewerAgents();

    const updated = findProject(projId);
    expect(updated!.agents?.some((a) => a.role === 'reviewer')).toBe(true);
  });

  it('seeds a reviewer whose system prompt has a balanced decision tree (no APPROVE- or COMMENT-bias)', async () => {
    // Regression guard: the seeded system prompt has now swung through two
    // biases. V1 hardcoded `"event":"APPROVE"` + "skip nits unless egregious",
    // producing rubber-stamped reviews. V2 (PR #291) over-corrected and told
    // the reviewer COMMENT was the default for any non-nit feedback, producing
    // reviews that never reach APPROVE. V3 (this test) pins a decision-tree
    // contract: walk in order, REQUEST_CHANGES → APPROVE → COMMENT, where
    // non-blocking feedback lives under APPROVE and COMMENT is reserved for
    // genuinely undecided reviews.
    const projId = `reviewer-nobias-${Date.now()}`;
    const project = await createProjectWithAgent(projId, 'No Bias Reviewer', '#888');
    project.githubRepo = 'owner/nobias-repo';
    saveProjects();

    ensureReviewerAgents();

    const updated = findProject(projId);
    const reviewer = updated!.agents?.find((a) => a.role === 'reviewer');
    expect(reviewer).toBeTruthy();
    const sp = reviewer!.systemPrompt || '';

    // No hardcoded APPROVE in the curl example — the example must use a
    // placeholder so the model doesn't anchor on any one event as the default.
    expect(sp).not.toContain('"event":"APPROVE"');
    expect(sp).toContain('"event":"<EVENT>"');

    // All three events must be presented, not just APPROVE.
    expect(sp).toContain('APPROVE');
    expect(sp).toContain('COMMENT');
    expect(sp).toContain('REQUEST_CHANGES');

    // The prompt must present a decision TREE (walk in order) rather than a
    // flat rubric — the flat rubric is what caused the reviewer to pick
    // whichever event felt least committal (COMMENT).
    expect(sp).toMatch(/decision tree/i);

    // Blocking vs. non-blocking classification is the hinge of the tree.
    expect(sp).toMatch(/blocking/i);
    expect(sp).toMatch(/non-blocking/i);

    // APPROVE must be scoped to "mergeable as-is", explicitly compatible
    // with non-blocking feedback — the wording that was missing during the
    // COMMENT-bias regression.
    expect(sp).toMatch(/mergeable as-is/i);

    // Both anti-patterns must be explicitly named so neither bias recurs.
    expect(sp).toMatch(/don't over-correct/i);
    expect(sp).toMatch(/don't rubber-stamp/i);

    // COMMENT must NOT be described as "the default" — that phrasing is what
    // caused the swing from APPROVE-bias to COMMENT-bias in PR #291/292.
    // Use a tight proximity check so discouragement phrasings (e.g. "Defaulting
    // … to COMMENT destroys the signal") don't false-positive.
    expect(sp).not.toMatch(/\bdefault\b[^.]{0,40}\bCOMMENT\b/i);
    expect(sp).not.toMatch(/\bCOMMENT\b[^.]{0,40}\bis the default\b/i);

    // The old "skip nits unless egregious" line was a subtle approval nudge
    // that should stay gone.
    expect(sp).not.toMatch(/Skip nits unless egregious/);
  });
});
