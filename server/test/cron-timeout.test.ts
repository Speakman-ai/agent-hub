import type TestAgent from 'supertest/lib/agent.js';
import { getRequest } from './helpers.js';
import type { CronRow } from '../types.js';

let request: TestAgent;

beforeAll(async () => {
  request = await getRequest();
});

/**
 * Per-cron `timeout_ms` overrides the shared `config.defaultTimeoutMs` so a
 * single long-running cron can opt out of the default without dragging every
 * other cron with it. These tests cover the API contract for that field:
 *
 *   - POST persists a positive integer and round-trips on GET.
 *   - POST rejects non-positive / non-integer values with 400.
 *   - POST defaults the column to null when the field is omitted.
 *   - PUT updates, clears, and rejects invalid values without touching other
 *     fields.
 */
describe('crons: per-cron timeout_ms', () => {
  async function createCron(body: Record<string, unknown> = {}): Promise<CronRow> {
    const res = await request
      .post('/api/crons')
      .send({
        name: `Timeout Test ${Math.random().toString(36).slice(2, 8)}`,
        schedule: '0 * * * *',
        prompt: 'echo hi',
        cwd: '/tmp',
        enabled: false,
        ...body,
      })
      .expect(200);
    return res.body as CronRow;
  }

  it('POST /api/crons persists a positive integer timeout_ms', async () => {
    const cron = await createCron({ timeout_ms: 30 * 60 * 1000 });
    expect(cron.timeout_ms).toBe(30 * 60 * 1000);

    // Round-trip through GET to make sure it was actually stored, not just
    // echoed from the request body.
    const list = await request.get('/api/crons').expect(200);
    const found = (list.body as CronRow[]).find((c) => c.id === cron.id);
    expect(found?.timeout_ms).toBe(30 * 60 * 1000);
  });

  it('POST /api/crons defaults timeout_ms to null when omitted', async () => {
    const cron = await createCron({});
    expect(cron.timeout_ms).toBeNull();
  });

  it('POST /api/crons rejects zero, negative, and non-numeric timeout_ms', async () => {
    for (const bad of [0, -1, 1.5, 'abc', true]) {
      await request
        .post('/api/crons')
        .send({
          name: `Bad Timeout ${Math.random().toString(36).slice(2, 8)}`,
          schedule: '0 * * * *',
          prompt: 'echo hi',
          cwd: '/tmp',
          enabled: false,
          timeout_ms: bad,
        })
        .expect(400);
    }
  });

  it('PUT /api/crons/:id updates timeout_ms', async () => {
    const cron = await createCron({ timeout_ms: 60_000 });
    const res = await request
      .put(`/api/crons/${cron.id}`)
      .send({ timeout_ms: 120_000 })
      .expect(200);
    expect((res.body as CronRow).timeout_ms).toBe(120_000);
  });

  it('PUT /api/crons/:id clears timeout_ms when explicitly set to null', async () => {
    const cron = await createCron({ timeout_ms: 60_000 });
    const res = await request.put(`/api/crons/${cron.id}`).send({ timeout_ms: null }).expect(200);
    expect((res.body as CronRow).timeout_ms).toBeNull();
  });

  it('PUT /api/crons/:id leaves timeout_ms unchanged when field is absent', async () => {
    const cron = await createCron({ timeout_ms: 60_000 });
    const res = await request.put(`/api/crons/${cron.id}`).send({ name: 'renamed' }).expect(200);
    expect((res.body as CronRow).timeout_ms).toBe(60_000);
    expect((res.body as CronRow).name).toBe('renamed');
  });

  it('PUT /api/crons/:id rejects invalid timeout_ms without mutating the row', async () => {
    const cron = await createCron({ timeout_ms: 60_000 });
    await request.put(`/api/crons/${cron.id}`).send({ timeout_ms: -5 }).expect(400);
    const after = await request.get('/api/crons').expect(200);
    const found = (after.body as CronRow[]).find((c) => c.id === cron.id);
    expect(found?.timeout_ms).toBe(60_000);
  });
});
