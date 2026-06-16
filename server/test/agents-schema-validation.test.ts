import type supertest from 'supertest';
import { getRequest, createProject, createAgent } from './helpers.js';

// ═══════════════════════════════════════════════════════════════════
// Zod schema validation for agents routes
//
// Confirms each agents endpoint the migration touched returns a 400
// with an `error` message + `details` array on bad input. The pre-Zod
// handlers hand-rolled `if (!id)` / `if (!projectId)` / `if (typeof X
// !== 'boolean')` checks plus bespoke browser-dim range checks. The
// migration moved that wiring to `.safeParse(req.body)` with schemas
// defined in `server/routes/agents.openapi.ts`.
//
// These tests pin:
//   - the status code (400 — surface-stable)
//   - the presence of `details` (the new Zod-issue array)
//   - back-compat error reasons (e.g. `id is required ...`,
//     `projectId is required`, `browserToolsEnabled must be a boolean`,
//     `Invalid or missing engine`)
// ═══════════════════════════════════════════════════════════════════

let request: supertest.Agent;
let projectId: string;

beforeAll(async () => {
  request = await getRequest();
  const project = (await createProject()) as { id: string };
  projectId = project.id;
});

describe('Schema validation — POST /api/agents', () => {
  it('rejects empty body with 400 (id missing)', async () => {
    const res = await request.post('/api/agents').send({}).expect(400);
    expect((res.body as { error: string }).error).toMatch(/id is required/i);
    expect(Array.isArray((res.body as { details: unknown[] }).details)).toBe(true);
  });

  it('rejects missing projectId (400)', async () => {
    const res = await request
      .post('/api/agents')
      .send({ id: `agent-${Date.now()}` })
      .expect(400);
    expect((res.body as { error: string }).error).toMatch(/projectId is required/i);
  });

  it('rejects invalid id (non-alphanumeric+hyphens) (400)', async () => {
    const res = await request.post('/api/agents').send({ id: 'bad id!', projectId }).expect(400);
    expect((res.body as { error: string }).error).toMatch(/id is required/i);
  });

  it('rejects non-string id (400)', async () => {
    const res = await request.post('/api/agents').send({ id: 42, projectId }).expect(400);
    expect(Array.isArray((res.body as { details: unknown[] }).details)).toBe(true);
  });

  it('rejects non-boolean browserToolsEnabled (400)', async () => {
    const res = await request
      .post('/api/agents')
      .send({
        id: `agent-${Date.now()}`,
        projectId,
        browserToolsEnabled: 'false',
      })
      .expect(400);
    expect((res.body as { error: string }).error).toMatch(/browserToolsEnabled must be a boolean/i);
  });

  it('rejects out-of-range browserViewportWidth (400)', async () => {
    const res = await request
      .post('/api/agents')
      .send({
        id: `agent-${Date.now()}`,
        projectId,
        browserViewportWidth: 10,
      })
      .expect(400);
    expect(Array.isArray((res.body as { details: unknown[] }).details)).toBe(true);
  });

  it('rejects out-of-range browserPageLoadTimeoutMs (400)', async () => {
    const res = await request
      .post('/api/agents')
      .send({
        id: `agent-${Date.now()}`,
        projectId,
        browserPageLoadTimeoutMs: 999_999,
      })
      .expect(400);
    expect((res.body as { error: string }).error).toMatch(/browserPageLoadTimeoutMs/i);
  });
});

describe('Schema validation — PATCH /api/agents/:agentId', () => {
  it('rejects non-boolean browserToolsEnabled (400)', async () => {
    const agent = (await createAgent({ projectId })) as { id: string };
    const res = await request
      .patch(`/api/agents/${agent.id}`)
      .send({ browserToolsEnabled: 'true' })
      .expect(400);
    expect((res.body as { error: string }).error).toMatch(/browserToolsEnabled must be a boolean/i);
  });

  it('accepts null to clear browserViewportWidth (200)', async () => {
    const agent = (await createAgent({ projectId })) as { id: string };
    await request.patch(`/api/agents/${agent.id}`).send({ browserViewportWidth: 1280 }).expect(200);
    await request.patch(`/api/agents/${agent.id}`).send({ browserViewportWidth: null }).expect(200);
  });

  it('accepts empty body as no-op (200)', async () => {
    const agent = (await createAgent({ projectId })) as { id: string };
    await request.patch(`/api/agents/${agent.id}`).send({}).expect(200);
  });

  it('rejects out-of-range browserViewportHeight (400)', async () => {
    const agent = (await createAgent({ projectId })) as { id: string };
    const res = await request
      .patch(`/api/agents/${agent.id}`)
      .send({ browserViewportHeight: 99_999 })
      .expect(400);
    expect(Array.isArray((res.body as { details: unknown[] }).details)).toBe(true);
  });
});

describe('Schema validation — POST /api/agents/bulk-engine', () => {
  // bulk-engine now writes per-user overrides and auth-gates ahead of body
  // validation. This suite runs in no-auth-configured mode (no authUserId),
  // so every request 401s before the Zod schema runs. The 400 + `details`
  // shape for empty / non-string bodies is asserted with an authenticated
  // caller in routes/agents-bulk-engine-per-user.test.ts.
  it('auth-gates an empty body with 401', async () => {
    await request.post('/api/agents/bulk-engine').send({}).expect(401);
  });

  it('auth-gates a non-string engine with 401', async () => {
    await request.post('/api/agents/bulk-engine').send({ engine: 42 }).expect(401);
  });
});

describe('Schema validation — PUT /api/agents/:agentId/memory', () => {
  it('rejects non-string content (400)', async () => {
    const agent = (await createAgent({ projectId })) as { id: string };
    const res = await request
      .put(`/api/agents/${agent.id}/memory`)
      .send({ content: 42 })
      .expect(400);
    expect(Array.isArray((res.body as { details: unknown[] }).details)).toBe(true);
  });

  it('rejects empty body (missing content) (400)', async () => {
    const agent = (await createAgent({ projectId })) as { id: string };
    await request.put(`/api/agents/${agent.id}/memory`).send({}).expect(400);
  });
});
