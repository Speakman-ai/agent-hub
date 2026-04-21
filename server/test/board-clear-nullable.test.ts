import type supertest from 'supertest';
import { getRequest, createProject, createCard } from './helpers.js';

// ═══════════════════════════════════════════════════════════════════
// PUT /api/projects/:projectId/board/cards/:cardId — clearing nullable
// fields with explicit null.
//
// Regression for the "stuck Assigned / Session active" bug: before the
// fix, the PUT endpoint used `??` for every nullable column, which made
// it impossible for the client to clear `session_id`, `assignee`,
// `labels`, etc. because `null` was treated as absent and the existing
// value was re-written. The UI guards the Assignee dropdown behind the
// absence of `session_id`, so a stamped-and-stuck id locked the card
// out of the UI forever.
// ═══════════════════════════════════════════════════════════════════

let request: supertest.Agent;
let projectId: string;

beforeAll(async () => {
  request = await getRequest();
  const project = await createProject();
  projectId = project.id as string;
});

async function seedCard(overrides: Record<string, unknown> = {}) {
  const card = await createCard(projectId, {
    title: `null-clear-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    description: 'seeded',
    labels: 'bug,user-report',
    ...overrides,
  });
  const cardId = card.id as string;
  // Seed nullable fields we want to clear by doing an initial PUT — the
  // POST /cards endpoint doesn't accept every nullable field as a
  // first-class input (e.g. prUrl), so update after creation.
  const seed = await request
    .put(`/api/projects/${projectId}/board/cards/${cardId}`)
    .send({
      sessionId: 'ephemeral-session-id-xyz',
      assignee: 'Agent Name',
      prUrl: 'https://example.test/pr/1',
      githubIssueUrl: 'https://example.test/issue/1',
    })
    .expect(200);
  return seed.body as Record<string, unknown>;
}

describe('PUT board card — clearing nullable fields with explicit null', () => {
  it('clears session_id when null is passed (snake_case)', async () => {
    const card = await seedCard();
    expect(card.session_id).toBe('ephemeral-session-id-xyz');

    const res = await request
      .put(`/api/projects/${projectId}/board/cards/${card.id}`)
      .send({ session_id: null })
      .expect(200);

    expect((res.body as { session_id: unknown }).session_id).toBeNull();
  });

  it('clears session_id when null is passed (camelCase)', async () => {
    const card = await seedCard();
    expect(card.session_id).toBe('ephemeral-session-id-xyz');

    const res = await request
      .put(`/api/projects/${projectId}/board/cards/${card.id}`)
      .send({ sessionId: null })
      .expect(200);

    expect((res.body as { session_id: unknown }).session_id).toBeNull();
  });

  it('clears assignee when null is passed', async () => {
    const card = await seedCard();
    expect(card.assignee).toBe('Agent Name');

    const res = await request
      .put(`/api/projects/${projectId}/board/cards/${card.id}`)
      .send({ assignee: null })
      .expect(200);

    expect((res.body as { assignee: unknown }).assignee).toBeNull();
  });

  it('clears assign_model when null is passed', async () => {
    const card = await seedCard();
    await request
      .put(`/api/projects/${projectId}/board/cards/${card.id}`)
      .send({ assignModel: 'claude-sonnet-4-6' })
      .expect(200);

    const res = await request
      .put(`/api/projects/${projectId}/board/cards/${card.id}`)
      .send({ assign_model: null })
      .expect(200);

    expect((res.body as { assign_model: unknown }).assign_model).toBeNull();
  });

  it('clears labels when null is passed', async () => {
    const card = await seedCard();
    expect(card.labels).toBe('bug,user-report');

    const res = await request
      .put(`/api/projects/${projectId}/board/cards/${card.id}`)
      .send({ labels: null })
      .expect(200);

    expect((res.body as { labels: unknown }).labels).toBeNull();
  });

  it('clears prUrl and githubIssueUrl when null is passed', async () => {
    const card = await seedCard();
    expect(card.pr_url).toBe('https://example.test/pr/1');
    expect(card.github_issue_url).toBe('https://example.test/issue/1');

    const res = await request
      .put(`/api/projects/${projectId}/board/cards/${card.id}`)
      .send({ prUrl: null, githubIssueUrl: null })
      .expect(200);

    expect((res.body as { pr_url: unknown }).pr_url).toBeNull();
    expect((res.body as { github_issue_url: unknown }).github_issue_url).toBeNull();
  });

  it('does NOT clear fields that are omitted from the body', async () => {
    const card = await seedCard();

    // Update only the description, and make sure every other nullable
    // field is preserved at its seeded value.
    const res = await request
      .put(`/api/projects/${projectId}/board/cards/${card.id}`)
      .send({ description: 'updated only' })
      .expect(200);

    const body = res.body as Record<string, unknown>;
    expect(body.description).toBe('updated only');
    expect(body.session_id).toBe('ephemeral-session-id-xyz');
    expect(body.assignee).toBe('Agent Name');
    expect(body.labels).toBe('bug,user-report');
    expect(body.pr_url).toBe('https://example.test/pr/1');
    expect(body.github_issue_url).toBe('https://example.test/issue/1');
  });

  it('preserves non-nullable title and priority when not supplied', async () => {
    const card = await seedCard();
    const originalTitle = card.title as string;
    const originalPriority = card.priority as string;

    const res = await request
      .put(`/api/projects/${projectId}/board/cards/${card.id}`)
      .send({ session_id: null })
      .expect(200);

    expect((res.body as { title: string }).title).toBe(originalTitle);
    expect((res.body as { priority: string }).priority).toBe(originalPriority);
  });
});
