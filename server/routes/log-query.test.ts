import '../test/setup.js';
import type supertest from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { createProject, getRequest } from '../test/helpers.js';
import { insertLogRecords } from '../logs/logs-db.js';
import { isPublicPath } from '../auth.js';
import { isFtsSyntaxError } from './log-query.js';

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
