import '../test/setup.js';
import type supertest from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { createProject, getRequest } from '../test/helpers.js';
import { insertLogRecords, type LogRecordInput } from '../logs/logs-db.js';
import { deriveIssueGrouping } from '../logs/log-fingerprint.js';
import { SEVERITY_NUMBER } from '../logs/logs-schema.js';

const MS = 1_000_000;

function errRecord(projectId: string, body: string, timeMs: number): LogRecordInput {
  const grouping = deriveIssueGrouping({
    projectId,
    sourceId: 'src1',
    serviceName: 'checkout',
    environment: 'prod',
    severityNumber: SEVERITY_NUMBER.ERROR,
    body,
    attributes: { 'exception.type': 'CheckoutError' },
    resource: { 'service.version': '1.2.3', 'git.commit.sha': 'deadbeef' },
  });
  return {
    projectId,
    sourceId: 'src1',
    timeUnixNano: timeMs * MS,
    severityNumber: SEVERITY_NUMBER.ERROR,
    serviceName: 'checkout',
    environment: 'prod',
    body,
    fingerprint: grouping?.fingerprint ?? null,
    grouping,
  };
}

let request: supertest.Agent;
let projectA: string;
let projectB: string;

beforeAll(async () => {
  request = await getRequest();
  projectA = (await createProject({ cwd: '/tmp' })).id as string;
  projectB = (await createProject({ cwd: '/tmp' })).id as string;
  insertLogRecords(
    [errRecord(projectA, 'order 1 failed', 100), errRecord(projectA, 'order 2 failed', 200)],
    Date.now(),
  );
  insertLogRecords([errRecord(projectB, 'secret other-project failure', 300)], Date.now());
});

describe('GET /api/projects/:projectId/logs/issues', () => {
  it('lists grouped issues with aggregate + camelCase fields', async () => {
    const res = await request.get(`/api/projects/${projectA}/logs/issues`).expect(200);
    expect(res.body.issues).toHaveLength(1);
    expect(res.body.issues[0]).toMatchObject({
      projectId: projectA,
      exceptionType: 'CheckoutError',
      eventCount: 2,
      status: 'open',
    });
    expect(res.body.issues[0].project_id).toBeUndefined();
  });

  it('never leaks another project’s issues', async () => {
    const res = await request.get(`/api/projects/${projectA}/logs/issues`).expect(200);
    expect(JSON.stringify(res.body)).not.toContain('other-project');
  });

  it('rejects an invalid status filter', async () => {
    await request.get(`/api/projects/${projectA}/logs/issues?status=bogus`).expect(400);
  });

  it('404s for an unknown project', async () => {
    await request.get(`/api/projects/does-not-exist/logs/issues`).expect(404);
  });
});

describe('GET /api/projects/:projectId/logs/issues/:issueId', () => {
  it('returns detail with release facets and raw sample records', async () => {
    const list = await request.get(`/api/projects/${projectA}/logs/issues`).expect(200);
    const id = list.body.issues[0].id as string;
    const res = await request.get(`/api/projects/${projectA}/logs/issues/${id}`).expect(200);
    expect(res.body.id).toBe(id);
    expect(res.body.releases).toEqual([
      expect.objectContaining({ release: '1.2.3', commitSha: 'deadbeef', eventCount: 2 }),
    ]);
    expect(res.body.samples.length).toBeGreaterThanOrEqual(2);
    expect(res.body.samples.every((s: { fingerprint: string }) => s.fingerprint)).toBe(true);
  });

  it('does not resolve an issue id from another project (404)', async () => {
    const list = await request.get(`/api/projects/${projectA}/logs/issues`).expect(200);
    const id = list.body.issues[0].id as string;
    await request.get(`/api/projects/${projectB}/logs/issues/${id}`).expect(404);
  });
});

describe('issue lifecycle transitions', () => {
  it('resolves, ignores, and reopens an issue', async () => {
    const list = await request.get(`/api/projects/${projectA}/logs/issues`).expect(200);
    const id = list.body.issues[0].id as string;

    let res = await request.post(`/api/projects/${projectA}/logs/issues/${id}/resolve`).expect(200);
    expect(res.body.status).toBe('resolved');

    res = await request.post(`/api/projects/${projectA}/logs/issues/${id}/ignore`).expect(200);
    expect(res.body.status).toBe('ignored');

    res = await request.post(`/api/projects/${projectA}/logs/issues/${id}/reopen`).expect(200);
    expect(res.body.status).toBe('open');
  });

  it('404s a transition on a foreign-project issue id', async () => {
    const list = await request.get(`/api/projects/${projectA}/logs/issues`).expect(200);
    const id = list.body.issues[0].id as string;
    await request.post(`/api/projects/${projectB}/logs/issues/${id}/resolve`).expect(404);
  });
});

describe('POST /api/projects/:projectId/logs/issues/bulk-status', () => {
  let bulkIds: string[];

  beforeAll(() => {
    insertLogRecords(
      [
        errRecord(projectA, 'bulk alpha exploded', 400),
        errRecord(projectA, 'bulk beta exploded', 500),
      ],
      Date.now(),
    );
  });

  async function idsFor(bodies: string[]): Promise<string[]> {
    const list = await request.get(`/api/projects/${projectA}/logs/issues?limit=200`).expect(200);
    return bodies.map((body) => {
      const match = (list.body.issues as Array<{ id: string; title: string }>).find((issue) =>
        issue.title.includes(body),
      );
      if (!match) throw new Error(`no issue for ${body}`);
      return match.id;
    });
  }

  it('resolves every selected issue in one call', async () => {
    bulkIds = await idsFor(['bulk alpha', 'bulk beta']);
    const res = await request
      .post(`/api/projects/${projectA}/logs/issues/bulk-status`)
      .send({ issueIds: bulkIds, status: 'resolved' })
      .expect(200);
    expect(res.body.updated.map((i: { id: string }) => i.id).sort()).toEqual([...bulkIds].sort());
    expect(res.body.updated.every((i: { status: string }) => i.status === 'resolved')).toBe(true);
    expect(res.body.notFound).toEqual([]);

    for (const id of bulkIds) {
      const detail = await request.get(`/api/projects/${projectA}/logs/issues/${id}`).expect(200);
      expect(detail.body.status).toBe('resolved');
    }
  });

  it('reports unknown ids instead of failing the batch', async () => {
    const [known] = await idsFor(['bulk alpha']);
    const res = await request
      .post(`/api/projects/${projectA}/logs/issues/bulk-status`)
      .send({ issueIds: [known, 'not-an-issue'], status: 'ignored' })
      .expect(200);
    expect(res.body.updated).toHaveLength(1);
    expect(res.body.updated[0].id).toBe(known);
    expect(res.body.notFound).toEqual(['not-an-issue']);
  });

  it('never transitions an issue belonging to another project', async () => {
    const foreign = await request.get(`/api/projects/${projectB}/logs/issues`).expect(200);
    const foreignId = foreign.body.issues[0].id as string;
    const res = await request
      .post(`/api/projects/${projectA}/logs/issues/bulk-status`)
      .send({ issueIds: [foreignId], status: 'resolved' })
      .expect(200);
    expect(res.body.updated).toEqual([]);
    expect(res.body.notFound).toEqual([foreignId]);

    const stillOpen = await request
      .get(`/api/projects/${projectB}/logs/issues/${foreignId}`)
      .expect(200);
    expect(stillOpen.body.status).toBe('open');
  });

  it('rejects an empty selection and an unknown status', async () => {
    await request
      .post(`/api/projects/${projectA}/logs/issues/bulk-status`)
      .send({ issueIds: [], status: 'resolved' })
      .expect(400);
    await request
      .post(`/api/projects/${projectA}/logs/issues/bulk-status`)
      .send({ issueIds: ['x'], status: 'bogus' })
      .expect(400);
  });

  it('404s for an unknown project', async () => {
    await request
      .post(`/api/projects/does-not-exist/logs/issues/bulk-status`)
      .send({ issueIds: ['x'], status: 'resolved' })
      .expect(404);
  });
});
