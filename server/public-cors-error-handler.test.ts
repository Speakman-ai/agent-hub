import { describe, it, expect } from 'vitest';
import express from 'express';
import cors from 'cors';
import request from 'supertest';
import { isPublicCorsPath, publicCorsErrorHandler } from './public-cors-error-handler.js';

// Build an app whose middleware chain mirrors server/index.ts in the order
// that matters for this bug: a global CORS middleware restricted to an
// allowlist (so a third-party origin gets NO header from it), then the
// GLOBAL json parser, then the public routes with their own permissive
// applyCors, then the public CORS error handler last.
function buildApp() {
  const app = express();

  // Global cors() restricted to an allowlist — third-party recorder origins
  // are NOT on it, so it contributes no Access-Control-Allow-Origin.
  app.use(cors({ origin: 'https://hub.example.com' }));

  // Global json parser with a small limit so we can trip entity.too.large
  // without sending megabytes in a test.
  app.use(express.json({ limit: '1kb' }));

  function applyCors(_req: express.Request, res: express.Response, next: express.NextFunction) {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, X-Requested-With');
    next();
  }

  app.post('/api/replays', applyCors, (_req, res) => {
    res.status(201).json({ ok: true });
  });
  app.post('/api/replays/:id/events', applyCors, (_req, res) => {
    res.status(201).json({ ok: true });
  });
  app.post('/api/bug-reports', applyCors, (_req, res) => {
    res.status(201).json({ ok: true });
  });
  // A non-public route to prove the handler does NOT touch other paths.
  app.post('/api/other', (_req, res) => {
    res.status(200).json({ ok: true });
  });

  app.use(publicCorsErrorHandler);
  return app;
}

const THIRD_PARTY_ORIGIN = 'https://customer.example.org';

describe('isPublicCorsPath', () => {
  it('matches the public ingest paths', () => {
    expect(isPublicCorsPath('/api/replays')).toBe(true);
    expect(isPublicCorsPath('/api/replays/')).toBe(true);
    expect(isPublicCorsPath('/api/replays/abc-123/events')).toBe(true);
    expect(isPublicCorsPath('/api/bug-reports')).toBe(true);
  });

  it('does not match unrelated paths', () => {
    expect(isPublicCorsPath('/api/replays/abc-123')).toBe(false);
    expect(isPublicCorsPath('/api/replays/abc/events/extra')).toBe(false);
    expect(isPublicCorsPath('/api/sessions')).toBe(false);
    expect(isPublicCorsPath('/api/other')).toBe(false);
  });
});

describe('publicCorsErrorHandler — body-parser failures keep CORS headers', () => {
  const app = buildApp();

  it('oversized JSON body to /api/replays → 413 with Access-Control-Allow-Origin: *', async () => {
    const big = JSON.stringify({ events: 'x'.repeat(2048) }); // > 1kb limit
    const res = await request(app)
      .post('/api/replays')
      .set('Origin', THIRD_PARTY_ORIGIN)
      .set('Content-Type', 'application/json')
      .send(big);

    expect(res.status).toBe(413);
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(res.body.error).toBeTruthy();
  });

  it('malformed JSON body to /api/replays → 400 with Access-Control-Allow-Origin: *', async () => {
    const res = await request(app)
      .post('/api/replays')
      .set('Origin', THIRD_PARTY_ORIGIN)
      .set('Content-Type', 'application/json')
      .send('{ not valid json');

    expect(res.status).toBe(400);
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(res.body.error).toBeTruthy();
  });

  it('oversized body to /api/replays/:id/events → 413 with CORS header', async () => {
    const big = JSON.stringify({ events: 'x'.repeat(2048) });
    const res = await request(app)
      .post('/api/replays/abc-123/events')
      .set('Origin', THIRD_PARTY_ORIGIN)
      .set('Content-Type', 'application/json')
      .send(big);

    expect(res.status).toBe(413);
    expect(res.headers['access-control-allow-origin']).toBe('*');
  });

  it('oversized body to /api/bug-reports → 413 with CORS header', async () => {
    const big = JSON.stringify({ events: 'x'.repeat(2048) });
    const res = await request(app)
      .post('/api/bug-reports')
      .set('Origin', THIRD_PARTY_ORIGIN)
      .set('Content-Type', 'application/json')
      .send(big);

    expect(res.status).toBe(413);
    expect(res.headers['access-control-allow-origin']).toBe('*');
  });

  it('valid body to /api/replays still succeeds (CORS from route applyCors)', async () => {
    const res = await request(app)
      .post('/api/replays')
      .set('Origin', THIRD_PARTY_ORIGIN)
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ events: [] }));

    expect(res.status).toBe(201);
    expect(res.headers['access-control-allow-origin']).toBe('*');
  });

  it('does NOT stamp permissive CORS on non-public paths', async () => {
    const big = JSON.stringify({ events: 'x'.repeat(2048) });
    const res = await request(app)
      .post('/api/other')
      .set('Origin', THIRD_PARTY_ORIGIN)
      .set('Content-Type', 'application/json')
      .send(big);

    // Default handler answers 413; our handler left it untouched, so the
    // permissive wildcard is absent (global cors() didn't match the origin).
    expect(res.status).toBe(413);
    expect(res.headers['access-control-allow-origin']).not.toBe('*');
  });
});
