import type TestAgent from 'supertest/lib/agent.js';
import { getRequest } from './helpers.js';
import type { CronRow } from '../types.js';
import config from '../config.js';

let request: TestAgent;

beforeAll(async () => {
  request = await getRequest();
});

/**
 * Per-cron `model` lets the operator pick which Claude variant fires when the
 * cron triggers (previously hardcoded to `claude-opus-4-8` in heartbeat.ts).
 * These tests cover the API contract:
 *
 *   - POST persists a valid id and round-trips on GET.
 *   - POST defaults to null when omitted (= "use engine default at run time").
 *   - POST rejects unknown ids and non-string types with 400.
 *   - PUT updates, clears, and rejects invalid ids without touching the row.
 *
 * Validation runs against `config.engineValidModels['claude-code']` because
 * crons currently always run via that engine.
 */
describe('crons: per-cron model', () => {
  const validModels = config.engineValidModels['claude-code'] || [];
  const validModel = validModels[0];
  const otherValidModel = validModels[1] || validModels[0];

  // Loud failure beats silent skip if the test config ever ships an empty
  // allowlist — without a valid id, every `model: validModel` payload would
  // be `model: undefined`, which the API normalizes to null, so the
  // round-trip and PUT-update assertions would silently pass against the
  // wrong values. Asserting the precondition up front keeps that drift
  // from going unnoticed.
  it('precondition: claude-code allowlist has at least one model', () => {
    expect(validModels.length).toBeGreaterThan(0);
  });

  async function createCron(body: Record<string, unknown> = {}): Promise<CronRow> {
    const res = await request
      .post('/api/crons')
      .send({
        name: `Model Test ${Math.random().toString(36).slice(2, 8)}`,
        schedule: '0 * * * *',
        prompt: 'echo hi',
        cwd: '/tmp',
        enabled: false,
        ...body,
      })
      .expect(200);
    return res.body as CronRow;
  }

  it('POST /api/crons persists a valid model id and round-trips through GET', async () => {
    const cron = await createCron({ model: validModel });
    expect(cron.model).toBe(validModel);

    const list = await request.get('/api/crons').expect(200);
    const found = (list.body as CronRow[]).find((c) => c.id === cron.id);
    expect(found?.model).toBe(validModel);
  });

  it('POST /api/crons defaults model to null when omitted', async () => {
    const cron = await createCron({});
    expect(cron.model).toBeNull();
  });

  it('POST /api/crons treats explicit empty string as null', async () => {
    // The web client renders an empty <option> for "use engine default" and
    // sends '' through the JSON body. Treating that as null on the server
    // keeps the row stable when the user re-opens the form for editing.
    const cron = await createCron({ model: '' });
    expect(cron.model).toBeNull();
  });

  it('POST /api/crons rejects unknown model ids with 400', async () => {
    await request
      .post('/api/crons')
      .send({
        name: `Bad Model ${Math.random().toString(36).slice(2, 8)}`,
        schedule: '0 * * * *',
        prompt: 'echo hi',
        cwd: '/tmp',
        enabled: false,
        model: 'claude-not-a-real-model-9001',
      })
      .expect(400);
  });

  it('POST /api/crons rejects non-string model values with 400', async () => {
    for (const bad of [123, true, { foo: 'bar' }, ['claude-opus-4-8']]) {
      await request
        .post('/api/crons')
        .send({
          name: `Bad Model Type ${Math.random().toString(36).slice(2, 8)}`,
          schedule: '0 * * * *',
          prompt: 'echo hi',
          cwd: '/tmp',
          enabled: false,
          model: bad,
        })
        .expect(400);
    }
  });

  it('PUT /api/crons/:id updates the model', async () => {
    const cron = await createCron({ model: validModel });
    const res = await request
      .put(`/api/crons/${cron.id}`)
      .send({ model: otherValidModel })
      .expect(200);
    expect((res.body as CronRow).model).toBe(otherValidModel);
  });

  it('PUT /api/crons/:id clears the model when explicitly set to null', async () => {
    const cron = await createCron({ model: validModel });
    const res = await request.put(`/api/crons/${cron.id}`).send({ model: null }).expect(200);
    expect((res.body as CronRow).model).toBeNull();
  });

  it('PUT /api/crons/:id leaves model unchanged when the field is absent', async () => {
    const cron = await createCron({ model: validModel });
    const res = await request.put(`/api/crons/${cron.id}`).send({ name: 'renamed' }).expect(200);
    expect((res.body as CronRow).model).toBe(validModel);
    expect((res.body as CronRow).name).toBe('renamed');
  });

  it('PUT /api/crons/:id rejects invalid model without mutating the row', async () => {
    const cron = await createCron({ model: validModel });
    await request
      .put(`/api/crons/${cron.id}`)
      .send({ model: 'claude-not-a-real-model-9001' })
      .expect(400);
    const after = await request.get('/api/crons').expect(200);
    const found = (after.body as CronRow[]).find((c) => c.id === cron.id);
    expect(found?.model).toBe(validModel);
  });
});
