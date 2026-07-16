import '../test/setup.js';
import type supertest from 'supertest';
import express from 'express';
import stSupertest from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { createProject, getRequest } from '../test/helpers.js';
import { insertLogRecords } from '../logs/logs-db.js';
import { isPublicPath } from '../auth.js';
import createLogQueryRoutes, { isFtsSyntaxError } from './log-query.js';
import type { Project, RouteDeps } from '../types.js';

let request: supertest.Agent;
let projectA: string;
let projectB: string;
let aNewestId: number;
let bCursor: number;

beforeAll(async () => {
  request = await getRequest();
  projectA = (await createProject({ cwd: '/tmp' })).id as string;
  projectB = (await createProject({ cwd: '/tmp' })).id as string;
  const a = insertLogRecords(
    [
      {
        projectId: projectA,
        sourceId: 'source-a',
        timeUnixNano: 10,
        severityNumber: 9,
        body: 'older checkout warning',
        serviceName: 'checkout',
        environment: 'staging',
      },
      {
        projectId: projectA,
        sourceId: 'source-a',
        timeUnixNano: 20,
        severityNumber: 17,
        body: 'new checkout failure',
        serviceName: 'checkout',
        environment: 'prod',
        traceId: 'trace-a',
        fingerprint: 'fp-a',
      },
    ],
    Date.now(),
  );
  aNewestId = a.records[1]!.id;
  bCursor = insertLogRecords(
    [
      {
        projectId: projectB,
        sourceId: 'source-b',
        timeUnixNano: 30,
        severityNumber: 17,
        body: 'secret other-project failure',
        serviceName: 'billing',
        environment: 'prod',
      },
    ],
    Date.now(),
  ).records[0]!.id;
});

describe('GET /api/projects/:projectId/logs', () => {
  it('returns a bounded newest-first filtered page with camel-case records', async () => {
    const res = await request
      .get(
        `/api/projects/${projectA}/logs?serviceName=checkout&environment=prod&minSeverityNumber=17&traceId=trace-a&fingerprint=fp-a&text=checkout`,
      )
      .expect(200);
    expect(res.body).toMatchObject({ nextCursor: null });
    expect(res.body.records).toHaveLength(1);
    expect(res.body.records[0]).toMatchObject({
      id: aNewestId,
      projectId: projectA,
      sourceId: 'source-a',
      body: 'new checkout failure',
    });
    expect(res.body.records[0].project_id).toBeUndefined();
  });

  it('never leaks records when supplied a cursor minted by another project', async () => {
    const res = await request
      .get(`/api/projects/${projectA}/logs?cursor=${bCursor}&limit=50`)
      .expect(200);
    expect(
      res.body.records.every((record: { projectId: string }) => record.projectId === projectA),
    ).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain('secret other-project failure');
  });

  it('rejects invalid bounded query parameters', async () => {
    await request.get(`/api/projects/${projectA}/logs?limit=999999`).expect(400);
    await request.get(`/api/projects/${projectA}/logs?text=%22unterminated`).expect(400);
  });
});

describe('DELETE /api/projects/:projectId/logs (clear logs)', () => {
  it('purges only the target project and reports the count', async () => {
    const projectC = (await createProject({ cwd: '/tmp' })).id as string;
    const projectD = (await createProject({ cwd: '/tmp' })).id as string;
    insertLogRecords(
      [
        { projectId: projectC, sourceId: 's', timeUnixNano: 1, severityNumber: 9, body: 'c1' },
        { projectId: projectC, sourceId: 's', timeUnixNano: 2, severityNumber: 9, body: 'c2' },
      ],
      Date.now(),
    );
    insertLogRecords(
      [{ projectId: projectD, sourceId: 's', timeUnixNano: 3, severityNumber: 9, body: 'd1' }],
      Date.now(),
    );

    const res = await request.delete(`/api/projects/${projectC}/logs`).expect(200);
    expect(res.body).toEqual({ purged: 2 });

    // Target project is emptied; the sibling project is untouched.
    const emptied = await request.get(`/api/projects/${projectC}/logs`).expect(200);
    expect(emptied.body.records).toHaveLength(0);
    const sibling = await request.get(`/api/projects/${projectD}/logs`).expect(200);
    expect(sibling.body.records).toHaveLength(1);
  });

  it('returns { purged: 0 } for a project with no records', async () => {
    const projectE = (await createProject({ cwd: '/tmp' })).id as string;
    const res = await request.delete(`/api/projects/${projectE}/logs`).expect(200);
    expect(res.body).toEqual({ purged: 0 });
  });

  it('404s an unknown project without leaking its existence', async () => {
    await request.delete('/api/projects/does-not-exist/logs').expect(404);
  });
});

// ─── DELETE authorization, isolated from the shared app's break-glass Owner ──
// The shared supertest app authenticates as the local Owner (localBypass), so
// the Admin gate + visibility both pass there. To prove the destructive route
// is genuinely Admin-gated AND ACL-scoped — not merely reachable in the bypass
// harness — mount it behind a stubbed auth middleware we can downgrade, mirror-
// ing the log-sources authorization tests.
function buildStubbedApp(stub: { role?: string; userId?: string }, project?: Project) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const r = req as unknown as { authRole?: string; authUserId?: string };
    if (stub.role !== undefined) r.authRole = stub.role;
    if (stub.userId !== undefined) r.authUserId = stub.userId;
    next();
  });
  const deps = {
    findProject: (id: string): Project | null => (project && id === project.id ? project : null),
  } as unknown as RouteDeps;
  app.use(createLogQueryRoutes(deps));
  return app;
}

describe('DELETE /api/projects/:projectId/logs authorization', () => {
  const visibleProject = { id: 'p1', name: 'P1' } as unknown as Project;

  it('401s when the request carries no role', async () => {
    const app = buildStubbedApp({}, visibleProject);
    await stSupertest(app).delete('/api/projects/p1/logs').expect(401);
  });

  it('403s a plain User (clearing logs requires Admin)', async () => {
    const app = buildStubbedApp({ role: 'User', userId: 'u1' }, visibleProject);
    await stSupertest(app).delete('/api/projects/p1/logs').expect(403);
  });

  it('404s an existing project the Admin caller cannot see (no destructive leak)', async () => {
    // Private project owned by someone else: the Admin passes the role gate but
    // fails the route's `canViewProject` check, so the purge is masked as 404
    // instead of silently clearing another user's logs.
    const privateProject = {
      id: 'p1',
      name: 'P1',
      visibility: 'private',
      ownerUserId: 'other-user',
    } as unknown as Project;
    const app = buildStubbedApp({ role: 'Admin', userId: 'u1' }, privateProject);
    await stSupertest(app).delete('/api/projects/p1/logs').expect(404);
  });
});

describe('customer log credentials remain write-only', () => {
  it('does not put the query route on the public ingest-token allowlist', () => {
    expect(isPublicPath(`/api/projects/${projectA}/logs`, 'GET')).toBe(false);
    expect(isPublicPath('/api/logs/ingest', 'POST')).toBe(true);
  });
});

describe('FTS query failures', () => {
  it('classifies only FTS parser syntax errors as user input', () => {
    expect(isFtsSyntaxError(new Error('fts5: syntax error near ""'))).toBe(true);
    expect(isFtsSyntaxError(new Error('unterminated string'))).toBe(true);
    expect(isFtsSyntaxError(new Error('SQLITE_IOERR: disk I/O error'))).toBe(false);
    expect(isFtsSyntaxError(new Error('database is locked'))).toBe(false);
  });
});
