import type supertest from 'supertest';
import { getRequest, createProject, createCard } from './helpers.js';

// ═══════════════════════════════════════════════════════════════════
// FK pre-flight validation in board.ts routes
//
// Regression for the recurring `SqliteError: FOREIGN KEY constraint
// failed at board.ts routes` tool-error reports. Several handlers used
// to pass user-supplied IDs (columnId, epicId, cardId) directly to
// SQL writes without checking existence first. better-sqlite3 then
// threw an opaque 500 instead of a clean 404.
//
// These tests cover each affected handler:
//   - POST   /board/cards                — stale columnId
//   - POST   /board/cards/:id/move       — stale columnId, cross-board
//   - PUT    /board/cards/:id            — stale epicId
//   - POST   /board/cards/:id/epic       — stale epicId
//   - POST   /board/cards/:id/comments   — stale cardId
// ═══════════════════════════════════════════════════════════════════

let request: supertest.Agent;
let projectId: string;
let columnId: string;

beforeAll(async () => {
  request = await getRequest();
  const project = await createProject();
  projectId = project.id as string;
  const boardRes = await request.get(`/api/projects/${projectId}/board`).expect(200);
  const body = boardRes.body as {
    board: { id: string };
    columns: Array<{ id: string; name: string }>;
  };
  columnId = body.columns[0].id;
});

describe('FK pre-flight — POST /board/cards', () => {
  it('returns 404 when columnId does not exist', async () => {
    const res = await request
      .post(`/api/projects/${projectId}/board/cards`)
      .send({ title: 'fk-stale-col', columnId: 'nonexistent-column-id' })
      .expect(404);
    expect((res.body as { error: string }).error).toMatch(/Column not found/i);
  });

  it('returns 404 when columnId belongs to a different board', async () => {
    // Create a second project — its board has its own columns.
    const otherProject = await createProject();
    const otherBoardRes = await request
      .get(`/api/projects/${otherProject.id as string}/board`)
      .expect(200);
    const otherColumnId = (otherBoardRes.body as { columns: Array<{ id: string }> }).columns[0].id;

    const res = await request
      .post(`/api/projects/${projectId}/board/cards`)
      .send({ title: 'fk-cross-board-col', columnId: otherColumnId })
      .expect(404);
    expect((res.body as { error: string }).error).toMatch(/Column not found/i);
  });

  it('still creates a card with a valid columnId', async () => {
    const res = await request
      .post(`/api/projects/${projectId}/board/cards`)
      .send({ title: `fk-valid-${Date.now()}`, columnId })
      .expect(200);
    expect((res.body as { id: string }).id).toBeTruthy();
  });
});

describe('FK pre-flight — POST /board/cards/:cardId/move', () => {
  it('returns 404 when target columnId does not exist', async () => {
    const card = await createCard(projectId, { title: `fk-move-stale-${Date.now()}` });
    const res = await request
      .post(`/api/projects/${projectId}/board/cards/${card.id}/move`)
      .send({ columnId: 'nonexistent-column-id', position: 0 })
      .expect(404);
    expect((res.body as { error: string }).error).toMatch(/Column not found/i);
  });

  it('returns 404 when target columnId belongs to a different board', async () => {
    const card = await createCard(projectId, { title: `fk-move-cross-${Date.now()}` });
    const otherProject = await createProject();
    const otherBoardRes = await request
      .get(`/api/projects/${otherProject.id as string}/board`)
      .expect(200);
    const otherColumnId = (otherBoardRes.body as { columns: Array<{ id: string }> }).columns[0].id;

    const res = await request
      .post(`/api/projects/${projectId}/board/cards/${card.id}/move`)
      .send({ columnId: otherColumnId, position: 0 })
      .expect(404);
    expect((res.body as { error: string }).error).toMatch(/Column not found/i);
  });

  it('moves successfully with a valid columnId on the same board', async () => {
    const card = await createCard(projectId, { title: `fk-move-valid-${Date.now()}` });
    const boardRes = await request.get(`/api/projects/${projectId}/board`).expect(200);
    const cols = (boardRes.body as { columns: Array<{ id: string }> }).columns;
    const targetColumn = cols.find((c) => c.id !== card.column_id)!;

    const res = await request
      .post(`/api/projects/${projectId}/board/cards/${card.id}/move`)
      .send({ columnId: targetColumn.id, position: 0 })
      .expect(200);
    expect((res.body as { column_id: string }).column_id).toBe(targetColumn.id);
  });
});

describe('FK pre-flight — PUT /board/cards/:cardId (epic_id)', () => {
  it('returns 404 when epicId does not exist', async () => {
    const card = await createCard(projectId, { title: `fk-epic-put-stale-${Date.now()}` });
    const res = await request
      .put(`/api/projects/${projectId}/board/cards/${card.id}`)
      .send({ epicId: 'nonexistent-epic-id' })
      .expect(404);
    expect((res.body as { error: string }).error).toMatch(/Epic not found/i);
  });

  it('still allows clearing epic_id with explicit null', async () => {
    const card = await createCard(projectId, { title: `fk-epic-put-clear-${Date.now()}` });
    const res = await request
      .put(`/api/projects/${projectId}/board/cards/${card.id}`)
      .send({ epicId: null })
      .expect(200);
    expect((res.body as { epic_id: unknown }).epic_id).toBeNull();
  });
});

describe('FK pre-flight — POST /board/cards/:cardId/epic', () => {
  it('returns 404 when epicId does not exist', async () => {
    const card = await createCard(projectId, { title: `fk-epic-post-stale-${Date.now()}` });
    const res = await request
      .post(`/api/projects/${projectId}/board/cards/${card.id}/epic`)
      .send({ epicId: 'nonexistent-epic-id' })
      .expect(404);
    expect((res.body as { error: string }).error).toMatch(/Epic not found/i);
  });

  it('still allows clearing the epic by passing no epicId', async () => {
    const card = await createCard(projectId, { title: `fk-epic-post-clear-${Date.now()}` });
    const res = await request
      .post(`/api/projects/${projectId}/board/cards/${card.id}/epic`)
      .send({})
      .expect(200);
    expect((res.body as { epic_id: unknown }).epic_id).toBeNull();
  });

  it('attaches a valid epic on the same board', async () => {
    const card = await createCard(projectId, { title: `fk-epic-post-valid-${Date.now()}` });
    const epicRes = await request
      .post(`/api/projects/${projectId}/board/epics`)
      .send({ name: `epic-${Date.now()}` })
      .expect(200);
    const epicId = (epicRes.body as { id: string }).id;

    const res = await request
      .post(`/api/projects/${projectId}/board/cards/${card.id}/epic`)
      .send({ epicId })
      .expect(200);
    expect((res.body as { epic_id: string }).epic_id).toBe(epicId);
  });
});

describe('FK pre-flight — POST /board/cards/:cardId/comments', () => {
  it('returns 404 when cardId does not exist', async () => {
    const res = await request
      .post(`/api/projects/${projectId}/board/cards/nonexistent-card-id/comments`)
      .send({ author: 'tester', content: 'hello' })
      .expect(404);
    expect((res.body as { error: string }).error).toMatch(/Card not found/i);
  });

  it('still creates a comment when cardId is valid', async () => {
    const card = await createCard(projectId, { title: `fk-comment-valid-${Date.now()}` });
    const res = await request
      .post(`/api/projects/${projectId}/board/cards/${card.id}/comments`)
      .send({ author: 'tester', content: 'hello' })
      .expect(200);
    const comments = res.body as Array<{ author: string; content: string }>;
    expect(comments.length).toBeGreaterThan(0);
    expect(comments[comments.length - 1].author).toBe('tester');
  });
});
