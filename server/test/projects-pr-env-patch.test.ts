import type supertest from 'supertest';
import { getRequest, createProject } from './helpers.js';

let request: supertest.Agent;

beforeAll(async () => {
  request = await getRequest();
});

describe('PATCH /api/projects/:projectId — prEnv', () => {
  it('persists a valid legacy PR-env slot', async () => {
    const project = await createProject();
    const res = await request.patch(`/api/projects/${project.id}`).send({
      prEnv: { enabled: true, startScript: 'npm start', internalPort: 3000 },
    });
    expect(res.status).toBe(200);
    expect(res.body.prEnv).toMatchObject({
      enabled: true,
      startScript: 'npm start',
      internalPort: 3000,
    });
  });

  it('persists a dev-server block independently of the parent flag', async () => {
    const project = await createProject();
    const res = await request.patch(`/api/projects/${project.id}`).send({
      prEnv: {
        enabled: false,
        devServer: {
          startCommand: 'npm run dev',
          portMap: [{ internalPort: 5173, label: 'web' }],
          idleTTL: 600,
        },
      },
    });
    expect(res.status).toBe(200);
    expect(res.body.prEnv).toEqual({
      enabled: false,
      devServer: {
        startCommand: 'npm run dev',
        env: {},
        secretKeys: [],
        portMap: [{ internalPort: 5173, label: 'web', primary: true }],
        idleTTL: 600,
        aptPackages: [],
      },
    });
  });

  it('rejects an invalid dev-server environment key', async () => {
    const project = await createProject();
    const res = await request.patch(`/api/projects/${project.id}`).send({
      prEnv: { enabled: false, devServer: { env: { PORT: '3000' } } },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/devServer|reserved/i);
  });

  it('clears the prEnv slot when sent as null', async () => {
    const project = await createProject();
    const res = await request.patch(`/api/projects/${project.id}`).send({ prEnv: null });
    expect(res.status).toBe(200);
    expect(res.body.prEnv).toBeUndefined();
  });
});
