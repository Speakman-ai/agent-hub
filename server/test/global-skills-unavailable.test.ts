import { describe, it, expect, beforeAll, vi } from 'vitest';
import type supertest from 'supertest';

// Force the global skills dir to resolve as unavailable (as it would when
// config.dataDir is unusable). The mutating global routes must then fail CLOSED
// with 503 rather than path.join('', slug) => a relative './slug' write/delete
// under the server process cwd.
vi.mock('../global-skills-dir.js', () => ({
  resolveGlobalSkillsDir: () => '',
}));

import { getRequest } from './helpers.js';

let request: supertest.Agent;

beforeAll(async () => {
  request = await getRequest();
});

describe('Global skills routes — fail closed when the global dir is unavailable', () => {
  it('POST returns 503 and does not write', async () => {
    const res = await request
      .post('/api/global-skills')
      .send({ name: 'cwd-escape', description: 'should not be written' })
      .expect(503);
    expect((res.body as { error: string }).error).toMatch(/unavailable/i);
  });

  it('PUT returns 503', async () => {
    await request
      .put('/api/global-skills/cwd-escape')
      .send({ name: 'cwd-escape', description: 'x' })
      .expect(503);
  });

  it('DELETE returns 503', async () => {
    await request.delete('/api/global-skills/cwd-escape').expect(503);
  });

  it('GET one returns 503 (path-computing reader is also guarded)', async () => {
    await request.get('/api/global-skills/cwd-escape').expect(503);
  });

  it('GET list degrades gracefully: bundled defaults still listed, no user-global tier', async () => {
    // The list endpoint serves the global CATALOG = bundled defaults + the
    // user-writable global tier. The defaults live in the repo (independent of
    // config.dataDir), so they must still surface even when the writable global
    // dir is unavailable. What MUST be absent is any `source: 'global'` entry —
    // that tier needs the (unavailable) dir, so it contributes nothing. The
    // point of this case is that the reader never computes a path under an empty
    // dir (no crash / no `./slug` escape), not that the whole catalog is empty.
    const res = await request.get('/api/global-skills').expect(200);
    const body = res.body as Array<{ id: string; source: string }>;
    expect(Array.isArray(body)).toBe(true);
    // Bundled defaults are still served (graceful degradation, not a crash).
    expect(body.length).toBeGreaterThan(0);
    expect(body.every((s) => s.source === 'default')).toBe(true);
    // The unavailable user-global tier leaks nothing.
    expect(body.some((s) => s.source === 'global')).toBe(false);
  });
});
