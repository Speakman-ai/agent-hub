/**
 * HTTP contract for the infra alert-rule and alert-lifecycle routes.
 *
 * Two harnesses, because they answer different questions:
 *
 *   - The **integration** block drives the real Express app via supertest, the
 *     same way `infra.test.ts` does. It covers the request/response contract:
 *     status codes, body shapes, validation, and the 404-before-anything-else
 *     ordering. That suite runs in no-auth-configured mode where every caller
 *     resolves to Owner, so `requireRole('Admin')` is wide open there.
 *   - The **auth-gating** block therefore mounts the router into a tiny ad-hoc
 *     app and stamps auth claims per request — the only way to actually
 *     exercise the Admin gate, and the same pattern `agents-visibility.test.ts`
 *     uses for the visibility filter it cannot reach through the real app.
 */
import '../test/setup.js';
import express, { type NextFunction, type Request, type Response } from 'express';
import supertestRequest from 'supertest';
import type supertest from 'supertest';
import { describe, it, expect, beforeAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { getRequest } from '../test/helpers.js';
import createInfraAlertRoutes from './infra-alerts.js';
import type { Project, RouteDeps } from '../types.js';

let request: supertest.Agent;

beforeAll(async () => {
  request = await getRequest();
});

async function freshProject(): Promise<string> {
  const id = `infra-alerts-${uuidv4().slice(0, 8)}`;
  await request
    .post('/api/projects')
    .send({ id, name: id, cwd: '/tmp', color: '#3B82F6' })
    .expect(201);
  return id;
}

function ruleBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'ALB unhealthy hosts',
    service: 'elbv2',
    namespace: 'AWS/ApplicationELB',
    metricName: 'UnHealthyHostCount',
    // AWS's own published guidance for this metric: the Minimum statistic over
    // more than one datapoint (decision INFRA-ALERT's default rule packs).
    stat: 'Minimum',
    periodS: 60,
    threshold: 0,
    comparisonOperator: 'GreaterThanThreshold',
    evaluationPeriods: 2,
    ...overrides,
  };
}

async function createRule(
  projectId: string,
  overrides: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const res = await request
    .post(`/api/projects/${projectId}/infra/alert-rules`)
    .send(ruleBody(overrides))
    .expect(201);
  return res.body as Record<string, unknown>;
}

describe('infra alert rules', () => {
  it('creates a rule with the documented defaults and lists it back', async () => {
    const projectId = await freshProject();
    const created = await createRule(projectId);

    expect(created).toMatchObject({
      projectId,
      name: 'ALB unhealthy hosts',
      service: 'elbv2',
      metricName: 'UnHealthyHostCount',
      datapointsToAlarm: null,
      treatMissingData: 'missing',
      severity: 'warning',
      enabled: true,
      tagFilter: null,
    });
    expect(typeof created.id).toBe('string');

    const list = await request.get(`/api/projects/${projectId}/infra/alert-rules`).expect(200);
    expect(list.body.rules).toHaveLength(1);
    expect(list.body.rules[0].id).toBe(created.id);
  });

  it('rejects a rule that could never reach ALARM', async () => {
    const projectId = await freshProject();
    const res = await request
      .post(`/api/projects/${projectId}/infra/alert-rules`)
      .send(ruleBody({ evaluationPeriods: 2, datapointsToAlarm: 5 }))
      .expect(400);

    expect(String(res.body.error)).toMatch(/never reach ALARM/);
  });

  it('rejects an anomaly-detection comparison operator', async () => {
    const projectId = await freshProject();
    // PutMetricAlarm accepts this one, but only for anomaly-detection alarms.
    // We fit no model, so accepting it would mean accepting a rule we cannot
    // evaluate.
    await request
      .post(`/api/projects/${projectId}/infra/alert-rules`)
      .send(ruleBody({ comparisonOperator: 'GreaterThanUpperThreshold' }))
      .expect(400);
  });

  it('filters the rule list by service and enabled', async () => {
    const projectId = await freshProject();
    await createRule(projectId, { service: 'elbv2' });
    await createRule(projectId, { service: 'ec2', enabled: false });

    const byService = await request
      .get(`/api/projects/${projectId}/infra/alert-rules?service=ec2`)
      .expect(200);
    expect(byService.body.rules).toHaveLength(1);
    expect(byService.body.rules[0].service).toBe('ec2');

    const enabled = await request
      .get(`/api/projects/${projectId}/infra/alert-rules?enabled=true`)
      .expect(200);
    expect(enabled.body.rules).toHaveLength(1);
    expect(enabled.body.rules[0].service).toBe('elbv2');
  });

  it('patches a rule without disturbing absent fields', async () => {
    const projectId = await freshProject();
    const created = await createRule(projectId);

    const updated = await request
      .put(`/api/projects/${projectId}/infra/alert-rules/${created.id}`)
      .send({ threshold: 2, severity: 'critical' })
      .expect(200);

    expect(updated.body).toMatchObject({
      threshold: 2,
      severity: 'critical',
      name: 'ALB unhealthy hosts',
      evaluationPeriods: 2,
    });
  });

  it('rejects an empty patch', async () => {
    const projectId = await freshProject();
    const created = await createRule(projectId);

    await request
      .put(`/api/projects/${projectId}/infra/alert-rules/${created.id}`)
      .send({})
      .expect(400);
  });

  it('404s a rule from another project rather than leaking it', async () => {
    const projectA = await freshProject();
    const projectB = await freshProject();
    const created = await createRule(projectA);

    await request
      .put(`/api/projects/${projectB}/infra/alert-rules/${created.id}`)
      .send({ threshold: 9 })
      .expect(404);
    await request.delete(`/api/projects/${projectB}/infra/alert-rules/${created.id}`).expect(404);
  });

  it('deletes a rule and 404s the second attempt', async () => {
    const projectId = await freshProject();
    const created = await createRule(projectId);

    await request.delete(`/api/projects/${projectId}/infra/alert-rules/${created.id}`).expect(204);
    await request.delete(`/api/projects/${projectId}/infra/alert-rules/${created.id}`).expect(404);
    const list = await request.get(`/api/projects/${projectId}/infra/alert-rules`).expect(200);
    expect(list.body.rules).toHaveLength(0);
  });

  it('404s an unknown project before validating the body', async () => {
    // Order matters: answering 400 first would confirm the project is real to a
    // caller who only guessed at its id.
    await request
      .post('/api/projects/no-such-project/infra/alert-rules')
      .send({ nonsense: true })
      .expect(404);
  });
});

describe('infra alerts', () => {
  it('lists an empty page for a project that has never breached', async () => {
    const projectId = await freshProject();
    const res = await request.get(`/api/projects/${projectId}/infra/alerts`).expect(200);
    expect(res.body).toEqual({ alerts: [], nextCursor: null });
  });

  it('rejects a malformed list query', async () => {
    const projectId = await freshProject();
    await request.get(`/api/projects/${projectId}/infra/alerts?status=bogus`).expect(400);
    await request.get(`/api/projects/${projectId}/infra/alerts?limit=0`).expect(400);
  });

  it('404s an unknown alert', async () => {
    const projectId = await freshProject();
    await request.get(`/api/projects/${projectId}/infra/alerts/nope`).expect(404);
    await request
      .put(`/api/projects/${projectId}/infra/alerts/nope/status`)
      .send({ status: 'resolved' })
      .expect(404);
  });

  it('rejects an unknown lifecycle status', async () => {
    const projectId = await freshProject();
    await request
      .put(`/api/projects/${projectId}/infra/alerts/any/status`)
      .send({ status: 'snoozed' })
      .expect(400);
  });
});

// ── Auth gating ────────────────────────────────────────────────────────────

/**
 * Claims the auth middleware would normally stamp. The integration suite above
 * runs with no auth configured, so every caller there is Owner and the Admin
 * gate is never actually exercised — these tests stamp the claims by hand.
 */
interface AuthClaims {
  authUserId?: string;
  authRole?: 'Owner' | 'Admin' | 'User';
}

function makeGatedApp(claims: AuthClaims) {
  const project = {
    id: 'gated',
    name: 'Gated',
    cwd: '/tmp',
    ahw: '/tmp',
    agents: [],
  } as unknown as Project;
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    Object.assign(req, claims);
    next();
  });
  app.use(
    createInfraAlertRoutes({
      findProject: (id: string) => (id === project.id ? project : undefined),
    } as unknown as RouteDeps),
  );
  return app;
}

describe('infra alert route auth gating', () => {
  const routes: ReadonlyArray<[string, 'get' | 'post' | 'put' | 'delete', string]> = [
    ['list rules', 'get', '/api/projects/gated/infra/alert-rules'],
    ['create rule', 'post', '/api/projects/gated/infra/alert-rules'],
    ['update rule', 'put', '/api/projects/gated/infra/alert-rules/r1'],
    ['delete rule', 'delete', '/api/projects/gated/infra/alert-rules/r1'],
    ['list alerts', 'get', '/api/projects/gated/infra/alerts'],
    ['get alert', 'get', '/api/projects/gated/infra/alerts/a1'],
    ['set alert status', 'put', '/api/projects/gated/infra/alerts/a1/status'],
  ];

  it.each(routes)('rejects %s below the Admin role', async (_label, method, path) => {
    const app = makeGatedApp({ authUserId: 'u1', authRole: 'User' });
    const res = await supertestRequest(app)[method](path).send({}).expect(403);
    expect(res.body).toMatchObject({ requiredRole: 'Admin', currentRole: 'User' });
  });

  it.each(routes)('rejects %s with no authenticated role at all', async (_label, method, path) => {
    const app = makeGatedApp({});
    await supertestRequest(app)[method](path).send({}).expect(401);
  });

  it('lets an Admin through the gate', async () => {
    const app = makeGatedApp({ authUserId: 'u1', authRole: 'Admin' });
    // Past the gate: the project resolves, so this is a real 200 from the
    // handler rather than a 403 from the middleware.
    await supertestRequest(app).get('/api/projects/gated/infra/alert-rules').expect(200);
  });

  it('still 404s an Admin on a project they named wrong', async () => {
    const app = makeGatedApp({ authUserId: 'u1', authRole: 'Admin' });
    await supertestRequest(app).get('/api/projects/other/infra/alert-rules').expect(404);
  });
});
