import express from 'express';
import request from 'supertest';
import { createJsonCompression } from './http-compression.js';

function buildApp() {
  const app = express();
  app.use(createJsonCompression());
  const bigCards = Array.from({ length: 2000 }, (_, i) => ({
    id: `card-${i}`,
    description: 'Long description text that repeats across cards. '.repeat(4),
  }));
  app.get('/json', (_req, res) => res.json({ cards: bigCards }));
  app.get('/small', (_req, res) => res.json({ ok: true }));
  app.get('/sse', (_req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.write(`data: ${'x'.repeat(20_000)}\n\n`);
    res.end();
  });
  app.get('/text', (_req, res) => res.type('text/plain').send('y'.repeat(20_000)));
  return app;
}

describe('createJsonCompression', () => {
  it('gzips large JSON responses and the body still parses', async () => {
    const res = await request(buildApp()).get('/json').set('Accept-Encoding', 'gzip');
    expect(res.status).toBe(200);
    expect(res.headers['content-encoding']).toBe('gzip');
    expect(res.body.cards).toHaveLength(2000);
  });

  it('leaves small JSON responses uncompressed', async () => {
    const res = await request(buildApp()).get('/small').set('Accept-Encoding', 'gzip');
    expect(res.headers['content-encoding']).toBeUndefined();
    expect(res.body).toEqual({ ok: true });
  });

  it('never compresses event streams or other non-JSON bodies', async () => {
    const app = buildApp();
    const sse = await request(app).get('/sse').set('Accept-Encoding', 'gzip');
    expect(sse.headers['content-encoding']).toBeUndefined();
    const text = await request(app).get('/text').set('Accept-Encoding', 'gzip');
    expect(text.headers['content-encoding']).toBeUndefined();
  });

  it('skips compression when the client does not accept gzip', async () => {
    const res = await request(buildApp()).get('/json').set('Accept-Encoding', 'identity');
    expect(res.headers['content-encoding']).toBeUndefined();
  });
});
