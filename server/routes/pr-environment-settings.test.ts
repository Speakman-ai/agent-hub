/**
 * `GET /pr-environments` and `PUT /pr-environments/limits`, mounted
 * standalone with a stub auth middleware and a stub service.
 */
import express from 'express';
import request from 'supertest';
import { describe, it, expect, vi } from 'vitest';
import createPrEnvironmentSettingsRoutes from './pr-environment-settings.js';
import { DEFAULT_PR_ENVIRONMENT_LIMITS } from '../preview/pr-environment-limits.js';
import type { Project } from '../types.js';

function makeApp(role = 'Owner', previewSubdomainBase: string | null = 'preview.example') {
  const project = { id: 'proj-a' } as Project;
  const saveProjects = vi.fn();
  const env = { id: 'e1', projectId: 'proj-a', prNumber: 4, status: 'ready', url: 'http://up' };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as express.Request & { authRole: string }).authRole = role;
    next();
  });
  app.use(
    createPrEnvironmentSettingsRoutes({
      findProject: (id: string) => (id === 'proj-a' ? project : null),
      saveProjects,
      config: { previewSubdomainBase },
      prEnvironments: { list: () => [env] },
      presentPrEnvironment: (e: { url: string | null }) => ({ ...e, url: 'https://public' }),
    } as never),
  );
  return { app, project, saveProjects };
}

describe('PR environment settings routes', () => {
  it('reports idle sleep as not enforced without wildcard ingress', async () => {
    const on = await request(makeApp().app).get('/api/projects/proj-a/pr-environments');
    expect(on.body).toMatchObject({ wakeOnRequest: true, enforced: DEFAULT_PR_ENVIRONMENT_LIMITS });
    const off = await request(makeApp('Owner', null).app).get(
      '/api/projects/proj-a/pr-environments',
    );
    expect(off.body.wakeOnRequest).toBe(false);
    expect(off.body.enforced).toEqual({ ...DEFAULT_PR_ENVIRONMENT_LIMITS, idleTtlMinutes: 0 });
    expect(off.body.limits).toEqual(DEFAULT_PR_ENVIRONMENT_LIMITS);
  });

  it('lists environments (public URLs) with the default limits', async () => {
    const { app } = makeApp();
    const res = await request(app).get('/api/projects/proj-a/pr-environments');
    expect(res.status).toBe(200);
    expect(res.body.limits).toEqual(DEFAULT_PR_ENVIRONMENT_LIMITS);
    expect(res.body.overrides).toEqual({});
    expect(res.body.environments).toEqual([
      expect.objectContaining({ prNumber: 4, url: 'https://public' }),
    ]);
  });

  it('saves overrides, resets with null, and rejects out-of-bounds values', async () => {
    const { app, project, saveProjects } = makeApp();
    const put = (body: object) =>
      request(app).put('/api/projects/proj-a/pr-environments/limits').send(body);

    const saved = await put({ maxConcurrent: 2, idleTtlMinutes: 0 });
    expect(saved.status).toBe(200);
    expect(saved.body.limits).toMatchObject({ maxConcurrent: 2, idleTtlMinutes: 0 });
    expect(project.prEnvironmentLimits).toEqual({ maxConcurrent: 2, idleTtlMinutes: 0 });
    expect(saveProjects).toHaveBeenCalledTimes(1);

    expect((await put({ idleTtlMinutes: 2 })).status).toBe(400);
    expect(saveProjects).toHaveBeenCalledTimes(1);

    await put({ maxConcurrent: null, idleTtlMinutes: null });
    expect(project.prEnvironmentLimits).toBeUndefined();
  });

  it('requires Admin and a known project', async () => {
    expect(
      (await request(makeApp('User').app).get('/api/projects/proj-a/pr-environments')).status,
    ).toBe(403);
    expect((await request(makeApp().app).get('/api/projects/nope/pr-environments')).status).toBe(
      404,
    );
  });
});
