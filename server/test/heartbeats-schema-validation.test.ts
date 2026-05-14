import type TestAgent from 'supertest/lib/agent.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { getRequest, createProject, createAgent } from './helpers.js';
import type { Project, Agent } from '../types.js';

// ═══════════════════════════════════════════════════════════════════
// Zod schema validation for heartbeat routes
//
// Confirms PUT /api/heartbeats/:agentId returns a 400 with `error` +
// `details` for cron-expression / type violations. Migration moved the
// hand-rolled body destructuring to `safeParse(...)` against the schema
// in `server/routes/heartbeats.openapi.ts`.
// ═══════════════════════════════════════════════════════════════════

let request: TestAgent;
let project: Project;
let agent: Agent;

beforeAll(async () => {
  request = await getRequest();
  project = (await createProject()) as unknown as Project;
  agent = (await createAgent({
    projectId: project.id,
    name: 'Heartbeat Schema Agent',
  })) as unknown as Agent;
});

describe('Schema validation — PUT /api/heartbeats/:agentId', () => {
  it('rejects an invalid cron expression in interval (400)', async () => {
    const res = await request
      .put(`/api/heartbeats/${agent.id}`)
      .send({ enabled: true, interval: 'not a cron expr', prompt: 'hi' })
      .expect(400);
    expect((res.body as { error: string }).error).toMatch(
      /interval must be a valid cron expression/i,
    );
    expect(Array.isArray((res.body as { details: unknown[] }).details)).toBe(true);
  });

  it('rejects out-of-range cron field with 400', async () => {
    const res = await request
      .put(`/api/heartbeats/${agent.id}`)
      .send({ interval: '99 * * * *' })
      .expect(400);
    expect((res.body as { error: string }).error).toMatch(
      /interval must be a valid cron expression/i,
    );
  });

  it('accepts a valid cron expression (200)', async () => {
    const res = await request
      .put(`/api/heartbeats/${agent.id}`)
      .send({ enabled: true, interval: '*/30 * * * *', prompt: 'check the queue' })
      .expect(200);
    expect((res.body as { interval: string }).interval).toBe('*/30 * * * *');
  });

  it('accepts an empty-string interval (200) — preserves "no schedule" semantics', async () => {
    await request
      .put(`/api/heartbeats/${agent.id}`)
      .send({ enabled: false, interval: '', prompt: 'noop' })
      .expect(200);
  });

  it('rejects a non-boolean enabled (400)', async () => {
    const res = await request
      .put(`/api/heartbeats/${agent.id}`)
      .send({ enabled: 'yes', interval: '*/5 * * * *', prompt: 'hi' })
      .expect(400);
    expect(Array.isArray((res.body as { details: unknown[] }).details)).toBe(true);
  });

  it('rejects a non-string prompt (400)', async () => {
    const res = await request.put(`/api/heartbeats/${agent.id}`).send({ prompt: 42 }).expect(400);
    expect(Array.isArray((res.body as { details: unknown[] }).details)).toBe(true);
  });

  it('returns 404 for unknown agent (without invoking schema)', async () => {
    await request
      .put('/api/heartbeats/this-agent-does-not-exist')
      .send({ enabled: true, interval: '* * * * *', prompt: 'hi' })
      .expect(404);
  });

  it('accepts an empty body as a no-op preserve (200)', async () => {
    await request.put(`/api/heartbeats/${agent.id}`).send({}).expect(200);
  });
});
