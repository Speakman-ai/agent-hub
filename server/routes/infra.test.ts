/**
 * HTTP contract for the infrastructure-monitoring routes: monitoring status,
 * the cost surface, and the retention overrides.
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
import {
  DEFAULT_INFRA_RETENTION_DAYS,
  MIN_INFRA_RETENTION_DAYS,
  MAX_INFRA_RETENTION_DAYS,
  DEFAULT_INFRA_PROJECT_QUOTA_BYTES,
  MIN_INFRA_PROJECT_QUOTA_BYTES,
  MAX_INFRA_PROJECT_QUOTA_BYTES,
} from '../infra/infra-schema.js';

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

describe('infra cost routes', () => {
  it('reports an empty, uncapped cost body for a project that has never collected', async () => {
    const projectId = await freshProject();
    const res = await request.get(`/api/projects/${projectId}/infra/cost`).expect(200);

    expect(res.body).toMatchObject({
      monthToDateUsd: 0,
      runs: 0,
      monthlyCeilingUsd: null,
      degradation: 'normal',
      configured: false,
    });
    expect(res.body.projection).toEqual({
      metricsRequestedPerMonth: 0,
      estimatedMonthlyCostUsd: 0,
      perScope: [],
    });
    expect(res.body.recentRuns).toEqual([]);
    expect(typeof res.body.monthStartMs).toBe('number');
  });

  it('404s the cost endpoint for an unknown project', async () => {
    await request.get('/api/projects/does-not-exist/infra/cost').expect(404);
  });

  it('prices a proposed scope list without persisting it', async () => {
    const projectId = await freshProject();
    const res = await request
      .post(`/api/projects/${projectId}/infra/cost/projection`)
      .send({ scopes: [{ service: 'ec2', resourceCount: 50, region: 'us-east-1' }] })
      .expect(200);

    expect(res.body.perScope).toHaveLength(1);
    expect(res.body.perScope[0].resourceCount).toBe(50);
    expect(res.body.metricsRequestedPerMonth).toBeGreaterThan(0);
    expect(res.body.estimatedMonthlyCostUsd).toBeGreaterThan(0);
    // Every metric reports the floor it was clamped to, so the editor can say
    // *why* a cadence is what it is rather than just quoting a number.
    expect(res.body.perScope[0].intervals.length).toBeGreaterThan(0);
    expect(res.body.perScope[0].intervals[0]).toHaveProperty('minPeriodSeconds');

    // Pricing is a pure read — nothing was saved.
    const after = await request.get(`/api/projects/${projectId}/infra/cost`).expect(200);
    expect(after.body.projection.perScope).toEqual([]);
    expect(after.body.configured).toBe(false);
  });

  it('prices each scope in its own region', async () => {
    const projectId = await freshProject();
    const res = await request
      .post(`/api/projects/${projectId}/infra/cost/projection`)
      .send({
        scopes: [
          { service: 'ec2', resourceCount: 10, region: 'us-east-1' },
          { service: 'ec2', resourceCount: 10, region: 'sa-east-1' },
        ],
      })
      .expect(200);

    const [virginia, saopaulo] = res.body.perScope;
    expect(saopaulo.metricsRequestedPerMonth).toBe(virginia.metricsRequestedPerMonth);
    expect(saopaulo.estimatedMonthlyCostUsd).toBeGreaterThan(virginia.estimatedMonthlyCostUsd);
  });

  it('rejects a malformed projection body', async () => {
    const projectId = await freshProject();
    await request
      .post(`/api/projects/${projectId}/infra/cost/projection`)
      .send({ scopes: [{ service: 'ec2', resourceCount: -1 }] })
      .expect(400);
    await request
      .post(`/api/projects/${projectId}/infra/cost/projection`)
      .send({ scopes: [{ resourceCount: 5 }] })
      .expect(400);
  });

  it('saves and clears the monthly ceiling', async () => {
    const projectId = await freshProject();
    const saved = await request
      .put(`/api/projects/${projectId}/infra/cost/config`)
      .send({ monthlyCeilingUsd: 25 })
      .expect(200);
    expect(saved.body).toMatchObject({ monthlyCeilingUsd: 25, configured: true });

    const read = await request.get(`/api/projects/${projectId}/infra/cost`).expect(200);
    expect(read.body.monthlyCeilingUsd).toBe(25);

    const cleared = await request
      .put(`/api/projects/${projectId}/infra/cost/config`)
      .send({ monthlyCeilingUsd: null })
      .expect(200);
    // Cleared, but still `configured` — the operator deliberately removed it,
    // which is not the same as never having opened the panel.
    expect(cleared.body.monthlyCeilingUsd).toBeNull();
    expect(cleared.body.configured).toBe(true);
  });

  it('accepts a zero ceiling, which means "collect nothing"', async () => {
    const projectId = await freshProject();
    const res = await request
      .put(`/api/projects/${projectId}/infra/cost/config`)
      .send({ monthlyCeilingUsd: 0 })
      .expect(200);
    expect(res.body.monthlyCeilingUsd).toBe(0);
  });

  it('rejects a negative or absent ceiling', async () => {
    const projectId = await freshProject();
    await request
      .put(`/api/projects/${projectId}/infra/cost/config`)
      .send({ monthlyCeilingUsd: -1 })
      .expect(400);
    await request.put(`/api/projects/${projectId}/infra/cost/config`).send({}).expect(400);
  });

  it('404s the config endpoint for an unknown project before validating the body', async () => {
    await request
      .put('/api/projects/does-not-exist/infra/cost/config')
      .send({ monthlyCeilingUsd: 10 })
      .expect(404);
  });
});

describe('infra retention routes', () => {
  it('resolves defaults, bounds and store size for an unconfigured project', async () => {
    const projectId = await freshProject();
    const res = await request.get(`/api/projects/${projectId}/infra/retention`).expect(200);

    expect(res.body).toMatchObject({
      retentionDays: DEFAULT_INFRA_RETENTION_DAYS,
      quotaBytes: DEFAULT_INFRA_PROJECT_QUOTA_BYTES,
      configured: false,
      updatedAt: null,
      defaults: {
        retentionDays: DEFAULT_INFRA_RETENTION_DAYS,
        quotaBytes: DEFAULT_INFRA_PROJECT_QUOTA_BYTES,
      },
      bounds: {
        minRetentionDays: MIN_INFRA_RETENTION_DAYS,
        maxRetentionDays: MAX_INFRA_RETENTION_DAYS,
        minQuotaBytes: MIN_INFRA_PROJECT_QUOTA_BYTES,
        maxQuotaBytes: MAX_INFRA_PROJECT_QUOTA_BYTES,
      },
    });
    expect(typeof res.body.dbBytes).toBe('number');
  });

  it('saves an override and reads it back', async () => {
    const projectId = await freshProject();
    const saved = await request
      .put(`/api/projects/${projectId}/infra/retention`)
      .send({ retentionDays: 60, quotaBytes: 2 * 1024 * 1024 * 1024 })
      .expect(200);
    expect(saved.body).toMatchObject({
      retentionDays: 60,
      quotaBytes: 2 * 1024 * 1024 * 1024,
      configured: true,
    });

    const read = await request.get(`/api/projects/${projectId}/infra/retention`).expect(200);
    expect(read.body.retentionDays).toBe(60);
    expect(typeof read.body.updatedAt).toBe('number');
  });

  it('leaves the omitted half of a partial update alone', async () => {
    const projectId = await freshProject();
    await request
      .put(`/api/projects/${projectId}/infra/retention`)
      .send({ retentionDays: 60, quotaBytes: 2 * 1024 * 1024 * 1024 })
      .expect(200);
    const res = await request
      .put(`/api/projects/${projectId}/infra/retention`)
      .send({ quotaBytes: 3 * 1024 * 1024 * 1024 })
      .expect(200);
    expect(res.body).toMatchObject({ retentionDays: 60, quotaBytes: 3 * 1024 * 1024 * 1024 });
  });

  it('clamps out-of-range values rather than rejecting them, and says what it stored', async () => {
    const projectId = await freshProject();
    const res = await request
      .put(`/api/projects/${projectId}/infra/retention`)
      .send({ retentionDays: 100_000, quotaBytes: 1 })
      .expect(200);
    expect(res.body.retentionDays).toBe(MAX_INFRA_RETENTION_DAYS);
    expect(res.body.quotaBytes).toBe(MIN_INFRA_PROJECT_QUOTA_BYTES);
  });

  it('rejects a body that sets nothing at all', async () => {
    const projectId = await freshProject();
    await request.put(`/api/projects/${projectId}/infra/retention`).send({}).expect(400);
    await request
      .put(`/api/projects/${projectId}/infra/retention`)
      .send({ retentionDays: 'thirty' })
      .expect(400);
  });

  it('404s both retention endpoints for an unknown project', async () => {
    await request.get('/api/projects/does-not-exist/infra/retention').expect(404);
    await request
      .put('/api/projects/does-not-exist/infra/retention')
      .send({ retentionDays: 10 })
      .expect(404);
  });
});
