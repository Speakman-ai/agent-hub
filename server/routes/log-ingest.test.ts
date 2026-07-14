/**
 * Log-ingest route integration tests. Runs against the real Express app
 * (supertest); importing `../test/setup.js` installs the no-real-CLI spawn
 * guard and the live-network guard, so this suite can never spawn a real
 * `claude`/`cursor` binary or hit a remote host. A source token is minted via
 * the real log-sources API and used to authenticate ingest end-to-end.
 */
import '../test/setup.js';
import type supertest from 'supertest';
import { gzipSync } from 'zlib';
import { afterEach, beforeAll, beforeEach, describe, it, expect } from 'vitest';
import { getRequest, createProject } from '../test/helpers.js';
import { queryLogRecords } from '../logs/logs-db.js';
import { MAX_REQUEST_BYTES } from '../logs/logs-schema.js';
import {
  _ipRateBuckets,
  _resetLogIngestRateLimit,
  _sourceRateBuckets,
  _sweepLogIngestRateLimit,
  isGzipSizeError,
} from './log-ingest.js';

let request: supertest.Agent;
let projectId: string;
let token: string;
let sourceId: string;

// ── test-local protobuf encoder (independent of the module) ─────────
function varint(n: number | bigint): Buffer {
  const bytes: number[] = [];
  let v = BigInt(n);
  do {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v > 0n) b |= 0x80;
    bytes.push(b);
  } while (v > 0n);
  return Buffer.from(bytes);
}
const tag = (f: number, w: number) => varint((f << 3) | w);
const lenField = (f: number, p: Buffer) => Buffer.concat([tag(f, 2), varint(p.length), p]);
const strAny = (s: string) => lenField(1, Buffer.from(s, 'utf8'));

/** Build a minimal ExportLogsServiceRequest protobuf with one string-body record. */
function otlpProtobuf(bodyText: string): Buffer {
  const logRecord = Buffer.concat([lenField(5, strAny(bodyText))]); // body (field 5)
  const scopeLogs = lenField(2, logRecord);
  const resourceLogs = lenField(2, scopeLogs);
  return lenField(1, resourceLogs);
}

function deeplyNestedProtobuf(depth: number): Buffer {
  let body = strAny('leaf');
  for (let i = 0; i < depth; i++) {
    body = lenField(5, lenField(1, body)); // AnyValue.array_value → ArrayValue.values
  }
  const logRecord = lenField(5, body);
  const scopeLogs = lenField(2, logRecord);
  const resourceLogs = lenField(2, scopeLogs);
  return lenField(1, resourceLogs);
}

/** OTLP/JSON body with one record. */
function otlpJson(bodyText: string, extra: Record<string, unknown> = {}): object {
  return {
    resourceLogs: [
      {
        scopeLogs: [
          {
            logRecords: [{ body: { stringValue: bodyText }, ...extra }],
          },
        ],
      },
    ],
  };
}

function auth() {
  return { Authorization: `Bearer ${token}` };
}

beforeAll(async () => {
  request = await getRequest();
  const project = await createProject({ cwd: '/tmp' });
  projectId = project.id as string;
  const src = await request
    .post(`/api/projects/${projectId}/log-sources`)
    .send({ name: 'ingest-src', serviceName: 'checkout', environment: 'prod' })
    .expect(201);
  token = src.body.token as string;
  sourceId = src.body.id as string;
});

beforeEach(() => {
  _resetLogIngestRateLimit();
});

function recordsFor(): ReturnType<typeof queryLogRecords>['records'] {
  return queryLogRecords({ projectId, sourceId, limit: 500 }).records;
}

describe('POST /api/logs/ingest (Agent Hub JSON batch)', () => {
  it('accepts a batch and persists canonical records', async () => {
    const before = recordsFor().length;
    const res = await request
      .post('/api/logs/ingest')
      .set(auth())
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ records: [{ severity: 'error', message: 'boom', traceId: 'abcd' }] }))
      .expect(200);
    expect(res.body.accepted).toBe(1);
    expect(res.body.rejected).toBe(0);
    const rows = recordsFor();
    expect(rows.length).toBe(before + 1);
    expect(rows[0]!.body).toBe('boom');
    expect(rows[0]!.severity_text).toBe('error');
    expect(rows[0]!.service_name).toBe('checkout'); // source default facet
  });

  it('rejects an oversize record (>256 KiB) while accepting the rest', async () => {
    const big = 'a'.repeat(300 * 1024);
    const res = await request
      .post('/api/logs/ingest')
      .set(auth())
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ records: [{ message: big }, { message: 'small' }] }))
      .expect(200);
    expect(res.body.accepted).toBe(1);
    expect(res.body.rejected).toBe(1);
  });

  it('redacts secrets before persistence (end-to-end)', async () => {
    await request
      .post('/api/logs/ingest')
      .set(auth())
      .set('Content-Type', 'application/json')
      .send(
        JSON.stringify({
          records: [
            {
              body: {
                event: 'connecting',
                password: 'hunter2',
                note: 'token ghp_0123456789abcdef0123456789abcdefABCD',
              },
              attributes: { password: 'hunter2', ok: 'visible' },
            },
          ],
        }),
      )
      .expect(200);
    const rows = queryLogRecords({ projectId, sourceId, text: 'connecting', limit: 5 }).records;
    const row = rows[0]!;
    const storedBody = JSON.parse(row.body!);
    expect(storedBody.password).toBe('[redacted]');
    expect(storedBody.note).not.toContain('ghp_');
    expect(storedBody.note).toContain('[redacted]');
    const attrs = JSON.parse(row.attributes_json!);
    expect(attrs.password).toBe('[redacted]');
    expect(attrs.ok).toBe('visible');
  });

  it('accepts a gzip-compressed body', async () => {
    const body = gzipSync(
      Buffer.from(JSON.stringify({ records: [{ message: 'zipped' }] }), 'utf8'),
    );
    const res = await request
      .post('/api/logs/ingest')
      .set(auth())
      .set('Content-Type', 'application/json')
      .set('Content-Encoding', 'gzip')
      // `.serialize((v) => v)` stops superagent from JSON-stringifying the raw
      // gzip Buffer (which the `application/json` type would otherwise trigger).
      .serialize((v) => v)
      .send(body)
      .expect(200);
    expect(res.body.accepted).toBe(1);
  });

  it('400s a malformed JSON body', async () => {
    await request
      .post('/api/logs/ingest')
      .set(auth())
      .set('Content-Type', 'application/json')
      .send('{ not valid')
      .expect(400);
  });

  it('400s when `records` is missing', async () => {
    await request
      .post('/api/logs/ingest')
      .set(auth())
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ resource: {} }))
      .expect(400);
  });

  it('400s when a batch record is not an object', async () => {
    const res = await request
      .post('/api/logs/ingest')
      .set(auth())
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ records: [null] }))
      .expect(400);
    expect(res.body).toEqual({ error: '`records` entries must be objects' });
  });
});

describe('POST /api/otel/v1/logs (OTLP/HTTP)', () => {
  it('accepts an OTLP/JSON body', async () => {
    const before = recordsFor().length;
    const res = await request
      .post('/api/otel/v1/logs')
      .set(auth())
      .set('Content-Type', 'application/json')
      .send(JSON.stringify(otlpJson('otlp-json', { severityNumber: 17, severityText: 'ERROR' })))
      .expect(200);
    // Full success → empty partialSuccess.
    expect(res.body).toEqual({});
    const rows = recordsFor();
    expect(rows.length).toBe(before + 1);
    expect(rows[0]!.severity_number).toBe(17);
  });

  it('accepts a binary-Protobuf body and replies with x-protobuf', async () => {
    const res = await request
      .post('/api/otel/v1/logs')
      .set(auth())
      .set('Content-Type', 'application/x-protobuf')
      .send(otlpProtobuf('otlp-proto'))
      .expect(200);
    expect(res.headers['content-type']).toContain('application/x-protobuf');
    // Full success → empty ExportLogsServiceResponse (zero-length body).
    expect(res.text ?? '').toBe('');
  });

  it('accepts an empty binary-Protobuf request as a no-op', async () => {
    const before = recordsFor().length;
    const res = await request
      .post('/api/otel/v1/logs')
      .set(auth())
      .set('Content-Type', 'application/x-protobuf')
      .send(Buffer.alloc(0))
      .expect(200);
    expect(res.headers['content-type']).toContain('application/x-protobuf');
    expect(res.text ?? '').toBe('');
    expect(recordsFor()).toHaveLength(before);
  });

  it('accepts a gzip-compressed OTLP/JSON body', async () => {
    const body = gzipSync(Buffer.from(JSON.stringify(otlpJson('otlp-gzip')), 'utf8'));
    await request
      .post('/api/otel/v1/logs')
      .set(auth())
      .set('Content-Type', 'application/json')
      .set('Content-Encoding', 'gzip')
      .serialize((v) => v)
      .send(body)
      .expect(200);
  });

  it('reports partial success with a rejected count when the batch overflows', async () => {
    const logRecords = Array.from({ length: 1002 }, () => ({ body: { stringValue: 'x' } }));
    const body = { resourceLogs: [{ scopeLogs: [{ logRecords }] }] };
    const res = await request
      .post('/api/otel/v1/logs')
      .set(auth())
      .set('Content-Type', 'application/json')
      .send(JSON.stringify(body))
      .expect(200);
    expect(res.body.partialSuccess.rejectedLogRecords).toBe('2');
  });

  it('400s a malformed protobuf body', async () => {
    const res = await request
      .post('/api/otel/v1/logs')
      .set(auth())
      .set('Content-Type', 'application/x-protobuf')
      .send(Buffer.from([0x0a, 0x0a])) // claims 10 bytes, has none
      .expect(400);
    expect(res.headers['content-type']).toContain('application/x-protobuf');
    // Supertest exposes unknown binary media types as a binary string.
    expect(res.text.charCodeAt(0)).toBe(0x08); // google.rpc.Status.code
    expect(res.text.charCodeAt(1)).toBe(0x03); // INVALID_ARGUMENT
  });

  it('400s deeply nested protobuf AnyValues without an uncaught stack overflow', async () => {
    const res = await request
      .post('/api/otel/v1/logs')
      .set(auth())
      .set('Content-Type', 'application/x-protobuf')
      .send(deeplyNestedProtobuf(40))
      .expect(400);
    expect(res.headers['content-type']).toContain('application/x-protobuf');
    expect(res.text.charCodeAt(0)).toBe(0x08); // google.rpc.Status.code
    expect(res.text.charCodeAt(1)).toBe(0x03); // INVALID_ARGUMENT
  });

  it('400s a malformed JSON body', async () => {
    const res = await request
      .post('/api/otel/v1/logs')
      .set(auth())
      .set('Content-Type', 'application/json')
      .send('{ broken')
      .expect(400);
    expect(res.body).toEqual({ error: 'body must be valid JSON' });
  });

  it.each([
    [{ resourceLogs: {} }, '`resourceLogs` must be an array'],
    [{ resourceLogs: [{ scopeLogs: [{ logRecords: 5 }] }] }, '`logRecords` must be an array'],
  ])('400s a valid-JSON body with a malformed OTLP tree', async (body, error) => {
    const res = await request
      .post('/api/otel/v1/logs')
      .set(auth())
      .set('Content-Type', 'application/json')
      .send(JSON.stringify(body))
      .expect(400);
    expect(res.body).toEqual({ error });
  });

  it('bounds deeply nested JSON AnyValues without an uncaught stack overflow', async () => {
    let nestedBody: object = { stringValue: 'leaf' };
    for (let i = 0; i < 100; i++) {
      nestedBody = { arrayValue: { values: [nestedBody] } };
    }
    const body = { resourceLogs: [{ scopeLogs: [{ logRecords: [{ body: nestedBody }] }] }] };
    await request
      .post('/api/otel/v1/logs')
      .set(auth())
      .set('Content-Type', 'application/json')
      .send(JSON.stringify(body))
      .expect(200);
  });
});

describe('ingest auth (write-only token)', () => {
  it('401s without a token', async () => {
    await request
      .post('/api/logs/ingest')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ records: [{ message: 'x' }] }))
      .expect(401);
  });

  it('401s with an invalid token', async () => {
    await request
      .post('/api/logs/ingest')
      .set('Authorization', 'Bearer ahlog_not_a_real_token_value_padding_padding_padding')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ records: [{ message: 'x' }] }))
      .expect(401);
  });

  it('treats a trailing-slash path as public (token flow, not Hub-auth 401)', async () => {
    // Express non-strict routing + the auth public-path check both tolerate a
    // trailing slash, so `/api/logs/ingest/` must reach the token flow (200),
    // not fall through to a Hub-auth 401.
    const res = await request
      .post('/api/logs/ingest/')
      .set(auth())
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ records: [{ message: 'trailing-slash' }] }))
      .expect(200);
    expect(res.body.accepted).toBe(1);
  });

  it('401s after the source token is revoked', async () => {
    // Mint a throwaway source, revoke it, confirm ingest is refused.
    const src = await request
      .post(`/api/projects/${projectId}/log-sources`)
      .send({ name: 'revoke-ingest-src' })
      .expect(201);
    await request.post(`/api/projects/${projectId}/log-sources/${src.body.id}/revoke`).expect(200);
    await request
      .post('/api/logs/ingest')
      .set('Authorization', `Bearer ${src.body.token}`)
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ records: [{ message: 'x' }] }))
      .expect(401);
  });
});

describe('ingest limits (rate limit + decompression bomb)', () => {
  afterEach(() => {
    delete process.env.LOG_INGEST_PER_SOURCE_MAX;
    _resetLogIngestRateLimit();
  });

  it('429s with Retry-After once the per-source cap is exceeded', async () => {
    // Cap read at call time, so setting it here (after boot) takes effect.
    process.env.LOG_INGEST_PER_SOURCE_MAX = '1';
    const body = JSON.stringify({ records: [{ message: 'rl' }] });
    // First request under the cap succeeds.
    await request
      .post('/api/logs/ingest')
      .set(auth())
      .set('Content-Type', 'application/json')
      .send(body)
      .expect(200);
    // Second request within the window trips the per-source bucket.
    const res = await request
      .post('/api/logs/ingest')
      .set(auth())
      .set('Content-Type', 'application/json')
      .send(body)
      .expect(429);
    expect(res.headers['retry-after']).toBe('60');
    expect(res.body.error).toMatch(/rate limit/i);
  });

  it('413s a gzip body that decompresses past the size cap (bomb guard)', async () => {
    // ~2 MiB of 'a' compresses to a few KB but inflates past MAX_REQUEST_BYTES
    // (1 MiB). Sent as a raw gzip-framed body (no Content-Encoding header), so
    // decodeIngestBody inflates it under a bounded maxOutputLength and rejects.
    const bomb = gzipSync(Buffer.from('a'.repeat(2 * 1024 * 1024), 'utf8'));
    const res = await request
      .post('/api/logs/ingest')
      .set(auth())
      .set('Content-Type', 'application/json')
      .serialize((v) => v)
      .send(bomb)
      .expect(413);
    expect(res.body.error).toMatch(/too large/i);
  });

  it('classifies zlib overflow by stable error code even if wording changes', () => {
    expect(isGzipSizeError({ code: 'ERR_BUFFER_TOO_LARGE', message: 'new wording' })).toBe(true);
  });

  it('413s an uncompressed request over the wire-size cap', async () => {
    const res = await request
      .post('/api/logs/ingest')
      .set(auth())
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.alloc(MAX_REQUEST_BYTES + 1, 0x61))
      .expect(413);
    expect(res.body.error).toMatch(/size cap/i);
  });

  it('evicts expired rate-limit buckets during the periodic sweep', () => {
    const now = Date.now();
    _ipRateBuckets.set('expired-ip', { count: 1, resetAt: now - 1 });
    _sourceRateBuckets.set('expired-source', { count: 1, resetAt: now - 1 });
    _ipRateBuckets.set('live-ip', { count: 1, resetAt: now + 60_000 });

    _sweepLogIngestRateLimit(now);

    expect(_ipRateBuckets.has('expired-ip')).toBe(false);
    expect(_sourceRateBuckets.has('expired-source')).toBe(false);
    expect(_ipRateBuckets.has('live-ip')).toBe(true);
  });
});
