import type TestAgent from 'supertest/lib/agent.js';
import { getRequest, createProject, createAgent } from './helpers.js';
import type { CronRow } from '../types.js';
import config from '../config.js';

let request: TestAgent;

beforeAll(async () => {
  request = await getRequest();
});

/**
 * `crons.engine` is the new per-row override that decides which CLI engine
 * the cron runs under (and which `engineValidModels[engine]` allowlist the
 * `model` field is validated against). When `engine` is null, the resolver
 * inherits from the resolved skill principal agent's `engine`, falling
 * back to `claude-code`.
 *
 * These tests cover the API contract:
 *
 *   - POST persists a valid engine, defaults to null when omitted, and
 *     rejects unknown engine ids / non-strings with 400.
 *   - POST validates `model` against the engine the cron will run under
 *     (explicit > principal > claude-code default), so a Cursor cron
 *     accepts a Cursor model and rejects a Claude model, and vice versa.
 *   - PUT updates engine + model, and re-validates the surviving model
 *     when only the engine changes.
 */
describe('crons: per-cron engine + per-engine model validation', () => {
  const claudeModels = config.engineValidModels['claude-code'] || [];
  const cursorModels = config.engineValidModels['cursor-agent'] || [];
  const claudeModel = claudeModels[0];
  const cursorModel = cursorModels[0];

  it('precondition: claude-code and cursor-agent allowlists are populated', () => {
    expect(claudeModels.length).toBeGreaterThan(0);
    expect(cursorModels.length).toBeGreaterThan(0);
    // The allowlists must be disjoint for the cross-engine rejection
    // assertions below to be meaningful — if a model id existed on both,
    // sending it under either engine would always pass.
    for (const m of claudeModels) expect(cursorModels.includes(m)).toBe(false);
  });

  async function createCron(body: Record<string, unknown> = {}): Promise<CronRow> {
    const res = await request
      .post('/api/crons')
      .send({
        name: `Engine Test ${Math.random().toString(36).slice(2, 8)}`,
        schedule: '0 * * * *',
        prompt: 'echo hi',
        cwd: '/tmp',
        enabled: false,
        ...body,
      })
      .expect(200);
    return res.body as CronRow;
  }

  describe('POST /api/crons engine field', () => {
    it('persists a valid engine id and round-trips through GET', async () => {
      const cron = await createCron({ engine: 'cursor-agent', model: cursorModel });
      expect(cron.engine).toBe('cursor-agent');

      const list = await request.get('/api/crons').expect(200);
      const found = (list.body as CronRow[]).find((c) => c.id === cron.id);
      expect(found?.engine).toBe('cursor-agent');
    });

    it('defaults engine to null when omitted', async () => {
      const cron = await createCron({});
      expect(cron.engine).toBeNull();
    });

    it('treats explicit empty string as null', async () => {
      const cron = await createCron({ engine: '' });
      expect(cron.engine).toBeNull();
    });

    it('rejects unknown engine ids with 400', async () => {
      await request
        .post('/api/crons')
        .send({
          name: `Bad Engine ${Math.random().toString(36).slice(2, 8)}`,
          schedule: '0 * * * *',
          prompt: 'echo hi',
          cwd: '/tmp',
          enabled: false,
          engine: 'made-up-engine',
        })
        .expect(400);
    });

    it('rejects non-string engine values with 400', async () => {
      for (const bad of [123, true, { foo: 'bar' }, ['claude-code']]) {
        await request
          .post('/api/crons')
          .send({
            name: `Bad Engine Type ${Math.random().toString(36).slice(2, 8)}`,
            schedule: '0 * * * *',
            prompt: 'echo hi',
            cwd: '/tmp',
            enabled: false,
            engine: bad,
          })
          .expect(400);
      }
    });
  });

  describe('POST /api/crons per-engine model validation', () => {
    it('accepts a Cursor model when engine is cursor-agent', async () => {
      const cron = await createCron({ engine: 'cursor-agent', model: cursorModel });
      expect(cron.engine).toBe('cursor-agent');
      expect(cron.model).toBe(cursorModel);
    });

    it('rejects a Claude model when engine is cursor-agent', async () => {
      await request
        .post('/api/crons')
        .send({
          name: `Cross Engine ${Math.random().toString(36).slice(2, 8)}`,
          schedule: '0 * * * *',
          prompt: 'echo hi',
          cwd: '/tmp',
          enabled: false,
          engine: 'cursor-agent',
          model: claudeModel,
        })
        .expect(400);
    });

    it('rejects a Cursor model when engine is claude-code', async () => {
      await request
        .post('/api/crons')
        .send({
          name: `Cross Engine 2 ${Math.random().toString(36).slice(2, 8)}`,
          schedule: '0 * * * *',
          prompt: 'echo hi',
          cwd: '/tmp',
          enabled: false,
          engine: 'claude-code',
          model: cursorModel,
        })
        .expect(400);
    });

    it('inherits engine from the sole agent on the project when engine is omitted', async () => {
      // Single-agent project on cursor-agent ⇒ resolveCronEngine should pick
      // cursor-agent ⇒ a Cursor model is accepted, a Claude model is rejected.
      const project = await createProject();
      const projectId = project.id as string;
      await createAgent({ projectId, engine: 'cursor-agent' });

      // Cursor model on a Cursor-inheriting cron: accepted.
      const ok = await request
        .post('/api/crons')
        .send({
          name: `Inherit OK ${Math.random().toString(36).slice(2, 8)}`,
          schedule: '0 * * * *',
          prompt: 'echo hi',
          cwd: '/tmp',
          enabled: false,
          project_id: projectId,
          model: cursorModel,
        })
        .expect(200);
      expect((ok.body as CronRow).engine).toBeNull();
      expect((ok.body as CronRow).model).toBe(cursorModel);

      // Claude model on a Cursor-inheriting cron: rejected.
      await request
        .post('/api/crons')
        .send({
          name: `Inherit Bad ${Math.random().toString(36).slice(2, 8)}`,
          schedule: '0 * * * *',
          prompt: 'echo hi',
          cwd: '/tmp',
          enabled: false,
          project_id: projectId,
          model: claudeModel,
        })
        .expect(400);
    });

    it('falls back to claude-code allowlist when no project / no principal can be resolved', async () => {
      // No project_id ⇒ findProjectForCron returns null ⇒ default engine is
      // claude-code ⇒ Claude model accepted, Cursor model rejected.
      const cron = await createCron({ model: claudeModel });
      expect(cron.model).toBe(claudeModel);

      await request
        .post('/api/crons')
        .send({
          name: `Default Cross ${Math.random().toString(36).slice(2, 8)}`,
          schedule: '0 * * * *',
          prompt: 'echo hi',
          cwd: '/tmp',
          enabled: false,
          model: cursorModel,
        })
        .expect(400);
    });
  });

  describe('PUT /api/crons/:id engine field', () => {
    it('updates the engine and accepts a model from the new engine in one PUT', async () => {
      const cron = await createCron({ engine: 'claude-code', model: claudeModel });
      const res = await request
        .put(`/api/crons/${cron.id}`)
        .send({ engine: 'cursor-agent', model: cursorModel })
        .expect(200);
      const body = res.body as CronRow;
      expect(body.engine).toBe('cursor-agent');
      expect(body.model).toBe(cursorModel);
    });

    it('clears the engine when explicitly set to null', async () => {
      const cron = await createCron({ engine: 'cursor-agent', model: cursorModel });
      const res = await request
        .put(`/api/crons/${cron.id}`)
        // Clearing engine alongside model so the surviving Cursor model
        // doesn't trip the auto-clear path; that path is exercised below.
        .send({ engine: null, model: null })
        .expect(200);
      expect((res.body as CronRow).engine).toBeNull();
    });

    it('rejects an invalid engine without mutating the row', async () => {
      const cron = await createCron({ engine: 'cursor-agent', model: cursorModel });
      await request.put(`/api/crons/${cron.id}`).send({ engine: 'made-up-engine' }).expect(400);
      const after = await request.get('/api/crons').expect(200);
      const found = (after.body as CronRow[]).find((c) => c.id === cron.id);
      expect(found?.engine).toBe('cursor-agent');
      expect(found?.model).toBe(cursorModel);
    });

    it('clears the model when changing engine renders the existing model invalid', async () => {
      // Existing row: cursor-agent + cursor model. PUT only the engine to
      // claude-code without re-sending model — the surviving Cursor model
      // is no longer in the claude-code allowlist, so the handler clears
      // it (rather than silently persisting an invalid pair).
      const cron = await createCron({ engine: 'cursor-agent', model: cursorModel });
      const res = await request
        .put(`/api/crons/${cron.id}`)
        .send({ engine: 'claude-code' })
        .expect(200);
      const body = res.body as CronRow;
      expect(body.engine).toBe('claude-code');
      expect(body.model).toBeNull();
    });

    it('keeps the model when changing engine and the existing model happens to be valid for both', async () => {
      // Pick a model that's only on one allowlist (claudeModel). Setting engine
      // to claude-code from null should keep the model intact.
      const cron = await createCron({ model: claudeModel });
      expect(cron.model).toBe(claudeModel);
      const res = await request
        .put(`/api/crons/${cron.id}`)
        .send({ engine: 'claude-code' })
        .expect(200);
      const body = res.body as CronRow;
      expect(body.engine).toBe('claude-code');
      expect(body.model).toBe(claudeModel);
    });
  });
});
