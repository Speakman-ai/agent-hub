import type supertest from 'supertest';
import { getRequest, createProject, createCard } from './helpers.js';

let request: supertest.Agent;
let projectId: string;

beforeAll(async () => {
  request = await getRequest();
  const project = await createProject();
  projectId = project.id as string;
});

// ═══════════════════════════════════════════════════════════════════
// PR URL linking — snake_case and camelCase field acceptance
// ═══════════════════════════════════════════════════════════════════

describe('Card PR URL linking', () => {
  it('links pr_url via camelCase (prUrl)', async () => {
    const card = await createCard(projectId);
    const res = await request
      .put(`/api/projects/${projectId}/board/cards/${card.id}`)
      .send({ prUrl: 'https://github.com/org/repo/pull/1' })
      .expect(200);
    expect(res.body.pr_url).toBe('https://github.com/org/repo/pull/1');
  });

  it('links pr_url via snake_case (pr_url)', async () => {
    const card = await createCard(projectId);
    const res = await request
      .put(`/api/projects/${projectId}/board/cards/${card.id}`)
      .send({ pr_url: 'https://github.com/org/repo/pull/2' })
      .expect(200);
    expect(res.body.pr_url).toBe('https://github.com/org/repo/pull/2');
  });

  it('camelCase takes precedence when both are provided', async () => {
    const card = await createCard(projectId);
    const res = await request
      .put(`/api/projects/${projectId}/board/cards/${card.id}`)
      .send({
        prUrl: 'https://github.com/org/repo/pull/3',
        pr_url: 'https://github.com/org/repo/pull/999',
      })
      .expect(200);
    expect(res.body.pr_url).toBe('https://github.com/org/repo/pull/3');
  });

  it('preserves existing pr_url when neither field is sent', async () => {
    const card = await createCard(projectId);
    // First, set the pr_url
    await request
      .put(`/api/projects/${projectId}/board/cards/${card.id}`)
      .send({ prUrl: 'https://github.com/org/repo/pull/4' })
      .expect(200);
    // Now update only the title — pr_url should be preserved
    const res = await request
      .put(`/api/projects/${projectId}/board/cards/${card.id}`)
      .send({ title: 'Updated title' })
      .expect(200);
    expect(res.body.pr_url).toBe('https://github.com/org/repo/pull/4');
    expect(res.body.title).toBe('Updated title');
  });

  it('accepts snake_case fields on card creation (column_id, session_id)', async () => {
    const boardRes = await request.get(`/api/projects/${projectId}/board`).expect(200);
    const columns = (boardRes.body as { columns: Array<{ id: string }> }).columns;
    const columnId = columns[0].id;

    const res = await request
      .post(`/api/projects/${projectId}/board/cards`)
      .send({
        title: 'Snake case test',
        column_id: columnId,
        session_id: 'test-session-123',
        github_issue_url: 'https://github.com/org/repo/issues/1',
      })
      .expect(200);
    expect(res.body.title).toBe('Snake case test');
    expect(res.body.session_id).toBe('test-session-123');
    expect(res.body.github_issue_url).toBe('https://github.com/org/repo/issues/1');
  });
});
