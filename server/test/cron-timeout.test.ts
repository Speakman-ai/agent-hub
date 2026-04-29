import type TestAgent from 'supertest/lib/agent.js';
import { getRequest } from './helpers.js';
import type { CronRow } from '../types.js';
import { formatCronErrorResult } from '../heartbeat.js';

let request: TestAgent;

beforeAll(async () => {
  request = await getRequest();
});

/**
 * `formatCronErrorResult` builds the `last_result` value written into the
 * `crons` row when a run errors. Historically the column only stored
 * `ERROR: <msg>` — a timeout therefore looked like
 * `ERROR: Timed out after 5 minutes` and threw away whatever partial
 * stdout/stderr the CLI emitted before being killed. The success path
 * already wrote partial output; the error path now mirrors that so the
 * cron card surfaces progress instead of a bare error string.
 */
describe('formatCronErrorResult', () => {
  it('returns the historical "ERROR: <msg>" shape when there is no partial output', () => {
    expect(formatCronErrorResult('Timed out after 5 minutes', undefined, undefined)).toBe(
      'ERROR: Timed out after 5 minutes',
    );
    expect(formatCronErrorResult('boom', null, null)).toBe('ERROR: boom');
    // Whitespace-only partial output is treated as no output — don't emit
    // an empty "--- Partial output ---" section.
    expect(formatCronErrorResult('boom', '   \n\t', '')).toBe('ERROR: boom');
  });

  it('appends partial stdout under a "--- Partial output ---" section', () => {
    const out = formatCronErrorResult(
      'Timed out after 5 minutes',
      'scanned 1200 lines\nfound 3 errors',
      '',
    );
    expect(out).toBe(
      'ERROR: Timed out after 5 minutes\n\n--- Partial output ---\nscanned 1200 lines\nfound 3 errors',
    );
  });

  it('falls back to partial stderr when stdout is empty', () => {
    const out = formatCronErrorResult('boom', '', 'stderr line 1\nstderr line 2');
    expect(out).toBe('ERROR: boom\n\n--- Partial output ---\nstderr line 1\nstderr line 2');
  });

  it('prefers stdout over stderr when both are present', () => {
    const out = formatCronErrorResult('boom', 'good stuff', 'noise');
    expect(out).toContain('--- Partial output ---\ngood stuff');
    expect(out).not.toContain('noise');
  });

  it('trims surrounding whitespace from the partial output', () => {
    const out = formatCronErrorResult('boom', '\n\n  stdout body  \n\n', undefined);
    expect(out).toBe('ERROR: boom\n\n--- Partial output ---\nstdout body');
  });

  it('coerces an empty / whitespace error message to "Unknown error"', () => {
    expect(formatCronErrorResult('', undefined, undefined)).toBe('ERROR: Unknown error');
    expect(formatCronErrorResult('   ', 'partial', undefined)).toBe(
      'ERROR: Unknown error\n\n--- Partial output ---\npartial',
    );
  });
});

/**
 * Per-cron `timeout_ms` overrides the shared `config.defaultTimeoutMs` so a
 * single long-running cron can opt out of the default without dragging every
 * other cron with it. These tests cover the API contract for that field:
 *
 *   - POST persists a positive integer and round-trips on GET.
 *   - POST rejects non-positive / non-integer values with 400.
 *   - POST defaults the column to null when the field is omitted.
 *   - PUT updates, clears, and rejects invalid values without touching other
 *     fields.
 */
describe('crons: per-cron timeout_ms', () => {
  async function createCron(body: Record<string, unknown> = {}): Promise<CronRow> {
    const res = await request
      .post('/api/crons')
      .send({
        name: `Timeout Test ${Math.random().toString(36).slice(2, 8)}`,
        schedule: '0 * * * *',
        prompt: 'echo hi',
        cwd: '/tmp',
        enabled: false,
        ...body,
      })
      .expect(200);
    return res.body as CronRow;
  }

  it('POST /api/crons persists a positive integer timeout_ms', async () => {
    const cron = await createCron({ timeout_ms: 30 * 60 * 1000 });
    expect(cron.timeout_ms).toBe(30 * 60 * 1000);

    // Round-trip through GET to make sure it was actually stored, not just
    // echoed from the request body.
    const list = await request.get('/api/crons').expect(200);
    const found = (list.body as CronRow[]).find((c) => c.id === cron.id);
    expect(found?.timeout_ms).toBe(30 * 60 * 1000);
  });

  it('POST /api/crons defaults timeout_ms to null when omitted', async () => {
    const cron = await createCron({});
    expect(cron.timeout_ms).toBeNull();
  });

  it('POST /api/crons rejects zero, negative, and non-numeric timeout_ms', async () => {
    for (const bad of [0, -1, 1.5, 'abc', true]) {
      await request
        .post('/api/crons')
        .send({
          name: `Bad Timeout ${Math.random().toString(36).slice(2, 8)}`,
          schedule: '0 * * * *',
          prompt: 'echo hi',
          cwd: '/tmp',
          enabled: false,
          timeout_ms: bad,
        })
        .expect(400);
    }
  });

  it('PUT /api/crons/:id updates timeout_ms', async () => {
    const cron = await createCron({ timeout_ms: 60_000 });
    const res = await request
      .put(`/api/crons/${cron.id}`)
      .send({ timeout_ms: 120_000 })
      .expect(200);
    expect((res.body as CronRow).timeout_ms).toBe(120_000);
  });

  it('PUT /api/crons/:id clears timeout_ms when explicitly set to null', async () => {
    const cron = await createCron({ timeout_ms: 60_000 });
    const res = await request.put(`/api/crons/${cron.id}`).send({ timeout_ms: null }).expect(200);
    expect((res.body as CronRow).timeout_ms).toBeNull();
  });

  it('PUT /api/crons/:id leaves timeout_ms unchanged when field is absent', async () => {
    const cron = await createCron({ timeout_ms: 60_000 });
    const res = await request.put(`/api/crons/${cron.id}`).send({ name: 'renamed' }).expect(200);
    expect((res.body as CronRow).timeout_ms).toBe(60_000);
    expect((res.body as CronRow).name).toBe('renamed');
  });

  it('PUT /api/crons/:id rejects invalid timeout_ms without mutating the row', async () => {
    const cron = await createCron({ timeout_ms: 60_000 });
    await request.put(`/api/crons/${cron.id}`).send({ timeout_ms: -5 }).expect(400);
    const after = await request.get('/api/crons').expect(200);
    const found = (after.body as CronRow[]).find((c) => c.id === cron.id);
    expect(found?.timeout_ms).toBe(60_000);
  });
});
