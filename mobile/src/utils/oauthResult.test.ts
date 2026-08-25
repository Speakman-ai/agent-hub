import { describe, it, expect } from 'vitest';
import { interpretAuthSessionResult, OAUTH_SCHEME, OAUTH_REDIRECT_PATH } from './oauthResult';

describe('interpretAuthSessionResult', () => {
  it('treats success as a completed redirect', () => {
    expect(
      interpretAuthSessionResult({ type: 'success', url: 'agenthub://oauth-callback' }),
    ).toEqual({ ok: true, cancelled: false });
  });

  it('treats cancel and dismiss as benign user aborts', () => {
    expect(interpretAuthSessionResult({ type: 'cancel' })).toEqual({ ok: false, cancelled: true });
    expect(interpretAuthSessionResult({ type: 'dismiss' })).toEqual({ ok: false, cancelled: true });
  });

  it('treats any other result type as a failure (not a cancel)', () => {
    expect(interpretAuthSessionResult({ type: 'locked' })).toEqual({ ok: false, cancelled: false });
    expect(interpretAuthSessionResult({ type: 'opened' })).toEqual({ ok: false, cancelled: false });
  });
});

describe('OAuth scheme constants', () => {
  it('match the server allowlist and app.json scheme', () => {
    // Guards against drift: server/oauth-return-to.ts MOBILE_OAUTH_SCHEMES
    // and mobile/app.json expo.scheme must both be 'agenthub'.
    expect(OAUTH_SCHEME).toBe('agenthub');
    expect(OAUTH_REDIRECT_PATH).toBe('oauth-callback');
  });
});
