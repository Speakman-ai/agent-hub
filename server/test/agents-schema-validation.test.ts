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

describe('isDev contract — autonomous-ticket eligibility', () => {
  it('POST persists isDev for a togglable agent', async () => {
    const id = `agent-${Date.now()}-dev`;
    const res = await request.post('/api/agents').send({ id, projectId, isDev: true }).expect(201);
    expect((res.body as { isDev?: boolean }).isDev).toBe(true);
  });

  it('POST rejects a contradictory isDev for a locked default Dev role (400)', async () => {
    const res = await request
      .post('/api/agents')
      .send({ id: `agent-${Date.now()}-lead`, projectId, role: 'lead', isDev: false })
      .expect(400);
    expect((res.body as { error: string }).error).toMatch(/isDev cannot be set/i);
  });

  it('POST rejects a contradictory isDev for an out-of-band role (400)', async () => {
    const res = await request
      .post('/api/agents')
      .send({ id: `agent-${Date.now()}-rev`, projectId, role: 'reviewer', isDev: true })
      .expect(400);
    expect((res.body as { error: string }).error).toMatch(/isDev cannot be set/i);
  });

  it('POST accepts a matching isDev for a locked role as a no-op (201)', async () => {
    await request
      .post('/api/agents')
      .send({ id: `agent-${Date.now()}-rev2`, projectId, role: 'reviewer', isDev: false })
      .expect(201);
  });

  it('PATCH persists isDev for a togglable agent (200)', async () => {
    const agent = (await createAgent({ projectId })) as { id: string };
    const res = await request.patch(`/api/agents/${agent.id}`).send({ isDev: false }).expect(200);
    expect((res.body as { isDev?: boolean }).isDev).toBe(false);
  });

  it('PATCH rejects a contradictory isDev on a locked default Dev role (400)', async () => {
    const id = `agent-${Date.now()}-dev2`;
    await request.post('/api/agents').send({ id, projectId, role: 'dev' }).expect(201);
    const res = await request.patch(`/api/agents/${id}`).send({ isDev: false }).expect(400);
    expect((res.body as { error: string }).error).toMatch(/isDev cannot be changed/i);
  });

  it('PATCH accepts a matching isDev on a locked role as a no-op (200)', async () => {
    const id = `agent-${Date.now()}-dev3`;
    await request.post('/api/agents').send({ id, projectId, role: 'dev' }).expect(201);
    await request.patch(`/api/agents/${id}`).send({ isDev: true }).expect(200);
  });

  it('PATCH validates isDev against the POST-PATCH role (role→locked-off + isDev:true) (400)', async () => {
    // Unlocked agent; the SAME request moves it to a locked-off role AND sets
    // isDev:true — must be judged against the candidate role, not the current.
    const agent = (await createAgent({ projectId })) as { id: string };
    const res = await request
      .patch(`/api/agents/${agent.id}`)
      .send({ role: 'reviewer', isDev: true })
      .expect(400);
    expect((res.body as { error: string }).error).toMatch(/isDev cannot be changed/i);
  });

  it('PATCH validates isDev against the POST-PATCH role (role→locked-on + isDev:false) (400)', async () => {
    const agent = (await createAgent({ projectId })) as { id: string };
    const res = await request
      .patch(`/api/agents/${agent.id}`)
      .send({ role: 'dev', isDev: false })
      .expect(400);
    expect((res.body as { error: string }).error).toMatch(/isDev cannot be changed/i);
  });

  it('PATCH allows a role change with a consistent isDev (role→togglable + isDev:true) (200)', async () => {
    const agent = (await createAgent({ projectId })) as { id: string };
    const res = await request
      .patch(`/api/agents/${agent.id}`)
      .send({ role: 'sub', isDev: true })
      .expect(200);
    expect((res.body as { isDev?: boolean; role?: string }).isDev).toBe(true);
    expect((res.body as { role?: string }).role).toBe('sub');
  });

  it('PATCH clears a lingering raw isDev when the role changes to a locked role (200)', async () => {
    // Stored isDev:true on an unlocked agent, then promoted to a locked-off
    // role with no isDev in the body — the raw field must not linger.
    const agent = (await createAgent({ projectId, isDev: true })) as { id: string; isDev: boolean };
    expect(agent.isDev).toBe(true);
    const res = await request
      .patch(`/api/agents/${agent.id}`)
      .send({ role: 'reviewer' })
      .expect(200);
    expect((res.body as { isDev?: boolean }).isDev).toBeUndefined();
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
