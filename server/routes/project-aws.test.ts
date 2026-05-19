import '../test/setup.js';
import type supertest from 'supertest';
import { describe, it, expect, beforeAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { getRequest } from '../test/helpers.js';

let request: supertest.Agent;

beforeAll(async () => {
  request = await getRequest();
});

async function freshProject(): Promise<string> {
  const id = `aws-prof-${uuidv4().slice(0, 8)}`;
  await request
    .post('/api/projects')
    .send({ id, name: id, cwd: '/tmp', color: '#3B82F6' })
    .expect(201);
  return id;
}

const SAMPLE = {
  dev: {
    sso_account_id: '120569607241',
    sso_start_url: 'https://d-9a670b4c46.awsapps.com/start/',
    sso_region: 'us-east-2',
    sso_role_name: 'AdministratorAccess',
    region: 'us-east-2',
  },
};

describe('PUT/GET /api/projects/:id/aws-profiles', () => {
  it('round-trips profile config', async () => {
    const projectId = await freshProject();
    await request
      .put(`/api/projects/${projectId}/aws-profiles`)
      .send({ profiles: SAMPLE })
      .expect(200);
    const res = await request.get(`/api/projects/${projectId}/aws-profiles`).expect(200);
    expect(res.body.profiles.dev.sso_account_id).toBe('120569607241');
  });

  it('rejects invalid account id', async () => {
    const projectId = await freshProject();
    const res = await request
      .put(`/api/projects/${projectId}/aws-profiles`)
      .send({
        profiles: {
          dev: { ...SAMPLE.dev, sso_account_id: 'not-valid' },
        },
      })
      .expect(400);
    expect(res.body.error).toMatch(/account/i);
  });
});
