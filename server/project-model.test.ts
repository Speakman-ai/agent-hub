import { getRequest } from './test/helpers.js';
import config from './config.js';
import { getDb } from './db.js';
import {
  findProject,
  getProjects,
  saveProjects,
  migrateWebhookRepoToProject,
  ensureReviewerAgents,
  ensureSkillBuilderAgents,
} from './project-model.js';
import type { Project } from './types.js';

/**
 * Insert a legacy `webhook_configs` row directly. The webhook DB layer
 * (prepared statements) was removed with the GitHub App / webhook feature
 * (PR #149); only the table itself is retained so the one-shot
 * `migrateWebhookRepoToProject` upgrade path has something to read.
 */
function insertLegacyWebhookConfig(projectId: string, repoUrl: string): void {
  getDb()
    .prepare(
      'INSERT INTO webhook_configs (project_id, repo_url, secret, events, enabled, author_allowlist) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(projectId, repoUrl, 'secret', '["pull_request.opened"]', 1, '[]');
}

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
  it('sets githubRepo on a project from a legacy webhook config repo_url', async () => {
    const request = await getRequest();
    const projId = `migrate-test-${Date.now()}`;
    createdProjectIds.push(projId);
    await (
      request as {
        post(url: string): {
          send(body: Record<string, unknown>): { expect(code: number): Promise<unknown> };
        };
      }
    )
      .post('/api/projects')
      .send({ id: projId, name: 'Migrate Test', cwd: '/tmp', color: '#000' })
      .expect(201);

    const project = findProject(projId);
    expect(project).toBeTruthy();
    expect(project!.githubRepo).toBeUndefined();

    insertLegacyWebhookConfig(projId, 'https://github.com/test-org/test-repo');
    migrateWebhookRepoToProject();

    expect(findProject(projId)!.githubRepo).toBe('test-org/test-repo');
  });

  it('does not overwrite an existing githubRepo', async () => {
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

    insertLegacyWebhookConfig(projId, 'https://github.com/other-org/other-repo');
    migrateWebhookRepoToProject();

    expect(findProject(projId)!.githubRepo).toBe('existing/repo');
  });

  it('captures only owner/repo, ignoring trailing path segments', async () => {
    const request = await getRequest();
    const projId = `migrate-trailing-${Date.now()}`;
    createdProjectIds.push(projId);
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

    insertLegacyWebhookConfig(projId, 'https://github.com/some-org/some-repo/tree/main/extra');
    migrateWebhookRepoToProject();

    expect(findProject(projId)!.githubRepo).toBe('some-org/some-repo');
  });

  it('normalizes clone-style URLs to owner/repo, stripping a trailing .git', async () => {
    // Regression: clone URLs (HTTPS .git and SSH scp-style) must migrate to a
    // normalized owner/repo. Leaving ".git" attached (acme/widgets.git) breaks
    // downstream GitHub calls and the project UI, which expect owner/repo.
    const cases: Array<{ label: string; url: string; expected: string }> = [
      { label: 'https-git', url: 'https://github.com/acme/widgets.git', expected: 'acme/widgets' },
      { label: 'ssh-git', url: 'git@github.com:acme/widgets.git', expected: 'acme/widgets' },
      { label: 'ssh-plain', url: 'git@github.com:acme/widgets', expected: 'acme/widgets' },
      {
        label: 'https-git-trailing-slash',
        url: 'https://github.com/acme/widgets.git/',
        expected: 'acme/widgets',
      },
    ];

    const request = await getRequest();
    for (const c of cases) {
      const projId = `migrate-clone-${c.label}-${Date.now()}`;
      createdProjectIds.push(projId);
      await (
        request as {
          post(url: string): {
            send(body: Record<string, unknown>): { expect(code: number): Promise<unknown> };
          };
        }
      )
        .post('/api/projects')
        .send({ id: projId, name: `Clone ${c.label}`, cwd: '/tmp', color: '#333' })
        .expect(201);

      insertLegacyWebhookConfig(projId, c.url);
      migrateWebhookRepoToProject();

      expect(findProject(projId)!.githubRepo, `${c.label} (${c.url})`).toBe(c.expected);
    }
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

  it('does NOT seed a reviewer when project has no githubRepo and is not hosted', async () => {
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

describe('ensureSkillBuilderAgents', () => {
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

  it('seeds a Skill Builder coach scoped to the skill-creator skill', async () => {
    const projId = `skillbuilder-seed-${Date.now()}`;
    await createProjectWithAgent(projId, 'Skill Builder Seed', '#abc');

    ensureSkillBuilderAgents(projId);

    const updated = findProject(projId);
    const builder = updated!.agents?.find((a) => a.role === 'skill-builder');
    expect(builder).toBeTruthy();
    expect(builder!.id).toBe(`${projId}-skill-builder`);
    expect(builder!.name).toBe('Skill Builder');
    // Allowlisted to the coach skill (+ core) so its prompt stays focused.
    expect(builder!.allowedSkills).toContain('skill-creator');
    // System prompt encodes the coach contract: load the skill, push trigger
    // descriptions, save via the write API.
    const sp = builder!.systemPrompt || '';
    expect(sp).toContain('skill-creator');
    expect(sp).toContain(`/api/projects/${projId}/skills`);
  });

  it('does NOT seed a builder for an agentless project', async () => {
    const projId = `skillbuilder-noseed-${Date.now()}`;
    const request = await getRequest();
    await (
      request as {
        post(url: string): {
          send(body: Record<string, unknown>): { expect(code: number): Promise<unknown> };
        };
      }
    )
      .post('/api/projects')
      .send({ id: projId, name: 'Agentless', cwd: '/tmp', color: '#def' })
      .expect(201);
    createdProjectIds.push(projId);
    // Strip any auto-seeded agents so the roster is empty.
    const project = findProject(projId)!;
    project.agents = [];
    saveProjects();

    ensureSkillBuilderAgents(projId);

    const updated = findProject(projId);
    expect(updated!.agents?.some((a) => a.role === 'skill-builder')).toBe(false);
  });

  it('is idempotent — calling twice does not duplicate the builder', async () => {
    const projId = `skillbuilder-idem-${Date.now()}`;
    await createProjectWithAgent(projId, 'Idempotent Builder', '#fed');

    ensureSkillBuilderAgents(projId);
    ensureSkillBuilderAgents(projId);

    const updated = findProject(projId);
    const builders = (updated!.agents || []).filter((a) => a.role === 'skill-builder');
    expect(builders).toHaveLength(1);
  });

  it('is creation-scoped — seeding one project does NOT backfill others', async () => {
    // Regression guard for the reviewer's backfill concern: the iterate-all
    // shape of the sibling ensure-* helpers would mass-seed this new agent
    // role into every existing project on the next create. The creation path
    // passes a projectId, which must confine the seed to that one project.
    const otherId = `skillbuilder-other-${Date.now()}`;
    await createProjectWithAgent(otherId, 'Pre-existing Project', '#0ad');
    const newId = `skillbuilder-new-${Date.now()}`;
    await createProjectWithAgent(newId, 'Newly Created Project', '#0da');

    // Model a genuinely "pre-existing" project (one that predates this
    // feature) without depending on whether the create route auto-seeds a
    // builder: strip any skill-builder rows from BOTH projects and pin the
    // clean precondition. The explicit scoped call below is then the only
    // thing that can seed a builder, so the test can't be masked by
    // creation-path seeding.
    for (const id of [otherId, newId]) {
      const p = findProject(id)!;
      p.agents = (p.agents || []).filter((a) => a.role !== 'skill-builder');
    }
    saveProjects();
    expect(findProject(otherId)!.agents?.some((a) => a.role === 'skill-builder')).toBe(false);
    expect(findProject(newId)!.agents?.some((a) => a.role === 'skill-builder')).toBe(false);

    // Seed only the freshly-created project.
    ensureSkillBuilderAgents(newId);

    expect(findProject(newId)!.agents?.some((a) => a.role === 'skill-builder')).toBe(true);
    // The pre-existing project must be untouched — no backfill.
    expect(findProject(otherId)!.agents?.some((a) => a.role === 'skill-builder')).toBe(false);
  });

  it('backfills ALL existing projects with agents when called with no projectId', async () => {
    // Regression for the one-time backfill migration: the no-arg / iterate-all
    // shape must seed a coach into EVERY project that has agents but lacks one,
    // which is what gives pre-feature projects the web "Build a skill" button.
    const aId = `skillbuilder-backfill-a-${Date.now()}`;
    const bId = `skillbuilder-backfill-b-${Date.now()}`;
    await createProjectWithAgent(aId, 'Backfill A', '#a1a');
    await createProjectWithAgent(bId, 'Backfill B', '#b2b');

    // Model two pre-feature projects: agents present, but no builder yet.
    for (const id of [aId, bId]) {
      const p = findProject(id)!;
      p.agents = (p.agents || []).filter((agent) => agent.role !== 'skill-builder');
    }
    saveProjects();
    expect(findProject(aId)!.agents?.some((a) => a.role === 'skill-builder')).toBe(false);
    expect(findProject(bId)!.agents?.some((a) => a.role === 'skill-builder')).toBe(false);

    // No projectId → backfill every loaded project.
    ensureSkillBuilderAgents();

    expect(findProject(aId)!.agents?.some((a) => a.role === 'skill-builder')).toBe(true);
    expect(findProject(bId)!.agents?.some((a) => a.role === 'skill-builder')).toBe(true);
  });

  it('backfill leaves an agentless project without a builder', async () => {
    // The iterate-all backfill must not invent a roster for an empty project;
    // a coach with no project agents to assist makes no sense.
    const emptyId = `skillbuilder-backfill-empty-${Date.now()}`;
    const request = await getRequest();
    await (
      request as {
        post(url: string): {
          send(body: Record<string, unknown>): { expect(code: number): Promise<unknown> };
        };
      }
    )
      .post('/api/projects')
      .send({ id: emptyId, name: 'Backfill Empty', cwd: '/tmp', color: '#ccc' })
      .expect(201);
    createdProjectIds.push(emptyId);
    const project = findProject(emptyId)!;
    project.agents = [];
    saveProjects();

    ensureSkillBuilderAgents();

    expect(findProject(emptyId)!.agents?.some((a) => a.role === 'skill-builder')).toBe(false);
  });
});
