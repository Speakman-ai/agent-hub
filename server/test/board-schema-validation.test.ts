import type supertest from 'supertest';
import { getRequest, createProject, createCard } from './helpers.js';

// ═══════════════════════════════════════════════════════════════════
// Zod schema validation for board / epics routes
//
// Confirms each board endpoint that the migration touched returns a
// 400 with an `error` message + `details` array on bad input. The
// pre-Zod handlers hand-rolled `if (!field) return 400` for required
// fields; the migration moved that wiring to `.safeParse(req.body)`
// with schemas defined in `server/routes/board.openapi.ts`.
//
// These tests pin:
//   - the status code (400 — surface-stable)
//   - the presence of `details` (the new Zod-issue array)
//   - back-compat 400 reasons that pre-existing tests still cover
//     (`title is required`, `columnId is required`, …) — kept here as
//     explicit assertions so the schema's `.min(1, '...')` messages
//     can't drift without a test change.
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
    columns: Array<{ id: string }>;
  };
  columnId = body.columns[0].id;
});

describe('Schema validation — POST /board/columns', () => {
  it('rejects empty body with 400', async () => {
    const res = await request.post(`/api/projects/${projectId}/board/columns`).send({}).expect(400);
    expect((res.body as { error: string }).error).toMatch(/name is required/i);
    expect(Array.isArray((res.body as { details: unknown[] }).details)).toBe(true);
  });
});

describe('Schema validation — POST /board/cards', () => {
  it('rejects missing title (400)', async () => {
    const res = await request
      .post(`/api/projects/${projectId}/board/cards`)
      .send({ columnId })
      .expect(400);
    expect((res.body as { error: string }).error).toMatch(/title is required/i);
  });

  it('rejects missing columnId (400)', async () => {
    const res = await request
      .post(`/api/projects/${projectId}/board/cards`)
      .send({ title: `no-col-${Date.now()}` })
      .expect(400);
    expect((res.body as { error: string }).error).toMatch(/columnId is required/i);
  });

  it('rejects empty-string title (400) — Zod min(1) treats it like missing', async () => {
    const res = await request
      .post(`/api/projects/${projectId}/board/cards`)
      .send({ title: '', columnId })
      .expect(400);
    expect((res.body as { error: string }).error).toMatch(/title/i);
  });

  it('rejects invalid priority enum (400)', async () => {
    const res = await request
      .post(`/api/projects/${projectId}/board/cards`)
      .send({ title: `bad-prio-${Date.now()}`, columnId, priority: 'cosmic' })
      .expect(400);
    expect(Array.isArray((res.body as { details: unknown[] }).details)).toBe(true);
  });

  it('accepts snake_case column_id alias and creates the card (200)', async () => {
    const res = await request
      .post(`/api/projects/${projectId}/board/cards`)
      .send({ title: `snake-${Date.now()}`, column_id: columnId })
      .expect(200);
    expect((res.body as { column_id: string }).column_id).toBe(columnId);
  });
});

describe('Schema validation — PUT /board/cards/:cardId', () => {
  it('rejects invalid priority enum (400)', async () => {
    const card = await createCard(projectId, { title: `put-bad-prio-${Date.now()}` });
    await request
      .put(`/api/projects/${projectId}/board/cards/${card.id}`)
      .send({ priority: 'cosmic' })
      .expect(400);
  });

  it('treats omitted keys as "preserve" (no-op update succeeds)', async () => {
    const card = await createCard(projectId, {
      title: `put-noop-${Date.now()}`,
      description: 'original',
    });
    const res = await request
      .put(`/api/projects/${projectId}/board/cards/${card.id}`)
      .send({})
      .expect(200);
    expect((res.body as { description: string }).description).toBe('original');
  });

  it('honors explicit null to clear description', async () => {
    const card = await createCard(projectId, {
      title: `put-clear-${Date.now()}`,
      description: 'will-clear',
    });
    const res = await request
      .put(`/api/projects/${projectId}/board/cards/${card.id}`)
      .send({ description: null })
      .expect(200);
    expect((res.body as { description: unknown }).description).toBeNull();
  });
});

describe('Schema validation — POST /board/cards/:cardId/move', () => {
  it('rejects missing columnId (400)', async () => {
    const card = await createCard(projectId, { title: `move-no-col-${Date.now()}` });
    const res = await request
      .post(`/api/projects/${projectId}/board/cards/${card.id}/move`)
      .send({})
      .expect(400);
    expect((res.body as { error: string }).error).toMatch(/columnId is required/i);
  });

  it('rejects non-numeric position (400)', async () => {
    const card = await createCard(projectId, { title: `move-bad-pos-${Date.now()}` });
    await request
      .post(`/api/projects/${projectId}/board/cards/${card.id}/move`)
      .send({ columnId, position: 'top' })
      .expect(400);
  });
});

describe('Schema validation — POST /board/cards/:cardId/assign', () => {
  it('rejects missing agentId (400)', async () => {
    const card = await createCard(projectId, { title: `assign-no-agent-${Date.now()}` });
    const res = await request
      .post(`/api/projects/${projectId}/board/cards/${card.id}/assign`)
      .send({})
      .expect(400);
    expect((res.body as { error: string }).error).toMatch(/agentId is required/i);
  });
});

describe('Schema validation — POST /board/cards/:cardId/comments', () => {
  it('rejects missing author (400)', async () => {
    const card = await createCard(projectId, { title: `cmt-no-auth-${Date.now()}` });
    await request
      .post(`/api/projects/${projectId}/board/cards/${card.id}/comments`)
      .send({ content: 'hi' })
      .expect(400);
  });

  it('rejects missing content (400)', async () => {
    const card = await createCard(projectId, { title: `cmt-no-content-${Date.now()}` });
    await request
      .post(`/api/projects/${projectId}/board/cards/${card.id}/comments`)
      .send({ author: 'me' })
      .expect(400);
  });
});

describe('Schema validation — POST /board/cards/:cardId/blockers', () => {
  it('rejects missing blockedByCardId (400)', async () => {
    const card = await createCard(projectId, { title: `blk-missing-${Date.now()}` });
    const res = await request
      .post(`/api/projects/${projectId}/board/cards/${card.id}/blockers`)
      .send({})
      .expect(400);
    expect((res.body as { error: string }).error).toMatch(/blockedByCardId is required/i);
  });

  it('rejects empty-string blockedByCardId (400)', async () => {
    const card = await createCard(projectId, { title: `blk-empty-${Date.now()}` });
    await request
      .post(`/api/projects/${projectId}/board/cards/${card.id}/blockers`)
      .send({ blockedByCardId: '' })
      .expect(400);
  });
});

describe('Schema validation — POST /board/epics', () => {
  it('rejects missing name (400)', async () => {
    const res = await request.post(`/api/projects/${projectId}/board/epics`).send({}).expect(400);
    expect((res.body as { error: string }).error).toMatch(/name is required/i);
  });
});

describe('Schema validation — POST /board/cards/:cardId/epic', () => {
  it('accepts empty body and clears the epic (200)', async () => {
    const card = await createCard(projectId, { title: `link-empty-${Date.now()}` });
    const res = await request
      .post(`/api/projects/${projectId}/board/cards/${card.id}/epic`)
      .send({})
      .expect(200);
    expect((res.body as { epic_id: unknown }).epic_id).toBeNull();
  });

  it('accepts explicit null to clear (200)', async () => {
    const card = await createCard(projectId, { title: `link-null-${Date.now()}` });
    const res = await request
      .post(`/api/projects/${projectId}/board/cards/${card.id}/epic`)
      .send({ epicId: null })
      .expect(200);
    expect((res.body as { epic_id: unknown }).epic_id).toBeNull();
  });
});

describe('Schema validation — PUT /board/epics/:epicId', () => {
  it('rejects non-numeric autonomousInterval (400)', async () => {
    const epicRes = await request
      .post(`/api/projects/${projectId}/board/epics`)
      .send({ name: `put-epic-${Date.now()}` })
      .expect(200);
    const epicId = (epicRes.body as { id: string }).id;

    await request
      .put(`/api/projects/${projectId}/board/epics/${epicId}`)
      .send({ autonomousInterval: 'fast' })
      .expect(400);
  });
});
