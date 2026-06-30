import { describe, it, expect, vi } from 'vitest';
import {
  refreshGoogleAccessToken,
  GoogleInvalidGrantError,
  GOOGLE_TOKEN_ENDPOINT,
} from './google-oauth.js';

const CREDS = { clientId: 'cid', clientSecret: 'csecret' };

describe('refreshGoogleAccessToken', () => {
  it('POSTs the refresh grant to the Google token endpoint and returns the rotated token', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        access_token: 'ya29.new',
        expires_in: 3599,
        scope: 'openid email',
        token_type: 'Bearer',
      }),
      text: async () => '',
    })) as unknown as typeof fetch;

    const out = await refreshGoogleAccessToken({
      credentials: CREDS,
      refreshToken: '1//refresh',
      fetchImpl,
    });

    expect(out.access_token).toBe('ya29.new');
    expect(out.expires_in).toBe(3599);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe(GOOGLE_TOKEN_ENDPOINT);
    const body = (init as { body: string }).body;
    expect(body).toContain('grant_type=refresh_token');
    expect(body).toContain('refresh_token=1%2F%2Frefresh');
    expect(body).toContain('client_id=cid');
    expect(body).toContain('client_secret=csecret');
  });

  it('throws GoogleInvalidGrantError on a 400 invalid_grant (revoked token)', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 400,
      json: async () => ({
        error: 'invalid_grant',
        error_description: 'Token has been expired or revoked.',
      }),
      text: async () => '',
    })) as unknown as typeof fetch;

    await expect(
      refreshGoogleAccessToken({ credentials: CREDS, refreshToken: 'dead', fetchImpl }),
    ).rejects.toBeInstanceOf(GoogleInvalidGrantError);
  });

  it('throws a generic Error on a transient 5xx (retryable, not a revoke)', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 503,
      json: async () => ({ error: 'unavailable' }),
      text: async () => 'unavailable',
    })) as unknown as typeof fetch;

    const err = await refreshGoogleAccessToken({
      credentials: CREDS,
      refreshToken: 'r',
      fetchImpl,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(GoogleInvalidGrantError);
    expect((err as Error).message).toContain('503');
  });

  it('throws when the 200 response is missing access_token/expires_in', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ token_type: 'Bearer' }),
      text: async () => '',
    })) as unknown as typeof fetch;

    await expect(
      refreshGoogleAccessToken({ credentials: CREDS, refreshToken: 'r', fetchImpl }),
    ).rejects.toThrow(/missing access_token/);
  });
});
