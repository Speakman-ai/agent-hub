import { vi } from 'vitest';
import type TestAgent from 'supertest/lib/agent.js';
import type { PersonalOAuthConfig } from '../types.js';

// Avoid touching the real filesystem when the routes write the config back.
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    writeFileSync: vi.fn(),
    readFileSync: vi.fn((p: string, enc?: BufferEncoding) => {
      if (typeof p === 'string' && p.endsWith('config.json')) return '{}';
      return actual.readFileSync(p, enc);
    }),
  };
});

import { getRequest } from '../test/helpers.js';
import config from '../config.js';

let request: TestAgent;
let originalPersonalOAuth: PersonalOAuthConfig | null;
let originalApiKey: string | null;

beforeAll(async () => {
  request = await getRequest();
  originalPersonalOAuth = config.personalOAuth;
  originalApiKey = config.apiKey;
  config.apiKey = null;
});

afterAll(() => {
  config.personalOAuth = originalPersonalOAuth;
  config.apiKey = originalApiKey;
});

beforeEach(() => {
  config.personalOAuth = null;
});

describe('GET /api/config/personal-oauth', () => {
  it('reports unconfigured when no personalOAuth is set', async () => {
    const res = await request.get('/api/config/personal-oauth').expect(200);
    expect(res.body).toEqual({ configured: false, clientId: null });
  });

  it('reports configured and exposes only the clientId (never secret)', async () => {
    config.personalOAuth = { clientId: 'Iv1.abc', clientSecret: 'super-secret' };
    const res = await request.get('/api/config/personal-oauth').expect(200);
    expect(res.body).toEqual({ configured: true, clientId: 'Iv1.abc' });
    expect(JSON.stringify(res.body)).not.toContain('super-secret');
  });
});

describe('PUT /api/config/personal-oauth', () => {
  it('rejects missing clientId', async () => {
    const res = await request
      .put('/api/config/personal-oauth')
      .send({ clientSecret: 'x' })
      .expect(400);
    expect(res.body.error).toMatch(/clientId/);
  });

  it('rejects missing clientSecret', async () => {
    const res = await request
      .put('/api/config/personal-oauth')
      .send({ clientId: 'Iv1.abc' })
      .expect(400);
    expect(res.body.error).toMatch(/clientSecret/);
  });

  it('rejects empty/whitespace fields', async () => {
    await request
      .put('/api/config/personal-oauth')
      .send({ clientId: '   ', clientSecret: 'x' })
      .expect(400);
    await request
      .put('/api/config/personal-oauth')
      .send({ clientId: 'x', clientSecret: '' })
      .expect(400);
  });

  it('saves valid credentials into config.personalOAuth', async () => {
    const res = await request
      .put('/api/config/personal-oauth')
      .send({ clientId: 'Iv1.foo', clientSecret: 'bar-secret' })
      .expect(200);
    expect(res.body).toMatchObject({
      ok: true,
      configured: true,
      clientId: 'Iv1.foo',
    });
    expect(config.personalOAuth).toEqual({
      clientId: 'Iv1.foo',
      clientSecret: 'bar-secret',
    });
  });

  it('trims whitespace from values', async () => {
    await request
      .put('/api/config/personal-oauth')
      .send({ clientId: '  Iv1.trim  ', clientSecret: '  s3cret  ' })
      .expect(200);
    expect(config.personalOAuth).toEqual({
      clientId: 'Iv1.trim',
      clientSecret: 's3cret',
    });
  });
});

describe('DELETE /api/config/personal-oauth', () => {
  it('clears configured personalOAuth', async () => {
    config.personalOAuth = { clientId: 'Iv1.x', clientSecret: 'y' };
    const res = await request.delete('/api/config/personal-oauth').expect(200);
    expect(res.body).toEqual({ ok: true });
    expect(config.personalOAuth).toBeNull();
  });

  it('is a no-op when nothing is configured', async () => {
    expect(config.personalOAuth).toBeNull();
    const res = await request.delete('/api/config/personal-oauth').expect(200);
    expect(res.body).toEqual({ ok: true });
    expect(config.personalOAuth).toBeNull();
  });
});
