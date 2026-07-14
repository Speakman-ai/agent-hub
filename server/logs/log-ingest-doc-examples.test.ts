/**
 * Proves the copy-ready examples in `docs/guides/application-logs.md` actually
 * ingest. If the guide's Node JSON-batch or OTLP/HTTP (Collector wire) payload
 * shape ever drifts from what the endpoints accept, this fails — the docs stay
 * honest. Runs against the real app; `../test/setup.js` blocks real CLIs/network.
 */
import '../test/setup.js';
import type supertest from 'supertest';
import { beforeAll, describe, it, expect } from 'vitest';
import { getRequest, createProject } from '../test/helpers.js';
import { flushLogWriteQueue } from './log-write-queue.js';
import { resetLogMetrics } from './log-metrics.js';

let request: supertest.Agent;
let token: string;

beforeAll(async () => {
  request = await getRequest();
  const project = await createProject({ cwd: '/tmp' });
  const src = await request
    .post(`/api/projects/${project.id as string}/log-sources`)
    .send({ name: 'doc-src', serviceName: 'api', environment: 'production' })
    .expect(201);
  token = src.body.token as string;
});

describe('docs/guides/application-logs.md — Node application example', () => {
  it('accepts the documented JSON batch payload (§3 Option B)', async () => {
    resetLogMetrics();
    const res = await request
      .post('/api/logs/ingest')
      .set({ Authorization: `Bearer ${token}` })
      .set('Content-Type', 'application/json')
      .send({
        resource: { 'service.name': 'api', 'deployment.environment': 'production' },
        records: [
          {
            timeUnixMillis: 1752460800000,
            severityText: 'ERROR',
            body: 'Unhandled rejection: read ECONNRESET',
            attributes: { route: '/checkout', status: 500 },
            traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
          },
        ],
      })
      .expect(200);
    expect(res.body).toMatchObject({ accepted: 1, rejected: 0 });
    flushLogWriteQueue();
  });
});

describe('docs/guides/application-logs.md — OpenTelemetry Collector example', () => {
  it('accepts the documented OTLP/HTTP JSON envelope (§2 / §4 exporter wire)', async () => {
    const res = await request
      .post('/api/otel/v1/logs')
      .set({ Authorization: `Bearer ${token}` })
      .set('Content-Type', 'application/json')
      .send({
        resourceLogs: [
          {
            resource: {
              attributes: [{ key: 'service.name', value: { stringValue: 'api' } }],
            },
            scopeLogs: [
              {
                logRecords: [
                  {
                    timeUnixNano: '1752460800000000000',
                    severityNumber: 17,
                    severityText: 'ERROR',
                    body: { stringValue: 'Unhandled rejection: read ECONNRESET' },
                  },
                ],
              },
            ],
          },
        ],
      })
      .expect(200);
    // OTLP replies with an ExportLogsServiceResponse; no rejected records here.
    expect(res.body?.partialSuccess?.rejectedLogRecords).toBeFalsy();
    flushLogWriteQueue();
  });

  it('rejects an unauthenticated ingest (token is the sole credential)', async () => {
    await request
      .post('/api/logs/ingest')
      .set('Content-Type', 'application/json')
      .send({ records: [{ body: 'no token' }] })
      .expect(401);
  });
});
