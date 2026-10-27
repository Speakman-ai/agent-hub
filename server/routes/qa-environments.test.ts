import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDb, initDb } from '../db.js';
import { __setSecretCryptoKeyFilePathForTests, MASK } from '../secret-crypto.js';
import type { Project, RouteDeps } from '../types.js';
import createQaEnvironmentRoutes from './qa-environments.js';

const broadcast = vi.fn();
const projects: Record<string, Project> = {
  proj: { id: 'proj', name: 'Proj', cwd: '/tmp/proj', ahw: '/tmp/ahw', agents: [] },
};
let role = 'Admin';
let app: Express;

beforeAll(() => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ah-qa-env-routes-'));
  __setSecretCryptoKeyFilePathForTests(path.join(dir, 'key'));
  initDb(dir);
  app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as unknown as Record<string, unknown>).authRole = role;
    next();
  });
  app.use(
    createQaEnvironmentRoutes({
      broadcast,
      findProject: (id: string) => projects[id] ?? null,
    } as unknown as RouteDeps),
  );
});

beforeEach(() => {
  getDb().exec('DELETE FROM qa_environments');
  broadcast.mockClear();
  role = 'Admin';
});

const base = '/api/projects/proj/qa/environments';

describe('QA environment routes', () => {
  it('creates, lists masked, updates, and deletes', async () => {
    const created = await request(app)
      .post(base)
      .send({
        name: 'Staging',
        baseUrl: 'https://staging.example.com',
        notes: 'v2.4 build',
        accounts: [{ label: 'Admin', username: 'a@x.com', password: 'secret-pw' }],
      })
      .expect(201);
    const env = created.body.environment;
    expect(env.accounts[0]).toMatchObject({ username: 'a@x.com', password: MASK });
    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'qa_update', action: 'environments_updated' }),
    );

    const list = await request(app).get(base).expect(200);
    expect(list.body.environments).toHaveLength(1);
    expect(JSON.stringify(list.body)).not.toContain('secret-pw');

    const patched = await request(app)
      .patch(`${base}/${env.id}`)
      .send({ notes: 'v2.5 build' })
      .expect(200);
    expect(patched.body.environment).toMatchObject({ notes: 'v2.5 build' });
    expect(patched.body.environment.accounts[0].hasPassword).toBe(true);

    await request(app).delete(`${base}/${env.id}`).expect(200);
    await request(app).delete(`${base}/${env.id}`).expect(404);
  });

  it('validates input', async () => {
    await request(app).post(base).send({ name: '' }).expect(400);
    await request(app).post(base).send({ name: 'X', baseUrl: 'not a url' }).expect(400);
    await request(app)
      .post(base)
      .send({ name: 'X', accounts: [{ label: '' }] })
      .expect(400);
  });

  it('requires Admin to write but lets members read', async () => {
    role = 'User';
    await request(app).post(base).send({ name: 'Staging' }).expect(403);
    await request(app).get(base).expect(200);
  });

  it('404s an unknown project', async () => {
    await request(app).get('/api/projects/nope/qa/environments').expect(404);
  });
});
