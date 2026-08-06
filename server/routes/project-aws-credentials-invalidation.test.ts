/**
 * Saving profiles must drop the in-process SDK credential cache.
 *
 * Without this the collector would keep resolving against the identity a
 * previous save described: the ini files on disk are correct, but a provider
 * built before the save is still holding the credentials it resolved from the
 * old ones.
 */
import '../test/setup.js';
import type supertest from 'supertest';
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { getRequest } from '../test/helpers.js';
import { invalidateProjectAwsAccess } from '../infra/aws-clients.js';

vi.mock('../infra/aws-clients.js', () => ({
  invalidateProjectAwsAccess: vi.fn(),
  probeProjectMonitoringAccess: vi.fn(),
}));

const invalidateMock = vi.mocked(invalidateProjectAwsAccess);

let request: supertest.Agent;

beforeAll(async () => {
  request = await getRequest();
});

beforeEach(() => {
  invalidateMock.mockClear();
});

const STATIC_PROFILE = {
  type: 'static',
  aws_access_key_id: 'AKIAIOSFODNN7EXAMPLE',
  aws_secret_access_key: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  region: 'us-east-2',
};

async function freshProject(): Promise<string> {
  const id = `aws-cred-inv-${uuidv4().slice(0, 8)}`;
  await request
    .post('/api/projects')
    .send({ id, name: id, cwd: '/tmp', color: '#3B82F6' })
    .expect(201);
  return id;
}

describe('PUT /api/projects/:id/aws-profiles', () => {
  it('invalidates the cached credential providers and clients for that project', async () => {
    const projectId = await freshProject();
    await request
      .put(`/api/projects/${projectId}/aws-profiles`)
      .send({ profiles: { monitoring: STATIC_PROFILE } })
      .expect(200);

    expect(invalidateMock).toHaveBeenCalledWith(projectId);
  });

  it('does not invalidate when the save is rejected', async () => {
    const projectId = await freshProject();
    await request
      .put(`/api/projects/${projectId}/aws-profiles`)
      .send({ profiles: { monitoring: { ...STATIC_PROFILE, region: 'not-a-region' } } })
      .expect(400);

    expect(invalidateMock).not.toHaveBeenCalled();
  });

  it('leaves the cache alone on a plain read', async () => {
    const projectId = await freshProject();
    await request
      .put(`/api/projects/${projectId}/aws-profiles`)
      .send({ profiles: { monitoring: STATIC_PROFILE } })
      .expect(200);
    invalidateMock.mockClear();

    await request.get(`/api/projects/${projectId}/aws-profiles`).expect(200);
    expect(invalidateMock).not.toHaveBeenCalled();
  });
});
