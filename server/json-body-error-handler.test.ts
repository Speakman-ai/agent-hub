import { describe, it, expect, vi, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { jsonBodyErrorHandler } from './json-body-error-handler.js';

// Mirror the relevant middleware order from server/index.ts: the global json
// parser (small limit so we can trip entity.too.large without megabytes), a
// non-public route, then the global body-parser fallback handler last.
function buildApp() {
  const app = express();
  app.use(express.json({ limit: '1kb' }));

  app.post('/api/messages', (_req, res) => {
    res.status(200).json({ ok: true });
  });

  // A trailing route error handler that would run if jsonBodyErrorHandler
  // delegated a non-body-parser error, so we can assert delegation.
  app.get('/api/boom', () => {
    throw new Error('not a body-parser error');
  });

  // A route that throws a BARE SyntaxError (no body-parser `body` marker) — the
  // shape an internal `JSON.parse` failure produces. The classifier must NOT
  // swallow it as a 400; it must delegate so it surfaces as a 500.
  app.get('/api/syntax-boom', () => {
    throw new SyntaxError('Unexpected token in internal JSON.parse');
  });

  app.use(jsonBodyErrorHandler);
  return app;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('jsonBodyErrorHandler', () => {
  const app = buildApp();

  it('malformed JSON body (text sent as application/json) → clean 400, no stack dump', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const res = await request(app)
      .post('/api/messages')
      .set('Content-Type', 'application/json')
      // Canonical trigger from the bug report: an agent message posted with the
      // wrong content-type.
      .send('Implemented the feature and pushed a commit.');

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid request body');
    // One concise warn line, and it must NOT be a full stack trace.
    expect(warn).toHaveBeenCalledTimes(1);
    const logged = String(warn.mock.calls[0]?.[0] ?? '');
    expect(logged).toContain('POST /api/messages');
    expect(logged).not.toContain('at JSON.parse');
  });

  it('oversized JSON body → 413', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const big = JSON.stringify({ blob: 'x'.repeat(2048) });

    const res = await request(app)
      .post('/api/messages')
      .set('Content-Type', 'application/json')
      .send(big);

    expect(res.status).toBe(413);
    expect(res.body.error).toBe('Payload too large');
  });

  it('valid JSON body still reaches the route', async () => {
    const res = await request(app)
      .post('/api/messages')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ text: 'hello' }));

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('delegates non-body-parser errors unchanged', async () => {
    const res = await request(app).get('/api/boom');
    // Express default handler answers 500 for a plain thrown Error; our handler
    // must have called next(err) rather than swallowing it as a 400.
    expect(res.status).toBe(500);
    expect(res.body.error).toBeUndefined();
  });

  it('delegates a bare SyntaxError from a route (→ 500), not swallowed as 400', async () => {
    const res = await request(app).get('/api/syntax-boom');
    // A SyntaxError without body-parser's `body` marker is an internal fault,
    // not a malformed request body — it must surface as a 500, never a 400.
    expect(res.status).toBe(500);
    expect(res.body.error).toBeUndefined();
  });

  it('unsupported charset preserves the 415 status (not downgraded to 400)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await request(app)
      .post('/api/messages')
      // A charset body-parser cannot decode → `charset.unsupported`, status 415.
      .set('Content-Type', 'application/json; charset=foobar')
      .send(JSON.stringify({ text: 'hello' }));

    expect(res.status).toBe(415);
    expect(res.body.error).toBe('Unsupported media type');
  });
});
