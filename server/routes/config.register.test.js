/**
 * Tests for GET /api/github-app/register — the server-rendered
 * manifest form that auto-submits to GitHub.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { getRequest } from '../test/helpers.js';
import config from '../config.js';

let request;
let originalPublicUrl;

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
    // Use a publicUrl with characters that could cause attribute breakout
    config.publicUrl = "https://evil.com/x'><script>alert(1)</script>";
    const res = await request.get('/api/github-app/register').expect(200);
    // Single quotes must be escaped — no raw ' in the manifest value
    expect(res.text).not.toMatch(/value="[^"]*'[^"]*"/);
    // Script tags must be escaped
    expect(res.text).not.toContain('<script>alert');
    // The escaped versions should be present
    expect(res.text).toContain('&#39;');
    expect(res.text).toContain('&lt;');
  });

  it('does not require authentication (public endpoint)', async () => {
    // This test verifies the endpoint is listed in PUBLIC_PATHS.
    // If auth were required, the test setup (no API key) would still pass,
    // but we verify the response isn't a 401/403.
    config.publicUrl = 'https://example.com';
    const res = await request.get('/api/github-app/register');
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });
});
