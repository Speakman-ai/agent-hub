import '../test/setup.js';
import type supertest from 'supertest';
import { describe, it, expect, beforeAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { readFileSync } from 'fs';
import path from 'path';
import config from '../config.js';
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

  it('round-trips static credential profiles', async () => {
    const projectId = await freshProject();
    await request
      .put(`/api/projects/${projectId}/aws-profiles`)
      .send({
        profiles: {
          staticdev: {
            type: 'static',
            aws_access_key_id: 'AKIATESTKEY',
            aws_secret_access_key: 'secret-test-key',
            region: 'us-east-2',
          },
        },
      })
      .expect(200);
    const res = await request.get(`/api/projects/${projectId}/aws-profiles`).expect(200);
    expect(res.body.profiles.staticdev).toMatchObject({
      type: 'static',
      aws_access_key_id: 'AKIATESTKEY',
      aws_secret_access_key: 'secret-test-key',
      region: 'us-east-2',
    });
  });

  it('clearing profiles truncates generated config and credentials files', async () => {
    const projectId = await freshProject();
    await request
      .put(`/api/projects/${projectId}/aws-profiles`)
      .send({
        profiles: {
          staticdev: {
            type: 'static',
            aws_access_key_id: 'AKIATESTKEY',
            aws_secret_access_key: 'secret-test-key',
            region: 'us-east-2',
          },
        },
      })
      .expect(200);

    const dir = path.join(config.dataDir, 'project-aws-config', projectId);
    const configPath = path.join(dir, 'config');
    const credentialsPath = path.join(dir, 'credentials');
    expect(readFileSync(credentialsPath, 'utf-8')).toContain('secret-test-key');

    await request.put(`/api/projects/${projectId}/aws-profiles`).send({ profiles: {} }).expect(200);

    expect(readFileSync(configPath, 'utf-8')).toBe('');
    expect(readFileSync(credentialsPath, 'utf-8')).toBe('');
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
