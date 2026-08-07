import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import supertest from 'supertest';
import { mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { initInfraDb, closeInfraDb } from '../infra/infra-db.js';
import { recordInfraHealthEvents } from '../infra/health-event-store.js';
import type { ParsedHealthEvent } from '../infra/health-event-parse.js';
import { createInfraHealthIngestToken } from '../infra/health-ingest-token-store.js';
import createInfraHealthRoutes, { AWS_HEALTH_EVENT_PATTERN } from './infra-health.js';
import type { RouteDeps } from '../types.js';

let dir: string;
let app: Express;

function makeApp(role = 'Admin'): Express {
  const instance = express();
  instance.use(express.json());
  // Stand in for the auth middleware: `requireRole` reads `authRole`.
  instance.use((req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { authRole?: string }).authRole = role;
    next();
  });
  const deps = {
    findProject: (id: string) => (id === 'p1' ? ({ id: 'p1' } as never) : null),
  } as unknown as RouteDeps;
  instance.use(createInfraHealthRoutes(deps));
  return instance;
}

function event(overrides: Partial<ParsedHealthEvent> = {}): ParsedHealthEvent {
  return {
    eventArn: 'arn:aws:health:us-east-1::event/EC2/AWS_EC2_OPERATIONAL_ISSUE/abc',
    communicationId: 'comm-1',
    affectedAccount: '123456789012',
    accountId: '123456789012',
    deliveryRegion: 'us-east-1',
    eventRegion: 'us-east-1',
    detailType: 'AWS Health Event',
    service: 'EC2',
    eventTypeCode: 'AWS_EC2_OPERATIONAL_ISSUE',
    eventTypeCategory: 'issue',
    eventScopeCode: 'PUBLIC',
    statusCode: 'open',
    severity: 'critical',
    startTimeMs: 1_700_000_000_000,
    endTimeMs: null,
    lastUpdatedMs: null,
    description: 'trouble',
    affectedEntities: [],
    affectedEntityCount: 0,
    backupEvent: false,
    page: 1,
    totalPages: 1,
    eventTimeMs: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  dir = mkdtempSync(path.join(os.tmpdir(), 'infra-health-read-'));
  initInfraDb(dir);
  app = makeApp();
});

afterEach(() => {
  closeInfraDb();
  rmSync(dir, { recursive: true, force: true });
});

describe('GET /api/projects/:projectId/infra/health-events', () => {
  it('404s on an unknown project', async () => {
    const res = await supertest(app).get('/api/projects/nope/infra/health-events');
    expect(res.status).toBe(404);
  });

  it('403s a non-Admin caller', async () => {
    const res = await supertest(makeApp('User')).get('/api/projects/p1/infra/health-events');
    expect(res.status).toBe(403);
  });

  it('returns an empty timeline with ingestConfigured false before setup', async () => {
    const res = await supertest(app).get('/api/projects/p1/infra/health-events');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ events: [], total: 0, ingestConfigured: false });
  });

  it('reports ingestConfigured once a token exists', async () => {
    createInfraHealthIngestToken('p1');
    const res = await supertest(app).get('/api/projects/p1/infra/health-events');
    expect(res.body.ingestConfigured).toBe(true);
  });

  it('serializes events without leaking an AWS account id', async () => {
    recordInfraHealthEvents('p1', [event()], 1000);
    const res = await supertest(app).get('/api/projects/p1/infra/health-events');
    expect(res.body.events).toHaveLength(1);
    expect(res.body.events[0]).toMatchObject({
      eventTypeCode: 'AWS_EC2_OPERATIONAL_ISSUE',
      severity: 'critical',
      region: 'us-east-1',
    });
    expect(JSON.stringify(res.body)).not.toContain('123456789012');
  });

  it('collapses to the newest communication by default', async () => {
    recordInfraHealthEvents('p1', [event({ communicationId: 'c1' })], 1000);
    recordInfraHealthEvents('p1', [event({ communicationId: 'c2', statusCode: 'closed' })], 2000);
    const collapsed = await supertest(app).get('/api/projects/p1/infra/health-events');
    expect(collapsed.body.events).toHaveLength(1);
    expect(collapsed.body.events[0].statusCode).toBe('closed');
    // `total` counts every stored communication, not the collapsed view.
    expect(collapsed.body.total).toBe(2);

    const full = await supertest(app).get('/api/projects/p1/infra/health-events?latestOnly=false');
    expect(full.body.events).toHaveLength(2);
  });

  it('filters by statusCode and honours limit', async () => {
    recordInfraHealthEvents('p1', [event({ eventArn: 'a1', communicationId: 'c1' })], 1000);
    recordInfraHealthEvents(
      'p1',
      [event({ eventArn: 'a2', communicationId: 'c2', statusCode: 'closed' })],
      2000,
    );
    const closed = await supertest(app).get(
      '/api/projects/p1/infra/health-events?statusCode=closed',
    );
    expect(closed.body.events).toHaveLength(1);

    const limited = await supertest(app).get('/api/projects/p1/infra/health-events?limit=1');
    expect(limited.body.events).toHaveLength(1);
  });

  it('400s on an out-of-range limit or unknown statusCode', async () => {
    expect((await supertest(app).get('/api/projects/p1/infra/health-events?limit=0')).status).toBe(
      400,
    );
    expect(
      (await supertest(app).get('/api/projects/p1/infra/health-events?statusCode=bogus')).status,
    ).toBe(400);
  });
});

describe('the ingest credential stays write-only', () => {
  it('only the POST ingest path is public; every read stays gated', async () => {
    const { isPublicPath } = await import('../auth.js');
    expect(isPublicPath('/api/infra/health/ingest', 'POST')).toBe(true);
    // Trailing-slash tolerant, matching Express's non-strict routing and the
    // body-parser skip regex in index.ts.
    expect(isPublicPath('/api/infra/health/ingest/', 'POST')).toBe(true);
    // A write-only credential must never reach a read or management surface.
    expect(isPublicPath('/api/infra/health/ingest', 'GET')).toBe(false);
    expect(isPublicPath('/api/projects/p1/infra/health-events', 'GET')).toBe(false);
    expect(isPublicPath('/api/projects/p1/infra/health-ingest', 'POST')).toBe(false);
    expect(isPublicPath('/api/projects/p1/infra/health-ingest', 'GET')).toBe(false);
  });
});

describe('ingest token management', () => {
  it('404s on an unknown project', async () => {
    expect((await supertest(app).post('/api/projects/nope/infra/health-ingest')).status).toBe(404);
  });

  it('403s a non-Admin caller', async () => {
    expect(
      (await supertest(makeApp('User')).post('/api/projects/p1/infra/health-ingest')).status,
    ).toBe(403);
  });

  it('reports no token before one is minted, with the setup material', async () => {
    const res = await supertest(app).get('/api/projects/p1/infra/health-ingest');
    expect(res.status).toBe(200);
    expect(res.body.token).toBeNull();
    expect(res.body.ingestPath).toBe('/api/infra/health/ingest');
    // The exact literal pattern; a wildcard source silently never matches.
    expect(res.body.eventPattern).toEqual(AWS_HEALTH_EVENT_PATTERN);
    expect(res.body.eventPattern.source).toEqual(['aws.health']);
  });

  it('mints a token and returns the plaintext exactly once', async () => {
    const mint = await supertest(app).post('/api/projects/p1/infra/health-ingest');
    expect(mint.status).toBe(201);
    expect(mint.body.token).toMatch(/^ahhealth_/);
    expect(mint.body.info.projectId).toBe('p1');

    // The read endpoint must never expose it again.
    const read = await supertest(app).get('/api/projects/p1/infra/health-ingest');
    expect(JSON.stringify(read.body)).not.toContain(mint.body.token.slice(20));
    expect(read.body.token.tokenPrefix).toBe(mint.body.token.slice(0, 17));
  });

  it('rotation returns a different token and stamps rotatedAt', async () => {
    const first = await supertest(app).post('/api/projects/p1/infra/health-ingest');
    const second = await supertest(app).post('/api/projects/p1/infra/health-ingest');
    expect(second.body.token).not.toBe(first.body.token);
    expect(second.body.info.rotatedAt).not.toBeNull();
  });

  it('revokes idempotently and reports it on the read', async () => {
    await supertest(app).post('/api/projects/p1/infra/health-ingest');
    const first = await supertest(app).delete('/api/projects/p1/infra/health-ingest');
    expect(first.body.revoked).toBe(true);
    expect(first.body.token.revokedAt).not.toBeNull();

    const second = await supertest(app).delete('/api/projects/p1/infra/health-ingest');
    expect(second.body.revoked).toBe(false);
  });

  it('a revoked project reports ingestConfigured false again', async () => {
    await supertest(app).post('/api/projects/p1/infra/health-ingest');
    await supertest(app).delete('/api/projects/p1/infra/health-ingest');
    const res = await supertest(app).get('/api/projects/p1/infra/health-events');
    expect(res.body.ingestConfigured).toBe(false);
  });
});
