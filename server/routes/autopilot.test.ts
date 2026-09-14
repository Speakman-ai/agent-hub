import '../test/setup.js';
import express, { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { beforeEach, describe, expect, it } from 'vitest';
import { initDb, getDb } from '../db.js';
import type { Project, RouteDeps } from '../types.js';
import createAutopilotRoutes from './autopilot.js';
import {
  autopilotWorkerGuard,
  configureAutopilotWorkerOperationLookup,
} from '../autopilot/worker-authority.js';
import { AutopilotStore } from '../autopilot/store.js';

const PROJECT_ID = 'autopilot-proj';

const READY = {
  enabled: true,
  brief: 'Build a disposable notes API with a browser-testable list.',
  target: {
    targetId: 'local-notes',
    origin: 'http://127.0.0.1:4310',
    readinessProbeUrl: 'http://127.0.0.1:4310/health',
  },
  limits: {
    cycleMode: 'continuous',
    maxWallTimeMs: 3_600_000,
    maxStageTimeoutMs: 600_000,
    maxRetriesPerStage: 2,
  },
  credentialOwnerUserId: 'user-1',
};

function makeApp(
  role: 'Owner' | 'Admin' | 'User' | null = 'Owner',
  extras?: { worker?: { projectId: string; runId: string } },
) {
  const project = {
    id: PROJECT_ID,
    name: 'Autopilot Project',
    cwd: '/tmp/project',
    agents: [],
  } as unknown as Project;
  const other = {
    id: 'other-proj',
    name: 'Other',
    cwd: '/tmp/other',
    agents: [],
  } as unknown as Project;
  const deps = {
    findProject: (id: string) => (id === PROJECT_ID ? project : id === 'other-proj' ? other : null),
  } as unknown as RouteDeps;
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (role) {
      (req as unknown as { authRole?: string; authUserId?: string }).authRole = role;
      (req as unknown as { authRole?: string; authUserId?: string }).authUserId = 'user-1';
    }
    if (extras?.worker) {
      (req as unknown as { authAutopilotWorker?: typeof extras.worker }).authAutopilotWorker =
        extras.worker;
    }
    next();
  });
  app.use(autopilotWorkerGuard);
  app.use(
    createAutopilotRoutes(deps, {
      isServerEnabled: () => true,
      assertContainment: () => undefined,
      issueWorkerCredential: ({ projectId, runId }) => ({
        keyName: `autopilot:${projectId}:${runId}`,
        keyId: `key-${runId}`,
        token: `ahub_worker_${runId}`,
      }),
      revokeWorkerCredential: () => undefined,
      credentialOwnerExists: () => true,
    }),
  );
  return app;
}

beforeEach(() => {
  initDb(mkdtempSync(path.join(tmpdir(), 'ah-autopilot-')));
  configureAutopilotWorkerOperationLookup((operationId) => {
    const store = new AutopilotStore(getDb());
    const op = store.getOperation(operationId);
    if (!op) return null;
    const run = store.getRun(op.runId);
    if (!run) return null;
    return { projectId: run.projectId, runId: run.id };
  });
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

  it('denies a worker credential for another project and protected config', async () => {
    const app = makeApp('Admin');
    await request(app).put(`/api/projects/${PROJECT_ID}/autopilot/config`).send(READY).expect(200);
    const started = await request(app)
      .post(`/api/projects/${PROJECT_ID}/autopilot/start`)
      .send({})
      .expect(201);
    const runId = started.body.run.id as string;
    const workerApp = makeApp('Admin', { worker: { projectId: PROJECT_ID, runId } });

    const other = await request(workerApp).get('/api/projects/other-proj/autopilot');
    expect(other.status).toBe(403);
    expect(other.body.code).toBe('authority_denied');

    const protectedWrite = await request(workerApp)
      .put(`/api/projects/${PROJECT_ID}/autopilot/config`)
      .send({ brief: 'worker must not rewrite the brief' });
    expect(protectedWrite.status).toBe(403);
    expect(protectedWrite.body.code).toBe('authority_denied');

    const own = await request(workerApp).get(`/api/projects/${PROJECT_ID}/autopilot`).expect(200);
    expect(own.body.activeRun.run.id).toBe(runId);

    const global = await request(workerApp).get('/api/config');
    expect(global.status).toBe(403);
    expect(global.body.code).toBe('authority_denied');

    const deploy = await request(workerApp)
      .patch(`/api/projects/${PROJECT_ID}/deploy/environments/prod`)
      .send({ enabled: false });
    expect(deploy.status).toBe(403);
    expect(deploy.body.code).toBe('authority_denied');
  });

  it("denies a worker completing another run's operation", async () => {
    const app = makeApp('Admin');
    await request(app).put(`/api/projects/${PROJECT_ID}/autopilot/config`).send(READY).expect(200);
    const first = await request(app).post(`/api/projects/${PROJECT_ID}/autopilot/start`).send({});
    expect(first.status).toBe(201);
    const firstOp = first.body.operations[0].id as string;
    const firstGen = first.body.run.fencingGeneration as number;
    await request(app).post(`/api/projects/${PROJECT_ID}/autopilot/stop`).expect(200);

    const second = await request(app).post(`/api/projects/${PROJECT_ID}/autopilot/start`).send({});
    expect(second.status).toBe(201);
    const workerApp = makeApp('Admin', {
      worker: { projectId: PROJECT_ID, runId: second.body.run.id as string },
    });
    const stolen = await request(workerApp)
      .post(`/api/projects/${PROJECT_ID}/autopilot/operations/${firstOp}/complete`)
      .send({ fencingGeneration: firstGen, outcome: 'succeeded' });
    expect(stolen.status).toBe(403);
    expect(stolen.body.code).toBe('authority_denied');
  });
});
