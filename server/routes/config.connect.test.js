/**
 * Tests for POST /api/github-app/connect — connect an existing GitHub App.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

// Mock github-app.js BEFORE any imports that transitively use it.
// Must provide default implementations because index.js calls getAppInfo() at startup.
const mockGetAppInfo = vi.fn().mockResolvedValue({ name: 'mock', slug: 'mock-app', id: 1 });
const mockGetAppInstallations = vi.fn().mockResolvedValue([]);

vi.mock('../github-app.js', () => ({
  getAppInfo: mockGetAppInfo,
  getAppInstallations: mockGetAppInstallations,
  buildAppManifest: () => ({ name: 'test', redirect_url: 'http://localhost/cb' }),
  clearTokenCache: () => {},
}));

import { getRequest } from '../test/helpers.js';
import config from '../config.js';

let request;
let originalGithubApp;
let originalApiKey;

beforeAll(async () => {
  request = await getRequest();
  originalGithubApp = config.githubApp;
  originalApiKey = config.apiKey;
  // Disable auth for tests
  config.apiKey = null;
});

afterAll(() => {
  config.githubApp = originalGithubApp;
  config.apiKey = originalApiKey;
});

describe('POST /api/github-app/connect', () => {
  it('returns 400 when appId is missing', async () => {
    const res = await request
      .post('/api/github-app/connect')
      .send({ privateKey: 'key', installationId: '123' })
      .expect(400);
    expect(res.body.error).toContain('required');
  });

  it('returns 400 when privateKey is missing', async () => {
    const res = await request
      .post('/api/github-app/connect')
      .send({ appId: '12345', installationId: '123' })
      .expect(400);
    expect(res.body.error).toContain('required');
  });

  it('returns 400 when installationId is missing', async () => {
    const res = await request
      .post('/api/github-app/connect')
      .send({ appId: '12345', privateKey: 'key' })
      .expect(400);
    expect(res.body.error).toContain('required');
  });

  it('returns 400 when getAppInfo fails (invalid credentials)', async () => {
    mockGetAppInfo.mockRejectedValueOnce(new Error('Bad credentials'));
    const res = await request
      .post('/api/github-app/connect')
      .send({ appId: '12345', privateKey: 'bad-key', installationId: '999' })
      .expect(400);
    expect(res.body.error).toContain('Invalid GitHub App credentials');
    expect(res.body.error).toContain('Bad credentials');
  });

  it('succeeds with valid credentials', async () => {
    mockGetAppInfo.mockResolvedValueOnce({ name: 'test', slug: 'test-app', id: 12345 });
    mockGetAppInstallations.mockResolvedValueOnce([{ id: 999 }]);

    const res = await request
      .post('/api/github-app/connect')
      .send({ appId: '12345', privateKey: 'valid-key', installationId: '999' })
      .expect(200);

    expect(res.body.ok).toBe(true);
    expect(res.body.appId).toBe('12345');
    expect(res.body.appSlug).toBe('test-app');
    expect(res.body.installationId).toBe('999');
  });

  it('succeeds even when installation verification fails', async () => {
    mockGetAppInfo.mockResolvedValueOnce({ name: 'my-app', slug: 'my-app', id: 1 });
    mockGetAppInstallations.mockRejectedValueOnce(new Error('API error'));

    const res = await request
      .post('/api/github-app/connect')
      .send({ appId: '12345', privateKey: 'valid-key', installationId: '777' })
      .expect(200);

    expect(res.body.ok).toBe(true);
    expect(res.body.appSlug).toBe('my-app');
  });

  it('uses appInfo.name as slug fallback when slug is missing', async () => {
    mockGetAppInfo.mockResolvedValueOnce({ name: 'fallback-name', id: 99 });
    mockGetAppInstallations.mockResolvedValueOnce([{ id: 111 }]);

    const res = await request
      .post('/api/github-app/connect')
      .send({ appId: '99', privateKey: 'key', installationId: '111' })
      .expect(200);

    expect(res.body.appSlug).toBe('fallback-name');
  });
});
