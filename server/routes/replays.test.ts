import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import type { Express } from 'express';
import supertest from 'supertest';
import os from 'os';
import path from 'path';
import { mkdirSync, rmSync, existsSync, readdirSync, readFileSync } from 'fs';
import createReplayRoutes, { _resetRateLimit, validateReplayPayload } from './replays.js';
import type { RouteDeps } from '../types.js';

function makeApp(): { app: Express; serverDir: string } {
  const serverDir = path.join(
    os.tmpdir(),
    `agent-hub-replay-test-${process.pid}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(path.join(serverDir, 'uploads'), { recursive: true });
  const deps = { serverDir } as unknown as RouteDeps;
  const app = express();
  app.use(createReplayRoutes(deps));
  return { app, serverDir };
}

const META = { type: 4, timestamp: 1000, data: {} };
const SNAPSHOT = { type: 2, timestamp: 1001, data: { node: {} } };
const INCREMENTAL = { type: 3, timestamp: 1500, data: { source: 2 } };

describe('validateReplayPayload', () => {
  it('accepts a well-formed events array', () => {
    const r = validateReplayPayload({ events: [META, SNAPSHOT], meta: { trigger: 'bug-report' } });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.events).toHaveLength(2);
      expect(r.value.meta).toEqual({ trigger: 'bug-report' });
    }
  });

  it('rejects a non-object body', () => {
    expect(validateReplayPayload(null).ok).toBe(false);
    expect(validateReplayPayload([META]).ok).toBe(false);
    expect(validateReplayPayload('x').ok).toBe(false);
  });

  it('rejects an empty events array', () => {
    const r = validateReplayPayload({ events: [] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/non-empty/);
  });

  it('rejects events missing numeric type/timestamp', () => {
    expect(validateReplayPayload({ events: [{ type: 'x', timestamp: 1 }] }).ok).toBe(false);
    expect(validateReplayPayload({ events: [{ type: 2 }] }).ok).toBe(false);
  });

  it('rejects events with no full snapshot (not replayable)', () => {
    const r = validateReplayPayload({ events: [META, INCREMENTAL] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/full snapshot/);
  });

  it('accepts events that include a full snapshot anywhere in the array', () => {
    expect(validateReplayPayload({ events: [INCREMENTAL, META, SNAPSHOT] }).ok).toBe(true);
  });

  it('rejects non-object meta', () => {
    expect(validateReplayPayload({ events: [SNAPSHOT], meta: [1, 2] }).ok).toBe(false);
    expect(validateReplayPayload({ events: [SNAPSHOT], meta: 'nope' }).ok).toBe(false);
  });

  it('treats missing meta as undefined', () => {
    const r = validateReplayPayload({ events: [SNAPSHOT] });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.meta).toBeUndefined();
  });
});

describe('POST /api/replays', () => {
  let app: Express;
  let serverDir: string;

  beforeEach(() => {
    _resetRateLimit();
    ({ app, serverDir } = makeApp());
  });

  afterEach(() => {
    try {
      if (serverDir && existsSync(serverDir)) rmSync(serverDir, { recursive: true, force: true });
    } catch {
      /* noop */
    }
  });

  it('stores a replay and returns 201 with a /uploads/replay-*.json ref', async () => {
    const res = await supertest(app)
      .post('/api/replays')
      .send({ events: [META, SNAPSHOT, INCREMENTAL], meta: { trigger: 'bug-report' } })
      .expect(201);

    expect(typeof res.body.replayId).toBe('string');
    expect(res.body.replayRef).toMatch(/^\/uploads\/replay-[\w-]+\.json$/);
    expect(res.headers['access-control-allow-origin']).toBe('*');

    // The replay landed on disk as readable JSON (what resolveReplayContext reads).
    const files = readdirSync(path.join(serverDir, 'uploads'));
    expect(files).toHaveLength(1);
    const stored = JSON.parse(readFileSync(path.join(serverDir, 'uploads', files[0]!), 'utf-8'));
    expect(stored.replayId).toBe(res.body.replayId);
    expect(stored.events).toHaveLength(3);
    expect(stored.meta).toEqual({ trigger: 'bug-report' });
  });

  it('returns 400 on an empty events array', async () => {
    const res = await supertest(app).post('/api/replays').send({ events: [] }).expect(400);
    expect(res.body.error).toMatch(/non-empty/);
  });

  it('returns 400 on malformed events', async () => {
    await supertest(app)
      .post('/api/replays')
      .send({ events: [{ foo: 'bar' }] })
      .expect(400);
  });

  it('returns 400 and stores nothing for a snapshot-less buffer', async () => {
    const res = await supertest(app)
      .post('/api/replays')
      .send({ events: [META, INCREMENTAL] })
      .expect(400);
    expect(res.body.error).toMatch(/full snapshot/);
    expect(readdirSync(path.join(serverDir, 'uploads'))).toHaveLength(0);
  });

  it('handles OPTIONS preflight with 204 + CORS headers', async () => {
    const res = await supertest(app).options('/api/replays').expect(204);
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(res.headers['access-control-allow-methods']).toMatch(/POST/);
  });

  it('rate-limits to 30 ingests per IP per hour', async () => {
    for (let i = 0; i < 30; i++) {
      await supertest(app)
        .post('/api/replays')
        .send({ events: [SNAPSHOT] })
        .expect(201);
    }
    const res = await supertest(app)
      .post('/api/replays')
      .send({ events: [SNAPSHOT] })
      .expect(429);
    expect(res.body.error).toMatch(/rate limit/i);
    expect(res.headers['retry-after']).toBeDefined();
  });
});
