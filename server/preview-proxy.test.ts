import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  extractPrNumber,
  findRunningPreview,
  buildPreviewUrl,
  createPreviewProxyMiddleware,
  createPreviewWsUpgradeHandler,
} from './preview-proxy.js';
import type { Stmts, PreviewContainerRow } from './types.js';
import type { Request, Response, NextFunction } from 'express';

// ── Helper: mock Stmts with a single running preview ─────────────

function createMockStmts(previews: PreviewContainerRow[] = []): Stmts {
  return {
    getRunningPreviewByPrNumber: {
      get: (prNumber: number) =>
        previews.find((p) => p.pr_number === prNumber && p.status === 'running') ?? undefined,
    },
  } as unknown as Stmts;
}

function makePreview(overrides: Partial<PreviewContainerRow> = {}): PreviewContainerRow {
  return {
    id: 'prev-1',
    project_id: 'proj-1',
    pr_number: 42,
    pr_url: 'https://github.com/org/repo/pull/42',
    branch: 'feature/foo',
    commit_sha: 'abc123',
    repo_url: 'https://github.com/org/repo.git',
    container_id: 'docker-123',
    port: 4001,
    url: 'https://preview-pr-42.preview.example.com',
    status: 'running',
    error_message: null,
    build_log: null,
    ttl_minutes: 60,
    expires_at: null,
    created_at: '2026-04-16T00:00:00Z',
    updated_at: '2026-04-16T00:00:00Z',
    ...overrides,
  };
}

// ── extractPrNumber ──────────────────────────────────────────────

describe('extractPrNumber', () => {
  it('extracts PR number from a valid preview subdomain', () => {
    expect(extractPrNumber('preview-pr-42.preview.example.com')).toBe(42);
  });

  it('extracts PR number from a localhost-style subdomain', () => {
    expect(extractPrNumber('preview-pr-1.localhost')).toBe(1);
  });

  it('handles large PR numbers', () => {
    expect(extractPrNumber('preview-pr-99999.preview.example.com')).toBe(99999);
  });

  it('is case insensitive', () => {
    expect(extractPrNumber('Preview-PR-7.preview.example.com')).toBe(7);
  });

  it('returns null for non-preview subdomains', () => {
    expect(extractPrNumber('www.example.com')).toBeNull();
  });

  it('returns null for missing host', () => {
    expect(extractPrNumber(undefined)).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(extractPrNumber('')).toBeNull();
  });

  it('returns null for preview-pr without a number', () => {
    expect(extractPrNumber('preview-pr-.example.com')).toBeNull();
  });

  it('returns null for the base domain itself', () => {
    expect(extractPrNumber('preview.example.com')).toBeNull();
  });
});

// ── findRunningPreview ───────────────────────────────────────────

describe('findRunningPreview', () => {
  it('returns a running preview container for the given PR', () => {
    const preview = makePreview();
    const stmts = createMockStmts([preview]);
    expect(findRunningPreview(stmts, 42)).toEqual(preview);
  });

  it('returns null when no preview matches', () => {
    const stmts = createMockStmts([]);
    expect(findRunningPreview(stmts, 42)).toBeNull();
  });

  it('returns null when preview exists but is not running', () => {
    const preview = makePreview({ status: 'stopped' });
    const stmts = createMockStmts([preview]);
    expect(findRunningPreview(stmts, 42)).toBeNull();
  });
});

// ── buildPreviewUrl ──────────────────────────────────────────────

describe('buildPreviewUrl', () => {
  it('returns a subdomain URL when previewDomain is set', () => {
    expect(buildPreviewUrl(42, 4001, 'preview.example.com')).toBe(
      'https://preview-pr-42.preview.example.com',
    );
  });

  it('returns a localhost URL when previewDomain is null', () => {
    expect(buildPreviewUrl(42, 4001, null)).toBe('http://localhost:4001');
  });
});

// ── createPreviewProxyMiddleware ─────────────────────────────────

describe('createPreviewProxyMiddleware', () => {
  const previewDomain = 'preview.example.com';

  function mockReq(host: string): Request {
    return {
      headers: { host },
      url: '/api/health',
      method: 'GET',
      pipe: vi.fn(),
    } as unknown as Request;
  }

  function mockRes(): Response {
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
      writeHead: vi.fn(),
      headersSent: false,
    } as unknown as Response;
    return res;
  }

  it('calls next() for non-preview hosts', () => {
    const stmts = createMockStmts([]);
    const middleware = createPreviewProxyMiddleware({ stmts, previewDomain });
    const next = vi.fn();

    middleware(mockReq('api.example.com'), mockRes(), next);
    expect(next).toHaveBeenCalled();
  });

  it('calls next() when host does not end with preview domain', () => {
    const stmts = createMockStmts([]);
    const middleware = createPreviewProxyMiddleware({ stmts, previewDomain });
    const next = vi.fn();

    middleware(mockReq('preview-pr-42.other.com'), mockRes(), next);
    expect(next).toHaveBeenCalled();
  });

  it('returns 502 when preview is not running', () => {
    const stmts = createMockStmts([]);
    const middleware = createPreviewProxyMiddleware({ stmts, previewDomain });
    const next = vi.fn();
    const res = mockRes();

    middleware(mockReq('preview-pr-99.preview.example.com'), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(502);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.stringContaining('PR #99') }),
    );
  });

  it('returns 502 when preview has no port', () => {
    const preview = makePreview({ port: null });
    const stmts = createMockStmts([preview]);
    const middleware = createPreviewProxyMiddleware({ stmts, previewDomain });
    const next = vi.fn();
    const res = mockRes();

    middleware(mockReq('preview-pr-42.preview.example.com'), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(502);
  });
});

// ── createPreviewWsUpgradeHandler ────────────────────────────────

describe('createPreviewWsUpgradeHandler', () => {
  const previewDomain = 'preview.example.com';

  function mockUpgradeReq(host: string) {
    return {
      headers: { host, upgrade: 'websocket', connection: 'upgrade' },
      url: '/ws',
      method: 'GET',
    } as unknown as import('http').IncomingMessage;
  }

  it('returns false for non-preview hosts', () => {
    const stmts = createMockStmts([]);
    const handler = createPreviewWsUpgradeHandler({ stmts, previewDomain });
    const socket = { write: vi.fn(), destroy: vi.fn() };

    const handled = handler(
      mockUpgradeReq('api.example.com'),
      socket as unknown as import('net').Socket,
      Buffer.alloc(0),
    );
    expect(handled).toBe(false);
  });

  it('destroys socket with 502 when preview is not running', () => {
    const stmts = createMockStmts([]);
    const handler = createPreviewWsUpgradeHandler({ stmts, previewDomain });
    const socket = { write: vi.fn(), destroy: vi.fn() };

    const handled = handler(
      mockUpgradeReq('preview-pr-42.preview.example.com'),
      socket as unknown as import('net').Socket,
      Buffer.alloc(0),
    );
    expect(handled).toBe(true);
    expect(socket.write).toHaveBeenCalledWith('HTTP/1.1 502 Bad Gateway\r\n\r\n');
    expect(socket.destroy).toHaveBeenCalled();
  });
});
