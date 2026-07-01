import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request } from 'express';

const githubMock = vi.hoisted(() => ({
  resolveOAuthConnectionUserId: vi.fn(),
}));

vi.mock('./github-connection-user.js', () => githubMock);

const { resolveGoogleConnectionUserId } = await import('./google-connection-user.js');

interface FakeReq {
  authUserId?: string;
  authSpawnSessionId?: string;
  headers: Record<string, string>;
}

function makeReq(opts: Partial<FakeReq> = {}): Request {
  const headers = opts.headers ?? {};
  return {
    authUserId: opts.authUserId,
    authSpawnSessionId: opts.authSpawnSessionId,
    get(name: string): string | undefined {
      return headers[name.toLowerCase()];
    },
  } as unknown as Request;
}

function makeCtx(rows: Record<string, { owner_user_id?: string | null }>) {
  return {
    getSession: {
      get: vi.fn((id: string) => rows[id]),
    },
  };
}

describe('resolveGoogleConnectionUserId', () => {
  beforeEach(() => {
    githubMock.resolveOAuthConnectionUserId.mockReset();
    githubMock.resolveOAuthConnectionUserId.mockReturnValue(null);
  });

  it('returns authUserId when a per-user identity is present (JWT / ahub / spawn key)', () => {
    const req = makeReq({ authUserId: 'user-123' });
    expect(resolveGoogleConnectionUserId(req, makeCtx({}))).toBe('user-123');
    expect(githubMock.resolveOAuthConnectionUserId).not.toHaveBeenCalled();
  });

  it('trims whitespace around authUserId', () => {
    const req = makeReq({ authUserId: '  user-9  ' });
    expect(resolveGoogleConnectionUserId(req, makeCtx({}))).toBe('user-9');
  });

  it('break-glass: attributes to the owner of the bound spawn session', () => {
    const req = makeReq({ authSpawnSessionId: 'sess-A' });
    const ctx = makeCtx({ 'sess-A': { owner_user_id: 'owner-A' } });
    expect(resolveGoogleConnectionUserId(req, ctx)).toBe('owner-A');
  });

  it('break-glass: falls back to the session-id header when no bound spawn id', () => {
    const req = makeReq({ headers: { 'x-agent-hub-session-id': 'sess-B' } });
    const ctx = makeCtx({ 'sess-B': { owner_user_id: 'owner-B' } });
    expect(resolveGoogleConnectionUserId(req, ctx)).toBe('owner-B');
  });

  it('prefers the cryptographically bound spawn id over the header', () => {
    const req = makeReq({
      authSpawnSessionId: 'sess-bound',
      headers: { 'x-agent-hub-session-id': 'sess-spoofed' },
    });
    const ctx = makeCtx({
      'sess-bound': { owner_user_id: 'owner-bound' },
      'sess-spoofed': { owner_user_id: 'owner-spoofed' },
    });
    expect(resolveGoogleConnectionUserId(req, ctx)).toBe('owner-bound');
  });

  it('falls back to the single-tenant resolver when the session is unknown', () => {
    githubMock.resolveOAuthConnectionUserId.mockReturnValue('synthetic-local');
    const req = makeReq({ headers: { 'x-agent-hub-session-id': 'missing' } });
    const ctx = makeCtx({});
    expect(resolveGoogleConnectionUserId(req, ctx)).toBe('synthetic-local');
  });

  it('falls back to the single-tenant resolver when the session has no owner', () => {
    githubMock.resolveOAuthConnectionUserId.mockReturnValue('synthetic-local');
    const req = makeReq({ authSpawnSessionId: 'sess-C' });
    const ctx = makeCtx({ 'sess-C': { owner_user_id: null } });
    expect(resolveGoogleConnectionUserId(req, ctx)).toBe('synthetic-local');
  });

  it('falls back to the single-tenant resolver when no ctx is provided', () => {
    githubMock.resolveOAuthConnectionUserId.mockReturnValue('synthetic-local');
    const req = makeReq({ headers: { 'x-agent-hub-session-id': 'sess-D' } });
    expect(resolveGoogleConnectionUserId(req, null)).toBe('synthetic-local');
  });
});
