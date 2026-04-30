import type supertest from 'supertest';
import { getRequest, createProject, createCard } from './helpers.js';

// ═══════════════════════════════════════════════════════════════════
// PUT /api/projects/:projectId/board/cards/:cardId — pr_base_branch
// override field. Cards may target a non-default base branch (e.g. for
// stacked / dependent PRs). The auto-PR flow reads this column when
// opening the PR; the route accepts both camelCase and snake_case keys.
// ═══════════════════════════════════════════════════════════════════

let request: supertest.Agent;
let projectId: string;

beforeAll(async () => {
  request = await getRequest();
  const project = await createProject();
  projectId = project.id as string;
});

describe('Card PR base-branch override', () => {
  it('persists pr_base_branch via camelCase (prBaseBranch)', async () => {
    const card = await createCard(projectId);
    const res = await request
      .put(`/api/projects/${projectId}/board/cards/${card.id}`)
      .send({ prBaseBranch: 'feature/parent-branch' })
      .expect(200);
    expect((res.body as { pr_base_branch: unknown }).pr_base_branch).toBe('feature/parent-branch');
  });

  it('persists pr_base_branch via snake_case (pr_base_branch)', async () => {
    const card = await createCard(projectId);
    const res = await request
      .put(`/api/projects/${projectId}/board/cards/${card.id}`)
      .send({ pr_base_branch: 'release/v2' })
      .expect(200);
    expect((res.body as { pr_base_branch: unknown }).pr_base_branch).toBe('release/v2');
  });

  it('clears pr_base_branch when null is passed', async () => {
    const card = await createCard(projectId);
    await request
      .put(`/api/projects/${projectId}/board/cards/${card.id}`)
      .send({ prBaseBranch: 'feature/temp' })
      .expect(200);
    const res = await request
      .put(`/api/projects/${projectId}/board/cards/${card.id}`)
      .send({ prBaseBranch: null })
      .expect(200);
    expect((res.body as { pr_base_branch: unknown }).pr_base_branch).toBeNull();
  });

  it('clears pr_base_branch when an empty string is passed', async () => {
    const card = await createCard(projectId);
    await request
      .put(`/api/projects/${projectId}/board/cards/${card.id}`)
      .send({ prBaseBranch: 'feature/temp' })
      .expect(200);
    const res = await request
      .put(`/api/projects/${projectId}/board/cards/${card.id}`)
      .send({ pr_base_branch: '' })
      .expect(200);
    expect((res.body as { pr_base_branch: unknown }).pr_base_branch).toBeNull();
  });

  it('preserves pr_base_branch when the field is omitted', async () => {
    const card = await createCard(projectId);
    await request
      .put(`/api/projects/${projectId}/board/cards/${card.id}`)
      .send({ prBaseBranch: 'feature/keep-me' })
      .expect(200);
    const res = await request
      .put(`/api/projects/${projectId}/board/cards/${card.id}`)
      .send({ title: 'unrelated update' })
      .expect(200);
    expect((res.body as { pr_base_branch: unknown }).pr_base_branch).toBe('feature/keep-me');
  });

  it('rejects pr_base_branch with shell-injection characters', async () => {
    const card = await createCard(projectId);
    const res = await request
      .put(`/api/projects/${projectId}/board/cards/${card.id}`)
      .send({ prBaseBranch: 'main; rm -rf /' })
      .expect(400);
    expect((res.body as { error: string }).error).toMatch(/Invalid pr_base_branch/);
  });

  it('rejects pr_base_branch containing spaces', async () => {
    const card = await createCard(projectId);
    await request
      .put(`/api/projects/${projectId}/board/cards/${card.id}`)
      .send({ prBaseBranch: 'feature with space' })
      .expect(400);
  });

  it('accepts standard branch name characters (slashes, dashes, dots)', async () => {
    const card = await createCard(projectId);
    const res = await request
      .put(`/api/projects/${projectId}/board/cards/${card.id}`)
      .send({ prBaseBranch: 'release/v1.2.3-rc.1' })
      .expect(200);
    expect((res.body as { pr_base_branch: unknown }).pr_base_branch).toBe('release/v1.2.3-rc.1');
  });

  it('camelCase takes precedence when both keys are provided', async () => {
    const card = await createCard(projectId);
    const res = await request
      .put(`/api/projects/${projectId}/board/cards/${card.id}`)
      .send({ prBaseBranch: 'feature/win', pr_base_branch: 'feature/lose' })
      .expect(200);
    expect((res.body as { pr_base_branch: unknown }).pr_base_branch).toBe('feature/win');
  });
});
