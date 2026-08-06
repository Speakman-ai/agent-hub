/**
 * `GET /api/projects/:projectId/infra/monitoring-status`.
 *
 * The probe layer is mocked: this file is about the HTTP contract the
 * Infrastructure module branches on, not about AWS.
 */
import '../test/setup.js';
import type supertest from 'supertest';
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { getRequest } from '../test/helpers.js';
import { probeProjectMonitoringAccess } from '../infra/aws-clients.js';

vi.mock('../infra/aws-clients.js', () => ({
  probeProjectMonitoringAccess: vi.fn(),
  invalidateProjectAwsAccess: vi.fn(),
}));

const probeMock = vi.mocked(probeProjectMonitoringAccess);

let request: supertest.Agent;

beforeAll(async () => {
  request = await getRequest();
});

beforeEach(() => {
  probeMock.mockReset();
  probeMock.mockResolvedValue({ profile: 'monitoring', region: 'us-east-2', reachable: true });
});

async function freshProject(): Promise<string> {
  const id = `infra-status-${uuidv4().slice(0, 8)}`;
  await request
    .post('/api/projects')
    .send({ id, name: id, cwd: '/tmp', color: '#3B82F6' })
    .expect(201);
  return id;
}

describe('GET /api/projects/:projectId/infra/monitoring-status', () => {
  it('reports a reachable project and stamps when the probe ran', async () => {
    const projectId = await freshProject();
    const res = await request.get(`/api/projects/${projectId}/infra/monitoring-status`).expect(200);

    expect(probeMock).toHaveBeenCalledWith(projectId);
    expect(res.body).toMatchObject({
      profile: 'monitoring',
      region: 'us-east-2',
      reachable: true,
    });
    expect(typeof res.body.checkedAt).toBe('number');
  });

  it('returns 200 with the empty-state payload when no monitoring profile is designated', async () => {
    const projectId = await freshProject();
    probeMock.mockResolvedValue({
      profile: null,
      region: null,
      reachable: false,
      code: 'monitoring_profile_required',
      reason: 'not_designated',
      error: 'no designated AWS monitoring profile',
    });

    // Not a 4xx on purpose: the module renders an empty state from this body,
    // so callers branch on `code` rather than on the status.
    const res = await request.get(`/api/projects/${projectId}/infra/monitoring-status`).expect(200);

    expect(res.body).toMatchObject({
      reachable: false,
      code: 'monitoring_profile_required',
      reason: 'not_designated',
    });
  });

  it('returns 200 when AWS refuses, so the operator sees the AWS error', async () => {
    const projectId = await freshProject();
    probeMock.mockResolvedValue({
      profile: 'monitoring',
      region: 'us-east-2',
      reachable: false,
      code: 'AccessDeniedException',
      error: 'not authorized to perform: cloudwatch:DescribeAlarms',
    });

    const res = await request.get(`/api/projects/${projectId}/infra/monitoring-status`).expect(200);
    expect(res.body.code).toBe('AccessDeniedException');
    expect(res.body.reachable).toBe(false);
  });

  it('404s for an unknown project without probing AWS', async () => {
    await request.get('/api/projects/does-not-exist/infra/monitoring-status').expect(404);
    expect(probeMock).not.toHaveBeenCalled();
  });
});
