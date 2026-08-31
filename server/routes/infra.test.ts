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
import { getInfraDb, infraResourceKey } from '../infra/infra-db.js';
import { insertInfraMetricPoints } from '../infra/infra-metric-store.js';
import { recordInfraAlertEvaluation } from '../infra/alert-store.js';
import { MAX_METRIC_WINDOW_MS } from '../infra/infra-metric-read.js';
import { EC2_PACK, infraPackedServices } from '../infra/packs/index.js';

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

/** Seed the Cost Explorer cache directly, bypassing the billed poller. */
function seedSpend(
  projectId: string,
  rows: Array<{ day: string; service: string; amountUsd: number; estimated?: boolean }>,
  profileName = 'monitoring',
): void {
  const stmt = getInfraDb().prepare(
    `INSERT INTO infra_cost_daily
       (project_id, profile_name, day, service, linked_account, amount_usd, unit, estimated, fetched_at)
     VALUES (?, ?, ?, ?, '', ?, 'USD', ?, ?)`,
  );
  for (const row of rows) {
    stmt.run(
      projectId,
      profileName,
      row.day,
      row.service,
      row.amountUsd,
      row.estimated ? 1 : 0,
      Date.now(),
    );
  }
}

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

describe('GET /api/projects/:projectId/infra/metric-packs', () => {
  it('serves every declared pack with its caveats and recommended rules', async () => {
    const projectId = await freshProject();
    const res = await request.get(`/api/projects/${projectId}/infra/metric-packs`).expect(200);

    expect(res.body.packs.map((p: { service: string }) => p.service)).toEqual(
      infraPackedServices(),
    );
    const ec2 = res.body.packs.find((p: { service: string }) => p.service === 'ec2');
    expect(ec2.label).toBe('EC2');
    expect(ec2.metrics.length).toBe(EC2_PACK.metrics.length);

    // The response is what the Metrics tab reads its caveats from, so the
    // fields that carry the explanation must survive serialization.
    const statusCheck = ec2.metrics.find(
      (m: { metricName: string }) => m.metricName === 'StatusCheckFailed',
    );
    expect(statusCheck).toMatchObject({
      namespace: 'AWS/EC2',
      dimensions: ['InstanceId'],
      metricType: 'flag',
      stat: 'Maximum',
      minPeriodSeconds: 60,
      availability: 'either',
      appliesTo: { universal: true, condition: '' },
      requiresFeature: null,
    });
    expect(statusCheck.validStatistics).not.toContain('Sum');

    const balance = ec2.metrics.find(
      (m: { metricName: string }) => m.metricName === 'EBSIOBalance%',
    );
    expect(balance.validStatistics).toEqual(['Minimum', 'Maximum']);
    expect(balance.availability).toBe('basic-only');
    expect(balance.appliesTo.universal).toBe(false);

    expect(ec2.dimensions).toContainEqual(
      expect.objectContaining({ name: 'ImageId', detailedMonitoringOnly: true }),
    );
    expect(ec2.dimensions).toContainEqual(
      expect.objectContaining({ name: 'InstanceType', detailedMonitoringOnly: true }),
    );

    const absentLabels = ec2.absentMetrics.map((a: { label: string }) => a.label).join(' | ');
    expect(absentLabels).toMatch(/Memory/i);
    expect(absentLabels).toMatch(/Disk-space/i);
    expect(ec2.defaultAlertRules.length).toBe(EC2_PACK.defaultAlertRules.length);
  });

  it('serves the ECS pack with its paid-feature gate intact', async () => {
    // The gate is what the Metrics tab reads to say "Container Insights is off,
    // here is what turning it on costs" instead of drawing an empty chart, so
    // it has to survive serialization along with the metrics it gates.
    const projectId = await freshProject();
    const res = await request.get(`/api/projects/${projectId}/infra/metric-packs`).expect(200);

    const ecs = res.body.packs.find((p: { service: string }) => p.service === 'ecs');
    expect(ecs.label).toBe('ECS');
    expect(ecs.features).toContainEqual(
      expect.objectContaining({
        key: 'containerInsights',
        label: 'Container Insights',
        costNote: expect.stringMatching(/custom metric/i),
      }),
    );

    // The same metric name at two dimension sets is two declarations, and the
    // wire has to keep them apart or a chart is annotated with the wrong one.
    const cpu = ecs.metrics.filter(
      (m: { metricName: string }) => m.metricName === 'CPUUtilization',
    );
    expect(cpu).toHaveLength(2);
    expect(cpu.map((m: { dimensions: string[] }) => m.dimensions.join('+')).sort()).toEqual([
      'ClusterName',
      'ClusterName+ServiceName',
    ]);

    const running = ecs.metrics.find(
      (m: { metricName: string }) => m.metricName === 'RunningTaskCount',
    );
    expect(running.namespace).toBe('ECS/ContainerInsights');
    expect(running.requiresFeature).toBe('containerInsights');

    // Free metrics stay ungated, or the collector would stop asking for the one
    // thing ECS publishes to everybody at no charge.
    for (const metric of ecs.metrics.filter(
      (m: { namespace: string }) => m.namespace === 'AWS/ECS',
    )) {
      expect(metric.requiresFeature).toBeNull();
    }
  });

  it('carries no credential or account-identifying material', async () => {
    // The catalog is static declarations. If a project id, account id or
    // profile name ever appears here, something project-scoped has leaked into
    // what is supposed to be a constant.
    const projectId = await freshProject();
    const res = await request.get(`/api/projects/${projectId}/infra/metric-packs`).expect(200);
    expect(JSON.stringify(res.body)).not.toContain(projectId);
  });

  it('404s for an unknown project', async () => {
    await request.get('/api/projects/does-not-exist/infra/metric-packs').expect(404);
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

describe('infra scope routes', () => {
  it('reports an empty allowlist for a project that has opted into nothing', async () => {
    const projectId = await freshProject();
    const res = await request.get(`/api/projects/${projectId}/infra/scopes`).expect(200);

    expect(res.body).toMatchObject({
      scopes: [],
      configured: false,
      monthlyCeilingUsd: null,
      degradation: 'normal',
      uncollectableServices: [],
    });
    expect(res.body.projection).toEqual({
      metricsRequestedPerMonth: 0,
      estimatedMonthlyCostUsd: 0,
      perScope: [],
    });
    // The service picker is populated from the metric packs, so the editor
    // never has to hardcode a list that drifts from what the collector polls.
    expect(res.body.collectableServices).toContain('ec2');
    expect(res.body.maxScopes).toBeGreaterThan(0);
  });

  it('saves an allowlist and reads it back priced', async () => {
    const projectId = await freshProject();
    const res = await request
      .put(`/api/projects/${projectId}/infra/scopes`)
      .send({
        scopes: [
          {
            profileName: 'monitoring',
            region: 'us-east-2',
            service: 'ec2',
            tagFilter: { Environment: ['prod'] },
          },
        ],
      })
      .expect(200);

    expect(res.body.configured).toBe(true);
    expect(res.body.scopes).toHaveLength(1);
    expect(res.body.scopes[0]).toMatchObject({
      profileName: 'monitoring',
      region: 'us-east-2',
      service: 'ec2',
      tagFilter: { Environment: ['prod'] },
      enabled: true,
      accountId: null,
      resourceCount: 0,
    });

    const after = await request.get(`/api/projects/${projectId}/infra/scopes`).expect(200);
    expect(after.body.scopes[0].id).toBe(res.body.scopes[0].id);
    expect(after.body.projection.perScope).toHaveLength(1);
    // Zero inventory rows is the honest state for a scope the hourly sync has
    // not described yet — priced at zero, but present in the breakdown.
    expect(after.body.projection.perScope[0]).toMatchObject({
      service: 'ec2',
      region: 'us-east-2',
      resourceCount: 0,
    });
  });

  it('replaces the whole list, deleting rows absent from the body', async () => {
    const projectId = await freshProject();
    await request
      .put(`/api/projects/${projectId}/infra/scopes`)
      .send({
        scopes: [
          { profileName: 'monitoring', region: 'us-east-2', service: 'ec2' },
          { profileName: 'monitoring', region: 'us-east-2', service: 'rds' },
        ],
      })
      .expect(200);

    const res = await request
      .put(`/api/projects/${projectId}/infra/scopes`)
      .send({ scopes: [{ profileName: 'monitoring', region: 'us-east-2', service: 'rds' }] })
      .expect(200);

    expect(res.body.scopes.map((s: { service: string }) => s.service)).toEqual(['rds']);
  });

  it('accepts an empty list, which turns collection off entirely', async () => {
    const projectId = await freshProject();
    await request
      .put(`/api/projects/${projectId}/infra/scopes`)
      .send({ scopes: [{ profileName: 'monitoring', region: 'us-east-2', service: 'ec2' }] })
      .expect(200);

    const res = await request
      .put(`/api/projects/${projectId}/infra/scopes`)
      .send({ scopes: [] })
      .expect(200);

    expect(res.body.scopes).toEqual([]);
    expect(res.body.configured).toBe(false);
    expect(res.body.projection.estimatedMonthlyCostUsd).toBe(0);
  });

  it('excludes a disabled scope from the projection but keeps the row', async () => {
    const projectId = await freshProject();
    const res = await request
      .put(`/api/projects/${projectId}/infra/scopes`)
      .send({
        scopes: [
          { profileName: 'monitoring', region: 'us-east-2', service: 'ec2', enabled: false },
        ],
      })
      .expect(200);

    expect(res.body.scopes).toHaveLength(1);
    expect(res.body.scopes[0].enabled).toBe(false);
    expect(res.body.projection.perScope).toEqual([]);
  });

  it('flags a stored service that no metric pack collects', async () => {
    const projectId = await freshProject();
    const res = await request
      .put(`/api/projects/${projectId}/infra/scopes`)
      .send({ scopes: [{ profileName: 'monitoring', region: 'us-east-2', service: 'quantumdb' }] })
      .expect(200);

    // Stored, not rejected — the service column is deliberately open — but
    // reported so an inert scope does not read as a working one.
    expect(res.body.scopes).toHaveLength(1);
    expect(res.body.uncollectableServices).toEqual(['quantumdb']);
    expect(res.body.projection.estimatedMonthlyCostUsd).toBe(0);
  });

  it('saves the ceiling in the same request as the scopes it caps', async () => {
    const projectId = await freshProject();
    const res = await request
      .put(`/api/projects/${projectId}/infra/scopes`)
      .send({
        scopes: [{ profileName: 'monitoring', region: 'us-east-2', service: 'ec2' }],
        monthlyCeilingUsd: 25,
      })
      .expect(200);

    expect(res.body.monthlyCeilingUsd).toBe(25);
    // And it is the same ceiling the cost surface reports — one setting, not two.
    const cost = await request.get(`/api/projects/${projectId}/infra/cost`).expect(200);
    expect(cost.body.monthlyCeilingUsd).toBe(25);
  });

  it('leaves the ceiling alone when the body omits it, and clears it on null', async () => {
    const projectId = await freshProject();
    await request
      .put(`/api/projects/${projectId}/infra/cost/config`)
      .send({ monthlyCeilingUsd: 10 })
      .expect(200);

    const kept = await request
      .put(`/api/projects/${projectId}/infra/scopes`)
      .send({ scopes: [] })
      .expect(200);
    expect(kept.body.monthlyCeilingUsd).toBe(10);

    const cleared = await request
      .put(`/api/projects/${projectId}/infra/scopes`)
      .send({ scopes: [], monthlyCeilingUsd: null })
      .expect(200);
    expect(cleared.body.monthlyCeilingUsd).toBeNull();
  });

  it('surfaces a duplicate triple as a 400 naming the offending scope', async () => {
    const projectId = await freshProject();
    const res = await request
      .put(`/api/projects/${projectId}/infra/scopes`)
      .send({
        scopes: [
          { profileName: 'monitoring', region: 'us-east-2', service: 'ec2' },
          { profileName: 'monitoring', region: 'us-east-2', service: 'ec2' },
        ],
      })
      .expect(400);

    expect(res.body.error).toMatch(/duplicate scope/i);
  });

  it('surfaces an unparseable tag filter as a 400 rather than storing a dead scope', async () => {
    const projectId = await freshProject();
    await request
      .put(`/api/projects/${projectId}/infra/scopes`)
      .send({
        scopes: [
          {
            profileName: 'monitoring',
            region: 'us-east-2',
            service: 'ec2',
            tagFilter: { Environment: [] },
          },
        ],
      })
      .expect(400);
  });

  it('rejects a malformed body', async () => {
    const projectId = await freshProject();
    await request.put(`/api/projects/${projectId}/infra/scopes`).send({}).expect(400);
    await request
      .put(`/api/projects/${projectId}/infra/scopes`)
      .send({ scopes: [{ profileName: 'monitoring', region: 'us-east-2' }] })
      .expect(400);
    await request
      .put(`/api/projects/${projectId}/infra/scopes`)
      .send({ scopes: [{ profileName: '', region: 'us-east-2', service: 'ec2' }] })
      .expect(400);
    await request
      .put(`/api/projects/${projectId}/infra/scopes`)
      .send({
        scopes: [{ profileName: 'monitoring', region: 'us-east-2', service: 'ec2' }],
        monthlyCeilingUsd: -1,
      })
      .expect(400);
  });

  it('404s both scope endpoints for an unknown project', async () => {
    await request.get('/api/projects/does-not-exist/infra/scopes').expect(404);
    await request.put('/api/projects/does-not-exist/infra/scopes').send({ scopes: [] }).expect(404);
  });
});

// ── Resource browser and metric charts (decision INFRA-UI) ─────────────────

const CHART_NOW = Date.now();
const CHART_HOUR = 60 * 60 * 1000;

function seedResource(
  projectId: string,
  over: {
    resourceId?: string;
    service?: string;
    region?: string;
    environment?: string | null;
    state?: string | null;
    name?: string | null;
    tags?: Array<{ Key: string; Value: string }> | null;
    lastSeen?: number;
    /** CloudWatch dimension map, which is what binds a row to its headlines. */
    dimensions?: Record<string, string> | null;
  } = {},
): string {
  const service = over.service ?? 'ec2';
  const region = over.region ?? 'us-east-1';
  const accountId = '111122223333';
  const resourceId = over.resourceId ?? 'i-0abc123';
  const resourceKey = infraResourceKey({ projectId, accountId, region, service, resourceId });
  getInfraDb()
    .prepare(
      `INSERT INTO infra_resources (
         resource_key, project_id, account_id, region, service, resource_id,
         name, tags_json, environment, state, metric_dimensions_json, first_seen, last_seen
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      resourceKey,
      projectId,
      accountId,
      region,
      service,
      resourceId,
      over.name ?? null,
      over.tags ? JSON.stringify(over.tags) : null,
      over.environment ?? null,
      over.state ?? 'running',
      over.dimensions ? JSON.stringify(over.dimensions) : null,
      CHART_NOW - 24 * CHART_HOUR,
      over.lastSeen ?? CHART_NOW,
    );
  return resourceKey;
}

describe('GET /api/projects/:projectId/infra/resources', () => {
  it('lists inventory with facets for the filter controls', async () => {
    const projectId = await freshProject();
    seedResource(projectId, { resourceId: 'i-web', name: 'web-1', environment: 'prod' });
    seedResource(projectId, { resourceId: 'db-1', service: 'rds', region: 'eu-west-1' });

    const res = await request.get(`/api/projects/${projectId}/infra/resources`).expect(200);

    expect(res.body.resources).toHaveLength(2);
    expect(res.body.resources[0]).toHaveProperty('resourceKey');
    expect(res.body.resources[0]).toHaveProperty('lastSeen');
    expect(res.body.facets.services.sort()).toEqual(['ec2', 'rds']);
    expect(res.body.facets.regions.sort()).toEqual(['eu-west-1', 'us-east-1']);
    expect(res.body.facets.total).toBe(2);
    expect(res.body.nextCursor).toBeNull();
    expect(res.body.staleAfterMs).toBeGreaterThan(0);
  });

  it('filters by service, environment and tag', async () => {
    const projectId = await freshProject();
    seedResource(projectId, {
      resourceId: 'i-prod',
      environment: 'prod',
      tags: [{ Key: 'Team', Value: 'platform' }],
    });
    seedResource(projectId, { resourceId: 'i-staging', environment: 'staging' });
    seedResource(projectId, { resourceId: 'db-1', service: 'rds' });

    const byService = await request
      .get(`/api/projects/${projectId}/infra/resources?service=rds`)
      .expect(200);
    expect(byService.body.resources.map((r: any) => r.resourceId)).toEqual(['db-1']);

    const byEnv = await request
      .get(`/api/projects/${projectId}/infra/resources?environment=prod`)
      .expect(200);
    expect(byEnv.body.resources.map((r: any) => r.resourceId)).toEqual(['i-prod']);

    const byTag = await request
      .get(`/api/projects/${projectId}/infra/resources?tagKey=Team&tagValue=platform`)
      .expect(200);
    expect(byTag.body.resources.map((r: any) => r.resourceId)).toEqual(['i-prod']);
  });

  it('hides rows the collector has stopped polling, unless asked for them', async () => {
    // Inventory rows are never deleted, so without the default staleness
    // window the browser opens on every instance the account ever ran.
    const projectId = await freshProject();
    seedResource(projectId, { resourceId: 'i-fresh' });
    seedResource(projectId, { resourceId: 'i-gone', lastSeen: CHART_NOW - 72 * CHART_HOUR });

    const fresh = await request.get(`/api/projects/${projectId}/infra/resources`).expect(200);
    expect(fresh.body.resources.map((r: any) => r.resourceId)).toEqual(['i-fresh']);

    const all = await request
      .get(`/api/projects/${projectId}/infra/resources?seenSince=0`)
      .expect(200);
    expect(all.body.resources.map((r: any) => r.resourceId).sort()).toEqual(['i-fresh', 'i-gone']);
  });

  it('rejects a malformed filter and 404s an unknown project', async () => {
    const projectId = await freshProject();
    await request.get(`/api/projects/${projectId}/infra/resources?limit=0`).expect(400);
    await request.get(`/api/projects/${projectId}/infra/resources?limit=abc`).expect(400);
    await request.get('/api/projects/does-not-exist/infra/resources').expect(404);
  });

  it('hides Service Quotas rows unless they are asked for', async () => {
    // These are the rows an operator reads as "kms keys and cloudwatch
    // streams". They describe a limit rather than something that runs, there
    // are dozens per account, and the Overview quota panel already summarises
    // them — so they bury the instances this browser exists to show.
    const projectId = await freshProject();
    seedResource(projectId, { resourceId: 'i-web' });
    seedResource(projectId, { resourceId: 'kms/L-0123', service: 'quota' });
    seedResource(projectId, { resourceId: 'logs/L-9876', service: 'quota' });

    const byDefault = await request.get(`/api/projects/${projectId}/infra/resources`).expect(200);
    expect(byDefault.body.resources.map((r: any) => r.resourceId)).toEqual(['i-web']);
    expect(byDefault.body.facets.total).toBe(1);
    // The facet list stays project-wide on purpose (a dropdown that hides a
    // value cannot be used to select it), so `quota` remains offered and
    // picking it is the per-request way to opt back in.
    expect(byDefault.body.facets.services.sort()).toEqual(['ec2', 'quota']);

    const included = await request
      .get(`/api/projects/${projectId}/infra/resources?includeQuotas=true`)
      .expect(200);
    expect(included.body.resources).toHaveLength(3);
    expect(included.body.facets.services.sort()).toEqual(['ec2', 'quota']);
  });

  it('treats an explicit service=quota filter as asking for them', async () => {
    const projectId = await freshProject();
    seedResource(projectId, { resourceId: 'i-web' });
    seedResource(projectId, { resourceId: 'kms/L-0123', service: 'quota' });

    const res = await request
      .get(`/api/projects/${projectId}/infra/resources?service=quota`)
      .expect(200);
    expect(res.body.resources.map((r: any) => r.resourceId)).toEqual(['kms/L-0123']);
  });
});

describe('GET /api/projects/:projectId/infra/fleet', () => {
  it('returns compute resources with headline metrics in one request', async () => {
    const projectId = await freshProject();
    const resourceKey = seedResource(projectId, {
      resourceId: 'i-web',
      dimensions: { InstanceId: 'i-web' },
    });
    seedResource(projectId, {
      resourceId: 'db-1',
      service: 'rds',
      dimensions: { DBInstanceIdentifier: 'db-1' },
    });
    insertInfraMetricPoints([
      {
        projectId,
        resourceKey,
        namespace: 'AWS/EC2',
        metricName: 'CPUUtilization',
        stat: 'Average',
        periodSeconds: 60,
        tsMs: CHART_NOW - 120_000,
        value: 37,
      },
    ]);

    const res = await request.get(`/api/projects/${projectId}/infra/fleet`).expect(200);

    expect(res.body.resources).toHaveLength(2);
    expect(res.body.services).toEqual(['ec2', 'ecs', 'rds']);
    expect(res.body.truncated).toBe(false);
    expect(res.body.bucketSeconds).toBeGreaterThanOrEqual(60);

    const ec2 = res.body.resources.find((r: any) => r.resourceId === 'i-web');
    const cpu = ec2.metrics.find((m: any) => m.metricName === 'CPUUtilization');
    expect(cpu.label).toBe('CPU');
    expect(cpu.unit).toBe('percent');
    expect(cpu.latest).toBe(37);
    expect(cpu.points.length).toBeGreaterThan(0);

    // The point of the endpoint: an RDS instance arrives with its headlines
    // already attached rather than needing a request per metric.
    const rds = res.body.resources.find((r: any) => r.resourceId === 'db-1');
    expect(rds.metrics.map((m: any) => m.metricName)).toEqual([
      'CPUUtilization',
      'FreeableMemory',
      'DatabaseConnections',
    ]);
    expect(rds.metrics.every((m: any) => m.latest === null)).toBe(true);
  });

  it('narrows to the requested services and ignores tokens it does not chart', async () => {
    const projectId = await freshProject();
    seedResource(projectId, { resourceId: 'i-web', dimensions: { InstanceId: 'i-web' } });
    seedResource(projectId, {
      resourceId: 'db-1',
      service: 'rds',
      dimensions: { DBInstanceIdentifier: 'db-1' },
    });
    seedResource(projectId, { resourceId: 'kms/L-0123', service: 'quota' });

    const rdsOnly = await request
      .get(`/api/projects/${projectId}/infra/fleet?services=rds`)
      .expect(200);
    expect(rdsOnly.body.resources.map((r: any) => r.resourceId)).toEqual(['db-1']);

    const quotas = await request
      .get(`/api/projects/${projectId}/infra/fleet?services=quota`)
      .expect(200);
    expect(quotas.body.resources).toEqual([]);
  });

  it('rejects a window outside the supported range and 404s an unknown project', async () => {
    const projectId = await freshProject();
    await request.get(`/api/projects/${projectId}/infra/fleet?windowMs=1000`).expect(400);
    await request.get(`/api/projects/${projectId}/infra/fleet?limit=0`).expect(400);
    await request.get('/api/projects/does-not-exist/infra/fleet').expect(404);
  });
});

describe('GET /api/projects/:projectId/infra/metric-series', () => {
  it('catalogs only series with stored points behind them', async () => {
    const projectId = await freshProject();
    const resourceKey = seedResource(projectId);
    insertInfraMetricPoints([
      {
        projectId,
        resourceKey,
        namespace: 'AWS/EC2',
        metricName: 'CPUUtilization',
        stat: 'Average',
        periodSeconds: 60,
        tsMs: CHART_NOW - 60_000,
        value: 12,
      },
    ]);

    const res = await request
      .get(
        `/api/projects/${projectId}/infra/metric-series?resource=${encodeURIComponent(resourceKey)}`,
      )
      .expect(200);

    expect(res.body.resource.resourceKey).toBe(resourceKey);
    expect(res.body.series).toHaveLength(1);
    expect(res.body.series[0]).toMatchObject({
      metricName: 'CPUUtilization',
      stat: 'Average',
      periodSeconds: 60,
      pointCount: 1,
    });
  });

  it('requires a resource and 404s an unknown project', async () => {
    const projectId = await freshProject();
    await request.get(`/api/projects/${projectId}/infra/metric-series`).expect(400);
    await request.get('/api/projects/does-not-exist/infra/metric-series?resource=x').expect(404);
  });
});

describe('GET /api/projects/:projectId/infra/metrics', () => {
  async function seedSeries(
    projectId: string,
    opts: { stat?: string; periodSeconds?: number; points: Array<{ tsMs: number; value: number }> },
  ): Promise<string> {
    const resourceKey = seedResource(projectId);
    insertInfraMetricPoints(
      opts.points.map((p) => ({
        projectId,
        resourceKey,
        namespace: 'AWS/EC2',
        metricName: 'CPUUtilization',
        stat: opts.stat ?? 'Average',
        periodSeconds: opts.periodSeconds ?? 60,
        tsMs: p.tsMs,
        value: p.value,
      })),
    );
    return resourceKey;
  }

  it('rejects an unbounded window', async () => {
    // `from` and `to` are the whole reason this route can be served at all:
    // one series at 60s over a year is half a million rows.
    const projectId = await freshProject();
    const resource = encodeURIComponent(seedResource(projectId));
    const base = `/api/projects/${projectId}/infra/metrics?resource=${resource}&metric=CPUUtilization`;

    await request.get(base).expect(400);
    await request.get(`${base}&from=${CHART_NOW - CHART_HOUR}`).expect(400);
    await request.get(`${base}&to=${CHART_NOW}`).expect(400);
  });

  it('rejects an inverted or zero-width window', async () => {
    const projectId = await freshProject();
    const resource = encodeURIComponent(seedResource(projectId));
    const base = `/api/projects/${projectId}/infra/metrics?resource=${resource}&metric=CPUUtilization`;

    await request.get(`${base}&from=${CHART_NOW}&to=${CHART_NOW - CHART_HOUR}`).expect(400);
    await request.get(`${base}&from=${CHART_NOW}&to=${CHART_NOW}`).expect(400);
  });

  it('rejects a window wider than CloudWatch’s longest retention tier', async () => {
    const projectId = await freshProject();
    const resource = encodeURIComponent(seedResource(projectId));
    const from = CHART_NOW - (MAX_METRIC_WINDOW_MS + 1);
    await request
      .get(
        `/api/projects/${projectId}/infra/metrics?resource=${resource}&metric=CPUUtilization&from=${from}&to=${CHART_NOW}`,
      )
      .expect(400);
  });

  it('serves a bucketed range and echoes the period it resolved', async () => {
    const projectId = await freshProject();
    const resourceKey = await seedSeries(projectId, {
      points: [
        { tsMs: CHART_NOW - 3 * 60_000, value: 10 },
        { tsMs: CHART_NOW - 2 * 60_000, value: 20 },
        { tsMs: CHART_NOW - 60_000, value: 30 },
      ],
    });

    const res = await request
      .get(
        `/api/projects/${projectId}/infra/metrics?resource=${encodeURIComponent(resourceKey)}&metric=CPUUtilization&from=${CHART_NOW - CHART_HOUR}&to=${CHART_NOW}`,
      )
      .expect(200);

    expect(res.body.periodSeconds).toBe(60);
    expect(res.body.aggregation).toBe('avg');
    expect(res.body.truncated).toBe(false);
    expect(res.body.points).toHaveLength(3);
    expect(res.body.points.map((p: any) => p.value)).toEqual([10, 20, 30]);
    expect(res.body.series).toMatchObject({ metricName: 'CPUUtilization', periodSeconds: 60 });
    expect(res.body.resource.resourceKey).toBe(resourceKey);
  });

  it('coarsens the display period for a wide window rather than asking for a tier that is gone', async () => {
    // The acceptance case: a 90-day view must not request 60s data that aged
    // out of CloudWatch 75 days ago and render as an empty chart.
    const projectId = await freshProject();
    const resourceKey = await seedSeries(projectId, {
      points: [{ tsMs: CHART_NOW - 60_000, value: 42 }],
    });
    const resource = encodeURIComponent(resourceKey);
    const base = `/api/projects/${projectId}/infra/metrics?resource=${resource}&metric=CPUUtilization&to=${CHART_NOW}`;

    const hour = await request.get(`${base}&from=${CHART_NOW - CHART_HOUR}`).expect(200);
    expect(hour.body.periodSeconds).toBe(60);

    const ninety = await request
      .get(`${base}&from=${CHART_NOW - 90 * 24 * CHART_HOUR}`)
      .expect(200);
    // Never finer than the 3600s tier the window's start has aged into; wider
    // still, because 90 days of hourly buckets overruns the bucket cap.
    expect(ninety.body.periodSeconds).toBeGreaterThanOrEqual(3600);
    // The point is still drawn — coarsening widens the bucket, it does not
    // filter the series down to a tier nothing is stored at.
    expect(ninety.body.points).toHaveLength(1);
    expect(ninety.body.points[0].value).toBe(42);
  });

  it('never draws finer than the series is stored at', async () => {
    const projectId = await freshProject();
    const resourceKey = await seedSeries(projectId, {
      periodSeconds: 300,
      points: [{ tsMs: CHART_NOW - 300_000, value: 5 }],
    });

    const res = await request
      .get(
        `/api/projects/${projectId}/infra/metrics?resource=${encodeURIComponent(resourceKey)}&metric=CPUUtilization&from=${CHART_NOW - CHART_HOUR}&to=${CHART_NOW}`,
      )
      .expect(200);
    expect(res.body.periodSeconds).toBe(300);
  });

  it('buckets a Maximum series by max, not by mean', async () => {
    // Averaging a Maximum series erases the spike it was charted for.
    const projectId = await freshProject();
    const resourceKey = await seedSeries(projectId, {
      stat: 'Maximum',
      points: [
        { tsMs: CHART_NOW - 30 * 24 * CHART_HOUR, value: 1 },
        { tsMs: CHART_NOW - 30 * 24 * CHART_HOUR + 60_000, value: 99 },
      ],
    });

    const res = await request
      .get(
        `/api/projects/${projectId}/infra/metrics?resource=${encodeURIComponent(resourceKey)}&metric=CPUUtilization&from=${CHART_NOW - 31 * 24 * CHART_HOUR}&to=${CHART_NOW}`,
      )
      .expect(200);

    expect(res.body.aggregation).toBe('max');
    expect(res.body.points).toHaveLength(1);
    expect(res.body.points[0].value).toBe(99);
    expect(res.body.points[0].count).toBe(2);
  });

  it('returns an empty series with a resolved period when nothing is stored', async () => {
    const projectId = await freshProject();
    const resourceKey = seedResource(projectId);

    const res = await request
      .get(
        `/api/projects/${projectId}/infra/metrics?resource=${encodeURIComponent(resourceKey)}&metric=CPUUtilization&from=${CHART_NOW - CHART_HOUR}&to=${CHART_NOW}`,
      )
      .expect(200);

    expect(res.body.points).toEqual([]);
    expect(res.body.series).toBeNull();
    expect(res.body.alarmSegments).toEqual([]);
    // The window echo stays authoritative so the chart can still draw its axis.
    expect(res.body.periodSeconds).toBe(60);
    expect(res.body.fromMs).toBe(CHART_NOW - CHART_HOUR);
    expect(res.body.toMs).toBe(CHART_NOW);
  });

  it('overlays alert state on the chart timeline', async () => {
    const projectId = await freshProject();
    const resourceKey = await seedSeries(projectId, {
      points: [{ tsMs: CHART_NOW - 60_000, value: 90 }],
    });

    const rule = await request
      .post(`/api/projects/${projectId}/infra/alert-rules`)
      .send({
        name: 'CPU high',
        service: 'ec2',
        namespace: 'AWS/EC2',
        metricName: 'CPUUtilization',
        stat: 'Average',
        periodS: 60,
        threshold: 80,
        comparisonOperator: 'GreaterThanThreshold',
        evaluationPeriods: 1,
      })
      .expect(201);

    recordInfraAlertEvaluation({
      projectId,
      ruleId: rule.body.id,
      resourceKey,
      evaluation: {
        state: 'ALARM',
        previousState: 'OK',
        transitioned: true,
        reason: 'datapoints_breached',
        evaluatedAtMs: CHART_NOW - 30 * 60_000,
        realDatapoints: 1,
        filledDatapoints: 0,
        breachingDatapoints: 1,
      },
      observedAtMs: CHART_NOW - 30 * 60_000,
      value: 90,
      nowMs: CHART_NOW - 30 * 60_000,
    });

    const res = await request
      .get(
        `/api/projects/${projectId}/infra/metrics?resource=${encodeURIComponent(resourceKey)}&metric=CPUUtilization&from=${CHART_NOW - CHART_HOUR}&to=${CHART_NOW}`,
      )
      .expect(200);

    expect(res.body.alarmSegments).toHaveLength(1);
    expect(res.body.alarmSegments[0]).toMatchObject({
      state: 'ALARM',
      ruleId: rule.body.id,
      startMs: CHART_NOW - 30 * 60_000,
      endMs: CHART_NOW,
    });
    expect(res.body.alerts).toHaveLength(1);
    expect(res.body.alerts[0]).toMatchObject({ state: 'ALARM', resourceKey });
  });

  it('404s an unknown project', async () => {
    await request
      .get(
        `/api/projects/does-not-exist/infra/metrics?resource=x&metric=y&from=${CHART_NOW - CHART_HOUR}&to=${CHART_NOW}`,
      )
      .expect(404);
  });
});

describe('infra spend routes (Cost Explorer)', () => {
  it('reports an opted-out, empty spend body for a fresh project', async () => {
    const projectId = await freshProject();
    const res = await request.get(`/api/projects/${projectId}/infra/spend`).expect(200);

    expect(res.body).toMatchObject({
      enabled: false,
      syncedAt: null,
      days: [],
      topServices: [],
      accounts: [],
      totalUsd: 0,
      unit: null,
      fetchedAt: null,
      lastRun: null,
    });
    // The window is always reported, even with nothing cached, so the panel can
    // say what range it is showing rather than rendering an unlabelled void.
    expect(res.body.windowStartDay).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(res.body.windowEndDay).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(res.body.windowEndDay > res.body.windowStartDay).toBe(true);
  });

  it('404s the spend endpoint for an unknown project', async () => {
    await request.get('/api/projects/does-not-exist/infra/spend').expect(404);
    await request
      .put('/api/projects/does-not-exist/infra/spend/config')
      .send({ enabled: true })
      .expect(404);
  });

  it('saves the opt-in and reads it back', async () => {
    const projectId = await freshProject();
    const saved = await request
      .put(`/api/projects/${projectId}/infra/spend/config`)
      .send({ enabled: true })
      .expect(200);
    expect(saved.body.enabled).toBe(true);

    const read = await request.get(`/api/projects/${projectId}/infra/spend`).expect(200);
    expect(read.body.enabled).toBe(true);
  });

  it('does not sync on enable, so the toggle itself costs nothing', async () => {
    // Charging a cent inside the request that saved the checkbox would make
    // opting in a billable action.
    const projectId = await freshProject();
    const res = await request
      .put(`/api/projects/${projectId}/infra/spend/config`)
      .send({ enabled: true })
      .expect(200);

    expect(res.body.syncedAt).toBeNull();
    expect(res.body.lastRun).toBeNull();
    expect(res.body.days).toEqual([]);
  });

  it('keeps the cached rows when the opt-in is turned back off', async () => {
    const projectId = await freshProject();
    await request
      .put(`/api/projects/${projectId}/infra/spend/config`)
      .send({ enabled: true })
      .expect(200);
    // Seed a day inside the rolling 30-day window relative to now, not a fixed
    // calendar date — a hardcoded day silently ages out of the window and the
    // cached total reads back as 0 (the failure this test is meant to catch is
    // "cache discarded on toggle-off", not "seed fell outside the query range").
    const today = new Date().toISOString().slice(0, 10);
    seedSpend(projectId, [{ day: today, service: 'Amazon EC2', amountUsd: 4 }]);

    const off = await request
      .put(`/api/projects/${projectId}/infra/spend/config`)
      .send({ enabled: false })
      .expect(200);
    // The cache is spend already paid for. Discarding it would mean toggling
    // off and on again re-bought the same history.
    expect(off.body.enabled).toBe(false);
    expect(off.body.totalUsd).toBe(4);
  });

  it('rejects a malformed opt-in body', async () => {
    const projectId = await freshProject();
    await request.put(`/api/projects/${projectId}/infra/spend/config`).send({}).expect(400);
    await request
      .put(`/api/projects/${projectId}/infra/spend/config`)
      .send({ enabled: 'yes' })
      .expect(400);
  });

  it('returns the cached trend, top services and window total', async () => {
    const projectId = await freshProject();
    const today = new Date().toISOString().slice(0, 10);
    seedSpend(projectId, [
      { day: today, service: 'Amazon EC2', amountUsd: 10, estimated: true },
      { day: today, service: 'Amazon S3', amountUsd: 3 },
      { day: today, service: 'AWS Lambda', amountUsd: 1 },
    ]);

    const res = await request
      .get(`/api/projects/${projectId}/infra/spend`)
      .query({ topServices: 2 })
      .expect(200);

    expect(res.body.days).toEqual([{ day: today, amountUsd: 14, estimated: true }]);
    expect(res.body.topServices).toEqual([
      { service: 'Amazon EC2', amountUsd: 10 },
      { service: 'Amazon S3', amountUsd: 3 },
    ]);
    // The total includes the tail the top-N omits, or a truncated panel would
    // understate the bill.
    expect(res.body.totalUsd).toBe(14);
    expect(res.body.unit).toBe('USD');
  });

  it('includes today, because the window end is exclusive and set to tomorrow', async () => {
    const projectId = await freshProject();
    const today = new Date().toISOString().slice(0, 10);
    seedSpend(projectId, [{ day: today, service: 'Amazon EC2', amountUsd: 2 }]);

    const res = await request.get(`/api/projects/${projectId}/infra/spend`).expect(200);
    expect(res.body.days.map((d: { day: string }) => d.day)).toContain(today);
  });

  it('honours the days window', async () => {
    const projectId = await freshProject();
    const today = new Date();
    const old = new Date(today.getTime() - 20 * 86_400_000).toISOString().slice(0, 10);
    seedSpend(projectId, [{ day: old, service: 'Amazon EC2', amountUsd: 5 }]);

    const wide = await request
      .get(`/api/projects/${projectId}/infra/spend`)
      .query({ days: 30 })
      .expect(200);
    expect(wide.body.totalUsd).toBe(5);

    const narrow = await request
      .get(`/api/projects/${projectId}/infra/spend`)
      .query({ days: 3 })
      .expect(200);
    expect(narrow.body.totalUsd).toBe(0);
  });

  it('rejects out-of-range query params', async () => {
    const projectId = await freshProject();
    await request.get(`/api/projects/${projectId}/infra/spend`).query({ days: 0 }).expect(400);
    await request.get(`/api/projects/${projectId}/infra/spend`).query({ days: 5000 }).expect(400);
    await request
      .get(`/api/projects/${projectId}/infra/spend`)
      .query({ topServices: 99 })
      .expect(400);
  });

  it('surfaces the last failed sync so an operator can see why the chart is empty', async () => {
    const projectId = await freshProject();
    const db = getInfraDb();
    db.prepare(
      `INSERT INTO infra_collect_runs
         (id, project_id, started_at, kind, queries_issued, errors, estimated_cost_usd, status, error_message)
       VALUES (?, ?, ?, 'cost_explorer', 1, 1, 0.01, 'failed', ?)`,
    ).run(uuidv4(), projectId, Date.now() - 1000, 'DataUnavailableException: no data');

    const res = await request.get(`/api/projects/${projectId}/infra/spend`).expect(200);
    expect(res.body.lastRun).toMatchObject({
      status: 'failed',
      pages: 1,
      estimatedCostUsd: 0.01,
      errorMessage: 'DataUnavailableException: no data',
    });
  });

  it('reports the Cost Explorer run, not a metric tick that happens to be newer', async () => {
    const projectId = await freshProject();
    const db = getInfraDb();
    db.prepare(
      `INSERT INTO infra_collect_runs (id, project_id, started_at, kind, queries_issued, status)
       VALUES (?, ?, ?, 'cost_explorer', 3, 'ok')`,
    ).run(uuidv4(), projectId, Date.now() - 10_000);
    db.prepare(
      `INSERT INTO infra_collect_runs (id, project_id, started_at, kind, queries_issued, status)
       VALUES (?, ?, ?, 'metrics', 99, 'ok')`,
    ).run(uuidv4(), projectId, Date.now());

    const res = await request.get(`/api/projects/${projectId}/infra/spend`).expect(200);
    expect(res.body.lastRun.pages).toBe(3);
  });

  it('splits month-to-date spend by billed API on the cost endpoint', async () => {
    const projectId = await freshProject();
    const db = getInfraDb();
    const now = Date.now();
    db.prepare(
      `INSERT INTO infra_collect_runs (id, project_id, started_at, kind, estimated_cost_usd, status)
       VALUES (?, ?, ?, 'cost_explorer', 0.03, 'ok')`,
    ).run(uuidv4(), projectId, now);
    db.prepare(
      `INSERT INTO infra_collect_runs (id, project_id, started_at, kind, estimated_cost_usd, status)
       VALUES (?, ?, ?, 'metrics', 0.5, 'ok')`,
    ).run(uuidv4(), projectId, now);

    const res = await request.get(`/api/projects/${projectId}/infra/cost`).expect(200);
    expect(res.body.byKind.cost_explorer).toBeCloseTo(0.03, 10);
    expect(res.body.byKind.metrics).toBeCloseTo(0.5, 10);
    // Both draw on one budget, so the total the ceiling reads covers both.
    expect(res.body.monthToDateUsd).toBeCloseTo(0.53, 10);
  });
});

describe('infra quota headroom route', () => {
  const QUOTA_DIMENSIONS = {
    Class: 'Standard/OnDemand',
    Resource: 'vCPU',
    Service: 'EC2',
    Type: 'Resource',
  };

  function seedQuota(
    projectId: string,
    opts: { quotaCode: string; limit: number | null; usage?: number; usageAtMs?: number },
  ): string {
    const resourceKey = infraResourceKey({
      projectId,
      accountId: '123456789012',
      region: 'us-east-1',
      service: 'quota',
      resourceId: `ec2/${opts.quotaCode}`,
    });
    getInfraDb()
      .prepare(
        `INSERT INTO infra_service_quotas
           (resource_key, project_id, account_id, region, service_code, quota_code,
            quota_name, value, unit, adjustable, global_quota, usage_metric_json, synced_at)
         VALUES (?, ?, ?, ?, 'ec2', ?, ?, ?, 'None', 1, 0, ?, ?)`,
      )
      .run(
        resourceKey,
        projectId,
        '123456789012',
        'us-east-1',
        opts.quotaCode,
        `Quota ${opts.quotaCode}`,
        opts.limit,
        JSON.stringify({
          namespace: 'AWS/Usage',
          metricName: 'ResourceCount',
          dimensions: QUOTA_DIMENSIONS,
          statisticRecommendation: 'Maximum',
        }),
        Date.now(),
      );

    if (typeof opts.usage === 'number') {
      insertInfraMetricPoints([
        {
          projectId,
          resourceKey,
          namespace: 'AWS/Usage',
          metricName: 'ResourceCount',
          dimensions: QUOTA_DIMENSIONS,
          stat: 'Maximum',
          periodSeconds: 60,
          tsMs: opts.usageAtMs ?? Date.now(),
          value: opts.usage,
        },
      ]);
    }
    return resourceKey;
  }

  it('reports an empty, non-error body for a project with no quotas', async () => {
    const projectId = await freshProject();
    const res = await request.get(`/api/projects/${projectId}/infra/quotas`).expect(200);

    expect(res.body.quotas).toEqual([]);
    expect(res.body.summary).toEqual({ critical: 0, warning: 0, ok: 0, unknown: 0, total: 0 });
    // The thresholds and expression ship even when empty, so the panel can
    // explain what it would show rather than rendering an unlabelled void.
    expect(res.body.thresholds).toEqual({ warning: 80, critical: 100 });
    expect(res.body.expression).toBe('m1/SERVICE_QUOTA(m1)*100');
  });

  it('returns headroom with utilization computed against the applied quota', async () => {
    const projectId = await freshProject();
    seedQuota(projectId, { quotaCode: 'L-VCPU', limit: 640, usage: 512 });

    const res = await request.get(`/api/projects/${projectId}/infra/quotas`).expect(200);
    expect(res.body.quotas).toHaveLength(1);
    expect(res.body.quotas[0]).toMatchObject({
      quotaCode: 'L-VCPU',
      limit: 640,
      usage: 512,
      utilizationPercent: 80,
      headroom: 128,
      // Exactly 80 is still ok: AWS alarms on Greater than 80.
      band: 'ok',
      adjustable: true,
      metricName: 'ResourceCount',
    });
    expect(res.body.summary).toMatchObject({ ok: 1, total: 1 });
  });

  it('orders the tightest quota first and unmeasurable ones last', async () => {
    const projectId = await freshProject();
    seedQuota(projectId, { quotaCode: 'L-OK', limit: 100, usage: 10 });
    seedQuota(projectId, { quotaCode: 'L-CRIT', limit: 100, usage: 120 });
    seedQuota(projectId, { quotaCode: 'L-WARN', limit: 100, usage: 90 });
    // No applied value: measurable usage, unknowable headroom.
    seedQuota(projectId, { quotaCode: 'L-UNK', limit: null, usage: 5 });

    const res = await request.get(`/api/projects/${projectId}/infra/quotas`).expect(200);
    expect(res.body.quotas.map((q: { quotaCode: string }) => q.quotaCode)).toEqual([
      'L-CRIT',
      'L-WARN',
      'L-OK',
      'L-UNK',
    ]);
    expect(res.body.summary).toEqual({
      critical: 1,
      warning: 1,
      ok: 1,
      unknown: 1,
      total: 4,
    });
  });

  it('reports unknown usage rather than a stale reading', async () => {
    // A collector that stopped must not leave a reassuring number on the panel.
    const projectId = await freshProject();
    seedQuota(projectId, {
      quotaCode: 'L-OLD',
      limit: 100,
      usage: 10,
      usageAtMs: Date.now() - 6 * 60 * 60_000,
    });

    const res = await request
      .get(`/api/projects/${projectId}/infra/quotas?staleAfterMinutes=30`)
      .expect(200);
    expect(res.body.quotas[0]).toMatchObject({ usage: null, band: 'unknown' });
    expect(res.body.staleAfterMs).toBe(30 * 60_000);
  });

  it('rejects a malformed staleness window', async () => {
    const projectId = await freshProject();
    await request.get(`/api/projects/${projectId}/infra/quotas?staleAfterMinutes=0`).expect(400);
    await request
      .get(`/api/projects/${projectId}/infra/quotas?staleAfterMinutes=nonsense`)
      .expect(400);
  });

  it('404s an unknown project', async () => {
    await request.get('/api/projects/does-not-exist/infra/quotas').expect(404);
  });
});
