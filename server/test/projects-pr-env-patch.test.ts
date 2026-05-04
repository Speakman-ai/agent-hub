import type supertest from 'supertest';
import { getRequest, createProject } from './helpers.js';

// ═══════════════════════════════════════════════════════════════════
// PATCH /api/projects/:projectId — prEnv slot
//
// The PR-env per-project config is persisted via the existing
// `PATCH /api/projects/:id` route, which calls `validatePrEnvProjectConfig`
// before writing the slot. The pure validator is covered in
// `routes/pr-env-project-validate.test.ts`; these supertest cases close
// the integration gap by hitting the real route and asserting the 400
// path bubbles up the validator's error message verbatim.
// ═══════════════════════════════════════════════════════════════════

let request: supertest.Agent;

beforeAll(async () => {
  request = await getRequest();
});

describe('PATCH /api/projects/:projectId — prEnv', () => {
  it('persists a valid prEnv slot to the project', async () => {
    const project = await createProject();
    const projectId = project.id as string;
    const res = await request
      .patch(`/api/projects/${projectId}`)
      .send({
        prEnv: {
          enabled: true,
          startScript: 'npm start',
          internalPort: 3000,
          setupCommand: 'npm install',
          healthPath: '/healthz',
        },
      })
      .expect(200);
    const body = res.body as { prEnv?: Record<string, unknown> };
    expect(body.prEnv).toEqual({
      enabled: true,
      startScript: 'npm start',
      internalPort: 3000,
      setupCommand: 'npm install',
      healthPath: '/healthz',
    });
  });

  it('rejects with 400 when startScript is missing on an enabled config', async () => {
    const project = await createProject();
    const projectId = project.id as string;
    const res = await request
      .patch(`/api/projects/${projectId}`)
      .send({ prEnv: { enabled: true, internalPort: 3000 } })
      .expect(400);
    const body = res.body as { error: string };
    expect(body.error).toMatch(/startScript/);
  });

  it('rejects with 400 when dockerfilePath is absolute', async () => {
    const project = await createProject();
    const projectId = project.id as string;
    const res = await request
      .patch(`/api/projects/${projectId}`)
      .send({
        prEnv: {
          enabled: true,
          startScript: 'npm start',
          internalPort: 3000,
          dockerfilePath: '/etc/passwd',
        },
      })
      .expect(400);
    const body = res.body as { error: string };
    expect(body.error).toMatch(/dockerfilePath/);
    expect(body.error).toMatch(/relative/i);
  });

  it('rejects with 400 when dockerfilePath escapes the repo root via ..', async () => {
    const project = await createProject();
    const projectId = project.id as string;
    const res = await request
      .patch(`/api/projects/${projectId}`)
      .send({
        prEnv: {
          enabled: true,
          startScript: 'npm start',
          internalPort: 3000,
          dockerfilePath: '../../etc/passwd',
        },
      })
      .expect(400);
    const body = res.body as { error: string };
    expect(body.error).toMatch(/dockerfilePath/);
    expect(body.error).toMatch(/escape/i);
  });

  it('round-trips enabled=false (toggle-off path)', async () => {
    const project = await createProject();
    const projectId = project.id as string;
    // First populate the slot.
    await request
      .patch(`/api/projects/${projectId}`)
      .send({
        prEnv: { enabled: true, startScript: 'npm start', internalPort: 3000 },
      })
      .expect(200);
    // Then toggle it off.
    const res = await request
      .patch(`/api/projects/${projectId}`)
      .send({ prEnv: { enabled: false } })
      .expect(200);
    const body = res.body as { prEnv?: Record<string, unknown> };
    expect(body.prEnv).toEqual({ enabled: false });
  });

  it('persists per-project env vars round-trip through PATCH', async () => {
    const project = await createProject();
    const projectId = project.id as string;
    const res = await request
      .patch(`/api/projects/${projectId}`)
      .send({
        prEnv: {
          enabled: true,
          startScript: 'npm start',
          internalPort: 3000,
          env: {
            AWS_ACCESS_KEY_ID: 'AKIATEST',
            AWS_SECRET_ACCESS_KEY: 'shhh',
          },
        },
      })
      .expect(200);
    const body = res.body as { prEnv?: Record<string, unknown> };
    expect(body.prEnv).toEqual({
      enabled: true,
      startScript: 'npm start',
      internalPort: 3000,
      env: {
        AWS_ACCESS_KEY_ID: 'AKIATEST',
        AWS_SECRET_ACCESS_KEY: 'shhh',
      },
    });
  });

  it('rejects with 400 when env contains a reserved key (PORT)', async () => {
    const project = await createProject();
    const projectId = project.id as string;
    const res = await request
      .patch(`/api/projects/${projectId}`)
      .send({
        prEnv: {
          enabled: true,
          startScript: 'npm start',
          internalPort: 3000,
          env: { PORT: '9999' },
        },
      })
      .expect(400);
    const body = res.body as { error: string };
    expect(body.error).toMatch(/PORT/);
    expect(body.error).toMatch(/reserved/i);
  });

  it('rejects with 400 when env contains an invalid key name', async () => {
    const project = await createProject();
    const projectId = project.id as string;
    const res = await request
      .patch(`/api/projects/${projectId}`)
      .send({
        prEnv: {
          enabled: true,
          startScript: 'npm start',
          internalPort: 3000,
          env: { 'has-dash': 'x' },
        },
      })
      .expect(400);
    const body = res.body as { error: string };
    expect(body.error).toMatch(/has-dash/);
  });

  it('persists a fully-populated preview block round-trip through PATCH', async () => {
    const project = await createProject();
    const projectId = project.id as string;
    const res = await request
      .patch(`/api/projects/${projectId}`)
      .send({
        prEnv: {
          enabled: true,
          startScript: 'npm start',
          internalPort: 3000,
          preview: {
            enabled: true,
            startScript: 'npm run preview',
            port: 4173,
            captureRoutes: ['/', '/about'],
            idleTTL: 600,
          },
        },
      })
      .expect(200);
    const body = res.body as { prEnv?: Record<string, unknown> };
    expect(body.prEnv).toEqual({
      enabled: true,
      startScript: 'npm start',
      internalPort: 3000,
      preview: {
        enabled: true,
        startScript: 'npm run preview',
        port: 4173,
        captureRoutes: ['/', '/about'],
        idleTTL: 600,
      },
    });
  });

  it('rejects with 400 when preview.enabled=true but parent enabled=false', async () => {
    const project = await createProject();
    const projectId = project.id as string;
    const res = await request
      .patch(`/api/projects/${projectId}`)
      .send({ prEnv: { enabled: false, preview: { enabled: true } } })
      .expect(400);
    const body = res.body as { error: string };
    expect(body.error).toMatch(/preview/i);
    expect(body.error).toMatch(/requires/i);
  });

  it('rejects with 400 when preview.captureRoutes contains a non-/-prefixed entry', async () => {
    const project = await createProject();
    const projectId = project.id as string;
    const res = await request
      .patch(`/api/projects/${projectId}`)
      .send({
        prEnv: {
          enabled: true,
          startScript: 'npm start',
          internalPort: 3000,
          preview: { enabled: true, captureRoutes: ['/', 'about'] },
        },
      })
      .expect(400);
    const body = res.body as { error: string };
    expect(body.error).toMatch(/captureRoutes/);
  });

  it('clears the prEnv slot when sent as null', async () => {
    const project = await createProject();
    const projectId = project.id as string;
    await request
      .patch(`/api/projects/${projectId}`)
      .send({
        prEnv: { enabled: true, startScript: 'npm start', internalPort: 3000 },
      })
      .expect(200);
    const res = await request.patch(`/api/projects/${projectId}`).send({ prEnv: null }).expect(200);
    const body = res.body as { prEnv?: unknown };
    expect(body.prEnv).toBeUndefined();
  });
});
