import type TestAgent from 'supertest/lib/agent.js';
import express from 'express';
import supertest from 'supertest';
import { getRequest, createProject } from './helpers.js';
import type { CronRow } from '../types.js';
import config from '../config.js';
import type { AuthenticatedRequest } from '../auth.js';
import createConfigRoutes from '../routes/config.js';
import { routeDeps } from '../index.js';
import { getStmts } from '../db.js';

let request: TestAgent;

beforeAll(async () => {
  request = await getRequest();
});

function configRoutesAs(userId: string): supertest.Agent {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as AuthenticatedRequest).authUserId = userId;
    next();
  });
  app.use(createConfigRoutes(routeDeps));
  return supertest(app);
}

/**
 * Regression coverage for the import paths in `server/routes/config.ts`.
 *
 * Both `POST /api/projects/:projectId/import` (v3 project export) and
 * `POST /api/config/import` (legacy v1/v2 export) call
 * `stmts.createCron.run(...)` directly. When the prepared statement gained
 * the 10th `skill_principal_agent_id` column alongside `model`, import call
 * sites must stay arity-matched — better-sqlite3 throws `RangeError: Too few
 * parameter values were provided` otherwise.
 */
describe('config import: cron `model` field', () => {
  const validModels = config.engineValidModels['claude-code'] || [];
  const validModel = validModels[0];

  // Loud failure beats silent skip if the test config ever ships an empty
  // allowlist — without a valid id, the round-trip assertions below would
  // pass against `model: undefined` (= null) and miss real bugs.
  it('precondition: claude-code allowlist has at least one model', () => {
    expect(validModels.length).toBeGreaterThan(0);
  });

  describe('POST /api/config/import (legacy v1/v2)', () => {
    it('imports a cron with a valid model id (10-arg createCron signature)', async () => {
      const cronName = `import-valid-${Math.random().toString(36).slice(2, 8)}`;
      const res = await request
        .post('/api/config/import')
        .send({
          version: 2,
          crons: [
            {
              name: cronName,
              schedule: '0 * * * *',
              prompt: 'echo hi',
              cwd: '/tmp',
              enabled: false,
              model: validModel,
            },
          ],
        })
        .expect(200);

      expect(res.body.results.crons).toMatch(/1 new/);

      const list = await request.get('/api/crons').expect(200);
      const found = (list.body as CronRow[]).find((c) => c.name === cronName);
      expect(found).toBeDefined();
      expect(found?.model).toBe(validModel);
    });

    it('imports a cron with no `model` field (omitted → null default)', async () => {
      const cronName = `import-omit-${Math.random().toString(36).slice(2, 8)}`;
      await request
        .post('/api/config/import')
        .send({
          version: 2,
          crons: [
            {
              name: cronName,
              schedule: '0 * * * *',
              prompt: 'echo hi',
              cwd: '/tmp',
              enabled: false,
            },
          ],
        })
        .expect(200);

      const list = await request.get('/api/crons').expect(200);
      const found = (list.body as CronRow[]).find((c) => c.name === cronName);
      expect(found).toBeDefined();
      expect(found?.model).toBeNull();
    });

    it('falls back to null when the imported model id is unknown (does not 500)', async () => {
      const cronName = `import-bogus-${Math.random().toString(36).slice(2, 8)}`;
      await request
        .post('/api/config/import')
        .send({
          version: 2,
          crons: [
            {
              name: cronName,
              schedule: '0 * * * *',
              prompt: 'echo hi',
              cwd: '/tmp',
              enabled: false,
              model: 'claude-totally-not-a-real-model',
            },
          ],
        })
        .expect(200);

      const list = await request.get('/api/crons').expect(200);
      const found = (list.body as CronRow[]).find((c) => c.name === cronName);
      expect(found).toBeDefined();
      expect(found?.model).toBeNull();
    });

    it('stamps imported crons with the authenticated importer owner id', async () => {
      const ownerUserId = 'legacy-import-owner';
      const cronName = `import-owner-${Math.random().toString(36).slice(2, 8)}`;
      await configRoutesAs(ownerUserId)
        .post('/api/config/import')
        .send({
          version: 2,
          crons: [
            {
              name: cronName,
              schedule: '0 * * * *',
              prompt: 'echo hi',
              cwd: '/tmp',
              enabled: false,
            },
          ],
        })
        .expect(200);

      const found = (getStmts().getCrons.all() as CronRow[]).find((c) => c.name === cronName);
      expect(found).toBeDefined();
      expect(found?.owner_user_id).toBe(ownerUserId);
    });
  });

  describe('POST /api/projects/:projectId/import (v3 project)', () => {
    // Each test creates its own project so they're independent — the
    // v3 import endpoint requires the target project to already exist
    // (404s otherwise) and we don't want to depend on whatever the
    // previous test left behind.
    async function someProjectId(): Promise<string> {
      const project = await createProject();
      return project.id as string;
    }

    it('imports a cron with a valid model id (10-arg createCron signature)', async () => {
      const projectId = await someProjectId();
      const cronName = `pimport-valid-${Math.random().toString(36).slice(2, 8)}`;

      const res = await request
        .post(`/api/projects/${projectId}/import`)
        .send({
          version: 3,
          type: 'project',
          crons: [
            {
              name: cronName,
              schedule: '0 * * * *',
              prompt: 'echo hi',
              enabled: false,
              model: validModel,
            },
          ],
        })
        .expect(200);

      // v3 wraps the per-section status under `results`, unlike the
      // legacy v1/v2 endpoint which flattens those onto the top-level
      // body. The cron summary lives at `body.results.crons`.
      expect(res.body.results.crons).toMatch(/1 new/);

      const list = await request.get('/api/crons').expect(200);
      const found = (list.body as CronRow[]).find((c) => c.name === cronName);
      expect(found).toBeDefined();
      expect(found?.model).toBe(validModel);
    });

    it('falls back to null when the imported model id is unknown (does not 500)', async () => {
      const projectId = await someProjectId();
      const cronName = `pimport-bogus-${Math.random().toString(36).slice(2, 8)}`;

      await request
        .post(`/api/projects/${projectId}/import`)
        .send({
          version: 3,
          type: 'project',
          crons: [
            {
              name: cronName,
              schedule: '0 * * * *',
              prompt: 'echo hi',
              enabled: false,
              model: 'claude-totally-not-a-real-model',
            },
          ],
        })
        .expect(200);

      const list = await request.get('/api/crons').expect(200);
      const found = (list.body as CronRow[]).find((c) => c.name === cronName);
      expect(found).toBeDefined();
      expect(found?.model).toBeNull();
    });

    it('imports a cron with no `model` field (omitted → null default)', async () => {
      const projectId = await someProjectId();
      const cronName = `pimport-omit-${Math.random().toString(36).slice(2, 8)}`;

      await request
        .post(`/api/projects/${projectId}/import`)
        .send({
          version: 3,
          type: 'project',
          crons: [
            {
              name: cronName,
              schedule: '0 * * * *',
              prompt: 'echo hi',
              enabled: false,
            },
          ],
        })
        .expect(200);

      const list = await request.get('/api/crons').expect(200);
      const found = (list.body as CronRow[]).find((c) => c.name === cronName);
      expect(found).toBeDefined();
      expect(found?.model).toBeNull();
    });

    it('stamps imported project crons with the authenticated importer owner id', async () => {
      const ownerUserId = 'v3-import-owner';
      const projectId = await someProjectId();
      const cronName = `pimport-owner-${Math.random().toString(36).slice(2, 8)}`;

      await configRoutesAs(ownerUserId)
        .post(`/api/projects/${projectId}/import`)
        .send({
          version: 3,
          type: 'project',
          crons: [
            {
              name: cronName,
              schedule: '0 * * * *',
              prompt: 'echo hi',
              enabled: false,
            },
          ],
        })
        .expect(200);

      const found = (getStmts().getCrons.all() as CronRow[]).find((c) => c.name === cronName);
      expect(found).toBeDefined();
      expect(found?.owner_user_id).toBe(ownerUserId);
    });
  });
});
