import { describe, it, expect, vi } from 'vitest';
import {
  buildAuthorizeUrl,
  exchangeCodeForToken,
  refreshUserToken,
  fetchUserInfo,
  githubUserApiRequest,
} from './github-oauth.js';

describe('buildAuthorizeUrl', () => {
  it('produces the github.com authorize URL with required params', () => {
    const url = buildAuthorizeUrl({
      clientId: 'Iv1.abc',
      redirectUri: 'https://hub.example.com/api/auth/github/callback',
      state: 'state-token-xyz',
    });
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe('https://github.com/login/oauth/authorize');
    expect(parsed.searchParams.get('client_id')).toBe('Iv1.abc');
    expect(parsed.searchParams.get('redirect_uri')).toBe(
      'https://hub.example.com/api/auth/github/callback',
    );
    expect(parsed.searchParams.get('state')).toBe('state-token-xyz');
    // We deliberately do NOT include scope — GitHub Apps ignore it.
    expect(parsed.searchParams.has('scope')).toBe(false);
    expect(parsed.searchParams.has('login')).toBe(false);
  });

  it('includes login hint when provided', () => {
    const url = buildAuthorizeUrl({
      clientId: 'Iv1.abc',
      redirectUri: 'https://hub/example',
      state: 's',
      login: 'speakmanra',
    });
    expect(new URL(url).searchParams.get('login')).toBe('speakmanra');
  });
});

function mockFetchJsonResponse(payload: unknown, status = 200, ok = true) {
  return vi.fn(async () => ({
    ok,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  })) as unknown as typeof fetch;
}

describe('exchangeCodeForToken', () => {
  it('POSTs form-encoded body and returns parsed tokens', async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = init?.body as string;
      expect(body).toContain('client_id=Iv1.abc');
      expect(body).toContain('client_secret=shh');
      expect(body).toContain('code=the-code');
      expect(body).toContain('redirect_uri=');
      expect(init?.method).toBe('POST');
      return {
        ok: true,
        status: 200,
        json: async () => ({
          access_token: 'ghu_access',
          expires_in: 28800,
          refresh_token: 'ghr_refresh',
          refresh_token_expires_in: 15724800,
          token_type: 'bearer',
          scope: '',
        }),
        text: async () => '',
      };
    }) as unknown as typeof fetch;

    const tokens = await exchangeCodeForToken({
      credentials: { clientId: 'Iv1.abc', clientSecret: 'shh' },
      code: 'the-code',
      redirectUri: 'https://hub.example/cb',
      fetchImpl,
    });
    expect(tokens.access_token).toBe('ghu_access');
    expect(tokens.refresh_token).toBe('ghr_refresh');
  });

  it('throws when GitHub returns a 200 with an error field (OAuth error)', async () => {
    const fetchImpl = mockFetchJsonResponse({
      error: 'bad_verification_code',
      error_description: 'The code passed is incorrect or expired.',
    });
    await expect(
      exchangeCodeForToken({
        credentials: { clientId: 'a', clientSecret: 'b' },
        code: 'x',
        redirectUri: 'https://hub/cb',
        fetchImpl,
      }),
    ).rejects.toThrow(/bad_verification_code|incorrect or expired/);
  });

  it('throws when response is missing tokens', async () => {
    const fetchImpl = mockFetchJsonResponse({ scope: 'repo' });
    await expect(
      exchangeCodeForToken({
        credentials: { clientId: 'a', clientSecret: 'b' },
        code: 'x',
        redirectUri: 'https://hub/cb',
        fetchImpl,
      }),
    ).rejects.toThrow(/missing access_token or refresh_token/);
  });

  it('throws on non-2xx HTTP status', async () => {
    const fetchImpl = mockFetchJsonResponse({ error: 'x' }, 500, false);
    await expect(
      exchangeCodeForToken({
        credentials: { clientId: 'a', clientSecret: 'b' },
        code: 'x',
        redirectUri: 'https://hub/cb',
        fetchImpl,
      }),
    ).rejects.toThrow(/GitHub OAuth token exchange failed \(500\)/);
  });
});

describe('refreshUserToken', () => {
  it('uses grant_type=refresh_token and returns rotated tokens', async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = init?.body as string;
      expect(body).toContain('grant_type=refresh_token');
      expect(body).toContain('refresh_token=old-refresh');
      return {
        ok: true,
        status: 200,
        json: async () => ({
          access_token: 'new-access',
          expires_in: 28800,
          refresh_token: 'new-refresh',
          refresh_token_expires_in: 15724800,
          token_type: 'bearer',
          scope: '',
        }),
        text: async () => '',
      };
    }) as unknown as typeof fetch;
    const rotated = await refreshUserToken({
      credentials: { clientId: 'a', clientSecret: 'b' },
      refreshToken: 'old-refresh',
      fetchImpl,
    });
    expect(rotated.access_token).toBe('new-access');
    expect(rotated.refresh_token).toBe('new-refresh');
  });

  it('propagates OAuth error payloads as exceptions', async () => {
    const fetchImpl = mockFetchJsonResponse({
      error: 'bad_refresh_token',
      error_description: 'The refresh token has expired',
    });
    await expect(
      refreshUserToken({
        credentials: { clientId: 'a', clientSecret: 'b' },
        refreshToken: 'dead',
        fetchImpl,
      }),
    ).rejects.toThrow(/refresh token has expired|bad_refresh_token/);
  });
});

describe('fetchUserInfo', () => {
  it('returns {id, login, name, avatar_url, email} from /user', async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe('https://api.github.com/user');
      const headers = init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer the-token');
      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: 42,
          login: 'speakmanra',
          name: 'Ryan Speakman',
          avatar_url: 'https://avatars.githubusercontent.com/u/42',
          email: null,
        }),
        text: async () => '',
      };
    }) as unknown as typeof fetch;
    const info = await fetchUserInfo({ accessToken: 'the-token', fetchImpl });
    expect(info.login).toBe('speakmanra');
    expect(info.id).toBe(42);
  });

  it('throws when response omits id or login', async () => {
    const fetchImpl = mockFetchJsonResponse({ id: 42 }); // missing login
    await expect(fetchUserInfo({ accessToken: 't', fetchImpl })).rejects.toThrow(
      /missing id or login/,
    );
  });
});

describe('githubUserApiRequest', () => {
  it('sends Bearer token and returns parsed JSON', async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe('https://api.github.com/repos/a/b/pulls');
      const headers = init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer abc');
      return {
        ok: true,
        status: 200,
        json: async () => [{ number: 1 }],
        text: async () => '',
      };
    }) as unknown as typeof fetch;
    const data = await githubUserApiRequest<Array<{ number: number }>>({
      accessToken: 'abc',
      endpoint: '/repos/a/b/pulls',
      fetchImpl,
    });
    expect(data[0].number).toBe(1);
  });

  it('returns empty object on 204', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 204,
      json: async () => ({}),
      text: async () => '',
    })) as unknown as typeof fetch;
    const data = await githubUserApiRequest({
      accessToken: 'x',
      endpoint: '/foo',
      method: 'DELETE',
      fetchImpl,
    });
    expect(data).toEqual({});
  });

  it('throws on non-2xx', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 403,
      json: async () => ({}),
      text: async () => 'forbidden',
    })) as unknown as typeof fetch;
    await expect(
      githubUserApiRequest({ accessToken: 'x', endpoint: '/foo', fetchImpl }),
    ).rejects.toThrow(/403.*forbidden/);
  });
});
