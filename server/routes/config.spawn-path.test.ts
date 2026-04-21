import type TestAgent from 'supertest/lib/agent.js';
import { getRequest } from '../test/helpers.js';

let request: TestAgent;

beforeAll(async () => {
  request = await getRequest();
});

describe('GET /api/config/spawn-path', () => {
  it('returns the cached shell PATH and its source', async () => {
    const res = await request.get('/api/config/spawn-path').expect(200);
    expect(res.body).toHaveProperty('path');
    expect(res.body).toHaveProperty('source');
    expect(res.body).toHaveProperty('entries');
    expect(['login-shell', 'fallback', 'uninitialized']).toContain(res.body.source);
  });

  it('entries array matches the colon-split path', async () => {
    const res = await request.get('/api/config/spawn-path').expect(200);
    if (res.body.path) {
      const segs = (res.body.path as string).split(':').filter(Boolean);
      expect(res.body.entries).toEqual(segs);
    }
  });
});

describe('POST /api/config/refresh-spawn-path', () => {
  it('refreshes and returns ok:true with updated cache', async () => {
    const res = await request.post('/api/config/refresh-spawn-path').expect(200);
    expect(res.body.ok).toBe(true);
    expect(['login-shell', 'fallback']).toContain(res.body.source);
    expect(res.body.path).toBeTruthy();
    expect(Array.isArray(res.body.entries)).toBe(true);
    expect(res.body.entries.length).toBeGreaterThan(0);
  });

  it('is idempotent — calling twice returns equivalent shape and entries', async () => {
    const a = await request.post('/api/config/refresh-spawn-path').expect(200);
    const b = await request.post('/api/config/refresh-spawn-path').expect(200);
    expect(a.body.source).toBe(b.body.source);
    expect(a.body.entries).toEqual(b.body.entries);
  });
});
