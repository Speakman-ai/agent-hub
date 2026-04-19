import { beforeAll, describe, it, expect, afterEach, beforeEach } from 'vitest';
import type supertest from 'supertest';
import { getRequest } from './helpers.js';

let request: supertest.Agent;
const ORIGINAL_ENV = process.env.ALLOWED_ORIGINS;

beforeAll(async () => {
  request = await getRequest();
});

afterEach(() => {
  if (ORIGINAL_ENV === undefined) {
    delete process.env.ALLOWED_ORIGINS;
  } else {
    process.env.ALLOWED_ORIGINS = ORIGINAL_ENV;
  }
});

describe('getAllowedOrigins()', () => {
  beforeEach(() => {
    delete process.env.ALLOWED_ORIGINS;
  });

  it('parses a comma-separated list', async () => {
    const { getAllowedOrigins } = await import('../cors-config.js');
    process.env.ALLOWED_ORIGINS = 'https://a.com,https://b.com';
    expect(getAllowedOrigins()).toEqual(['https://a.com', 'https://b.com']);
  });

  it('trims whitespace and drops empty entries', async () => {
    const { getAllowedOrigins } = await import('../cors-config.js');
    process.env.ALLOWED_ORIGINS = '  https://a.com , https://b.com , , ';
    expect(getAllowedOrigins()).toEqual(['https://a.com', 'https://b.com']);
  });

  it('returns an empty list when env is set to the empty string', async () => {
    const { getAllowedOrigins } = await import('../cors-config.js');
    process.env.ALLOWED_ORIGINS = '';
    expect(getAllowedOrigins()).toEqual([]);
  });

  it('falls back to localhost:3050 when env is unset', async () => {
    const { getAllowedOrigins } = await import('../cors-config.js');
    delete process.env.ALLOWED_ORIGINS;
    expect(getAllowedOrigins()).toEqual(['http://localhost:3050']);
  });
});

describe('CORS allowlist middleware', () => {
  it('emits Access-Control-Allow-Origin for an allowed origin', async () => {
    process.env.ALLOWED_ORIGINS = 'https://hub.example.com,http://localhost:3050';
    const res = await request
      .get('/api/health')
      .set('Origin', 'https://hub.example.com')
      .expect(200);
    expect(res.headers['access-control-allow-origin']).toBe('https://hub.example.com');
  });

  it('does NOT emit CORS headers for a disallowed origin', async () => {
    process.env.ALLOWED_ORIGINS = 'https://hub.example.com';
    const res = await request.get('/api/health').set('Origin', 'https://evil.com').expect(200);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    // Body still returns normally — the browser's SOP is what blocks delivery
    // to the caller. Server-to-server consumers are unaffected.
    expect(res.body.status).toBe('ok');
  });

  it('never emits the wildcard Access-Control-Allow-Origin: *', async () => {
    process.env.ALLOWED_ORIGINS = 'https://hub.example.com';
    const res = await request.get('/api/health').set('Origin', 'https://evil.com').expect(200);
    expect(res.headers['access-control-allow-origin']).not.toBe('*');
  });

  it('allows requests with no Origin header (Electron, curl, server-to-server)', async () => {
    process.env.ALLOWED_ORIGINS = 'https://hub.example.com';
    // supertest sends no Origin by default.
    const res = await request.get('/api/health').expect(200);
    expect(res.body.status).toBe('ok');
    // cors lib does not set ACAO when no Origin is present.
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('responds to preflight OPTIONS for an allowed origin', async () => {
    process.env.ALLOWED_ORIGINS = 'https://hub.example.com';
    const res = await request
      .options('/api/health')
      .set('Origin', 'https://hub.example.com')
      .set('Access-Control-Request-Method', 'GET')
      .expect(204);
    expect(res.headers['access-control-allow-origin']).toBe('https://hub.example.com');
  });

  it('preflight OPTIONS from disallowed origin gets no CORS headers', async () => {
    process.env.ALLOWED_ORIGINS = 'https://hub.example.com';
    const res = await request
      .options('/api/health')
      .set('Origin', 'https://evil.com')
      .set('Access-Control-Request-Method', 'GET');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('treats each entry as an exact match (no substring / subdomain inference)', async () => {
    process.env.ALLOWED_ORIGINS = 'https://hub.example.com';
    const res = await request
      .get('/api/health')
      .set('Origin', 'https://hub.example.com.evil.com')
      .expect(200);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('preserves the wildcard CORS header on /api/bug-reports for any origin', async () => {
    // The public bug-report intake endpoint installs its own applyCors
    // middleware in server/routes/bug-reports.ts that sets
    //   Access-Control-Allow-Origin: *
    // That runs AFTER the global allowlist middleware and must win.
    process.env.ALLOWED_ORIGINS = 'https://hub.example.com';
    const res = await request
      .options('/api/bug-reports')
      .set('Origin', 'https://random-site.com')
      .expect(204);
    expect(res.headers['access-control-allow-origin']).toBe('*');
  });
});
