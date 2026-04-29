import { beforeAll, describe, it, expect } from 'vitest';
import type supertest from 'supertest';
import { getRequest } from './helpers.js';

let request: supertest.Agent;

beforeAll(async () => {
  request = await getRequest();
});

describe('URI error handling — integration', () => {
  it('returns 400 (not 500) for /%c0 — the real probe pattern from logs', async () => {
    const res = await request.get('/%c0');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'malformed_uri' });
  });

  it('returns 400 for nested malformed sequences', async () => {
    const res = await request.get('/api/projects/%c0/board');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'malformed_uri' });
  });

  it('still serves valid health requests', async () => {
    // /api/health is registered before authMiddleware; assert the guard
    // didn't accidentally intercept well-formed paths.
    const res = await request.get('/api/health');
    expect(res.status).toBe(200);
  });
});
