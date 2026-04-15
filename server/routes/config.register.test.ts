import type TestAgent from 'supertest/lib/agent.js';
import { getRequest } from '../test/helpers.js';
import config from '../config.js';

let request: TestAgent;
let originalPublicUrl: string | null;

beforeAll(async () => {
  request = await getRequest();
  originalPublicUrl = config.publicUrl;
});

afterAll(() => {
  config.publicUrl = originalPublicUrl;
});

describe('GET /api/github-app/register', () => {
  it('returns 400 when publicUrl is not configured', async () => {
    config.publicUrl = null;
    const res = await request.get('/api/github-app/register').expect(400);
    expect(res.text).toContain('Public URL must be configured');
  });

  it('returns an HTML page with the manifest form', async () => {
    config.publicUrl = 'https://example.com';
    const res = await request.get('/api/github-app/register').expect(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.text).toContain('<!DOCTYPE html>');
    expect(res.text).toContain('manifest-form');
    expect(res.text).toContain('https://github.com/settings/apps/new');
    expect(res.text).toContain('.submit()');
  });

  it('escapes HTML entities in the manifest JSON to prevent XSS', async () => {
    config.publicUrl = "https://evil.com/x'><script>alert(1)</script>";
    const res = await request.get('/api/github-app/register').expect(200);
    expect(res.text).not.toMatch(/value="[^"]*'[^"]*"/);
    expect(res.text).not.toContain('<script>alert');
    expect(res.text).toContain('&#39;');
    expect(res.text).toContain('&lt;');
  });

  it('does not require authentication (public endpoint)', async () => {
    config.publicUrl = 'https://example.com';
    const res = await request.get('/api/github-app/register');
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });
});
