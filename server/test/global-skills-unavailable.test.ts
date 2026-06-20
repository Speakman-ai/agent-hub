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

  it('GET list still degrades gracefully to an empty array (no path computed)', async () => {
    const res = await request.get('/api/global-skills').expect(200);
    expect(res.body).toEqual([]);
  });
});
