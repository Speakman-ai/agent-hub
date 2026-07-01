import type TestAgent from 'supertest/lib/agent.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { getRequest } from './helpers.js';
import type { CronRow } from '../types.js';

// ═══════════════════════════════════════════════════════════════════
// Zod schema validation for cron routes
//
// Confirms POST/PUT /api/crons reject invalid cron expressions with a
// 400 carrying `error` + `details`. The schema lives in
// `server/routes/crons.openapi.ts`; the cron-expression check uses a
// Zod refinement around `node-cron`'s `cron.validate` so the failure
// surfaces at the parseBody chokepoint instead of leaking out of the
// scheduler later.
// ═══════════════════════════════════════════════════════════════════

let request: TestAgent;

beforeAll(async () => {
  request = await getRequest();
});

describe('Schema validation — POST /api/crons (cron expression)', () => {
  it('rejects an invalid cron expression with 400', async () => {
    const res = await request
      .post('/api/crons')
      .send({
        name: `bad-cron-${Date.now()}`,
        schedule: 'definitely not a cron',
        prompt: 'noop',
        cwd: '/tmp',
        enabled: false,
      })
      .expect(400);
    expect((res.body as { error: string }).error).toMatch(
      /schedule must be a valid cron expression/i,
    );
    expect(Array.isArray((res.body as { details: unknown[] }).details)).toBe(true);
  });

  it('rejects out-of-range cron field with 400', async () => {
    const res = await request
      .post('/api/crons')
      .send({
        name: `bad-cron-${Date.now()}`,
        schedule: '99 * * * *',
        prompt: 'noop',
        cwd: '/tmp',
        enabled: false,
      })
      .expect(400);
    expect((res.body as { error: string }).error).toMatch(
      /schedule must be a valid cron expression/i,
    );
  });

  it('accepts a valid cron expression with 200', async () => {
    const res = await request
      .post('/api/crons')
      .send({
        name: `good-cron-${Date.now()}`,
        schedule: '*/15 * * * *',
        timezone: 'America/New_York',
        prompt: 'noop',
        cwd: '/tmp',
        enabled: false,
      })
      .expect(200);
    expect((res.body as CronRow).schedule).toBe('*/15 * * * *');
    expect((res.body as CronRow).timezone).toBe('America/New_York');
  });

  it('rejects an invalid timezone with 400', async () => {
    const res = await request
      .post('/api/crons')
      .send({
        name: `bad-timezone-${Date.now()}`,
        schedule: '0 9 * * *',
        timezone: 'Eastern-ish',
        prompt: 'noop',
        cwd: '/tmp',
        enabled: false,
      })
      .expect(400);
    expect((res.body as { error: string }).error).toMatch(/valid IANA timezone/i);
  });

  it('rejects missing required fields with 400', async () => {
    const res = await request
      .post('/api/crons')
      .send({ name: '', schedule: '', prompt: '' })
      .expect(400);
    expect((res.body as { error: string }).error).toMatch(/required|cron expression/i);
  });

  it('rejects empty body with 400', async () => {
    await request.post('/api/crons').send({}).expect(400);
  });
});

describe('Schema validation — PUT /api/crons/:id (cron expression)', () => {
  async function createCron(): Promise<CronRow> {
    const res = await request
      .post('/api/crons')
      .send({
        name: `crud-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        schedule: '0 * * * *',
        prompt: 'noop',
        cwd: '/tmp',
        enabled: false,
      })
      .expect(200);
    return res.body as CronRow;
  }

  it('rejects an invalid cron expression in PUT with 400', async () => {
    const cron = await createCron();
    const res = await request
      .put(`/api/crons/${cron.id}`)
      .send({ schedule: 'still not a cron' })
      .expect(400);
    expect((res.body as { error: string }).error).toMatch(
      /schedule must be a valid cron expression/i,
    );
  });

  it('accepts an empty-string schedule in PUT (200) — preserves existing', async () => {
    const cron = await createCron();
    const res = await request.put(`/api/crons/${cron.id}`).send({ schedule: '' }).expect(200);
    expect((res.body as CronRow).schedule).toBe('0 * * * *');
  });

  it('updates timezone in PUT and rejects invalid timezone values', async () => {
    const cron = await createCron();
    const updated = await request
      .put(`/api/crons/${cron.id}`)
      .send({ timezone: 'America/Los_Angeles' })
      .expect(200);
    expect((updated.body as CronRow).timezone).toBe('America/Los_Angeles');

    const rejected = await request
      .put(`/api/crons/${cron.id}`)
      .send({ timezone: 'Pacific-ish' })
      .expect(400);
    expect((rejected.body as { error: string }).error).toMatch(/valid IANA timezone/i);
  });

  it('returns 404 for unknown cron id (without invoking schema)', async () => {
    await request.put('/api/crons/9999999').send({ schedule: '0 * * * *' }).expect(404);
  });
});
