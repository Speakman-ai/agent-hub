import type supertest from 'supertest';
import { getRequest, createProject } from './helpers.js';

// ═══════════════════════════════════════════════════════════════════
// PATCH /api/projects/:projectId — awsEnabled toggle
//
// `awsEnabled` gates the per-project "AWS" sidebar entry where SSO
// profiles are managed. It is a plain boolean: `true` persists the flag,
// `false` deletes the key so projects stay lean (defaults to off). These
// supertest cases hit the real route to lock the toggle + validation.
// ═══════════════════════════════════════════════════════════════════

let request: supertest.Agent;

beforeAll(async () => {
  request = await getRequest();
});

describe('PATCH /api/projects/:projectId — awsEnabled', () => {
  it('persists awsEnabled=true', async () => {
    const project = await createProject();
    const projectId = project.id as string;
    const res = await request
      .patch(`/api/projects/${projectId}`)
      .send({ awsEnabled: true })
      .expect(200);
    expect((res.body as { awsEnabled?: boolean }).awsEnabled).toBe(true);
  });

  it('clears the flag (key removed) when toggled back to false', async () => {
    const project = await createProject();
    const projectId = project.id as string;
    await request.patch(`/api/projects/${projectId}`).send({ awsEnabled: true }).expect(200);
    const res = await request
      .patch(`/api/projects/${projectId}`)
      .send({ awsEnabled: false })
      .expect(200);
    expect((res.body as { awsEnabled?: boolean }).awsEnabled).toBeUndefined();
  });

  it('rejects with 400 when awsEnabled is not a boolean', async () => {
    const project = await createProject();
    const projectId = project.id as string;
    const res = await request
      .patch(`/api/projects/${projectId}`)
      .send({ awsEnabled: 'yes' })
      .expect(400);
    expect((res.body as { error: string }).error).toMatch(/awsEnabled must be a boolean/);
  });
});
