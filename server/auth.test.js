import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock config before importing auth
vi.mock('./config.js', () => {
  return {
    default: { apiKey: null },
  };
});

const { default: config } = await import('./config.js');
const { authMiddleware, authenticateWs } = await import('./auth.js');

function mockReq(overrides = {}) {
  return {
    path: '/api/agents',
    headers: {},
    query: {},
    ...overrides,
  };
}

function mockRes() {
  const res = {
    statusCode: null,
    body: null,
    status(code) {
      res.statusCode = code;
      return res;
    },
    json(data) {
      res.body = data;
      return res;
    },
  };
  return res;
}

describe('authMiddleware', () => {
  beforeEach(() => {
    config.apiKey = null;
  });

  it('passes through when no API key is configured', () => {
    const next = vi.fn();
    authMiddleware(mockReq(), mockRes(), next);
    expect(next).toHaveBeenCalledOnce();
  });

  it('passes through for /api/health regardless of key', () => {
    config.apiKey = 'secret-key';
    const next = vi.fn();
    authMiddleware(mockReq({ path: '/api/health' }), mockRes(), next);
    expect(next).toHaveBeenCalledOnce();
  });

  it('returns 401 when key is required but not provided', () => {
    config.apiKey = 'secret-key';
    const next = vi.fn();
    const res = mockRes();
    authMiddleware(mockReq(), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(res.body.error).toContain('API key required');
  });

  it('returns 403 when wrong key is provided via header', () => {
    config.apiKey = 'secret-key';
    const next = vi.fn();
    const res = mockRes();
    authMiddleware(mockReq({ headers: { 'x-api-key': 'wrong-key' } }), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toContain('Invalid API key');
  });

  it('accepts correct key via X-API-Key header', () => {
    config.apiKey = 'secret-key';
    const next = vi.fn();
    authMiddleware(mockReq({ headers: { 'x-api-key': 'secret-key' } }), mockRes(), next);
    expect(next).toHaveBeenCalledOnce();
  });

  it('accepts correct key via query parameter', () => {
    config.apiKey = 'secret-key';
    const next = vi.fn();
    authMiddleware(mockReq({ query: { apiKey: 'secret-key' } }), mockRes(), next);
    expect(next).toHaveBeenCalledOnce();
  });

  it('passes through for non-API paths (static files / SPA fallback)', () => {
    config.apiKey = 'secret-key';
    const next = vi.fn();
    authMiddleware(mockReq({ path: '/' }), mockRes(), next);
    expect(next).toHaveBeenCalledOnce();
  });

  it('passes through for static asset paths', () => {
    config.apiKey = 'secret-key';
    const next = vi.fn();
    authMiddleware(mockReq({ path: '/assets/index-abc123.js' }), mockRes(), next);
    expect(next).toHaveBeenCalledOnce();
  });

  it('prefers header over query param', () => {
    config.apiKey = 'secret-key';
    const next = vi.fn();
    // Header has correct key, query has wrong key — should pass
    authMiddleware(
      mockReq({
        headers: { 'x-api-key': 'secret-key' },
        query: { apiKey: 'wrong' },
      }),
      mockRes(),
      next,
    );
    expect(next).toHaveBeenCalledOnce();
  });
});

describe('authenticateWs', () => {
  beforeEach(() => {
    config.apiKey = null;
  });

  it('returns true when no key is configured', () => {
    expect(authenticateWs({ url: '/ws', headers: { host: 'localhost:3051' } })).toBe(true);
  });

  it('returns true when correct key is provided', () => {
    config.apiKey = 'ws-key';
    expect(
      authenticateWs({
        url: '/ws?apiKey=ws-key',
        headers: { host: 'localhost:3051' },
      }),
    ).toBe(true);
  });

  it('returns false when wrong key is provided', () => {
    config.apiKey = 'ws-key';
    expect(
      authenticateWs({
        url: '/ws?apiKey=bad',
        headers: { host: 'localhost:3051' },
      }),
    ).toBe(false);
  });

  it('returns false when no key is provided but one is required', () => {
    config.apiKey = 'ws-key';
    expect(
      authenticateWs({
        url: '/ws',
        headers: { host: 'localhost:3051' },
      }),
    ).toBe(false);
  });
});
