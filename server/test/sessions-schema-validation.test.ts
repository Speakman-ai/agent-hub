import type supertest from 'supertest';
import { getRequest, createAgent, createSession } from './helpers.js';

// ═══════════════════════════════════════════════════════════════════
// Zod schema validation for session routes
//
// Confirms each session endpoint the migration touched returns a 400
// with an `error` message + `details` array on bad input. The pre-Zod
// handlers hand-rolled `if (typeof enabled !== 'boolean')` checks for
// the toggle endpoints, `!engine || !whitelist.includes(engine)` for
// /engine, plus `!uuid` / `label === undefined` for rewind/checkpoint.
// The migration moved that wiring to `.safeParse(req.body)` with
// schemas in `server/routes/sessions.openapi.ts`.
// ═══════════════════════════════════════════════════════════════════

let request: supertest.Agent;
let sessionId: string;

beforeAll(async () => {
  request = await getRequest();
  const session = (await createSession()) as { id: string };
  sessionId = session.id;
});

describe('Schema validation — PUT /api/sessions/:sessionId/ask-mode', () => {
  it('rejects non-boolean enabled (string) (400)', async () => {
    const res = await request
      .put(`/api/sessions/${sessionId}/ask-mode`)
      .send({ enabled: 'true' })
      .expect(400);
    expect((res.body as { error: string }).error).toMatch(/enabled must be a boolean/i);
    expect(Array.isArray((res.body as { details: unknown[] }).details)).toBe(true);
  });

  it('rejects missing enabled (400)', async () => {
    const res = await request.put(`/api/sessions/${sessionId}/ask-mode`).send({}).expect(400);
    expect((res.body as { error: string }).error).toMatch(/enabled must be a boolean/i);
  });

  it('accepts enabled=true (200)', async () => {
    await request.put(`/api/sessions/${sessionId}/ask-mode`).send({ enabled: true }).expect(200);
  });
});

describe('Schema validation — PUT /api/sessions/:sessionId/react-loop', () => {
  it('rejects non-boolean enabled (400)', async () => {
    const res = await request
      .put(`/api/sessions/${sessionId}/react-loop`)
      .send({ enabled: 1 })
      .expect(400);
    expect((res.body as { error: string }).error).toMatch(/enabled must be a boolean/i);
  });
});

describe('Schema validation — PUT /api/sessions/:sessionId/worktree', () => {
  it('rejects non-boolean enabled (400)', async () => {
    const res = await request
      .put(`/api/sessions/${sessionId}/worktree`)
      .send({ enabled: 'false' })
      .expect(400);
    expect((res.body as { error: string }).error).toMatch(/enabled must be a boolean/i);
  });
});

describe('Schema validation — PUT /api/sessions/:sessionId/engine', () => {
  it('rejects missing engine (400)', async () => {
    const res = await request.put(`/api/sessions/${sessionId}/engine`).send({}).expect(400);
    expect((res.body as { error: string }).error).toMatch(/invalid engine/i);
  });

  it('rejects unknown engine (400)', async () => {
    const res = await request
      .put(`/api/sessions/${sessionId}/engine`)
      .send({ engine: 'gpt-magic' })
      .expect(400);
    expect((res.body as { error: string }).error).toMatch(/invalid engine/i);
  });

  it('accepts a valid engine (200)', async () => {
    await request
      .put(`/api/sessions/${sessionId}/engine`)
      .send({ engine: 'claude-code' })
      .expect(200);
  });
});

describe('Schema validation — PUT /api/sessions/:sessionId/model', () => {
  it('rejects missing model (400)', async () => {
    const res = await request.put(`/api/sessions/${sessionId}/model`).send({}).expect(400);
    expect((res.body as { error: string }).error).toMatch(/invalid model/i);
  });

  it('rejects empty-string model (400)', async () => {
    const res = await request
      .put(`/api/sessions/${sessionId}/model`)
      .send({ model: '' })
      .expect(400);
    expect((res.body as { error: string }).error).toMatch(/invalid model/i);
  });
});

describe('Schema validation — POST /api/sessions/:sessionId/rewind', () => {
  it('rejects missing uuid (400)', async () => {
    const res = await request.post(`/api/sessions/${sessionId}/rewind`).send({}).expect(400);
    expect((res.body as { error: string }).error).toMatch(/uuid is required/i);
  });

  it('rejects empty-string uuid (400)', async () => {
    const res = await request
      .post(`/api/sessions/${sessionId}/rewind`)
      .send({ uuid: '' })
      .expect(400);
    expect((res.body as { error: string }).error).toMatch(/uuid is required/i);
  });
});

describe('Schema validation — PATCH /api/sessions/:sessionId/checkpoints/:uuid', () => {
  it('rejects missing label (400)', async () => {
    const res = await request
      .patch(`/api/sessions/${sessionId}/checkpoints/any-uuid`)
      .send({})
      .expect(400);
    expect((res.body as { error: string }).error).toMatch(/label is required/i);
  });

  it('rejects non-string label (400)', async () => {
    const res = await request
      .patch(`/api/sessions/${sessionId}/checkpoints/any-uuid`)
      .send({ label: 42 })
      .expect(400);
    expect(Array.isArray((res.body as { details: unknown[] }).details)).toBe(true);
  });
});

describe('Schema validation — PATCH /api/sessions/:sessionId', () => {
  it('accepts empty body as no-op (200)', async () => {
    await request.patch(`/api/sessions/${sessionId}`).send({}).expect(200);
  });

  it('accepts a rename (200)', async () => {
    const res = await request
      .patch(`/api/sessions/${sessionId}`)
      .send({ name: `Renamed ${Date.now()}` })
      .expect(200);
    expect((res.body as { name: string }).name).toMatch(/^Renamed /);
  });

  it('rejects non-string name (400)', async () => {
    const res = await request.patch(`/api/sessions/${sessionId}`).send({ name: 42 }).expect(400);
    expect(Array.isArray((res.body as { details: unknown[] }).details)).toBe(true);
  });
});

describe('Schema validation — POST /api/agents/:agentId/sessions', () => {
  it('rejects non-string name (400)', async () => {
    const agent = (await createAgent()) as { id: string };
    const res = await request
      .post(`/api/agents/${agent.id}/sessions`)
      .send({ name: 42 })
      .expect(400);
    expect(Array.isArray((res.body as { details: unknown[] }).details)).toBe(true);
  });

  it('rejects non-boolean use_worktree (400)', async () => {
    const agent = (await createAgent()) as { id: string };
    const res = await request
      .post(`/api/agents/${agent.id}/sessions`)
      .send({ use_worktree: 'yes' })
      .expect(400);
    expect(Array.isArray((res.body as { details: unknown[] }).details)).toBe(true);
  });

  it('accepts empty body (200)', async () => {
    const agent = (await createAgent()) as { id: string };
    await request.post(`/api/agents/${agent.id}/sessions`).send({}).expect(200);
  });
});
