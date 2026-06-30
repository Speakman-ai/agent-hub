import { vi } from 'vitest';
import type TestAgent from 'supertest/lib/agent.js';
import type { GoogleOAuthConfig } from '../types.js';

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
let originalGoogleOAuth: GoogleOAuthConfig | null;
let originalApiKey: string | null;
let originalPublicUrl: string | null;

beforeAll(async () => {
  request = await getRequest();
  originalGoogleOAuth = config.googleOAuth;
  originalApiKey = config.apiKey;
  originalPublicUrl = config.publicUrl;
  // No apiKey + no auth record → authMiddleware treats requests as Owner, which
  // satisfies the requireRole('Admin') gate on these routes.
  config.apiKey = null;
});

afterAll(() => {
  config.googleOAuth = originalGoogleOAuth;
  config.apiKey = originalApiKey;
  config.publicUrl = originalPublicUrl;
});

beforeEach(() => {
  config.googleOAuth = null;
  config.publicUrl = originalPublicUrl;
});

describe('GET /api/config/google-oauth', () => {
  it('reports unconfigured when no googleOAuth is set', async () => {
    const res = await request.get('/api/config/google-oauth').expect(200);
    expect(res.body).toMatchObject({ configured: false, clientId: null });
    expect(res.body.redirectUri).toMatch(/\/api\/auth\/google\/callback$/);
  });

  it('reports configured and exposes only the clientId (never the secret)', async () => {
    config.googleOAuth = {
      clientId: 'goog.apps.googleusercontent.com',
      clientSecret: 'super-secret',
    };
    const res = await request.get('/api/config/google-oauth').expect(200);
    expect(res.body).toMatchObject({
      configured: true,
      clientId: 'goog.apps.googleusercontent.com',
    });
    expect(JSON.stringify(res.body)).not.toContain('super-secret');
  });

  it('derives the canonical redirectUri from publicUrl, not the request origin', async () => {
    config.publicUrl = 'https://hub.example.com';
    const res = await request.get('/api/config/google-oauth').expect(200);
    expect(res.body.redirectUri).toBe('https://hub.example.com/api/auth/google/callback');
  });
});

describe('PUT /api/config/google-oauth', () => {
  it('rejects missing clientId', async () => {
    const res = await request
      .put('/api/config/google-oauth')
      .send({ clientSecret: 'x' })
      .expect(400);
    expect(res.body.error).toMatch(/clientId/);
  });

  it('rejects missing clientSecret', async () => {
    const res = await request
      .put('/api/config/google-oauth')
      .send({ clientId: 'goog.id' })
      .expect(400);
    expect(res.body.error).toMatch(/clientSecret/);
  });

  it('rejects empty/whitespace fields', async () => {
    await request
      .put('/api/config/google-oauth')
      .send({ clientId: '   ', clientSecret: 'x' })
      .expect(400);
    await request
      .put('/api/config/google-oauth')
      .send({ clientId: 'x', clientSecret: '' })
      .expect(400);
  });

  it('saves valid credentials into config.googleOAuth and round-trips on GET', async () => {
    const res = await request
      .put('/api/config/google-oauth')
      .send({ clientId: 'goog.foo', clientSecret: 'bar-secret' })
      .expect(200);
    expect(res.body).toMatchObject({ ok: true, configured: true, clientId: 'goog.foo' });
    expect(config.googleOAuth).toEqual({ clientId: 'goog.foo', clientSecret: 'bar-secret' });

    const status = await request.get('/api/config/google-oauth').expect(200);
    expect(status.body).toMatchObject({ configured: true, clientId: 'goog.foo' });
  });

  it('trims whitespace from values', async () => {
    await request
      .put('/api/config/google-oauth')
      .send({ clientId: '  goog.trim  ', clientSecret: '  s3cret  ' })
      .expect(200);
    expect(config.googleOAuth).toEqual({ clientId: 'goog.trim', clientSecret: 's3cret' });
  });
});

describe('DELETE /api/config/google-oauth', () => {
  it('clears configured googleOAuth', async () => {
    config.googleOAuth = { clientId: 'goog.x', clientSecret: 'y' };
    const res = await request.delete('/api/config/google-oauth').expect(200);
    expect(res.body).toEqual({ ok: true });
    expect(config.googleOAuth).toBeNull();
  });

  it('is a no-op when nothing is configured', async () => {
    expect(config.googleOAuth).toBeNull();
    const res = await request.delete('/api/config/google-oauth').expect(200);
    expect(res.body).toEqual({ ok: true });
    expect(config.googleOAuth).toBeNull();
  });
});
