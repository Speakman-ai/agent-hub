import '../test/setup.js';
import type supertest from 'supertest';
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { getRequest } from '../test/helpers.js';

const spawnAwsSsoLogin = vi.hoisted(() => vi.fn());
const ensurePrivateAwsSsoCache = vi.hoisted(() => vi.fn());

vi.mock('../aws-sso-identity.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../aws-sso-identity.js')>()),
  spawnAwsSsoLogin,
}));
vi.mock('../project-aws-spawn.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../project-aws-spawn.js')>()),
  ensurePrivateAwsSsoCache,
}));

let request: supertest.Agent;

beforeAll(async () => {
  request = await getRequest();
});

describe('POST /api/projects/:id/aws-sso/login cache isolation', () => {
  it('refuses to start a login when the caller cannot get a private SSO cache', async () => {
    const projectId = `aws-iso-${uuidv4().slice(0, 8)}`;
    await request
      .post('/api/projects')
      .send({ id: projectId, name: projectId, cwd: '/tmp', color: '#3B82F6' })
      .expect(201);
    await request
      .put(`/api/projects/${projectId}/aws-profiles`)
      .send({
        profiles: {
          dev: {
            sso_account_id: '120569607241',
            sso_start_url: 'https://d-9a670b4c46.awsapps.com/start/',
            sso_region: 'us-east-2',
            sso_role_name: 'AdministratorAccess',
            region: 'us-east-2',
          },
        },
      })
      .expect(200);
    ensurePrivateAwsSsoCache.mockReturnValue({ ok: false, reason: 'shared link stuck' });

    const res = await request
      .post(`/api/projects/${projectId}/aws-sso/login`)
      .send({ profile: 'dev' })
      .expect(503);

    expect(res.body).toMatchObject({ ok: false, profile: 'dev', error: 'shared link stuck' });
    expect(spawnAwsSsoLogin).not.toHaveBeenCalled();
  });
});
