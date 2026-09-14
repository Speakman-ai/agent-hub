import '../test/setup.js';
import express, { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { beforeEach, describe, expect, it } from 'vitest';
import { initDb } from '../db.js';
import type { Project, RouteDeps } from '../types.js';
import createAutopilotRoutes from './autopilot.js';

const PROJECT_ID = 'autopilot-proj';

const READY = {
  enabled: true,
  brief: 'Build a disposable notes API with a browser-testable list.',
  target: { targetId: 'local-notes' },
  limits: {
    cycleMode: 'continuous',
    maxWallTimeMs: 3_600_000,
    maxStageTimeoutMs: 600_000,
    maxRetriesPerStage: 2,
  },
  credentialOwnerUserId: 'user-1',
};

function makeApp(role: 'Owner' | 'Admin' | 'User' | null = 'Owner') {
  const project = {
    id: PROJECT_ID,
    name: 'Autopilot Project',
    cwd: '/tmp/project',
    agents: [],
  } as unknown as Project;
  const deps = {
    findProject: (id: string) => (id === PROJECT_ID ? project : null),
  } as unknown as RouteDeps;
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (role) {
      (req as unknown as { authRole?: string; authUserId?: string }).authRole = role;
      (req as unknown as { authRole?: string; authUserId?: string }).authUserId = 'user-1';
    }
    next();
  });
  app.use(createAutopilotRoutes(deps, { isServerEnabled: () => true }));
  return app;
}

beforeEach(() => {
  initDb(mkdtempSync(path.join(tmpdir(), 'ah-autopilot-')));
});

describe('autopilot routes', () => {
  it('returns disabled project state before configuration', async () => {
    const res = await request(makeApp('User')).get(`/api/projects/${PROJECT_ID}/autopilot`);
    expect(res.status).toBe(200);
    expect(res.body.serverEnabled).toBe(true);
    expect(res.body.config.enabled).toBe(false);
    expect(res.body.config.disabling).toBe(false);
    expect(res.body.activeRun).toBeNull();
  });

  it('rejects duplicate start', async () => {
    const app = makeApp('Admin');
    await request(app).put(`/api/projects/${PROJECT_ID}/autopilot/config`).send(READY).expect(200);
    const first = await request(app).post(`/api/projects/${PROJECT_ID}/autopilot/start`).send({});
    expect(first.status).toBe(201);
    expect(first.body.run.controlState).toBe('running');
    const before = await request(app).get(`/api/projects/${PROJECT_ID}/autopilot`).expect(200);
    const second = await request(app)
      .post(`/api/projects/${PROJECT_ID}/autopilot/start`)
      .send({
        brief: 'A different brief from a rejected duplicate start.',
        target: { targetId: 'other-target' },
        limits: {
          cycleMode: 'finite',
          maxCycles: 1,
          maxWallTimeMs: 5_000,
          maxStageTimeoutMs: 2_000,
          maxRetriesPerStage: 0,
        },
        credentialOwnerUserId: 'intruder',
      });
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('already_active');
    const after = await request(app).get(`/api/projects/${PROJECT_ID}/autopilot`).expect(200);
    expect(after.body.config.brief).toBe(before.body.config.brief);
    expect(after.body.config.target.targetId).toBe(READY.target.targetId);
    expect(after.body.config.limits).toEqual(before.body.config.limits);
    expect(after.body.config.credentialOwnerUserId).toBe(READY.credentialOwnerUserId);
    expect(after.body.activeRun.run.id).toBe(first.body.run.id);
    expect(after.body.activeRun.run.credentialOwnerUserId).toBe(
      first.body.run.credentialOwnerUserId,
    );
  });

  it('pauses, resumes, stops and disables through the HTTP API', async () => {
    const app = makeApp('Admin');
    await request(app).put(`/api/projects/${PROJECT_ID}/autopilot/config`).send(READY).expect(200);
    const started = await request(app)
      .post(`/api/projects/${PROJECT_ID}/autopilot/start`)
      .send({})
      .expect(201);
    const runId = started.body.run.id as string;

    const paused = await request(app)
      .post(`/api/projects/${PROJECT_ID}/autopilot/pause`)
      .expect(200);
    expect(paused.body.run.controlState).toBe('paused');

    const resumed = await request(app)
      .post(`/api/projects/${PROJECT_ID}/autopilot/resume`)
      .expect(200);
    expect(resumed.body.run.controlState).toBe('running');
    expect(resumed.body.run.fencingGeneration).toBeGreaterThan(started.body.run.fencingGeneration);

    const stopped = await request(app)
      .post(`/api/projects/${PROJECT_ID}/autopilot/stop`)
      .expect(200);
    expect(stopped.body.run.controlState).toBe('stopped');

    const read = await request(app)
      .get(`/api/projects/${PROJECT_ID}/autopilot/runs/${runId}`)
      .expect(200);
    expect(read.body.run.controlState).toBe('stopped');

    const disabled = await request(app)
      .post(`/api/projects/${PROJECT_ID}/autopilot/disable`)
      .expect(200);
    expect(disabled.body.config.enabled).toBe(false);

    const resume = await request(app).post(`/api/projects/${PROJECT_ID}/autopilot/resume`);
    expect(resume.status).toBe(403);
    expect(resume.body.code).toBe('not_enabled');
  });

  it('rejects a stale operation callback after stop', async () => {
    const app = makeApp('Admin');
    await request(app).put(`/api/projects/${PROJECT_ID}/autopilot/config`).send(READY).expect(200);
    const started = await request(app)
      .post(`/api/projects/${PROJECT_ID}/autopilot/start`)
      .send({})
      .expect(201);
    const operationId = started.body.operations[0].id as string;
    const gen = started.body.run.fencingGeneration as number;
    await request(app).post(`/api/projects/${PROJECT_ID}/autopilot/stop`).expect(200);
    const complete = await request(app)
      .post(`/api/projects/${PROJECT_ID}/autopilot/operations/${operationId}/complete`)
      .send({ fencingGeneration: gen, outcome: 'succeeded' });
    expect(complete.status).toBe(409);
    expect(complete.body.code).toBe('stale_generation');
  });
});
