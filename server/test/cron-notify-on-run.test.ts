import type TestAgent from 'supertest/lib/agent.js';
import { getRequest } from './helpers.js';
import type { CronRow } from '../types.js';

let request: TestAgent;

beforeAll(async () => {
  request = await getRequest();
});

/**
 * Per-cron `notify_on_run` is an opt-in toggle for "ran successfully" push
 * notifications. The default behaviour previously sent a push for every run
 * of every cron, which mobile users complained about. The column defaults to
 * 0 (off) for new and migrated rows; users explicitly opt in per-cron from
 * the settings UI.
 *
 * These tests cover the API contract for the field — the heartbeat-side
 * gate that actually reads the column to decide whether to dispatch the push
 * is unit-tested via the route round-trip plus a direct check in
 * `cron-notify-dispatch.test.ts` (no real Expo HTTP).
 */
describe('crons: per-cron notify_on_run', () => {
  async function createCron(body: Record<string, unknown> = {}): Promise<CronRow> {
    const res = await request
      .post('/api/crons')
      .send({
        name: `Notify Test ${Math.random().toString(36).slice(2, 8)}`,
        schedule: '0 * * * *',
        prompt: 'echo hi',
        cwd: '/tmp',
        enabled: false,
        ...body,
      })
      .expect(200);
    return res.body as CronRow;
  }

  it('POST /api/crons defaults notify_on_run to 0 when omitted', async () => {
    const cron = await createCron({});
    expect(cron.notify_on_run).toBe(0);
  });

  it('POST /api/crons stores notify_on_run=true as 1', async () => {
    const cron = await createCron({ notify_on_run: true });
    expect(cron.notify_on_run).toBe(1);

    const list = await request.get('/api/crons').expect(200);
    const found = (list.body as CronRow[]).find((c) => c.id === cron.id);
    expect(found?.notify_on_run).toBe(1);
  });

  it('POST /api/crons accepts 0/1, "true"/"false", and booleans', async () => {
    for (const v of [1, '1', 'true', true]) {
      const c = await createCron({ notify_on_run: v });
      expect(c.notify_on_run).toBe(1);
    }
    for (const v of [0, '0', 'false', false]) {
      const c = await createCron({ notify_on_run: v });
      expect(c.notify_on_run).toBe(0);
    }
  });

  it('POST /api/crons rejects garbage notify_on_run values', async () => {
    for (const bad of ['yes', 2, 'on', {}]) {
      await request
        .post('/api/crons')
        .send({
          name: `Bad Notify ${Math.random().toString(36).slice(2, 8)}`,
          schedule: '0 * * * *',
          prompt: 'echo hi',
          cwd: '/tmp',
          enabled: false,
          notify_on_run: bad,
        })
        .expect(400);
    }
  });

  it('PUT /api/crons/:id flips notify_on_run on and off', async () => {
    const cron = await createCron({});
    expect(cron.notify_on_run).toBe(0);

    const enabled = await request
      .put(`/api/crons/${cron.id}`)
      .send({ notify_on_run: true })
      .expect(200);
    expect((enabled.body as CronRow).notify_on_run).toBe(1);

    const disabled = await request
      .put(`/api/crons/${cron.id}`)
      .send({ notify_on_run: false })
      .expect(200);
    expect((disabled.body as CronRow).notify_on_run).toBe(0);
  });

  it('PUT /api/crons/:id leaves notify_on_run unchanged when field is absent', async () => {
    const cron = await createCron({ notify_on_run: true });
    const res = await request.put(`/api/crons/${cron.id}`).send({ name: 'renamed' }).expect(200);
    expect((res.body as CronRow).notify_on_run).toBe(1);
    expect((res.body as CronRow).name).toBe('renamed');
  });

  it('PUT /api/crons/:id rejects invalid notify_on_run without mutating the row', async () => {
    const cron = await createCron({ notify_on_run: true });
    await request.put(`/api/crons/${cron.id}`).send({ notify_on_run: 'maybe' }).expect(400);

    const after = await request.get('/api/crons').expect(200);
    const found = (after.body as CronRow[]).find((c) => c.id === cron.id);
    expect(found?.notify_on_run).toBe(1);
  });
});
