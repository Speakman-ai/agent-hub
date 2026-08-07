import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express, { type Express } from 'express';
import supertest from 'supertest';
import { mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';

interface NotifyResult {
  broadcast: boolean;
  emailsQueued: number;
  emailEnqueueFailures: number;
}
const notifyInfraHealthEvent = vi.fn<(...args: unknown[]) => NotifyResult>(() => ({
  broadcast: true,
  emailsQueued: 0,
  emailEnqueueFailures: 0,
}));

// The fan-out itself is covered by health-event-notifications.test.ts; here it
// is stubbed so these tests exercise the HTTP + dedupe path in isolation.
// Fully replaced rather than spread over the real module: the real one reaches
// `release-notification-settings.js`, which opens the main database.
vi.mock('../infra/health-event-notifications.js', () => ({
  notifyInfraHealthEvent: (...args: unknown[]) => notifyInfraHealthEvent(...args),
  buildHealthEventBroadcast: (row: { project_id: string; id: string; event_arn: string }) => ({
    type: 'infra_health_event',
    projectId: row.project_id,
    healthEventId: row.id,
    eventArn: row.event_arn,
  }),
}));

const { initInfraDb, closeInfraDb } = await import('../infra/infra-db.js');
const { createInfraHealthIngestToken, revokeInfraHealthIngestToken } =
  await import('../infra/health-ingest-token-store.js');
const { listInfraHealthEvents, countInfraHealthEvents } =
  await import('../infra/health-event-store.js');
const { default: createInfraHealthIngestRoutes, _resetInfraHealthIngestRateLimit } =
  await import('./infra-health-ingest.js');
type RouteDeps = import('../types.js').RouteDeps;

let dir: string;
let app: Express;
let broadcast: ReturnType<typeof vi.fn>;

function healthEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const { detail: detailOverrides, ...envelopeOverrides } = overrides;
  return {
    version: '0',
    id: 'ebid-1',
    'detail-type': 'AWS Health Event',
    source: 'aws.health',
    account: '123456789012',
    time: '2026-01-27T01:43:21Z',
    region: 'us-east-1',
    detail: {
      eventArn: 'arn:aws:health:us-east-1::event/EC2/AWS_EC2_OPERATIONAL_ISSUE/abc',
      service: 'EC2',
      eventTypeCode: 'AWS_EC2_OPERATIONAL_ISSUE',
      eventTypeCategory: 'issue',
      eventScopeCode: 'PUBLIC',
      communicationId: 'comm-1',
      startTime: 'Fri, 27 Jan 2023 06:02:51 GMT',
      statusCode: 'open',
      eventRegion: 'us-east-1',
      eventDescription: [{ language: 'en_US', latestDescription: 'trouble' }],
      affectedEntities: [],
      affectedAccount: '123456789012',
      page: '1',
      totalPages: '1',
      backupEvent: 'false',
      ...(detailOverrides as Record<string, unknown> | undefined),
    },
    ...envelopeOverrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // clearAllMocks clears calls but NOT implementations, so a mockReturnValue
  // set by one test would leak into the next. Restore the default explicitly.
  notifyInfraHealthEvent.mockReturnValue({
    broadcast: true,
    emailsQueued: 0,
    emailEnqueueFailures: 0,
  });
  _resetInfraHealthIngestRateLimit();
  dir = mkdtempSync(path.join(os.tmpdir(), 'infra-health-route-'));
  initInfraDb(dir);
  broadcast = vi.fn();
  app = express();
  app.use(createInfraHealthIngestRoutes({ broadcast } as unknown as RouteDeps));
});

afterEach(() => {
  closeInfraDb();
  rmSync(dir, { recursive: true, force: true });
});

function post(token: string | null, body: unknown) {
  const req = supertest(app).post('/api/infra/health/ingest');
  if (token) req.set('Authorization', `Bearer ${token}`);
  return req.send(body as object);
}

describe('POST /api/infra/health/ingest — auth', () => {
  it('401s with no token', async () => {
    const res = await post(null, healthEvent());
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('missing ingest token');
  });

  it('401s on an unknown token', async () => {
    const res = await post(`ahhealth_${'z'.repeat(43)}`, healthEvent());
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid or revoked ingest token');
  });

  it('401s on a revoked token and writes nothing', async () => {
    const { token } = createInfraHealthIngestToken('p1');
    revokeInfraHealthIngestToken('p1');
    expect((await post(token, healthEvent())).status).toBe(401);
    expect(countInfraHealthEvents('p1')).toBe(0);
  });

  it('accepts the X-AgentHub-Health-Token header as well as Bearer', async () => {
    const { token } = createInfraHealthIngestToken('p1');
    const res = await supertest(app)
      .post('/api/infra/health/ingest')
      .set('X-AgentHub-Health-Token', token)
      .send(healthEvent());
    expect(res.status).toBe(200);
    expect(res.body.accepted).toBe(1);
  });

  it('derives the project from the token, never from the body', async () => {
    const { token } = createInfraHealthIngestToken('real-project');
    const res = await post(token, { ...healthEvent(), projectId: 'attacker-project' });
    expect(res.status).toBe(200);
    expect(countInfraHealthEvents('real-project')).toBe(1);
    expect(countInfraHealthEvents('attacker-project')).toBe(0);
  });
});

describe('POST /api/infra/health/ingest — at-least-once delivery', () => {
  it('accepts a single envelope, which is what an API destination sends', async () => {
    const { token } = createInfraHealthIngestToken('p1');
    const res = await post(token, healthEvent());
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ accepted: 1, deduped: 0, rejected: 0, overflow: 0 });
    expect(countInfraHealthEvents('p1')).toBe(1);
  });

  it('reports a redelivery as deduped rather than writing it twice', async () => {
    // The acceptance criterion, end to end: EventBridge delivers at least once.
    const { token } = createInfraHealthIngestToken('p1');
    await post(token, healthEvent());
    const second = await post(token, healthEvent());
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ accepted: 0, deduped: 1 });
    expect(countInfraHealthEvents('p1')).toBe(1);
  });

  it('does not notify twice for a redelivered event', async () => {
    const { token } = createInfraHealthIngestToken('p1');
    await post(token, healthEvent());
    await post(token, healthEvent());
    expect(notifyInfraHealthEvent).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenCalledTimes(1);
  });

  it('dedupes the backup-Region copy of the same communication', async () => {
    const { token } = createInfraHealthIngestToken('p1');
    await post(token, healthEvent());
    const backup = await post(
      token,
      healthEvent({ region: 'us-west-2', detail: { backupEvent: 'true' } }),
    );
    expect(backup.body).toMatchObject({ accepted: 0, deduped: 1 });
  });

  it('accepts a new communication about the same incident', async () => {
    const { token } = createInfraHealthIngestToken('p1');
    await post(token, healthEvent());
    const update = await post(
      token,
      healthEvent({ detail: { communicationId: 'comm-2', statusCode: 'closed' } }),
    );
    expect(update.body).toMatchObject({ accepted: 1, deduped: 0 });
    expect(countInfraHealthEvents('p1')).toBe(2);
  });

  it('accepts an array batch', async () => {
    const { token } = createInfraHealthIngestToken('p1');
    const res = await post(token, [
      healthEvent(),
      healthEvent({ detail: { communicationId: 'comm-2' } }),
    ]);
    expect(res.body).toMatchObject({ accepted: 2, deduped: 0 });
  });
});

describe('POST /api/infra/health/ingest — non-health payloads', () => {
  it('returns 200 with a reason rather than 400 for a wrong-source payload', async () => {
    // EventBridge does not retry a plain 4xx, so a 400 would not be
    // re-delivered — it would just count as a failed invocation and fill the
    // operator's DLQ for a delivery that is merely out of scope. The reason is
    // echoed instead so the destination's own logs explain the miss.
    const { token } = createInfraHealthIngestToken('p1');
    const res = await post(token, { ...healthEvent(), source: 'aws.health2' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ accepted: 0, rejected: 1, reasons: ['wrong-source'] });
    expect(countInfraHealthEvents('p1')).toBe(0);
  });

  it('rejects a CloudTrail API-call event on the same source', async () => {
    const { token } = createInfraHealthIngestToken('p1');
    const res = await post(token, {
      ...healthEvent(),
      'detail-type': 'AWS API Call via CloudTrail',
    });
    expect(res.body).toMatchObject({ accepted: 0, reasons: ['wrong-detail-type'] });
  });

  it('accepts the good half of a mixed batch', async () => {
    const { token } = createInfraHealthIngestToken('p1');
    const res = await post(token, [healthEvent(), { source: 'nope' }]);
    expect(res.body).toMatchObject({ accepted: 1, rejected: 1 });
  });

  it('does not broadcast when nothing was accepted', async () => {
    const { token } = createInfraHealthIngestToken('p1');
    await post(token, { source: 'nope' });
    expect(broadcast).not.toHaveBeenCalled();
  });
});

describe('POST /api/infra/health/ingest — notification fan-out', () => {
  it('broadcasts the safe projection for an accepted event', async () => {
    const { token } = createInfraHealthIngestToken('p1');
    await post(token, healthEvent());
    expect(broadcast).toHaveBeenCalledTimes(1);
    const payload = broadcast.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload.type).toBe('infra_health_event');
    expect(payload.projectId).toBe('p1');
    // INFRA-NOTIFY: broadcasts fan out project-wide, so no account id.
    expect(JSON.stringify(payload)).not.toContain('123456789012');
  });

  it('does not broadcast when routing suppressed it', async () => {
    notifyInfraHealthEvent.mockReturnValue({
      broadcast: false,
      emailsQueued: 0,
      emailEnqueueFailures: 0,
    });
    const { token } = createInfraHealthIngestToken('p1');
    await post(token, healthEvent());
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('leaves the event pending when an email enqueue failed', async () => {
    // Pending is the correct failure mode: the recovery sweep retries it
    // rather than the event being silently un-notified.
    notifyInfraHealthEvent.mockReturnValue({
      broadcast: true,
      emailsQueued: 0,
      emailEnqueueFailures: 1,
    });
    const { token } = createInfraHealthIngestToken('p1');
    await post(token, healthEvent());
    expect(listInfraHealthEvents('p1')[0]!.notification_delivered_at_ms).toBeNull();
  });

  it('marks the event delivered on a clean fan-out', async () => {
    const { token } = createInfraHealthIngestToken('p1');
    await post(token, healthEvent());
    expect(listInfraHealthEvents('p1')[0]!.notification_delivered_at_ms).not.toBeNull();
  });

  it('still returns 200 when the fan-out throws', async () => {
    notifyInfraHealthEvent.mockImplementation(() => {
      throw new Error('boom');
    });
    const { token } = createInfraHealthIngestToken('p1');
    const res = await post(token, healthEvent());
    expect(res.status).toBe(200);
    expect(res.body.accepted).toBe(1);
  });
});

describe('POST /api/infra/health/ingest — rate limiting', () => {
  it('429s with Retry-After once the per-project ceiling is hit', async () => {
    process.env.INFRA_HEALTH_INGEST_PER_TOKEN_MAX = '2';
    try {
      const { token } = createInfraHealthIngestToken('p1');
      await post(token, healthEvent({ detail: { communicationId: 'c1' } }));
      await post(token, healthEvent({ detail: { communicationId: 'c2' } }));
      const third = await post(token, healthEvent({ detail: { communicationId: 'c3' } }));
      expect(third.status).toBe(429);
      expect(third.headers['retry-after']).toBe('60');
    } finally {
      delete process.env.INFRA_HEALTH_INGEST_PER_TOKEN_MAX;
    }
  });

  it('429s on the per-IP ceiling before any token work happens', async () => {
    process.env.INFRA_HEALTH_INGEST_PER_IP_MAX = '1';
    try {
      await post(null, healthEvent());
      const second = await post(null, healthEvent());
      expect(second.status).toBe(429);
      expect(second.body.error).toBe('rate limit exceeded');
    } finally {
      delete process.env.INFRA_HEALTH_INGEST_PER_IP_MAX;
    }
  });
});
