import { describe, it, expect, vi } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import { uriDecodeGuard, uriErrorHandler } from './uri-error-handler.js';

function mockRes(): Response & {
  status: ReturnType<typeof vi.fn>;
  json: ReturnType<typeof vi.fn>;
} {
  const res = {
    headersSent: false,
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as unknown as Response & {
    status: ReturnType<typeof vi.fn>;
    json: ReturnType<typeof vi.fn>;
  };
  return res;
}

describe('uriDecodeGuard', () => {
  it('passes well-formed URLs through to next()', () => {
    const next: NextFunction = vi.fn();
    const res = mockRes();
    uriDecodeGuard({ url: '/api/projects/agent-hub' } as Request, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('passes paths with valid percent-encoding through to next()', () => {
    const next: NextFunction = vi.fn();
    const res = mockRes();
    uriDecodeGuard({ url: '/api/sessions/hello%20world' } as Request, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('rejects /%c0 with 400 and does not call next()', () => {
    const next: NextFunction = vi.fn();
    const res = mockRes();
    uriDecodeGuard({ url: '/%c0' } as Request, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'malformed_uri' });
  });

  it('rejects truncated percent escapes with 400', () => {
    const next: NextFunction = vi.fn();
    const res = mockRes();
    uriDecodeGuard({ url: '/api/foo%' } as Request, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('rejects invalid lone surrogate sequences with 400', () => {
    const next: NextFunction = vi.fn();
    const res = mockRes();
    uriDecodeGuard({ url: '/%E0%A4%A' } as Request, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('ignores malformed bytes inside the query string (qs is tolerant)', () => {
    const next: NextFunction = vi.fn();
    const res = mockRes();
    // The query side is parsed by qs, which has its own tolerant decoder.
    // We only validate the path portion.
    uriDecodeGuard({ url: '/api/foo?bad=%c0' } as Request, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });
});

describe('uriErrorHandler', () => {
  it('returns 400 for URIError', () => {
    const next: NextFunction = vi.fn();
    const res = mockRes();
    uriErrorHandler(new URIError('Failed to decode param'), {} as Request, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'malformed_uri' });
  });

  it('passes non-URIError errors through to next()', () => {
    const next: NextFunction = vi.fn();
    const res = mockRes();
    const err = new Error('something else');
    uriErrorHandler(err, {} as Request, res, next);
    expect(next).toHaveBeenCalledWith(err);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('does not double-write when headers already sent', () => {
    const next: NextFunction = vi.fn();
    const res = mockRes();
    (res as unknown as { headersSent: boolean }).headersSent = true;
    uriErrorHandler(new URIError('boom'), {} as Request, res, next);
    expect(res.status).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });
});
